"""Persist chats as one folder each: a JSON document plus the chat's WAV recordings."""

import os
import re
import shutil
import uuid
from datetime import UTC, datetime
from pathlib import Path

from pydantic import BaseModel, ValidationError

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


class ChatNotFound(Exception):
    """The chat or recording does not exist, or the identifier is malformed."""


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


def _write_atomically(path: Path, content: bytes) -> None:
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_bytes(content)
    os.replace(temporary, path)


class ChatStore:
    """File storage for a single local user; the directory is created on first write."""

    def __init__(self, root: Path) -> None:
        self.root = root

    def _folder(self, chat_id: str) -> Path:
        if not IDENTIFIER.fullmatch(chat_id):
            raise ChatNotFound(chat_id)
        return self.root / chat_id

    def _save(self, chat: Chat) -> None:
        _write_atomically(
            self._folder(chat.id) / "chat.json", chat.model_dump_json(indent=2).encode()
        )

    def list(self) -> list[ChatSummary]:
        """Most recently updated first; unreadable folders are skipped."""
        summaries = []
        if self.root.is_dir():
            for folder in self.root.iterdir():
                if not IDENTIFIER.fullmatch(folder.name):
                    continue
                try:
                    chat = self.get(folder.name)
                except ChatNotFound:
                    continue
                summaries.append(
                    ChatSummary(
                        id=chat.id,
                        title=title_for(chat.text),
                        updated=chat.updated,
                        recording_count=len(chat.recordings),
                    )
                )
        return sorted(summaries, key=lambda summary: summary.updated, reverse=True)

    def create(self) -> Chat:
        now = _now()
        chat = Chat(id=uuid.uuid4().hex, created=now, updated=now)
        self._folder(chat.id).mkdir(parents=True)
        self._save(chat)
        return chat

    def get(self, chat_id: str) -> Chat:
        try:
            return Chat.model_validate_json((self._folder(chat_id) / "chat.json").read_bytes())
        except (OSError, ValidationError) as error:
            raise ChatNotFound(chat_id) from error

    def update_text(self, chat_id: str, text: str) -> Chat:
        chat = self.get(chat_id)
        chat.text = text
        chat.updated = _now()
        self._save(chat)
        return chat

    def delete(self, chat_id: str) -> None:
        folder = self._folder(chat_id)
        if not (folder / "chat.json").is_file():
            raise ChatNotFound(chat_id)
        shutil.rmtree(folder)

    def add_recording(self, chat_id: str, audio: bytes, duration_seconds: float) -> Recording:
        chat = self.get(chat_id)
        recording = Recording(
            id=uuid.uuid4().hex, created=_now(), duration_seconds=duration_seconds
        )
        _write_atomically(self._folder(chat_id) / f"{recording.id}.wav", audio)
        chat.recordings.append(recording)
        chat.updated = recording.created
        self._save(chat)
        return recording

    def recording_audio(self, chat_id: str, recording_id: str) -> bytes:
        chat = self.get(chat_id)
        if not any(recording.id == recording_id for recording in chat.recordings):
            raise ChatNotFound(recording_id)
        try:
            return (self._folder(chat_id) / f"{recording_id}.wav").read_bytes()
        except OSError as error:
            raise ChatNotFound(recording_id) from error
