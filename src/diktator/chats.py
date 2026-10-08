"""Public chat representations and membership-authorized application service."""

import logging
import os
import re
import shutil
import uuid
from datetime import UTC, datetime
from pathlib import Path
from threading import RLock

from pydantic import BaseModel
from sqlalchemy import Engine, func, select
from sqlalchemy.orm import Session

from diktator.db import session_scope
from diktator.db.rows import ChatMemberRow, ChatRow, RecordingRow
from diktator.errors import ApiFailure

IDENTIFIER = re.compile(r"[0-9a-f]{32}")
TITLE_LENGTH = 48


class Recording(BaseModel):
    """A stored recording; its audio lives next to the chat document."""

    id: str
    created: datetime
    duration_seconds: float


class Chat(BaseModel):
    """One editable transcript and every recording made for it."""

    id: str
    created: datetime
    updated: datetime
    text: str = ""
    recordings: list[Recording] = []


class ChatSummary(BaseModel):
    """What the chat list needs, without transcripts or recordings."""

    id: str
    title: str
    updated: datetime
    recording_count: int


class ChatNotFound(ApiFailure):
    """The chat does not exist, or its identifier is malformed."""

    def __init__(self) -> None:
        super().__init__("This chat no longer exists.", "chat_not_found", 404)


class RecordingNotFound(ApiFailure):
    """A recording or its audio is absent within an existing chat."""

    def __init__(self) -> None:
        super().__init__("This recording no longer exists.", "recording_not_found", 404)


def title_for(text: str) -> str:
    """Name a chat after the start of its transcript."""
    words = " ".join(text.split())
    if not words:
        return "New chat"
    if len(words) <= TITLE_LENGTH:
        return words
    return words[:TITLE_LENGTH].rsplit(" ", 1)[0] + "…"


def _now() -> datetime:
    return datetime.now(UTC)


log = logging.getLogger(__name__)


def sync_directory(directory: Path) -> None:
    """Persist renames on platforms that provide directory fsync."""
    if os.name == "nt":
        return
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def finalize_audio(path: Path, audio: bytes) -> None:
    """Durably finalize audio before a transaction can reference it."""
    temporary = path.with_suffix(".wav.tmp")
    try:
        with temporary.open("wb") as stream:
            stream.write(audio)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        sync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


class ChatService:
    """One owned SQLite database and stable audio paths, with short transactions.

    A service-level lock spans each mutation and its file cleanup. File operations
    happen outside transactions, while competing uploads/deletes cannot cross that
    boundary. Every operation creates and closes its own session in its calling thread.
    """

    def __init__(self, root: Path, engine: Engine) -> None:
        self.root = root
        self.engine = engine
        self._mutation_lock = RLock()

    def _folder(self, chat_id: str) -> Path:
        if not IDENTIFIER.fullmatch(chat_id):
            raise ChatNotFound()
        folder = self.root / chat_id
        if folder.is_symlink():
            raise ChatNotFound()
        return folder

    def _chat(self, session: Session, actor_id: str, chat_id: str) -> ChatRow:
        if not IDENTIFIER.fullmatch(chat_id):
            raise ChatNotFound()
        row = session.scalar(
            select(ChatRow)
            .join(ChatMemberRow, ChatMemberRow.chat_id == ChatRow.id)
            .where(ChatRow.id == chat_id, ChatMemberRow.user_id == actor_id)
        )
        if row is None:
            raise ChatNotFound()
        return row

    def _model(self, session: Session, row: ChatRow) -> Chat:
        recordings = session.scalars(
            select(RecordingRow)
            .where(RecordingRow.chat_id == row.id)
            .order_by(RecordingRow.created, RecordingRow.id)
        )
        return Chat(
            id=row.id,
            created=row.created,
            updated=row.updated,
            text=row.text,
            recordings=[self._recording_model(recording) for recording in recordings],
        )

    @staticmethod
    def _recording_model(row: RecordingRow) -> Recording:
        return Recording(id=row.id, created=row.created, duration_seconds=row.duration_seconds)

    def list(self, actor_id: str) -> list[ChatSummary]:
        """Most recently updated accessible chats first, ordered stably on ties."""
        with session_scope(self.engine) as session:
            count = (
                select(func.count(RecordingRow.id))
                .where(RecordingRow.chat_id == ChatRow.id)
                .correlate(ChatRow)
                .scalar_subquery()
            )
            rows = session.execute(
                select(ChatRow, count)
                .join(ChatMemberRow, ChatMemberRow.chat_id == ChatRow.id)
                .where(ChatMemberRow.user_id == actor_id)
                .order_by(ChatRow.updated.desc(), ChatRow.id)
            )
            return [
                ChatSummary(
                    id=row.id,
                    title=title_for(row.text),
                    updated=row.updated,
                    recording_count=recording_count,
                )
                for row, recording_count in rows
            ]

    def create(self, actor_id: str) -> Chat:
        with self._mutation_lock:
            now = _now()
            row = ChatRow(
                id=uuid.uuid4().hex, created=now, updated=now, text="", created_by=actor_id
            )
            # Creation needs no folder until an upload. This avoids empty folders
            # when a transaction fails and keeps all file I/O outside transactions.
            with session_scope(self.engine, write=True) as session:
                session.add(row)
                session.flush()
                session.add(ChatMemberRow(chat_id=row.id, user_id=actor_id, role="owner"))
                return self._model(session, row)

    def get(self, actor_id: str, chat_id: str) -> Chat:
        with session_scope(self.engine) as session:
            return self._model(session, self._chat(session, actor_id, chat_id))

    def update_text(self, actor_id: str, chat_id: str, text: str) -> Chat:
        with self._mutation_lock, session_scope(self.engine, write=True) as session:
            row = self._chat(session, actor_id, chat_id)
            row.text = text
            row.updated = _now()
            return self._model(session, row)

    def delete(self, actor_id: str, chat_id: str) -> None:
        with self._mutation_lock:
            folder = self._folder(chat_id)
            with session_scope(self.engine, write=True) as session:
                session.delete(self._chat(session, actor_id, chat_id))
            if folder.exists():
                try:
                    shutil.rmtree(folder)
                    sync_directory(self.root)
                except OSError:
                    log.exception("Chat %s deleted; audio folder cleanup failed", chat_id)

    def add_recording(
        self, actor_id: str, chat_id: str, audio: bytes, duration_seconds: float
    ) -> Recording:
        with self._mutation_lock:
            # Authorization before any file changes; close the read transaction
            # before durable finalization. The mutation lock preserves the result.
            self.get(actor_id, chat_id)
            recording = Recording(
                id=uuid.uuid4().hex, created=_now(), duration_seconds=duration_seconds
            )
            folder = self._folder(chat_id)
            folder.mkdir(exist_ok=True)
            sync_directory(self.root)
            path = folder / f"{recording.id}.wav"
            try:
                finalize_audio(path, audio)
                with session_scope(self.engine, write=True) as session:
                    chat = self._chat(session, actor_id, chat_id)
                    chat.updated = recording.created
                    session.add(
                        RecordingRow(
                            id=recording.id,
                            chat_id=chat_id,
                            created=recording.created,
                            duration_seconds=duration_seconds,
                            audio_path=path.relative_to(self.root).as_posix(),
                        )
                    )
            except BaseException:
                try:
                    path.unlink(missing_ok=True)
                    sync_directory(folder)
                except OSError:
                    log.exception("Uncommitted recording cleanup failed: %s", path)
                raise
            return recording

    def recording_audio(self, actor_id: str, chat_id: str, recording_id: str) -> bytes:
        # Serialize the row lookup and read with deletion, so a completed lookup
        # cannot race a folder removal. No database transaction surrounds the read.
        with self._mutation_lock:
            if not IDENTIFIER.fullmatch(recording_id):
                raise RecordingNotFound()
            with session_scope(self.engine) as session:
                self._chat(session, actor_id, chat_id)
                row = session.scalar(
                    select(RecordingRow).where(
                        RecordingRow.id == recording_id, RecordingRow.chat_id == chat_id
                    )
                )
                if row is None:
                    raise RecordingNotFound()
                relative_path = row.audio_path
            expected = f"{chat_id}/{recording_id}.wav"
            path = self._folder(chat_id) / f"{recording_id}.wav"
            if relative_path != expected or path.is_symlink():
                raise RecordingNotFound()
            try:
                return path.read_bytes()
            except OSError as error:
                log.warning("Recording audio is missing or unreadable: %s", path)
                raise RecordingNotFound() from error
