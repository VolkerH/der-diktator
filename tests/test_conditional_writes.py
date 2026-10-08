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


@pytest.mark.anyio
async def test_concurrent_conditional_text_saves_have_one_winner(tmp_path: Path) -> None:
    async with client_for(transcribing_engine, Settings(data_directory=tmp_path)) as client:
        created = await client.put(f"/api/chats/{CHAT_ID}")
        responses = await asyncio.gather(
            *(
                client.put(
                    f"/api/chats/{CHAT_ID}/text",
                    json={"text": text},
                    headers={"If-Match": created.headers["text-etag"]},
                )
                for text in ["First client", "Second client"]
            )
        )
        assert sorted(response.status_code for response in responses) == [200, 412]
        winner = next(response for response in responses if response.status_code == 200)
        assert (await client.get(f"/api/chats/{CHAT_ID}")).json() == winner.json()


@pytest.mark.anyio
async def test_inaccessible_create_and_cross_chat_recording_collision_over_http(
    tmp_path: Path,
) -> None:
    async with client_for(transcribing_engine, Settings(data_directory=tmp_path)) as client:
        await client.put(f"/api/chats/{CHAT_ID}")
        await client.put(
            f"/api/chats/{CHAT_ID}/recordings/{RECORDING_ID}",
            content=make_wav(),
            headers=AUDIO_HEADERS,
        )
        another = "e" * 32
        await client.put(f"/api/chats/{another}")
        collision = await client.put(
            f"/api/chats/{another}/recordings/{RECORDING_ID}",
            content=make_wav(),
            headers=AUDIO_HEADERS,
        )
        assert collision.status_code == 409
        assert collision.json()["code"] == "idempotency_conflict"
        assert not (tmp_path / another).exists()
        assert (tmp_path / CHAT_ID / f"{RECORDING_ID}.wav").read_bytes() == make_wav()
        engine = open_engine(tmp_path / DATABASE_NAME)
        try:
            with session_scope(engine, write=True) as session:
                membership = session.get(ChatMemberRow, (CHAT_ID, LOCAL_USER_ID))
                assert membership is not None
                session.delete(membership)
            inaccessible = await client.put(f"/api/chats/{CHAT_ID}")
            assert inaccessible.status_code == 409
            assert inaccessible.json()["code"] == "idempotency_conflict"
        finally:
            engine.dispose()


@pytest.mark.anyio
async def test_validators_persist_across_application_restart(tmp_path: Path) -> None:
    settings = Settings(data_directory=tmp_path)
    async with client_for(transcribing_engine, settings) as client:
        original = await client.put(f"/api/chats/{CHAT_ID}")
    async with client_for(transcribing_engine, settings) as client:
        reopened = await client.get(f"/api/chats/{CHAT_ID}")
        assert reopened.headers["etag"] == original.headers["etag"]
        assert reopened.headers["text-etag"] == original.headers["text-etag"]
        accepted = await client.put(
            f"/api/chats/{CHAT_ID}/text",
            json={"text": "After restart"},
            headers={"If-Match": original.headers["text-etag"]},
        )
        assert accepted.status_code == 200


def test_baseline_upgrade_preserves_rows_and_populates_incarnations(tmp_path: Path) -> None:
    import shutil
    import sqlite3

    fixture = Path(__file__).parent / "fixtures" / "database" / "0001.sqlite3"
    shutil.copyfile(fixture, tmp_path / DATABASE_NAME)
    with sqlite3.connect(tmp_path / DATABASE_NAME) as old:
        old.execute(
            "INSERT INTO chats VALUES (?, ?, ?, ?, ?)",
            (CHAT_ID, "2026-10-07 10:00:00", "2026-10-07 11:00:00", "Preserved", LOCAL_USER_ID),
        )
        old.execute("INSERT INTO chat_members VALUES (?, ?, ?)", (CHAT_ID, LOCAL_USER_ID, "owner"))
        old.execute(
            "INSERT INTO recordings VALUES (?, ?, ?, ?, ?)",
            (RECORDING_ID, CHAT_ID, "2026-10-07 10:30:00", 0.01, f"{CHAT_ID}/{RECORDING_ID}.wav"),
        )
    engine = open_engine(tmp_path / DATABASE_NAME)
    try:
        upgrade_schema(engine, tmp_path)
        service = ChatService(tmp_path, engine)
        chat = service.get(LOCAL_USER_ID, CHAT_ID)
        assert chat.text == "Preserved"
        assert chat.created == datetime(2026, 10, 7, 10, tzinfo=UTC)
        assert chat.updated == datetime(2026, 10, 7, 11, tzinfo=UTC)
        assert len(chat.recordings) == 1
        assert chat.recordings[0].id == RECORDING_ID
        assert chat.revision == chat.text_revision == 1
        with session_scope(engine) as session:
            from diktator.db.rows import ChatRow

            row = session.get(ChatRow, CHAT_ID)
            assert row is not None
            assert len(row.incarnation) == 32
            recording = session.get(RecordingRow, RECORDING_ID)
            assert recording is not None
            assert recording.audio_sha256 is None
        backups = list((tmp_path / "backups").glob("*.sqlite3"))
        assert len(backups) == 1
        with sqlite3.connect(backups[0]) as backup:
            assert backup.execute("SELECT version_num FROM alembic_version").fetchone() == ("0001",)
            assert backup.execute("SELECT text FROM chats").fetchone() == ("Preserved",)
        upgrade_schema(engine, tmp_path)
        assert service.get(LOCAL_USER_ID, CHAT_ID).etag == chat.etag
        assert list((tmp_path / "backups").glob("*.sqlite3")) == backups
    finally:
        engine.dispose()


def test_recreation_waits_for_old_folder_cleanup(service: ChatService) -> None:
    import shutil

    original = service.create_with_id(LOCAL_USER_ID, CHAT_ID)[0]
    service.add_recording(LOCAL_USER_ID, CHAT_ID, make_wav(), 0.01, RECORDING_ID)
    entered, release = Event(), Event()
    real_remove = shutil.rmtree

    def paused_remove(folder: Path) -> None:
        entered.set()
        assert release.wait(5)
        real_remove(folder)

    def recreate_and_upload() -> None:
        recreated, created = service.create_with_id(LOCAL_USER_ID, CHAT_ID)
        assert created
        assert recreated.etag != original.etag
        service.add_recording(LOCAL_USER_ID, CHAT_ID, make_wav(frames=320), 0.02, RECORDING_ID)

    with ThreadPoolExecutor(2) as pool, patch("diktator.chats.shutil.rmtree", paused_remove):
        deleting = pool.submit(service.delete, LOCAL_USER_ID, CHAT_ID)
        assert entered.wait(5)
        recreating = pool.submit(recreate_and_upload)
        assert not recreating.done()
        release.set()
        deleting.result()
        recreating.result()
    assert len(service.get(LOCAL_USER_ID, CHAT_ID).recordings) == 1
    assert (service.root / CHAT_ID / f"{RECORDING_ID}.wav").read_bytes() == make_wav(frames=320)


@pytest.mark.anyio
async def test_list_validators_protect_sidebar_deletion(tmp_path: Path) -> None:
    async with client_for(transcribing_engine, Settings(data_directory=tmp_path)) as client:
        created = await client.put(f"/api/chats/{CHAT_ID}")
        listed = (await client.get("/api/chats")).json()[0]
        assert listed["etag"] == created.headers["etag"]
        await client.put(f"/api/chats/{CHAT_ID}/text", json={"text": "Changed since list read"})
        rejected = await client.delete(
            f"/api/chats/{CHAT_ID}", headers={"If-Match": listed["etag"]}
        )
        assert rejected.status_code == 412
        assert rejected.json()["code"] == "revision_conflict"
        fresh = (await client.get("/api/chats")).json()[0]
        assert fresh["etag"] != listed["etag"]
        assert (
            await client.delete(f"/api/chats/{CHAT_ID}", headers={"If-Match": fresh["etag"]})
        ).status_code == 204


@pytest.mark.anyio
@pytest.mark.parametrize("method", ["POST", "PUT"])
async def test_upload_parent_validator_is_an_atomic_snapshot(tmp_path: Path, method: str) -> None:
    original_upload = ChatService.upload_recording
    captured = []

    def upload_then_edit(self, *args, **kwargs):
        result = original_upload(self, *args, **kwargs)
        captured.append(result)
        # Another mutation completes before the route serializes its response. A separate
        # header reread would silently return the wrong revision for this upload snapshot.
        self.update_text(LOCAL_USER_ID, CHAT_ID, f"Later text {len(captured)}")
        return result

    async with client_for(transcribing_engine, Settings(data_directory=tmp_path)) as client:
        created = await client.put(f"/api/chats/{CHAT_ID}")
        route = f"/api/chats/{CHAT_ID}/recordings"
        if method == "PUT":
            route += f"/{RECORDING_ID}"
        with patch.object(ChatService, "upload_recording", upload_then_edit):
            response = await client.request(
                method, route, content=make_wav(), headers=AUDIO_HEADERS
            )
            assert response.status_code == (201 if method == "POST" else 200)
            assert response.json()["id"] == captured[0].recording.id
            assert response.headers["chat-etag"] == captured[0].chat_etag
            assert response.headers["chat-etag"] != created.headers["etag"]
            assert "etag" not in response.headers  # Recording is not a Chat representation.
            assert "text-etag" not in response.headers  # Uploads never acknowledge client text.
            current = await client.get(f"/api/chats/{CHAT_ID}")
            assert current.headers["etag"] != response.headers["chat-etag"]
            if method == "PUT":
                retry = await client.put(route, content=make_wav(), headers=AUDIO_HEADERS)
                assert retry.status_code == 200
                assert retry.json() == response.json()
                assert retry.headers["chat-etag"] == current.headers["etag"]
                assert retry.headers["chat-etag"] == captured[1].chat_etag
        stale = await client.put(
            f"/api/chats/{CHAT_ID}/text",
            json={"text": "Old draft"},
            headers={"If-Match": created.headers["text-etag"]},
        )
        assert stale.status_code == 412


@pytest.mark.anyio
async def test_legacy_recording_identity_is_publicly_retryable(tmp_path: Path) -> None:
    async with client_for(transcribing_engine, Settings(data_directory=tmp_path)) as client:
        await client.put(f"/api/chats/{CHAT_ID}")
        uploaded = await client.put(
            f"/api/chats/{CHAT_ID}/recordings/{RECORDING_ID}",
            content=make_wav(),
            headers=AUDIO_HEADERS,
        )
        engine = open_engine(tmp_path / DATABASE_NAME)
        try:
            with session_scope(engine, write=True) as session:
                row = session.get(RecordingRow, RECORDING_ID)
                assert row is not None
                row.audio_sha256 = None  # Same nullable identity as an imported recording.
            chat = await client.get(f"/api/chats/{CHAT_ID}")
            visible_id = chat.json()["recordings"][0]["id"]
            retry = await client.put(
                f"/api/chats/{CHAT_ID}/recordings/{visible_id}",
                content=make_wav(),
                headers=AUDIO_HEADERS,
            )
            assert retry.status_code == 200
            assert retry.json() == uploaded.json()
            assert retry.headers["chat-etag"] == chat.headers["etag"]
            assert (await client.get(f"/api/chats/{CHAT_ID}")).json() == chat.json()
            with session_scope(engine) as session:
                row = session.get(RecordingRow, visible_id)
                assert row is not None
                assert row.audio_sha256 == hashlib.sha256(make_wav()).hexdigest()
        finally:
            engine.dispose()
