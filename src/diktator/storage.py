"""Single-owner application storage startup and shutdown."""

import logging
from dataclasses import dataclass, field

from sqlalchemy import Engine

from diktator.chats import ChatService
from diktator.config import Settings, default_data_directory, legacy_data_directories, migrate_chats
from diktator.db import DATABASE_NAME, DataDirectoryLock, open_engine, upgrade_schema
from diktator.db.legacy import import_legacy, sweep_orphans

log = logging.getLogger(__name__)


@dataclass
class Storage:
    """Own the chat service, engine and lifetime directory lock together."""

    chats: ChatService
    _ownership: DataDirectoryLock = field(repr=False)
    _closed: bool = field(default=False, init=False, repr=False)

    @property
    def engine(self) -> Engine:
        """The shared application database, independent of a particular service."""
        return self.chats.engine

    def close(self) -> None:
        """Dispose connections before releasing ownership; repeated shutdown is harmless."""
        if self._closed:
            return
        try:
            self.chats.engine.dispose()
        finally:
            self._ownership.release()
            self._closed = True


def open_storage(settings: Settings) -> Storage:
    """Lock, move legacy data, upgrade, import and reconcile, or release on failure."""
    ownership = DataDirectoryLock(settings.data_directory)
    ownership.acquire()
    database = None
    try:
        if settings.data_directory == default_data_directory():
            for legacy in legacy_data_directories():
                if migrate_chats(legacy, settings.data_directory):
                    log.info("Moved existing chats from %s to %s", legacy, settings.data_directory)
                    break
        database = open_engine(settings.data_directory / DATABASE_NAME)
        upgrade_schema(database, settings.data_directory)
        import_legacy(database, settings.data_directory)
        sweep_orphans(database, settings.data_directory)
        return Storage(ChatService(settings.data_directory, database), ownership)
    except BaseException:
        try:
            if database is not None:
                database.dispose()
        finally:
            ownership.release()
        raise
