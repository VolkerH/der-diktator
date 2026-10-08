"""Lossless one-chat imports and conservative startup file reconciliation."""

import logging
import math
from datetime import UTC, datetime
from pathlib import Path

from pydantic import ValidationError
from sqlalchemy import Engine, select
from sqlalchemy.exc import SQLAlchemyError

from diktator.chats import IDENTIFIER, Chat
from diktator.db import session_scope
from diktator.db.rows import LOCAL_USER_ID, ChatMemberRow, ChatRow, LegacyImportRow, RecordingRow

log = logging.getLogger(__name__)


def validate_legacy(chat: Chat, folder: Path) -> None:
    """Reject path escapes and ambiguous timestamps beyond the legacy API validation."""
    if chat.id != folder.name or not IDENTIFIER.fullmatch(chat.id):
        raise ValueError("Chat ID does not match its folder")
    timestamps = [chat.created, chat.updated]
    identifiers: set[str] = set()
    for recording in chat.recordings:
        if not IDENTIFIER.fullmatch(recording.id) or recording.id in identifiers:
            raise ValueError("Invalid or repeated recording ID")
        identifiers.add(recording.id)
        if not math.isfinite(recording.duration_seconds) or recording.duration_seconds < 0:
            raise ValueError("Invalid recording duration")
        timestamps.append(recording.created)
    if any(value.tzinfo is None or value.utcoffset() is None for value in timestamps):
        raise ValueError("Legacy timestamps must include a timezone")


def import_legacy(engine: Engine, root: Path) -> None:
    """Commit a whole chat and its durable import marker together; retain source JSON."""
    with session_scope(engine) as session:
        imported = set(session.scalars(select(LegacyImportRow.chat_id)))
    for folder in sorted(root.iterdir()):
        if not IDENTIFIER.fullmatch(folder.name) or folder.is_symlink() or not folder.is_dir():
            continue
        source = folder / "chat.json"
        if folder.name in imported or not source.exists():
            continue
        try:
            if source.is_symlink():
                raise ValueError("Legacy JSON must not be a symlink")
            chat = Chat.model_validate_json(source.read_bytes())
            validate_legacy(chat, folder)
            # File inspection happens before the atomic database import.
            for recording in chat.recordings:
                if not (folder / f"{recording.id}.wav").is_file():
                    log.warning(
                        "Importing metadata for missing recording %s/%s", chat.id, recording.id
                    )
            with session_scope(engine, write=True) as session:
                session.add(
                    ChatRow(
                        id=chat.id,
                        created=chat.created,
                        updated=chat.updated,
                        text=chat.text,
                        created_by=LOCAL_USER_ID,
                    )
                )
                session.flush()
                session.add(ChatMemberRow(chat_id=chat.id, user_id=LOCAL_USER_ID, role="owner"))
                session.add_all(
                    [
                        RecordingRow(
                            id=recording.id,
                            chat_id=chat.id,
                            created=recording.created,
                            duration_seconds=recording.duration_seconds,
                            audio_path=f"{chat.id}/{recording.id}.wav",
                        )
                        for recording in chat.recordings
                    ]
                )
                session.add(
                    LegacyImportRow(
                        chat_id=chat.id,
                        imported_at=datetime.now(UTC),
                        source=source.relative_to(root).as_posix(),
                        baseline_text=chat.text,
                    )
                )
        except (OSError, ValidationError, ValueError, SQLAlchemyError):
            log.exception("Skipping unreadable or unimportable legacy chat %s", folder.name)


def sweep_orphans(engine: Engine, root: Path) -> None:
    """Remove abandoned files only where import status proves they are unreferenced."""
    removed = 0
    try:
        with session_scope(engine) as session:
            imported = set(session.scalars(select(LegacyImportRow.chat_id)))
            referenced = set(session.scalars(select(RecordingRow.audio_path)))
        for folder in root.iterdir():
            if not IDENTIFIER.fullmatch(folder.name) or folder.is_symlink() or not folder.is_dir():
                continue
            if (folder / "chat.json").exists() and folder.name not in imported:
                continue
            for path in folder.iterdir():
                if not path.is_file() or path.is_symlink():
                    continue
                if path.suffix == ".tmp" or (
                    path.suffix == ".wav" and path.relative_to(root).as_posix() not in referenced
                ):
                    try:
                        path.unlink()
                        removed += 1
                    except OSError:
                        log.exception("Cannot remove abandoned recording file %s", path)
    except OSError:
        log.exception("Recording cleanup interrupted; continuing startup")
    log.info("Removed %d abandoned recording files", removed)
