"""Connection, schema upgrade, backup and literal-path isolation tests."""

import os
import sqlite3
from pathlib import Path

import pytest
from sqlalchemy import select, text

from diktator.chats import ChatService
from diktator.db import (
    DATABASE_NAME,
    DataDirectoryLock,
    UnknownSchema,
    open_engine,
    session_scope,
    upgrade_schema,
)
from diktator.db.rows import (
    LOCAL_USER_ID,
    UserRow,
)


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
        assert not (tmp_path / "backups").exists()
        upgrade_schema(engine, tmp_path)
        assert not (tmp_path / "backups").exists()
        with engine.begin() as connection:
            connection.exec_driver_sql("UPDATE alembic_version SET version_num='9999'")
        with pytest.raises(UnknownSchema, match="newer"):
            upgrade_schema(engine, tmp_path)
        assert not (tmp_path / "backups").exists()
    finally:
        engine.dispose()


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


@pytest.mark.parametrize("revision", ["0001", "0002"])
def test_released_schema_fixture_opens_and_upgrades(tmp_path: Path, revision: str) -> None:
    import shutil

    fixture = Path(__file__).parent / "fixtures" / "database" / f"{revision}.sqlite3"
    shutil.copyfile(fixture, tmp_path / DATABASE_NAME)
    engine = open_engine(tmp_path / DATABASE_NAME)
    try:
        upgrade_schema(engine, tmp_path)
        assert (tmp_path / "backups").exists()
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
