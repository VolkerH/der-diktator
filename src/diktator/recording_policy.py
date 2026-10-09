"""One validated startup policy shared by both services and discovery clients."""

import hashlib
import math
import os
from typing import Literal, Self, override

from pydantic import BaseModel, ConfigDict, computed_field, model_validator


class RecordingPolicy(BaseModel):
    """Enforcement and waiting budgets; changing these requires a process restart."""

    model_config = ConfigDict(frozen=True, strict=True, extra="forbid")
    protocol_version: Literal[1] = 1
    hard_limit_seconds: int = 600
    # Includes the usual 44-byte header and bounded optional WAV metadata. This
    # preserves the existing 20,000,044-byte upload ceiling at 600 seconds.
    wav_container_allowance_bytes: int = 800_044
    max_stream_frame_bytes: int = 65_536
    upload_timeout_seconds: float = 180.0
    batch_timeout_seconds: float = 180.0
    live_finalization_timeout_seconds: float = 180.0
    client_timeout_margin_seconds: float = 10.0

    @model_validator(mode="after")
    def valid_budgets(self) -> Self:
        if self.hard_limit_seconds < 60 or self.hard_limit_seconds % 60:
            raise ValueError("Recording ceiling must be whole minutes, at least 60 seconds.")
        if not 44 <= self.wav_container_allowance_bytes <= 1_048_576:
            raise ValueError("WAV container allowance must be between 44 and 1048576 bytes.")
        if not 2 <= self.max_stream_frame_bytes <= 1_048_576 or self.max_stream_frame_bytes % 2:
            raise ValueError("Stream frame budget must be even and between 2 and 1048576 bytes.")
        for value in (
            self.upload_timeout_seconds,
            self.batch_timeout_seconds,
            self.live_finalization_timeout_seconds,
            self.client_timeout_margin_seconds,
        ):
            if not math.isfinite(value) or value <= 0:
                raise ValueError("Timeout budgets must be positive finite seconds.")
        # Browser timer APIs use a signed 32-bit millisecond delay. A finite
        # operator budget can still overflow that clock and fire immediately.
        client_deadlines = (
            2 * self.upload_timeout_seconds
            + self.batch_timeout_seconds
            + 3 * self.client_timeout_margin_seconds,
            self.live_finalization_timeout_seconds + 2 * self.client_timeout_margin_seconds,
        )
        if max(client_deadlines) > 2_147_483.647:
            raise ValueError("Combined browser deadlines exceed the supported timer range.")
        return self

    @computed_field
    @property
    def max_pcm_bytes(self) -> int:
        return self.hard_limit_seconds * 16_000 * 2

    @computed_field
    @property
    def max_audio_bytes(self) -> int:
        return self.max_pcm_bytes + self.wav_container_allowance_bytes

    @computed_field
    @property
    def policy_revision(self) -> str:
        canonical = self.model_dump_json(exclude={"policy_revision"})
        return hashlib.sha256(canonical.encode()).hexdigest()

    @classmethod
    def from_environment(cls) -> Self:
        values: dict[str, int | float] = {}
        for name in cls.model_fields:
            if name == "protocol_version":
                continue
            configured = os.environ.get(f"DIKTATOR_{name.upper()}")
            # The duration's explicit name distinguishes it from a future interval preference.
            if name == "hard_limit_seconds":
                configured = os.environ.get("DIKTATOR_RECORDING_HARD_LIMIT_SECONDS")
            if configured is not None:
                values[name] = float(configured) if "timeout" in name else int(configured)
        return cls.model_validate(values)


class EngineRecordingPolicy(RecordingPolicy):
    """Wire policy, including derived fields checked rather than trusted by the web."""

    @classmethod
    def from_wire(cls, payload: object) -> Self:
        if not isinstance(payload, dict):
            raise ValueError("Missing engine recording policy.")
        declared = {key: payload[key] for key in cls.model_fields if key in payload}
        if set(declared) != set(cls.model_fields):
            raise ValueError("Incomplete engine recording policy.")
        result = cls.model_validate(declared)
        if result.model_dump() != payload:
            raise ValueError("Invalid engine recording policy revision or derived budgets.")
        return result


class PublicRecordingPolicy(RecordingPolicy):
    """Agreed limits with the validator of one read of the shared local preferences."""

    preference_etag: str

    @computed_field
    @property
    @override
    def policy_revision(self) -> str:
        # The preference validator is a separate contract and cannot change the
        # web/engine agreement hash. PR2 may add resolved interval fields here.
        return RecordingPolicy.model_validate(
            {key: getattr(self, key) for key in RecordingPolicy.model_fields}
        ).policy_revision
