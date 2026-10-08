"""Persistence rows, kept separate from the public chat models."""

import uuid
from datetime import UTC, datetime
from typing import override

from sqlalchemy import DateTime, ForeignKey, String, Text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.types import TypeDecorator

LOCAL_USER_ID = "local"


class UtcDateTime(TypeDecorator[datetime]):
    """Store naive UTC in SQLite, and expose only aware UTC to application code."""

    impl = DateTime
    cache_ok = True

    @override
    def process_bind_param(self, value: datetime | None, dialect: object) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("Timestamps must be timezone-aware")
        return value.astimezone(UTC).replace(tzinfo=None)

    @override
    def process_result_value(self, value: datetime | None, dialect: object) -> datetime | None:
        return value.replace(tzinfo=UTC) if value is not None else None


class Base(DeclarativeBase):
    pass


class UserRow(Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    created: Mapped[datetime] = mapped_column(UtcDateTime)


class ChatRow(Base):
    __tablename__ = "chats"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    created: Mapped[datetime] = mapped_column(UtcDateTime)
    updated: Mapped[datetime] = mapped_column(UtcDateTime, index=True)
    text: Mapped[str] = mapped_column(Text, default="")
    created_by: Mapped[str] = mapped_column(ForeignKey("users.id"))
    revision: Mapped[int] = mapped_column(default=1)
    text_revision: Mapped[int] = mapped_column(default=1)
    incarnation: Mapped[str] = mapped_column(String, default=lambda: uuid.uuid4().hex)


class ChatMemberRow(Base):
    __tablename__ = "chat_members"
    chat_id: Mapped[str] = mapped_column(
        ForeignKey("chats.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), primary_key=True)
    role: Mapped[str] = mapped_column(String)


class RecordingRow(Base):
    __tablename__ = "recordings"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    chat_id: Mapped[str] = mapped_column(ForeignKey("chats.id", ondelete="CASCADE"), index=True)
    created: Mapped[datetime] = mapped_column(UtcDateTime)
    duration_seconds: Mapped[float]
    audio_path: Mapped[str] = mapped_column(String)
    audio_sha256: Mapped[str | None] = mapped_column(String, nullable=True)


class LegacyImportRow(Base):
    __tablename__ = "legacy_imports"
    chat_id: Mapped[str] = mapped_column(String, primary_key=True)
    imported_at: Mapped[datetime] = mapped_column(UtcDateTime)
    source: Mapped[str] = mapped_column(String)
    baseline_text: Mapped[str] = mapped_column(Text)
