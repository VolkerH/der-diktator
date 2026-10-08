"""Conditional resources and retry identities, exercised through HTTP and real files."""

import asyncio
import hashlib
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from threading import Event
from unittest.mock import patch

import pytest
from sqlalchemy import event

from diktator.chats import ChatService
from diktator.config import Settings
from diktator.db import DATABASE_NAME, open_engine, session_scope, upgrade_schema
from diktator.db.rows import LOCAL_USER_ID, ChatMemberRow, RecordingRow, UserRow
from diktator.errors import ApiFailure
from tests.test_app import client_for
from tests.test_audio import make_wav
from tests.test_chats import transcribing_engine

CHAT_ID = "c" * 32
RECORDING_ID = "d" * 32
AUDIO_HEADERS = {"Content-Type": "audio/wav"}


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture
def service(tmp_path: Path):
    engine = open_engine(tmp_path / DATABASE_NAME)
    upgrade_schema(engine, tmp_path)
    try:
        yield ChatService(tmp_path, engine)
    finally:
        engine.dispose()


@pytest.mark.anyio
async def test_separate_validators_and_two_client_conflict(tmp_path: Path) -> None:
    async with client_for(transcribing_engine, Settings(data_directory=tmp_path)) as client:
        created = await client.put(f"/api/chats/{CHAT_ID}")
        assert created.status_code == 201
        chat_etag = created.headers["etag"]
        text_etag = created.headers["text-etag"]
        assert chat_etag != text_etag
        text = await client.get(f"/api/chats/{CHAT_ID}/text")
        assert text.json() == {"text": "", "text_revision": 1}
        assert text.headers["etag"] == text_etag
        await client.put(
            f"/api/chats/{CHAT_ID}/recordings/{RECORDING_ID}",
            content=make_wav(),
            headers=AUDIO_HEADERS,
        )
        uploaded = await client.get(f"/api/chats/{CHAT_ID}")
        assert uploaded.headers["etag"] != chat_etag
        assert uploaded.headers["text-etag"] == text_etag
        assert (await client.get(f"/api/chats/{CHAT_ID}/text")).headers["etag"] == text_etag
        stale_delete = await client.delete(f"/api/chats/{CHAT_ID}", headers={"If-Match": chat_etag})
        assert stale_delete.status_code == 412
        assert stale_delete.json()["code"] == "revision_conflict"
        # Independent clients A and B start with the same acknowledged version.
        saved = await client.put(
            f"/api/chats/{CHAT_ID}/text",
            json={"text": "Client A"},
            headers={"If-Match": text_etag},
        )
        assert saved.status_code == 200
        assert saved.json()["revision"] == uploaded.json()["revision"] + 1
        assert saved.json()["text_revision"] == 2
        assert saved.headers["etag"] != saved.headers["text-etag"]
        assert saved.headers["text-etag"] != text_etag
        stale = await client.put(
            f"/api/chats/{CHAT_ID}/text",
            json={"text": "Client B"},
            headers={"If-Match": text_etag},
        )
        assert stale.status_code == 412
        assert stale.json()["code"] == "revision_conflict"
        assert (await client.get(f"/api/chats/{CHAT_ID}")).json() == saved.json()
        # Compatibility remains last-writer-wins when no validator is sent.
        legacy = await client.put(f"/api/chats/{CHAT_ID}/text", json={"text": "Legacy"})
        assert legacy.status_code == 200
        assert legacy.json()["text_revision"] == 3
        unchanged = await client.put(
            f"/api/chats/{CHAT_ID}/text",
            json={"text": "Legacy"},
            headers={"If-Match": legacy.headers["text-etag"]},
        )
        assert unchanged.json() == legacy.json()
        assert unchanged.headers["etag"] == legacy.headers["etag"]


@pytest.mark.anyio
async def test_validator_scope_and_delete_recreate_aba(tmp_path: Path) -> None:
    async with client_for(transcribing_engine, Settings(data_directory=tmp_path)) as client:
        original = await client.put(f"/api/chats/{CHAT_ID}")
        wrong_scope = await client.put(
            f"/api/chats/{CHAT_ID}/text",
            json={"text": "wrong"},
            headers={"If-Match": original.headers["etag"]},
        )
        assert wrong_scope.status_code == 412
        weak = await client.put(
            f"/api/chats/{CHAT_ID}/text",
            json={"text": "weak"},
            headers={"If-Match": "W/" + original.headers["text-etag"]},
        )
        assert weak.status_code == 412
        assert (await client.delete(f"/api/chats/{CHAT_ID}")).status_code == 204
        recreated = await client.put(f"/api/chats/{CHAT_ID}")
        assert recreated.json()["revision"] == original.json()["revision"]
        assert recreated.headers["etag"] != original.headers["etag"]
        assert recreated.headers["text-etag"] != original.headers["text-etag"]
        assert (
            await client.delete(
                f"/api/chats/{CHAT_ID}",
                headers={"If-Match": original.headers["etag"]},
            )
        ).status_code == 412
        assert (
            await client.put(
                f"/api/chats/{CHAT_ID}/text",
                json={"text": "old incarnation"},
                headers={"If-Match": original.headers["text-etag"]},
            )
        ).status_code == 412
        assert (await client.get(f"/api/chats/{CHAT_ID}/text")).json()["text"] == ""


@pytest.mark.anyio
async def test_concurrent_retryable_creates_and_uploads(tmp_path: Path) -> None:
    async with client_for(transcribing_engine, Settings(data_directory=tmp_path)) as client:
        created = await asyncio.gather(*(client.put(f"/api/chats/{CHAT_ID}") for _ in range(5)))
        assert sorted(response.status_code for response in created) == [200, 200, 200, 200, 201]
        assert all(response.json() == created[0].json() for response in created)
        assert len((await client.get("/api/chats")).json()) == 1
        responses = await asyncio.gather(
            *(
                client.put(
                    f"/api/chats/{CHAT_ID}/recordings/{RECORDING_ID}",
                    content=make_wav(),
                    headers=AUDIO_HEADERS,
                )
                for _ in range(5)
            )
        )
        assert all(response.status_code == 200 for response in responses)
        assert all(response.json() == responses[0].json() for response in responses)
        chat = await client.get(f"/api/chats/{CHAT_ID}")
        assert len(chat.json()["recordings"]) == 1
        assert chat.json()["revision"] == 2
        assert (tmp_path / CHAT_ID / f"{RECORDING_ID}.wav").read_bytes() == make_wav()
        assert (
            await client.get(f"/api/chats/{CHAT_ID}/recordings/{RECORDING_ID}")
        ).content == make_wav()
        retry = await client.put(f"/api/chats/{CHAT_ID}")
        assert retry.json() == chat.json()  # Creation retry does not reset a resource.
        assert (
            await client.put(f"/api/chats/{CHAT_ID}", json={"text": "ignored?"})
        ).status_code == 422


@pytest.mark.anyio
async def test_concurrent_different_uploads_preserve_winner_audio(tmp_path: Path) -> None:
    async with client_for(transcribing_engine, Settings(data_directory=tmp_path)) as client:
        await client.put(f"/api/chats/{CHAT_ID}")
        payloads = [make_wav(frames=160), make_wav(frames=320)]
        responses = await asyncio.gather(
            *(
                client.put(
                    f"/api/chats/{CHAT_ID}/recordings/{RECORDING_ID}",
                    content=audio,
                    headers=AUDIO_HEADERS,
                )
                for audio in payloads
            )
        )
        assert sorted(response.status_code for response in responses) == [200, 409]
        winner = next(
            index for index, response in enumerate(responses) if response.status_code == 200
        )
        loser = responses[1 - winner]
        assert loser.json()["code"] == "idempotency_conflict"
        expected = payloads[winner]
        assert (tmp_path / CHAT_ID / f"{RECORDING_ID}.wav").read_bytes() == expected
        assert (
            await client.get(f"/api/chats/{CHAT_ID}/recordings/{RECORDING_ID}")
        ).content == expected
        assert len((await client.get(f"/api/chats/{CHAT_ID}")).json()["recordings"]) == 1
        engine = open_engine(tmp_path / DATABASE_NAME)
        try:
            with session_scope(engine) as session:
                row = session.get(RecordingRow, RECORDING_ID)
                assert row is not None
                assert row.audio_sha256 == hashlib.sha256(expected).hexdigest()
        finally:
            engine.dispose()


def test_inaccessible_chosen_chat_id_conflicts(service: ChatService) -> None:
    chat = service.create_with_id(LOCAL_USER_ID, CHAT_ID)[0]
    with session_scope(service.engine, write=True) as session:
        session.add(UserRow(id="other", created=datetime.now(UTC)))
        membership = session.get(ChatMemberRow, (chat.id, LOCAL_USER_ID))
        assert membership is not None
        session.delete(membership)
    with pytest.raises(ApiFailure) as caught:
        service.create_with_id(LOCAL_USER_ID, chat.id)
    assert caught.value.code == "idempotency_conflict"


@pytest.mark.parametrize("missing", [False, True])
def test_retry_legacy_hash_is_recovered_without_overwriting(
    service: ChatService, missing: bool
) -> None:
    service.create_with_id(LOCAL_USER_ID, CHAT_ID)
    original = make_wav()
    service.add_recording(LOCAL_USER_ID, CHAT_ID, original, 0.01, RECORDING_ID)
    with session_scope(service.engine, write=True) as session:
        row = session.get(RecordingRow, RECORDING_ID)
        assert row is not None
        row.audio_sha256 = None
    path = service.root / CHAT_ID / f"{RECORDING_ID}.wav"
    if missing:
        path.unlink()
        with pytest.raises(ApiFailure) as caught:
            service.add_recording(LOCAL_USER_ID, CHAT_ID, original, 0.01, RECORDING_ID)
        assert caught.value.code == "recording_not_found"
        assert not path.exists()
        path.write_bytes(original)
    retry = service.add_recording(LOCAL_USER_ID, CHAT_ID, original, 0.01, RECORDING_ID)
    assert retry.id == RECORDING_ID
    with pytest.raises(ApiFailure) as caught:
        service.add_recording(LOCAL_USER_ID, CHAT_ID, make_wav(frames=320), 0.02, RECORDING_ID)
    assert caught.value.code == "idempotency_conflict"
    assert path.read_bytes() == original
    with session_scope(service.engine) as session:
        row = session.get(RecordingRow, RECORDING_ID)
        assert row is not None
        assert row.audio_sha256 == hashlib.sha256(original).hexdigest()


def test_upload_commit_failure_then_orphan_retry(service: ChatService) -> None:
    service.create_with_id(LOCAL_USER_ID, CHAT_ID)
    path = service.root / CHAT_ID / f"{RECORDING_ID}.wav"

    def fail_insert(_connection, _cursor, statement, _parameters, _context, _executemany):
        if statement.startswith("INSERT INTO recordings"):
            assert path.read_bytes() == make_wav()  # failure after durable finalization
            raise RuntimeError("interrupted before commit")

    event.listen(service.engine, "before_cursor_execute", fail_insert)
    try:
        with pytest.raises(RuntimeError, match="interrupted"):
            service.add_recording(LOCAL_USER_ID, CHAT_ID, make_wav(), 0.01, RECORDING_ID)
    finally:
        event.remove(service.engine, "before_cursor_execute", fail_insert)
    assert service.get(LOCAL_USER_ID, CHAT_ID).recordings == []
    assert not path.exists()
    # A process crash can leave the finalized file, with no committed recording row.
    path.write_bytes(b"orphan from an interrupted attempt")
    recording = service.add_recording(LOCAL_USER_ID, CHAT_ID, make_wav(), 0.01, RECORDING_ID)
    assert recording.id == RECORDING_ID
    assert path.read_bytes() == make_wav()
    assert list(path.parent.glob("*.wav")) == [path]
    assert list(path.parent.glob("*.tmp")) == []
    assert len(service.get(LOCAL_USER_ID, CHAT_ID).recordings) == 1


def test_upload_delete_and_recreate_serialize_file_cleanup(service: ChatService) -> None:
    service.create_with_id(LOCAL_USER_ID, CHAT_ID)
    entered, release = Event(), Event()
    from diktator.chats import finalize_audio

    def paused_finalize(path: Path, audio: bytes) -> None:
        entered.set()
        assert release.wait(5)
        finalize_audio(path, audio)

    with ThreadPoolExecutor(2) as pool, patch("diktator.chats.finalize_audio", paused_finalize):
        uploading = pool.submit(
            service.add_recording, LOCAL_USER_ID, CHAT_ID, make_wav(), 0.01, RECORDING_ID
        )
        assert entered.wait(5)
        deleting = pool.submit(service.delete, LOCAL_USER_ID, CHAT_ID)
        assert not deleting.done()
        release.set()
        uploading.result()
        deleting.result()
    assert not (service.root / CHAT_ID).exists()
    service.create_with_id(LOCAL_USER_ID, CHAT_ID)
    service.add_recording(LOCAL_USER_ID, CHAT_ID, make_wav(frames=320), 0.02, RECORDING_ID)
    assert (service.root / CHAT_ID / f"{RECORDING_ID}.wav").read_bytes() == make_wav(frames=320)
