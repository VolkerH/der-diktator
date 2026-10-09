"""Chats persist transcripts and recordings in the configured directory."""

from pathlib import Path

import httpx
import pytest
from platformdirs import user_data_path

from diktator.chats import ChatNotFound, ChatService, title_for
from diktator.config import Settings, default_data_directory, migrate_chats
from diktator.db import open_engine, upgrade_schema
from diktator.db.legacy import import_legacy
from diktator.db.rows import LOCAL_USER_ID
from diktator.recording_policy import RecordingPolicy
from tests.test_app import client_for
from tests.test_audio import make_wav

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def transcribing_engine(request: httpx.Request) -> httpx.Response:
    if request.url.path == "/transcribe":
        return httpx.Response(200, json={"text": "From the stored audio."})
    return httpx.Response(200, json={"status": "ok", "model": "phonon-2"})


async def test_chat_lifecycle_keeps_text_and_audio_on_disk(tmp_path: Path) -> None:
    settings = Settings(data_directory=tmp_path / "chats")
    async with client_for(transcribing_engine, settings) as client:
        assert (await client.get("/api/chats")).json() == []
        created = await client.post("/api/chats")
        assert created.status_code == 201
        chat_id = created.json()["id"]

        audio = make_wav()
        upload = await client.post(
            f"/api/chats/{chat_id}/recordings",
            content=audio,
            headers={"Content-Type": "audio/wav"},
        )
        assert upload.status_code == 201
        recording = upload.json()
        assert recording["duration_seconds"] == 0.01

        saved = await client.put(
            f"/api/chats/{chat_id}/text", json={"text": "Hello  there\nfriend"}
        )
        assert saved.json()["text"] == "Hello  there\nfriend"

        chats = (await client.get("/api/chats")).json()
        assert [(chat["id"], chat["title"], chat["recording_count"]) for chat in chats] == [
            (chat_id, "Hello there friend", 1)
        ]
        chat = (await client.get(f"/api/chats/{chat_id}")).json()
        assert chat["recordings"] == [recording]

        stored = await client.get(f"/api/chats/{chat_id}/recordings/{recording['id']}")
        assert stored.headers["content-type"] == "audio/wav"
        assert stored.content == audio
        transcription = await client.post(
            f"/api/chats/{chat_id}/recordings/{recording['id']}/transcribe"
        )
        assert transcription.json() == {"text": "From the stored audio."}

    # A new application instance reads the same chats back.
    async with client_for(transcribing_engine, settings) as client:
        assert (await client.get(f"/api/chats/{chat_id}")).json()["text"] == "Hello  there\nfriend"
        assert (await client.delete(f"/api/chats/{chat_id}")).status_code == 204
        assert (await client.get(f"/api/chats/{chat_id}")).status_code == 404
        assert (await client.get("/api/chats")).json() == []
    assert not (tmp_path / "chats" / chat_id).exists()


async def test_invalid_requests_do_not_touch_storage(tmp_path: Path) -> None:
    settings = Settings(data_directory=tmp_path, max_text_characters=5)
    missing = "0" * 32
    async with client_for(transcribing_engine, settings) as client:
        assert (await client.get("/api/chats/..%2F..%2Fetc")).status_code in {404, 422}
        assert (await client.get(f"/api/chats/{missing}")).status_code == 404
        assert (await client.delete(f"/api/chats/{missing}")).status_code == 404
        chat_id = (await client.post("/api/chats")).json()["id"]
        too_long = await client.put(f"/api/chats/{chat_id}/text", json={"text": "123456"})
        assert too_long.status_code == 422
        bad_audio = await client.post(
            f"/api/chats/{chat_id}/recordings",
            content=b"not audio",
            headers={"Content-Type": "audio/wav"},
        )
        assert bad_audio.status_code == 400
        unknown = await client.post(f"/api/chats/{chat_id}/recordings/{missing}/transcribe")
        assert unknown.status_code == 404
        assert (await client.get(f"/api/chats/{chat_id}")).json()["recordings"] == []


def test_unreadable_chats_are_skipped_and_identifiers_are_strict(tmp_path: Path) -> None:
    engine = open_engine(tmp_path / "diktator.sqlite3")
    upgrade_schema(engine, tmp_path)
    store = ChatService(tmp_path, engine)
    chat = store.create(LOCAL_USER_ID)
    (tmp_path / ("a" * 32)).mkdir()
    (tmp_path / ("a" * 32) / "chat.json").write_text("{broken")
    import_legacy(engine, tmp_path)
    assert [summary.id for summary in store.list(LOCAL_USER_ID)] == [chat.id]
    with pytest.raises(ChatNotFound):
        store.get(LOCAL_USER_ID, "../" + chat.id)
    engine.dispose()


def test_titles_and_default_location() -> None:
    assert title_for("  ") == "New chat"
    assert title_for("word " * 20) == " ".join(["word"] * 9) + "…"
    assert default_data_directory() == user_data_path("diktator", appauthor=False) / "chats"


def test_storage_location_can_be_configured(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("DIKTATOR_DATA_DIR", str(tmp_path / "env"))
    assert Settings.from_environment().data_directory == tmp_path / "env"
    assert Settings.from_environment(tmp_path / "flag").data_directory == tmp_path / "flag"


def test_legacy_chats_move_once_without_overwriting(tmp_path: Path) -> None:
    legacy = tmp_path / ".phonon" / "chats"
    (legacy / "a").mkdir(parents=True)
    target = tmp_path / ".diktator" / "chats"
    assert migrate_chats(legacy, target)
    assert (target / "a").is_dir()
    assert not legacy.parent.exists(), "the emptied legacy folder is removed"
    legacy.mkdir(parents=True)
    assert not migrate_chats(legacy, target), "an existing target is never replaced"
    assert not migrate_chats(tmp_path / "missing", tmp_path / "new")


def test_legacy_folder_with_other_files_is_kept(tmp_path: Path) -> None:
    legacy = tmp_path / ".phonon" / "chats"
    legacy.mkdir(parents=True)
    (tmp_path / ".phonon" / "notes.txt").write_text("keep me")
    assert migrate_chats(legacy, tmp_path / "data" / "chats")
    assert (tmp_path / ".phonon" / "notes.txt").read_text() == "keep me"


async def test_missing_chat_and_recording_have_distinct_errors_and_restored_audio_works(
    tmp_path: Path,
) -> None:
    missing = "0" * 32
    async with client_for(transcribing_engine, Settings(data_directory=tmp_path)) as client:
        for suffix in ("", "/transcribe"):
            response = await client.request(
                "POST" if suffix else "GET", f"/api/chats/{missing}/recordings/{missing}{suffix}"
            )
            assert response.status_code == 404
            assert response.json() == {
                "detail": "This chat no longer exists.",
                "code": "chat_not_found",
            }
        chat_id = (await client.post("/api/chats")).json()["id"]
        for suffix in ("", "/transcribe"):
            response = await client.request(
                "POST" if suffix else "GET", f"/api/chats/{chat_id}/recordings/{missing}{suffix}"
            )
            assert response.status_code == 404
            assert response.json() == {
                "detail": "This recording no longer exists.",
                "code": "recording_not_found",
            }
        recording_id = (
            await client.post(
                f"/api/chats/{chat_id}/recordings",
                content=make_wav(),
                headers={"Content-Type": "audio/wav"},
            )
        ).json()["id"]
        audio_path = tmp_path / chat_id / f"{recording_id}.wav"
        audio_path.unlink()
        for suffix in ("", "/transcribe"):
            response = await client.request(
                "POST" if suffix else "GET",
                f"/api/chats/{chat_id}/recordings/{recording_id}{suffix}",
            )
            assert response.status_code == 404
            assert response.json()["code"] == "recording_not_found"
        audio_path.write_bytes(make_wav())
        assert (
            await client.get(f"/api/chats/{chat_id}/recordings/{recording_id}")
        ).content == make_wav()


@pytest.mark.parametrize(
    "audio,limit,status,code",
    [
        (make_wav(rate=48_000), 600, 400, "invalid_audio"),
        (make_wav(channels=2), 600, 400, "invalid_audio"),
        (make_wav(width=1), 600, 400, "invalid_audio"),
        (make_wav()[:-1], 600, 400, "invalid_audio"),
        (make_wav(frames=960_001), 60, 400, "invalid_audio"),
    ],
    ids=["sample-rate", "stereo", "sample-width", "truncated", "duration"],
)
async def test_external_wav_attachment_validation_preserves_chat(
    tmp_path: Path, audio: bytes, limit: int, status: int, code: str
) -> None:
    settings = Settings(
        data_directory=tmp_path, recording_policy=RecordingPolicy(hard_limit_seconds=limit)
    )
    async with client_for(transcribing_engine, settings) as client:
        chat_id = (await client.post("/api/chats")).json()["id"]
        await client.put(f"/api/chats/{chat_id}/text", json={"text": "Keep text"})
        before = (await client.get(f"/api/chats/{chat_id}")).json()
        rejected = await client.put(
            f"/api/chats/{chat_id}/recordings/{'a' * 32}",
            content=audio,
            headers={"Content-Type": "audio/wav"},
        )
        assert rejected.status_code == status
        assert rejected.json()["code"] == code
        assert (await client.get(f"/api/chats/{chat_id}")).json() == before
        assert not list(tmp_path.glob("**/*.wav"))
