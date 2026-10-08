"""Transactional actor-private group lifecycle and chat placement."""

import logging
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime

from sqlalchemy import Engine, select, update
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from diktator.chats import IDENTIFIER, ChatNotFound, check_precondition, idempotency_conflict
from diktator.db import session_scope
from diktator.db.rows import ChatMemberRow, ChatRow, GroupRow
from diktator.errors import ApiFailure
from diktator.group_models import ChatPlacement, Group, GroupName, GroupNotFound

log = logging.getLogger(__name__)


class GroupService:
    def __init__(self, engine: Engine) -> None:
        self.engine = engine

    @contextmanager
    def _session(self, *, write: bool = False) -> Iterator[Session]:
        try:
            with session_scope(self.engine, write=write) as session:
                yield session
        except SQLAlchemyError as error:
            raise storage_failure(error) from error

    @staticmethod
    def _placement(actor_id: str, chat: ChatRow, member: ChatMemberRow) -> ChatPlacement:
        return ChatPlacement(
            actor_id=actor_id,
            chat_id=chat.id,
            incarnation=chat.incarnation,
            group_id=member.group_id,
            placement_revision=member.placement_revision,
        )

    @staticmethod
    def _group(session: Session, actor_id: str, group_id: str) -> GroupRow:
        row = session.scalar(
            select(GroupRow).where(GroupRow.id == group_id, GroupRow.owner_id == actor_id)
        )
        if row is None:
            raise GroupNotFound()
        return row

    @staticmethod
    def _model(row: GroupRow) -> Group:
        return Group(
            id=row.id,
            name=row.name,
            created=row.created,
            revision=row.revision,
            incarnation=row.incarnation,
        )

    @staticmethod
    def _member(session: Session, actor_id: str, chat_id: str) -> tuple[ChatRow, ChatMemberRow]:
        if not IDENTIFIER.fullmatch(chat_id):
            raise ChatNotFound()
        result = session.execute(
            select(ChatRow, ChatMemberRow)
            .join(ChatMemberRow, ChatMemberRow.chat_id == ChatRow.id)
            .where(ChatRow.id == chat_id, ChatMemberRow.user_id == actor_id)
        ).first()
        if result is None:
            raise ChatNotFound()
        return result[0], result[1]

    def list(self, actor_id: str) -> list[Group]:
        with self._session() as session:
            return [
                self._model(row)
                for row in session.scalars(
                    select(GroupRow)
                    .where(GroupRow.owner_id == actor_id)
                    .order_by(GroupRow.created, GroupRow.id)
                )
            ]

    def get(self, actor_id: str, group_id: str) -> Group:
        with self._session() as session:
            return self._model(self._group(session, actor_id, group_id))

    def create(self, actor_id: str, name: str, group_id: str | None = None) -> tuple[Group, bool]:
        name = GroupName(name=name).name
        group_id = group_id or uuid.uuid4().hex
        with self._session(write=True) as session:
            existing = session.get(GroupRow, group_id)
            if existing is not None:
                if existing.owner_id != actor_id:
                    raise idempotency_conflict()
                return self._model(existing), False
            row = GroupRow(
                id=group_id,
                name=name,
                owner_id=actor_id,
                created=datetime.now(UTC),
            )
            session.add(row)
            session.flush()
            return self._model(row), True

    def rename(self, actor_id: str, group_id: str, name: str, if_match: str | None = None) -> Group:
        name = GroupName(name=name).name
        with self._session(write=True) as session:
            row = self._group(session, actor_id, group_id)
            check_precondition(if_match, self._model(row).etag)
            if row.name != name:
                row.name = name
                row.revision += 1
            return self._model(row)

    def delete(self, actor_id: str, group_id: str, if_match: str | None = None) -> None:
        with self._session(write=True) as session:
            row = self._group(session, actor_id, group_id)
            check_precondition(if_match, self._model(row).etag)
            session.execute(
                update(ChatMemberRow)
                .where(ChatMemberRow.user_id == actor_id, ChatMemberRow.group_id == group_id)
                .values(group_id=None, placement_revision=ChatMemberRow.placement_revision + 1)
            )
            session.delete(row)

    def placement(self, actor_id: str, chat_id: str) -> ChatPlacement:
        with self._session() as session:
            chat, member = self._member(session, actor_id, chat_id)
            return self._placement(actor_id, chat, member)

    def move(
        self, actor_id: str, chat_id: str, group_id: str | None, if_match: str | None = None
    ) -> ChatPlacement:
        with self._session(write=True) as session:
            chat, member = self._member(session, actor_id, chat_id)
            check_precondition(if_match, self._placement(actor_id, chat, member).etag)
            if group_id is not None:
                self._group(session, actor_id, group_id)
            if member.group_id != group_id:
                member.group_id = group_id
                member.placement_revision += 1
            return self._placement(actor_id, chat, member)


def storage_failure(error: SQLAlchemyError) -> ApiFailure:
    """Expose one bounded public failure while logging the private database diagnostic."""
    log.error("Group operation failed", exc_info=error)
    return ApiFailure("Groups could not be updated or loaded. Try again.", "storage_error", 500)
