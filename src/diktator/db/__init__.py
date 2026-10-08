"""SQLite ownership, connection policy and packaged schema upgrades."""

import sqlite3
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from importlib.resources import as_file, files
from pathlib import Path

from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from filelock import FileLock, Timeout
from sqlalchemy import Connection, Engine, create_engine, event
from sqlalchemy.orm import Session

DATABASE_NAME = "diktator.sqlite3"
LOCK_NAME = ".diktator.lock"


class StorageInUse(RuntimeError):
    """Another application owns the data directory."""


class UnknownSchema(RuntimeError):
    """The database requires a different version of the application."""


class DataDirectoryLock:
    """Cross-platform process lock; retain its inode until the directory is retired."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self._lock = FileLock(root / LOCK_NAME, timeout=0, thread_local=False)

    def acquire(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        try:
            self._lock.acquire()
        except Timeout as error:
            raise StorageInUse(
                f"Chat storage {self.root} is already in use. Stop the other Diktator instance."
            ) from error

    def release(self) -> None:
        self._lock.release()


def open_engine(path: Path) -> Engine:
    """Use explicit pysqlite transaction control, with write locks only on mutations."""
    engine = create_engine(f"sqlite:///{path}", connect_args={"check_same_thread": False})

    @event.listens_for(engine, "connect")
    def configure(dbapi_connection: sqlite3.Connection, _record: object) -> None:
        dbapi_connection.isolation_level = None
        cursor = dbapi_connection.cursor()
        try:
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute("PRAGMA synchronous=FULL")
            cursor.execute("PRAGMA busy_timeout=5000")
        finally:
            cursor.close()

    @event.listens_for(engine, "begin")
    def begin(connection: Connection) -> None:
        connection.exec_driver_sql(
            "BEGIN IMMEDIATE" if connection.get_execution_options().get("write") else "BEGIN"
        )

    return engine


@contextmanager
def session_scope(engine: Engine, *, write: bool = False) -> Iterator[Session]:
    """Create, use and close a session in one synchronous unit of work."""
    with (
        engine.connect().execution_options(write=write) as connection,
        Session(connection, expire_on_commit=False) as session,
        session.begin(),
    ):
        yield session


def upgrade_schema(engine: Engine, root: Path) -> None:
    """Refuse unknown revisions and back up an existing schema before upgrading it."""
    with as_file(files("diktator.db").joinpath("migrations")) as migration_path:
        config = Config()
        config.set_main_option("script_location", str(migration_path))
        scripts = ScriptDirectory.from_config(config)
        head = scripts.get_current_head()
        with engine.connect() as connection:
            exists = connection.exec_driver_sql(
                "SELECT name FROM sqlite_master WHERE name='alembic_version'"
            ).first()
            revisions = (
                [
                    row[0]
                    for row in connection.exec_driver_sql("SELECT version_num FROM alembic_version")
                ]
                if exists
                else []
            )
        known = {revision.revision for revision in scripts.walk_revisions()}
        if len(revisions) > 1 or any(revision not in known for revision in revisions):
            raise UnknownSchema(f"Database schema {revisions} is newer than this Diktator version.")
        if revisions == [head]:
            return
        backups = root / "backups"
        backups.mkdir(exist_ok=True)
        name = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ") + "-" + uuid.uuid4().hex
        # VACUUM cannot run in a transaction. The exclusive directory lock already
        # excludes application writers; bind the filename rather than interpolating SQL.
        raw = engine.raw_connection()
        try:
            cursor = raw.cursor()
            try:
                cursor.execute("VACUUM INTO ?", (str(backups / f"{name}.sqlite3"),))
            finally:
                cursor.close()
        finally:
            raw.close()
        with engine.connect().execution_options(write=True) as connection:
            config.attributes["connection"] = connection
            command.upgrade(config, "head")
