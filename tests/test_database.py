"""File-backed SQLite, ownership, import and file boundary acceptance tests."""

import json
import os
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path
from threading import Event
from unittest.mock import patch

import pytest
from sqlalchemy import Connection, event, select, text
from sqlalchemy.exc import StatementError
from sqlalchemy.orm import Session

from diktator.app import create_app
from diktator.chats import Chat, ChatNotFound, ChatService, Recording, RecordingNotFound
from diktator.config import Settings, migrate_chats
from diktator.db import (
    DATABASE_NAME,
    DataDirectoryLock,
    StorageInUse,
    UnknownSchema,
    open_engine,
    session_scope,
    upgrade_schema,
)
from diktator.db.legacy import import_legacy, sweep_orphans
from diktator.db.rows import (
    LOCAL_USER_ID,
    ChatMemberRow,
    ChatRow,
    LegacyImportRow,
    RecordingRow,
    UserRow,
)
from tests.test_audio import make_wav


@pytest.fixture
def service(tmp_path: Path):
    ownership = DataDirectoryLock(tmp_path)
    ownership.acquire()
    engine = open_engine(tmp_path / DATABASE_NAME)
    upgrade_schema(engine, tmp_path)
    try:
        yield ChatService(tmp_path, engine)
    finally:
        engine.dispose()
        ownership.release()


def legacy_chat(root: Path, *, missing: bool = False) -> Chat:
    created = datetime(2021, 1, 2, 3, 4, 5, 678901, tzinfo=timezone(timedelta(hours=2)))
    chat = Chat(
        id="a" * 32,
        created=created,
        updated=created + timedelta(days=1),
        text="legacy\n  transcript 🌻",
        recordings=[
            Recording(id="b" * 32, created=created + timedelta(seconds=1), duration_seconds=0.01)
        ],
    )
    folder = root / chat.id
    folder.mkdir()
    (folder / "chat.json").write_text(chat.model_dump_json())
    if not missing:
        (folder / f"{chat.recordings[0].id}.wav").write_bytes(make_wav())
    return chat


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


def test_connection_pragmas_and_read_write_transaction_policy(service: ChatService) -> None:
    with service.engine.connect() as connection:
        assert connection.exec_driver_sql("PRAGMA foreign_keys").scalar() == 1
        assert connection.exec_driver_sql("PRAGMA journal_mode").scalar() == "wal"
        assert connection.exec_driver_sql("PRAGMA synchronous").scalar() == 2
        assert connection.exec_driver_sql("PRAGMA busy_timeout").scalar() == 5000
    # A reader permits a simultaneous immediate writer, and WAL keeps its read snapshot.
    with session_scope(service.engine) as reader:
        assert reader.scalar(select(UserRow.id)) == LOCAL_USER_ID
        service.create(LOCAL_USER_ID)
    with session_scope(service.engine, write=True) as session:
        assert session.scalar(text("SELECT 1")) == 1


def test_baseline_backup_unknown_schema_and_repeated_startup(tmp_path: Path) -> None:
    engine = open_engine(tmp_path / DATABASE_NAME)
    try:
        upgrade_schema(engine, tmp_path)
        backups = list((tmp_path / "backups").glob("*.sqlite3"))
        assert len(backups) == 1
        with sqlite3.connect(backups[0]) as backup:
            assert backup.execute("PRAGMA integrity_check").fetchone() == ("ok",)
            assert (
                backup.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall() == []
            )
        upgrade_schema(engine, tmp_path)
        assert list((tmp_path / "backups").glob("*.sqlite3")) == backups
        with engine.begin() as connection:
            connection.exec_driver_sql("UPDATE alembic_version SET version_num='9999'")
        with pytest.raises(UnknownSchema, match="newer"):
            upgrade_schema(engine, tmp_path)
        assert list((tmp_path / "backups").glob("*.sqlite3")) == backups
    finally:
        engine.dispose()


def snapshot(root: Path) -> dict[str, bytes]:
    return {
        path.relative_to(root).as_posix(): path.read_bytes()
        for path in root.rglob("*")
        if path.is_file() and path.name != ".diktator.lock"
    }


@pytest.mark.anyio
async def test_second_app_refuses_before_import_or_cleanup(tmp_path: Path) -> None:
    app = create_app(Settings(data_directory=tmp_path))
    async with app.router.lifespan_context(app):
        legacy_chat(tmp_path)
        orphan = tmp_path / ("c" * 32)
        orphan.mkdir()
        (orphan / "recording.wav.tmp").write_bytes(b"untouched")
        before = snapshot(tmp_path)
        second = create_app(Settings(data_directory=tmp_path))
        with pytest.raises(StorageInUse, match="already in use"):
            async with second.router.lifespan_context(second):
                pytest.fail("second startup must be refused")
        assert snapshot(tmp_path) == before


def test_second_lock_refuses_during_upload(service: ChatService) -> None:
    from diktator.chats import finalize_audio

    chat = service.create(LOCAL_USER_ID)
    started, finish = Event(), Event()

    def paused(path: Path, audio: bytes) -> None:
        finalize_audio(path, audio)
        started.set()
        assert finish.wait(5)

    with patch("diktator.chats.finalize_audio", paused), ThreadPoolExecutor(1) as pool:
        upload = pool.submit(service.add_recording, LOCAL_USER_ID, chat.id, make_wav(), 0.01)
        try:
            assert started.wait(5)
            before = snapshot(service.root)
            with pytest.raises(StorageInUse):
                DataDirectoryLock(service.root).acquire()
            assert snapshot(service.root) == before
        finally:
            finish.set()
        assert upload.result().id == service.get(LOCAL_USER_ID, chat.id).recordings[0].id


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
    assert service.get(LOCAL_USER_ID, chat.id) == chat
    assert list((service.root / chat.id).iterdir()) == []


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


def test_legacy_move_resumes_without_replacing_ownership_inode(tmp_path: Path) -> None:
    legacy, target = tmp_path / "old" / "chats", tmp_path / "new"
    legacy.mkdir(parents=True)
    legacy_chat(legacy)
    ownership = DataDirectoryLock(target)
    ownership.acquire()
    inode = (target / ".diktator.lock").stat().st_ino
    real_rmtree = __import__("shutil").rmtree
    interrupted = False

    def interrupt(path: Path, *args: object, **kwargs: object) -> None:
        nonlocal interrupted
        if path.parent == legacy and not interrupted:
            interrupted = True
            raise OSError("interrupted after destination rename")
        real_rmtree(path)

    try:
        with (
            patch("diktator.config.shutil.rmtree", interrupt),
            pytest.raises(OSError, match="interrupted"),
        ):
            migrate_chats(legacy, target)
        assert (target / ".legacy-migration.json").exists()
        with pytest.raises(StorageInUse):
            DataDirectoryLock(target).acquire()
        assert migrate_chats(legacy, target)
        assert (target / ".diktator.lock").stat().st_ino == inode
        assert (target / ("a" * 32) / "chat.json").exists()
        assert not legacy.exists()
        assert not (target / ".legacy-migration.json").exists()
    finally:
        ownership.release()


def test_openapi_inspection_does_not_create_storage(tmp_path: Path) -> None:
    root = tmp_path / "absent"
    app = create_app(Settings(data_directory=root))
    assert app.openapi()["info"]["title"] == "Der Diktator"
    assert not root.exists()


def test_lock_excludes_another_process(service: ChatService) -> None:
    import subprocess
    import sys

    result = subprocess.run(
        [
            sys.executable,
            "-c",
            """
import sys
from pathlib import Path
from diktator.db import DataDirectoryLock, StorageInUse
try:
    DataDirectoryLock(Path(sys.argv[1])).acquire()
except StorageInUse as error:
    print(error)
    sys.exit(23)
sys.exit(0)
""",
            str(service.root),
        ],
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    assert result.returncode == 23
    assert "already in use" in result.stdout


@pytest.mark.anyio
async def test_failed_startup_disposes_database_and_releases_lock(tmp_path: Path) -> None:
    from sqlalchemy import Engine

    disposed = []
    real_dispose = Engine.dispose

    def dispose(engine: Engine, close: bool = True) -> None:
        disposed.append(engine)
        real_dispose(engine, close)

    app = create_app(Settings(data_directory=tmp_path))
    with (
        patch("diktator.app.upgrade_schema", side_effect=RuntimeError("upgrade failed")),
        patch.object(Engine, "dispose", dispose),
        pytest.raises(RuntimeError, match="upgrade failed"),
    ):
        async with app.router.lifespan_context(app):
            pytest.fail("failed upgrade cannot serve requests")
    assert len(disposed) == 1
    next_app = create_app(Settings(data_directory=tmp_path))
    async with next_app.router.lifespan_context(next_app):
        pass
    lock = DataDirectoryLock(tmp_path)
    lock.acquire()
    lock.release()


def test_backup_contains_existing_data_before_baseline_upgrade(tmp_path: Path) -> None:
    path = tmp_path / DATABASE_NAME
    with sqlite3.connect(path) as connection:
        connection.execute("CREATE TABLE recovery_note (text TEXT)")
        connection.execute("INSERT INTO recovery_note VALUES ('kept before migration')")
    engine = open_engine(path)
    try:
        upgrade_schema(engine, tmp_path)
        backup_path = next((tmp_path / "backups").glob("*.sqlite3"))
        with sqlite3.connect(backup_path) as backup:
            assert backup.execute("SELECT text FROM recovery_note").fetchone() == (
                "kept before migration",
            )
            assert (
                backup.execute("SELECT name FROM sqlite_master WHERE name='chats'").fetchall() == []
            )
        with session_scope(engine) as session:
            assert session.scalar(text("SELECT text FROM recovery_note")) == "kept before migration"
    finally:
        engine.dispose()


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


@pytest.mark.anyio
async def test_lifespan_moves_legacy_under_lock_and_resumes(tmp_path: Path) -> None:
    import shutil

    target = tmp_path / "target"
    legacy = tmp_path / "legacy" / "chats"
    legacy.mkdir(parents=True)
    chat = legacy_chat(legacy)
    settings = Settings(data_directory=target)
    real_copytree = shutil.copytree
    interrupted = False

    def interrupt(source: Path, destination: Path, **kwargs: object) -> None:
        nonlocal interrupted
        if not interrupted:
            interrupted = True
            raise OSError("copy interrupted")
        real_copytree(source, destination, symlinks=True)

    with (
        patch("diktator.app.default_data_directory", return_value=target),
        patch("diktator.app.legacy_data_directories", return_value=[legacy]),
    ):
        app = create_app(settings)
        with (
            patch("diktator.config.shutil.copytree", interrupt),
            pytest.raises(OSError, match="copy interrupted"),
        ):
            async with app.router.lifespan_context(app):
                pytest.fail("migration interrupted")
        assert (target / ".legacy-migration.json").exists()
        assert not (target / DATABASE_NAME).exists()
        app = create_app(settings)
        async with app.router.lifespan_context(app):
            engine = open_engine(target / DATABASE_NAME)
            try:
                assert ChatService(target, engine).get(LOCAL_USER_ID, chat.id) == chat
            finally:
                engine.dispose()
    assert not legacy.exists()
    assert not (target / ".legacy-migration.json").exists()


def test_released_baseline_fixture_opens_without_upgrade(tmp_path: Path) -> None:
    import shutil

    fixture = Path(__file__).parent / "fixtures" / "database" / "0001.sqlite3"
    shutil.copyfile(fixture, tmp_path / DATABASE_NAME)
    engine = open_engine(tmp_path / DATABASE_NAME)
    try:
        upgrade_schema(engine, tmp_path)
        assert not (tmp_path / "backups").exists()
        service = ChatService(tmp_path, engine)
        chat = service.create(LOCAL_USER_ID)
        assert service.get(LOCAL_USER_ID, chat.id) == chat
    finally:
        engine.dispose()


@pytest.mark.parametrize("suffix", ["?one", "?two", "#hash", "%20 space ü"])
def test_database_path_preserves_special_characters(tmp_path: Path, suffix: str) -> None:
    if os.name == "nt" and "?" in suffix:
        pytest.skip("Windows filenames cannot contain question marks")
    root = tmp_path / f"chats{suffix}"
    root.mkdir()
    path = root / DATABASE_NAME
    engine = open_engine(path)
    try:
        upgrade_schema(engine, root)
        assert path.is_file()
        with engine.connect() as connection:
            database = connection.exec_driver_sql("PRAGMA database_list").first()
            assert database is not None
            assert Path(database[2]) == path
    finally:
        engine.dispose()
    assert not (tmp_path / "chats").exists()


@pytest.mark.skipif(os.name == "nt", reason="Windows filenames cannot contain question marks")
def test_independently_locked_special_character_directories_are_isolated(tmp_path: Path) -> None:
    roots = [tmp_path / "chats?one", tmp_path / "chats?two"]
    locks = [DataDirectoryLock(root) for root in roots]
    engines = []
    try:
        for lock in locks:
            lock.acquire()
            engine = open_engine(lock.root / DATABASE_NAME)
            engines.append(engine)
            upgrade_schema(engine, lock.root)
        first = ChatService(roots[0], engines[0])
        second = ChatService(roots[1], engines[1])
        first_chat = first.create(LOCAL_USER_ID)
        assert second.list(LOCAL_USER_ID) == []
        second_chat = second.create(LOCAL_USER_ID)
        assert [chat.id for chat in first.list(LOCAL_USER_ID)] == [first_chat.id]
        assert [chat.id for chat in second.list(LOCAL_USER_ID)] == [second_chat.id]
        assert all((root / DATABASE_NAME).is_file() for root in roots)
        assert not (tmp_path / "chats").exists()
    finally:
        for engine in engines:
            engine.dispose()
        for lock in locks:
            lock.release()
