"""Directory ownership, migration recovery and storage lifecycle acceptance tests."""

from pathlib import Path
from unittest.mock import patch

import pytest

from diktator.app import create_app
from diktator.chats import ChatService
from diktator.config import Settings, migrate_chats
from diktator.db import (
    DATABASE_NAME,
    DataDirectoryLock,
    StorageInUse,
    open_engine,
)
from diktator.db.rows import (
    LOCAL_USER_ID,
)
from tests.storage_helpers import legacy_chat


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


def test_cli_reports_cross_process_lock_refusal_without_traceback(service: ChatService) -> None:
    import subprocess
    import sys

    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "from diktator.cli import main; main()",
            "--data-dir",
            str(service.root),
        ],
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    assert result.returncode == 1
    assert "already in use" in result.stderr
    assert "Traceback" not in result.stderr
    assert "Application startup failed" not in result.stderr


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
        patch("diktator.storage.upgrade_schema", side_effect=RuntimeError("upgrade failed")),
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


@pytest.mark.anyio
async def test_lifespan_moves_legacy_under_lock_and_resumes(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    import shutil

    caplog.set_level("INFO", logger="diktator.storage")
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
        patch("diktator.storage.default_data_directory", return_value=target),
        patch("diktator.storage.legacy_data_directories", return_value=[legacy]),
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
    assert f"Moved existing chats from {legacy} to {target}" in caplog.text


@pytest.mark.anyio
async def test_storage_owns_shutdown_and_releases_lock(tmp_path: Path) -> None:
    from diktator.storage import open_storage

    settings = Settings(data_directory=tmp_path)
    storage = open_storage(settings)
    app = create_app(settings, storage=storage)
    async with app.router.lifespan_context(app):
        assert app.state.storage is storage
        assert storage.chats.create(LOCAL_USER_ID).id
        with pytest.raises(StorageInUse):
            DataDirectoryLock(tmp_path).acquire()
    storage.close()
    lock = DataDirectoryLock(tmp_path)
    lock.acquire()
    lock.release()


def test_cli_releases_storage_if_server_setup_fails(tmp_path: Path) -> None:
    from diktator.cli import main

    with (
        patch("sys.argv", ["diktator", "--data-dir", str(tmp_path)]),
        patch("diktator.cli.uvicorn.run", side_effect=RuntimeError("server setup failed")),
        pytest.raises(RuntimeError, match="server setup failed"),
    ):
        main()
    lock = DataDirectoryLock(tmp_path)
    lock.acquire()
    lock.release()
