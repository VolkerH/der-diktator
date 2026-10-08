"""Legacy import and conservative recording reconciliation acceptance tests."""

import json
from datetime import UTC
from pathlib import Path
from unittest.mock import patch

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from diktator.app import create_app
from diktator.chats import ChatService, RecordingNotFound
from diktator.config import Settings
from diktator.db import (
    DATABASE_NAME,
    open_engine,
    session_scope,
    upgrade_schema,
)
from diktator.db.legacy import import_legacy, sweep_orphans
from diktator.db.rows import (
    LOCAL_USER_ID,
    ChatMemberRow,
    LegacyImportRow,
    RecordingRow,
)
from tests.storage_helpers import legacy_chat
from tests.test_audio import make_wav


def test_legacy_import_preserves_every_field_and_baseline(service: ChatService) -> None:
    chat = legacy_chat(service.root)
    original = (service.root / chat.id / "chat.json").read_bytes()
    import_legacy(service.engine, service.root)
    assert service.get(LOCAL_USER_ID, chat.id) == chat
    assert service.recording_audio(LOCAL_USER_ID, chat.id, chat.recordings[0].id) == make_wav()
    service.update_text(LOCAL_USER_ID, chat.id, "edited")
    import_legacy(service.engine, service.root)
    with session_scope(service.engine) as session:
        markers = list(session.scalars(select(LegacyImportRow)))
        assert len(markers) == 1
        assert markers[0].baseline_text == chat.text
        assert markers[0].source == f"{chat.id}/chat.json"
        assert markers[0].imported_at.tzinfo == UTC
    assert (service.root / chat.id / "chat.json").read_bytes() == original
    assert service.get(LOCAL_USER_ID, chat.id).text == "edited"


def test_deleted_import_is_not_resurrected_even_if_folder_restored(service: ChatService) -> None:
    chat = legacy_chat(service.root)
    import_legacy(service.engine, service.root)
    service.delete(LOCAL_USER_ID, chat.id)
    legacy_chat(service.root)
    import_legacy(service.engine, service.root)
    sweep_orphans(service.engine, service.root)
    assert service.list(LOCAL_USER_ID) == []
    assert not (service.root / chat.id / f"{chat.recordings[0].id}.wav").exists()


@pytest.mark.anyio
async def test_missing_wav_metadata_survives_restart_and_restoration(tmp_path: Path) -> None:
    chat = legacy_chat(tmp_path, missing=True)
    settings = Settings(data_directory=tmp_path)
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        engine = open_engine(tmp_path / DATABASE_NAME)
        service = ChatService(tmp_path, engine)
        assert service.get(LOCAL_USER_ID, chat.id).recordings == chat.recordings
        with pytest.raises(RecordingNotFound):
            service.recording_audio(LOCAL_USER_ID, chat.id, chat.recordings[0].id)
        engine.dispose()
    path = tmp_path / chat.id / f"{chat.recordings[0].id}.wav"
    path.write_bytes(make_wav())
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        engine = open_engine(tmp_path / DATABASE_NAME)
        try:
            service = ChatService(tmp_path, engine)
            assert (
                service.recording_audio(LOCAL_USER_ID, chat.id, chat.recordings[0].id) == make_wav()
            )
        finally:
            engine.dispose()
    assert path.exists()


@pytest.mark.parametrize("invalid", ["json", "chat_id", "recording_id", "naive", "duplicate"])
def test_corrupt_import_protects_audio_from_sweep(service: ChatService, invalid: str) -> None:
    chat = legacy_chat(service.root)
    source = service.root / chat.id / "chat.json"
    data = chat.model_dump(mode="json")
    if invalid == "json":
        source.write_text("{bad")
    else:
        if invalid == "chat_id":
            data["id"] = "c" * 32
        elif invalid == "recording_id":
            data["recordings"][0]["id"] = "../escape"
        elif invalid == "naive":
            data["created"] = "2021-01-02T03:04:05"
        elif invalid == "duplicate":
            data["recordings"].append(data["recordings"][0])
        source.write_text(json.dumps(data))
    orphan = source.parent / "orphan.wav"
    orphan.write_bytes(b"recoverable")
    temp = source.parent / "recoverable.wav.tmp"
    temp.write_bytes(b"recoverable")
    import_legacy(service.engine, service.root)
    sweep_orphans(service.engine, service.root)
    assert service.list(LOCAL_USER_ID) == []
    assert orphan.exists() and temp.exists()


def test_interrupted_import_rolls_back_whole_chat(service: ChatService) -> None:
    chat = legacy_chat(service.root)
    real_add = Session.add

    def interrupt(session: Session, row: object, **kwargs: object) -> None:
        if isinstance(row, LegacyImportRow):
            raise RuntimeError("interrupted before marker")
        real_add(session, row)

    with patch.object(Session, "add", interrupt), pytest.raises(RuntimeError, match="interrupted"):
        import_legacy(service.engine, service.root)
    assert service.list(LOCAL_USER_ID) == []
    with session_scope(service.engine) as session:
        assert session.scalars(select(RecordingRow)).all() == []
        assert session.scalars(select(ChatMemberRow)).all() == []
        assert session.scalars(select(LegacyImportRow)).all() == []
    import_legacy(service.engine, service.root)
    assert service.get(LOCAL_USER_ID, chat.id) == chat


def test_failed_new_chat_delete_cleanup_is_logged_and_preserved(
    service: ChatService, caplog: pytest.LogCaptureFixture
) -> None:
    chat = service.create(LOCAL_USER_ID)
    recording = service.add_recording(LOCAL_USER_ID, chat.id, make_wav(), 0.01)
    path = service.root / chat.id / f"{recording.id}.wav"
    with patch("diktator.chats.shutil.rmtree", side_effect=OSError("unlink failed")):
        service.delete(LOCAL_USER_ID, chat.id)
    assert "cleanup failed" in caplog.text
    assert path.exists()
    sweep_orphans(service.engine, service.root)
    assert path.exists()
    assert "Preserving unknown chat folder" in caplog.text
    assert service.list(LOCAL_USER_ID) == []


def test_unknown_wav_only_folder_survives_startup(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    folder = tmp_path / ("c" * 32)
    folder.mkdir()
    audio = folder / "recoverable.wav"
    temporary = folder / "recoverable.wav.tmp"
    audio.write_bytes(b"original audio")
    temporary.write_bytes(b"partial audio")
    engine = open_engine(tmp_path / DATABASE_NAME)
    try:
        upgrade_schema(engine, tmp_path)
        import_legacy(engine, tmp_path)
        sweep_orphans(engine, tmp_path)
        assert audio.read_bytes() == b"original audio"
        assert temporary.read_bytes() == b"partial audio"
    finally:
        engine.dispose()
    assert "Preserving unknown chat folder" in caplog.text


def test_failed_imported_chat_delete_cleanup_is_swept(service: ChatService) -> None:
    chat = legacy_chat(service.root)
    import_legacy(service.engine, service.root)
    path = service.root / chat.id / f"{chat.recordings[0].id}.wav"
    with patch("diktator.chats.shutil.rmtree", side_effect=OSError("unlink failed")):
        service.delete(LOCAL_USER_ID, chat.id)
    assert path.exists()
    sweep_orphans(service.engine, service.root)
    assert not path.exists()
    assert service.list(LOCAL_USER_ID) == []


def test_cleanup_errors_are_logged_without_failing_startup(
    service: ChatService, caplog: pytest.LogCaptureFixture
) -> None:
    chat = service.create(LOCAL_USER_ID)
    folder = service.root / chat.id
    folder.mkdir()
    temporary = folder / "abandoned.wav.tmp"
    temporary.write_bytes(b"abandoned")
    with patch.object(Path, "unlink", side_effect=OSError("filesystem refused unlink")):
        sweep_orphans(service.engine, service.root)
    assert "Cannot remove abandoned recording" in caplog.text
    assert temporary.exists()
    sweep_orphans(service.engine, service.root)
    assert not temporary.exists()
