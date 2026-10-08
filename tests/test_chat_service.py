"""Chat authorization, recency and database/file mutation boundaries."""

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from pathlib import Path
from threading import Event
from unittest.mock import patch

import pytest
from sqlalchemy import Connection, event
from sqlalchemy.exc import StatementError

from diktator.chats import Chat, ChatNotFound, ChatService, RecordingNotFound
from diktator.db import (
    session_scope,
)
from diktator.db.legacy import sweep_orphans
from diktator.db.rows import (
    LOCAL_USER_ID,
    ChatMemberRow,
    ChatRow,
    RecordingRow,
    UserRow,
)
from tests.test_audio import make_wav


def test_membership_controls_all_operations_not_creator(service: ChatService) -> None:
    chat = service.create(LOCAL_USER_ID)
    recording = service.add_recording(LOCAL_USER_ID, chat.id, make_wav(), 0.01)
    outsider = "other"
    with session_scope(service.engine, write=True) as session:
        session.add(UserRow(id=outsider, created=datetime.now(UTC)))
        session.flush()
        row = session.get(ChatRow, chat.id)
        assert row is not None
        row.created_by = outsider
    assert service.list(outsider) == []
    for operation in (
        lambda: service.get(outsider, chat.id),
        lambda: service.update_text(outsider, chat.id, "attack"),
        lambda: service.delete(outsider, chat.id),
        lambda: service.add_recording(outsider, chat.id, b"attack", 1),
        lambda: service.recording_audio(outsider, chat.id, recording.id),
    ):
        with pytest.raises(ChatNotFound):
            operation()
    assert service.get(LOCAL_USER_ID, chat.id).recordings == [recording]
    with session_scope(service.engine, write=True) as session:
        session.add(ChatMemberRow(chat_id=chat.id, user_id=outsider, role="owner"))
    assert service.get(outsider, chat.id) == service.get(LOCAL_USER_ID, chat.id)


def test_utc_roundtrip_and_recency(service: ChatService) -> None:
    first = service.create(LOCAL_USER_ID)
    second = service.create(LOCAL_USER_ID)
    assert [chat.id for chat in service.list(LOCAL_USER_ID)] == [second.id, first.id]
    updated = service.update_text(LOCAL_USER_ID, first.id, "newest")
    assert [chat.id for chat in service.list(LOCAL_USER_ID)] == [first.id, second.id]
    assert updated.created.tzinfo == UTC and updated.updated.tzinfo == UTC
    with (
        pytest.raises(StatementError, match="timezone-aware"),
        session_scope(service.engine, write=True) as session,
    ):
        session.add(UserRow(id="naive", created=datetime(2020, 1, 1)))


def test_commit_failure_removes_finalized_audio_and_rolls_back(service: ChatService) -> None:
    chat = service.create(LOCAL_USER_ID)

    def fail_commit(connection: Connection) -> None:
        if connection.get_execution_options().get("write"):
            raise RuntimeError("failed commit")

    event.listen(service.engine, "commit", fail_commit)
    try:
        with pytest.raises(RuntimeError, match="failed commit"):
            service.add_recording(LOCAL_USER_ID, chat.id, make_wav(), 0.01)
    finally:
        event.remove(service.engine, "commit", fail_commit)
    assert service.get(LOCAL_USER_ID, chat.id).model_dump() == chat.model_dump()
    assert list((service.root / chat.id).iterdir()) == []


def test_text_upload_concurrency_preserves_both_fields(service: ChatService) -> None:
    chat = service.create(LOCAL_USER_ID)
    with ThreadPoolExecutor(4) as pool:
        futures = [
            pool.submit(service.add_recording, LOCAL_USER_ID, chat.id, make_wav(), 0.01)
            for _ in range(12)
        ]
        saves = [
            pool.submit(service.update_text, LOCAL_USER_ID, chat.id, "latest text")
            for _ in range(12)
        ]
        recordings = [future.result() for future in futures]
        for save in saves:
            save.result()
    stored = service.get(LOCAL_USER_ID, chat.id)
    assert stored.text == "latest text"
    assert {recording.id for recording in stored.recordings} == {
        recording.id for recording in recordings
    }
    assert len(stored.recordings) == 12
    for recording in recordings:
        assert service.recording_audio(LOCAL_USER_ID, chat.id, recording.id) == make_wav()


def test_upload_delete_serialization(service: ChatService) -> None:
    from diktator.chats import finalize_audio

    chat = service.create(LOCAL_USER_ID)
    started, finish = Event(), Event()

    def paused(path: Path, audio: bytes) -> None:
        finalize_audio(path, audio)
        started.set()
        assert finish.wait(5)

    with patch("diktator.chats.finalize_audio", paused), ThreadPoolExecutor(2) as pool:
        upload = pool.submit(service.add_recording, LOCAL_USER_ID, chat.id, make_wav(), 0.01)
        try:
            assert started.wait(5)
            deletion = pool.submit(service.delete, LOCAL_USER_ID, chat.id)
            assert not deletion.done()
        finally:
            finish.set()
        upload.result()
        deletion.result()
    assert service.list(LOCAL_USER_ID) == []
    assert not (service.root / chat.id).exists()


def test_recording_uses_safe_stored_relative_path(service: ChatService) -> None:
    chat = service.create(LOCAL_USER_ID)
    recording = service.add_recording(LOCAL_USER_ID, chat.id, make_wav(), 0.01)
    original = service.root / chat.id / f"{recording.id}.wav"
    stored = original.with_name("d" * 32 + ".wav")
    original.rename(stored)
    with session_scope(service.engine, write=True) as session:
        row = session.get(RecordingRow, recording.id)
        assert row is not None
        row.audio_path = stored.relative_to(service.root).as_posix()
    assert service.recording_audio(LOCAL_USER_ID, chat.id, recording.id) == make_wav()
    sweep_orphans(service.engine, service.root)
    assert stored.exists()


@pytest.mark.parametrize("unsafe", ["../outside.wav", "/outside.wav", "other/file.wav", "a\\b.wav"])
def test_recording_rejects_unsafe_stored_path(service: ChatService, unsafe: str) -> None:
    chat = service.create(LOCAL_USER_ID)
    recording = service.add_recording(LOCAL_USER_ID, chat.id, make_wav(), 0.01)
    with session_scope(service.engine, write=True) as session:
        row = session.get(RecordingRow, recording.id)
        assert row is not None
        row.audio_path = unsafe
    with pytest.raises(RecordingNotFound):
        service.recording_audio(LOCAL_USER_ID, chat.id, recording.id)


def test_audio_read_does_not_block_mutations_and_handles_delete_race(service: ChatService) -> None:
    chat = service.create(LOCAL_USER_ID)
    recording = service.add_recording(LOCAL_USER_ID, chat.id, make_wav(), 0.01)
    started, finish = Event(), Event()
    read_bytes = Path.read_bytes

    def paused(path: Path) -> bytes:
        started.set()
        assert finish.wait(5)
        return read_bytes(path)

    with patch.object(Path, "read_bytes", paused), ThreadPoolExecutor(2) as pool:
        reading = pool.submit(service.recording_audio, LOCAL_USER_ID, chat.id, recording.id)
        try:
            assert started.wait(5)
            deleting = pool.submit(service.delete, LOCAL_USER_ID, chat.id)
            deleting.result(timeout=2)
        finally:
            finish.set()
        with pytest.raises(RecordingNotFound):
            reading.result()


def test_creation_waits_for_deleted_id_folder_cleanup(service: ChatService) -> None:
    import shutil
    from uuid import UUID

    chat = service.create(LOCAL_USER_ID)
    service.add_recording(LOCAL_USER_ID, chat.id, make_wav(), 0.01)
    started, finish, creating = Event(), Event(), Event()
    remove = shutil.rmtree

    def paused(path: Path) -> None:
        started.set()
        assert finish.wait(5)
        remove(path)

    def recreate() -> Chat:
        creating.set()
        return service.create(LOCAL_USER_ID)

    with (
        patch("diktator.chats.shutil.rmtree", paused),
        patch("diktator.chats.uuid.uuid4", return_value=UUID(hex=chat.id)),
        ThreadPoolExecutor(2) as pool,
    ):
        deleting = pool.submit(service.delete, LOCAL_USER_ID, chat.id)
        try:
            assert started.wait(5)
            creation = pool.submit(recreate)
            assert creating.wait(5)
            assert not creation.done()
        finally:
            finish.set()
        deleting.result()
        assert creation.result().id == chat.id
    recording = service.add_recording(LOCAL_USER_ID, chat.id, make_wav(), 0.01)
    assert service.recording_audio(LOCAL_USER_ID, chat.id, recording.id) == make_wav()


@pytest.mark.parametrize("upload_time_offset", [3, 1])
def test_upload_recency_preserves_text_save_during_finalization(
    service: ChatService, upload_time_offset: int
) -> None:
    from diktator.chats import finalize_audio

    chat = service.create(LOCAL_USER_ID)
    recording_started = chat.updated + timedelta(seconds=1)
    text_saved = chat.updated + timedelta(seconds=2)
    upload_mutation = chat.updated + timedelta(seconds=upload_time_offset)
    started, finish = Event(), Event()

    def paused(path: Path, audio: bytes) -> None:
        finalize_audio(path, audio)
        started.set()
        assert finish.wait(5)

    with (
        patch("diktator.chats.finalize_audio", paused),
        patch("diktator.chats._now", side_effect=[recording_started, text_saved, upload_mutation]),
        ThreadPoolExecutor(2) as pool,
    ):
        upload = pool.submit(service.add_recording, LOCAL_USER_ID, chat.id, make_wav(), 0.01)
        try:
            assert started.wait(5)
            saving = pool.submit(service.update_text, LOCAL_USER_ID, chat.id, "saved during upload")
            saved = saving.result(timeout=2)
            assert saved.updated == text_saved
        finally:
            finish.set()
        recording = upload.result()
    stored = service.get(LOCAL_USER_ID, chat.id)
    assert stored.text == saved.text
    assert recording.created == recording_started
    assert stored.recordings == [recording]
    assert stored.updated == max(saved.updated, upload_mutation)
