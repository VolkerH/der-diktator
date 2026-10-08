"""Actor-scoped application preferences, independent of operator configuration."""

import hashlib
import logging
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StrictBool, model_validator
from sqlalchemy import Engine
from sqlalchemy.exc import SQLAlchemyError

from diktator.chats import check_precondition
from diktator.db import session_scope
from diktator.db.rows import PreferenceRow, UserRow
from diktator.errors import ApiFailure

log = logging.getLogger(__name__)
DEFAULT_PREAMBLE = (
    "The following text was voice dictated and transcribed with Der Diktator "
    "and may contain transcription errors."
)
MAX_PREAMBLE_CHARACTERS = 4_000


def _non_blank(value: str) -> str:
    if not value.strip():
        raise ValueError("The preamble must contain non-whitespace text.")
    return value


Preamble = Annotated[str, Field(max_length=MAX_PREAMBLE_CHARACTERS), AfterValidator(_non_blank)]


class Preferences(BaseModel):
    """Current values, revision and server-owned defaults for one user profile."""

    copy_preamble: str = Field(default_factory=lambda: DEFAULT_PREAMBLE)
    copy_preamble_is_default: bool = True
    share_include_preamble: bool = False
    revision: int = 1
    default_copy_preamble: str = Field(default_factory=lambda: DEFAULT_PREAMBLE)
    max_copy_preamble_characters: int = MAX_PREAMBLE_CHARACTERS

    def etag(self, actor_id: str) -> str:
        """Cover the entire representation, including defaults and limits."""
        digest = hashlib.sha256(
            (actor_id + "\0" + self.model_dump_json()).encode("utf-8")
        ).hexdigest()
        return f'"preferences-{digest}"'


class PreferenceUpdate(BaseModel):
    """Omitted fields remain unchanged; reset and replacement are mutually exclusive."""

    model_config = ConfigDict(extra="forbid")
    copy_preamble: Preamble | None = None
    share_include_preamble: StrictBool | None = None
    reset: list[Literal["copy_preamble", "share_include_preamble"]] = Field(default_factory=list)

    @model_validator(mode="after")
    def valid_changes(self) -> "PreferenceUpdate":
        for name in ("copy_preamble", "share_include_preamble"):
            if name in self.model_fields_set:
                if getattr(self, name) is None:
                    raise ValueError(f"{name} cannot be null.")
                if name in self.reset:
                    raise ValueError("Cannot set and reset the same preference.")
        return self


class PreferenceService:
    """Use the shared SQLite owner and serialize precondition checks with writes."""

    def __init__(self, engine: Engine) -> None:
        self.engine = engine

    @staticmethod
    def _representation(row: PreferenceRow | None) -> Preferences:
        if row is None:
            return Preferences()
        if row.copy_preamble is not None and (
            not row.copy_preamble.strip() or len(row.copy_preamble) > MAX_PREAMBLE_CHARACTERS
        ):
            raise ApiFailure("Saved preferences cannot be read.", "preferences_unavailable", 503)
        return Preferences(
            copy_preamble=DEFAULT_PREAMBLE if row.copy_preamble is None else row.copy_preamble,
            copy_preamble_is_default=row.copy_preamble is None,
            share_include_preamble=row.share_include_preamble,
            revision=row.revision,
        )

    def get(self, actor_id: str) -> Preferences:
        """Resolve defaults without creating rows or changing chat recency."""
        try:
            with session_scope(self.engine) as session:
                return self._representation(session.get(PreferenceRow, actor_id))
        except SQLAlchemyError as error:
            log.exception("Could not read preferences")
            raise ApiFailure(
                "Preferences are unavailable. Try again.", "preferences_unavailable", 503
            ) from error

    def update(self, actor_id: str, update: PreferenceUpdate, if_match: str | None) -> Preferences:
        """Persist only effective changes; a failed/stale write changes nothing."""
        if if_match is None:
            raise ApiFailure("Read preferences before saving.", "precondition_required", 428)
        try:
            with session_scope(self.engine, write=True) as session:
                if session.get(UserRow, actor_id) is None:
                    raise ApiFailure("Preferences are unavailable.", "preferences_unavailable", 503)
                row = session.get(PreferenceRow, actor_id)
                resetting = "copy_preamble" in update.reset
                # Explicit wildcard reset is also a recovery operation for unreadable rows.
                if not (resetting and if_match.strip() == "*"):
                    current = self._representation(row)
                    check_precondition(
                        if_match, current.etag(actor_id), "These preferences changed elsewhere."
                    )
                stored_preamble = row.copy_preamble if row is not None else None
                stored_share = row.share_include_preamble if row is not None else False
                preamble = stored_preamble
                if resetting:
                    preamble = None
                elif "copy_preamble" in update.model_fields_set:
                    preamble = update.copy_preamble
                share_include_preamble = stored_share
                if "share_include_preamble" in update.reset:
                    share_include_preamble = False
                elif update.share_include_preamble is not None:
                    share_include_preamble = update.share_include_preamble
                if preamble == stored_preamble and share_include_preamble == stored_share:
                    return self._representation(row)
                if row is None:
                    row = PreferenceRow(
                        user_id=actor_id,
                        copy_preamble=preamble,
                        share_include_preamble=share_include_preamble,
                        revision=2,
                    )
                    session.add(row)
                else:
                    row.copy_preamble = preamble
                    row.share_include_preamble = share_include_preamble
                    row.revision += 1
                return self._representation(row)
        except SQLAlchemyError as error:
            log.exception("Could not save preferences")
            raise ApiFailure(
                "Preferences could not be saved. Read them again before retrying.",
                "persistence_failed",
                503,
            ) from error
