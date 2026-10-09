"""Public, non-secret limits from the running application's configuration snapshot."""

import hashlib
from typing import Literal

from pydantic import BaseModel, ConfigDict

from diktator.config import Settings


class EffectiveLimit(BaseModel):
    """A running limit; changes require operator configuration and a new process."""

    model_config = ConfigDict(frozen=True)
    id: Literal["recording_seconds", "audio_bytes", "text_characters"]
    label: str
    value: int
    unit: Literal["seconds", "bytes", "characters"]
    source: Literal["application_configuration"] = "application_configuration"
    editable: Literal[False] = False
    restart_required: Literal[True] = True


class EffectiveSettings(BaseModel):
    """Safe for any current client; contains no filesystem paths or network addresses."""

    model_config = ConfigDict(frozen=True)
    profile_scope: Literal["shared_local_profile"] = "shared_local_profile"
    operator_editable: Literal[False] = False
    model_selection: Literal["instance_model_api"] = "instance_model_api"
    upload_timeout_seconds: float
    client_timeout_margin_seconds: float
    client_upload_timeout_ms: int
    policy_revision: str
    limits: list[EffectiveLimit]


def effective_settings(settings: Settings) -> EffectiveSettings:
    """Describe web enforcement only; this does not attest an engine policy handshake."""
    limits = [
        EffectiveLimit(
            id="recording_seconds",
            label="Recording duration",
            value=settings.max_duration_seconds,
            unit="seconds",
        ),
        EffectiveLimit(
            id="audio_bytes",
            label="Audio upload size",
            value=settings.max_audio_bytes,
            unit="bytes",
        ),
        EffectiveLimit(
            id="text_characters",
            label="Transcript length",
            value=settings.max_text_characters,
            unit="characters",
        ),
    ]
    # Revision identifies this public snapshot, not an authorization or engine agreement.
    revision = hashlib.sha256(
        (
            "|".join(limit.model_dump_json() for limit in limits)
            + f"|{settings.recording_policy.upload_timeout_seconds}"
            + f"|{settings.recording_policy.client_timeout_margin_seconds}"
            + f"|{settings.recording_policy.client_deadlines_ms.upload}"
        ).encode()
    ).hexdigest()
    return EffectiveSettings(
        policy_revision=revision,
        limits=limits,
        upload_timeout_seconds=settings.recording_policy.upload_timeout_seconds,
        client_timeout_margin_seconds=settings.recording_policy.client_timeout_margin_seconds,
        client_upload_timeout_ms=settings.recording_policy.client_deadlines_ms.upload,
    )
