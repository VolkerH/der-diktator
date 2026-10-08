"""Typed private group/placement contracts and their scoped validators."""

import unicodedata
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, computed_field, field_validator

from diktator.errors import ApiFailure


class GroupName(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        if any(unicodedata.category(character) in {"Cc", "Cs", "Zl", "Zp"} for character in value):
            raise ApiFailure(
                "Group names cannot contain controls or line breaks.", "invalid_group_name", 422
            )
        value = value.strip()
        if not 1 <= len(value) <= 80:
            raise ApiFailure(
                "A group name must contain 1 to 80 characters.", "invalid_group_name", 422
            )
        return value


class Group(BaseModel):
    """One actor's private group, with its validator available in lists."""

    id: str
    name: str
    created: datetime
    revision: int
    incarnation: str = Field(exclude=True, repr=False)

    @computed_field
    @property
    def etag(self) -> str:
        return f'"group-{self.incarnation}-{self.revision}"'


class PlacementUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    group_id: str | None = Field(pattern=r"^[0-9a-f]{32}$")


class ChatCreate(BaseModel):
    """Initial private placement; ignored when the chosen chat ID already exists."""

    model_config = ConfigDict(extra="forbid")
    group_id: str | None = Field(default=None, pattern=r"^[0-9a-f]{32}$")


class ChatPlacement(BaseModel):
    actor_id: str = Field(exclude=True, repr=False)
    chat_id: str
    group_id: str | None
    placement_revision: int
    incarnation: str = Field(exclude=True, repr=False)

    @computed_field
    @property
    def etag(self) -> str:
        actor = self.actor_id.encode().hex()
        return f'"placement-{self.incarnation}-{actor}-{self.placement_revision}"'


class GroupNotFound(ApiFailure):
    def __init__(self) -> None:
        super().__init__("This group no longer exists.", "group_not_found", 404)
