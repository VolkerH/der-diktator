"""Public chat representations and membership-authorized application service."""

import hashlib
import logging
import os
import re
import shutil
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from threading import Lock

from pydantic import BaseModel, PrivateAttr
from sqlalchemy import Engine, func, select
from sqlalchemy.orm import Session

from diktator.db import session_scope
from diktator.db.rows import ChatMemberRow, ChatRow, RecordingRow
from diktator.durability import sync_directory
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
    revision: int = 1
    text_revision: int = 1
    _incarnation: str = PrivateAttr(default="")

    @property
    def etag(self) -> str:
        """Opaque strong validator for this complete chat representation."""
        return f'"chat-{self.id}-{self._incarnation}-{self.revision}"'

    @property
    def text_etag(self) -> str:
        """Text changes independently of recordings and chat metadata."""
        return f'"text-{self.id}-{self._incarnation}-{self.text_revision}"'


class ChatText(BaseModel):
    """Canonical text resource, independent of the chat's recordings."""

    text: str
    text_revision: int


class ChatSummary(BaseModel):
    """What the chat list needs, without transcripts or recordings."""

    id: str
    title: str
    updated: datetime
    recording_count: int
    etag: str


@dataclass(frozen=True)
class RecordingUpload:
    """Stored audio and the parent validator captured in the same serialized mutation."""

    recording: Recording
    chat_etag: str
    chat_revision: int
    created: bool


def chat_etag(row: ChatRow) -> str:
    """Compute the complete-chat validator without querying its recordings."""
    return f'"chat-{row.id}-{row.incarnation}-{row.revision}"'


def text_etag(row: ChatRow) -> str:
    """Compute the independently writable text validator from its row snapshot."""
    return f'"text-{row.id}-{row.incarnation}-{row.text_revision}"'


class ChatNotFound(ApiFailure):
    """The chat does not exist, or its identifier is malformed."""

    def __init__(self) -> None:
        super().__init__("This chat no longer exists.", "chat_not_found", 404)


class RecordingNotFound(ApiFailure):
    """A recording or its audio is absent within an existing chat."""

    def __init__(self) -> None:
        super().__init__("This recording no longer exists.", "recording_not_found", 404)


def check_precondition(if_match: str | None, etag: str) -> None:
    """Allow legacy writes; match only strong validators or the existing-resource wildcard."""
    if if_match is None or if_match.strip() == "*":
        return
    if etag not in [value.strip() for value in if_match.split(",")]:
        raise ApiFailure("This chat changed elsewhere.", "revision_conflict", 412)


def idempotency_conflict() -> ApiFailure:
    """Do not reveal the resource held by another actor or another payload."""
    return ApiFailure("This identifier is already in use.", "idempotency_conflict", 409)


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

    A plain lock spans uploads, deletions and creation through file cleanup.
    Creation stays serialized so a recreated ID cannot acquire a folder while its
    previous deletion is still removing it. File work runs outside transactions;
    reads and text-only updates use their own sessions without this lock.
    """

    def __init__(self, root: Path, engine: Engine) -> None:
        self.root = root
        self.engine = engine
        self._mutation_lock = Lock()

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
        chat = Chat(
            id=row.id,
            created=row.created,
            updated=row.updated,
            text=row.text,
            recordings=[self._recording_model(recording) for recording in recordings],
            revision=row.revision,
            text_revision=row.text_revision,
        )
        # Keep validator metadata in the typed response snapshot, without exposing DB rows
        # or adding the incarnation to the public JSON representation.
        chat._incarnation = row.incarnation
        return chat

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
                    etag=chat_etag(row),
                )
                for row, recording_count in rows
            ]

    def create(self, actor_id: str) -> Chat:
        return self.create_with_id(actor_id, uuid.uuid4().hex)[0]

    def create_with_id(self, actor_id: str, chat_id: str) -> tuple[Chat, bool]:
        """Create once for a chosen ID; retries return the accessible winner unchanged."""
        self._folder(chat_id)
        with self._mutation_lock, session_scope(self.engine, write=True) as session:
            existing = session.get(ChatRow, chat_id)
            if existing is not None:
                try:
                    return self._model(session, self._chat(session, actor_id, chat_id)), False
                except ChatNotFound:
                    raise idempotency_conflict() from None
            now = _now()
            row = ChatRow(id=chat_id, created=now, updated=now, text="", created_by=actor_id)
            session.add(row)
            session.flush()
            session.add(ChatMemberRow(chat_id=row.id, user_id=actor_id, role="owner"))
            return self._model(session, row), True

    def get(self, actor_id: str, chat_id: str) -> Chat:
        with session_scope(self.engine) as session:
            return self._model(session, self._chat(session, actor_id, chat_id))

    def update_text(
        self, actor_id: str, chat_id: str, text: str, if_match: str | None = None
    ) -> Chat:
        with session_scope(self.engine, write=True) as session:
            row = self._chat(session, actor_id, chat_id)
            check_precondition(if_match, text_etag(row))
            if row.text != text:
                row.text = text
                row.text_revision += 1
                row.revision += 1
                row.updated = _now()
            return self._model(session, row)

    def delete(self, actor_id: str, chat_id: str, if_match: str | None = None) -> None:
        with self._mutation_lock:
            folder = self._folder(chat_id)
            with session_scope(self.engine, write=True) as session:
                row = self._chat(session, actor_id, chat_id)
                check_precondition(if_match, chat_etag(row))
                session.delete(row)
            if folder.exists():
                try:
                    shutil.rmtree(folder)
                    sync_directory(self.root)
                except OSError:
                    log.exception("Chat %s deleted; audio folder cleanup failed", chat_id)

    def add_recording(
        self,
        actor_id: str,
        chat_id: str,
        audio: bytes,
        duration_seconds: float,
        recording_id: str | None = None,
    ) -> Recording:
        """Store audio for callers that only need the recording representation."""
        return self.upload_recording(
            actor_id, chat_id, audio, duration_seconds, recording_id
        ).recording

    def upload_recording(
        self,
        actor_id: str,
        chat_id: str,
        audio: bytes,
        duration_seconds: float,
        recording_id: str | None = None,
    ) -> RecordingUpload:
        """Store durable audio once. Retrying a different payload never touches winner bytes.

        Hashing incoming audio does not hold a lock. The service lock spans existing-row
        lookup, legacy hash recovery, file finalization, commit and failure cleanup.
        """
        recording_id = recording_id or uuid.uuid4().hex
        if not IDENTIFIER.fullmatch(recording_id):
            raise RecordingNotFound()
        digest = hashlib.sha256(audio).hexdigest()
        with self._mutation_lock:
            with session_scope(self.engine) as session:
                parent = self._chat(session, actor_id, chat_id)
                parent_etag, parent_revision = chat_etag(parent), parent.revision
                existing = session.get(RecordingRow, recording_id)
                if existing is not None:
                    if existing.chat_id != chat_id:
                        raise idempotency_conflict()
                    stored_hash = existing.audio_sha256
                    recording = self._recording_model(existing)
                else:
                    recording = None
                    stored_hash = None
            if recording is not None:
                if stored_hash is None:
                    # Missing legacy audio has unknown identity: do not overwrite it.
                    stored_hash = hashlib.sha256(
                        self.recording_audio(actor_id, chat_id, recording_id)
                    ).hexdigest()
                    with session_scope(self.engine, write=True) as session:
                        row = session.get(RecordingRow, recording_id)
                        assert row is not None  # protected by the mutation lock
                        row.audio_sha256 = stored_hash
                if stored_hash != digest:
                    raise idempotency_conflict()
                return RecordingUpload(
                    recording=recording,
                    chat_etag=parent_etag,
                    chat_revision=parent_revision,
                    created=False,
                )
            recording = Recording(
                id=recording_id, created=_now(), duration_seconds=duration_seconds
            )
            folder = self._folder(chat_id)
            folder.mkdir(exist_ok=True)
            sync_directory(self.root)
            path = folder / f"{recording.id}.wav"
            try:
                finalize_audio(path, audio)
                with session_scope(self.engine, write=True) as session:
                    chat = self._chat(session, actor_id, chat_id)
                    # A text save may finish during audio finalization. Sample recency
                    # inside this write transaction and preserve any later stored value.
                    chat.updated = max(chat.updated, _now())
                    chat.revision += 1
                    parent_etag, parent_revision = chat_etag(chat), chat.revision
                    session.add(
                        RecordingRow(
                            id=recording.id,
                            chat_id=chat_id,
                            created=recording.created,
                            duration_seconds=duration_seconds,
                            audio_path=path.relative_to(self.root).as_posix(),
                            audio_sha256=digest,
                        )
                    )
            except BaseException:
                try:
                    path.unlink(missing_ok=True)
                    sync_directory(folder)
                except OSError:
                    log.exception("Uncommitted recording cleanup failed: %s", path)
                raise
            return RecordingUpload(
                recording=recording,
                chat_etag=parent_etag,
                chat_revision=parent_revision,
                created=True,
            )

    def recording_audio(self, actor_id: str, chat_id: str, recording_id: str) -> bytes:
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
        # Use the stored relative path. This layout confines audio to the authorized
        # chat and rejects traversal, absolute paths and platform-specific separators.
        if not re.fullmatch(rf"{chat_id}/[0-9a-f]{{32}}\.wav", relative_path):
            raise RecordingNotFound()
        path = self._folder(chat_id) / relative_path.split("/")[1]
        if path.is_symlink():
            raise RecordingNotFound()
        try:
            return path.read_bytes()
        except OSError as error:
            # Deletion may remove the file after lookup; reads never block mutations.
            log.warning("Recording audio is missing or unreadable: %s", path)
            raise RecordingNotFound() from error
