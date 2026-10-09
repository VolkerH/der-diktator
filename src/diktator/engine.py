"""Typed boundary to Fermion's persistent HTTP inference server."""

from typing import Literal

import httpx
from pydantic import BaseModel, ConfigDict, ValidationError

from diktator.errors import ApiError, engine_failure
from diktator.models import ModelId, ModelsStatus
from diktator.recording_policy import EngineRecordingPolicy, RecordingPolicy


class Transcription(BaseModel):
    """The transcript returned to the browser."""

    model_config = ConfigDict(strict=True)
    text: str


class EngineClient:
    """Reuse one HTTP client while the upstream process keeps its model loaded."""

    def __init__(self, client: httpx.AsyncClient) -> None:
        self.client = client

    async def is_ready(self) -> bool:
        """Check that the healthy service serves a supported speech model."""
        try:
            response = await self.client.get("/health", timeout=2.0)
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, ValueError):
            return False
        return (
            isinstance(payload, dict)
            and payload.get("status") == "ok"
            and payload.get("model") in ("phonon-2", "FermionResearch/Phonon-2", "parakeet-v3")
        )

    async def _request(
        self,
        method: str,
        path: str,
        *,
        audio: bytes | None = None,
        model: ModelId | None = None,
        timeout: float | None = None,
        policy_revision: str | None = None,
    ) -> httpx.Response:
        """Classify upstream failures once for transcription and model operations."""
        try:
            response = await self.client.request(
                method,
                path,
                content=audio,
                params={"model": model} if model is not None else None,
                headers=(
                    {
                        "Content-Type": "audio/wav",
                        **(
                            {"X-Recording-Policy-Revision": policy_revision}
                            if policy_revision
                            else {}
                        ),
                    }
                    if audio is not None
                    else None
                ),
                timeout=self.client.timeout if timeout is None else timeout,
            )
        except httpx.TimeoutException as error:
            raise engine_failure("engine_timeout") from error
        except httpx.RequestError as error:
            raise engine_failure("engine_unavailable") from error
        if response.is_success:
            return response
        try:
            payload = response.json()
        except ValueError:
            payload = None
        if isinstance(payload, dict) and "code" in payload:
            # A coded envelope must be well formed and agree with its status.
            try:
                envelope = ApiError.model_validate(payload)
            except ValidationError as error:
                raise engine_failure("engine_error") from error
            failure = engine_failure(envelope.code, response.status_code)
            # Only transcription accepts audio; these codes cannot describe a model request.
            if audio is None and failure.code in {
                "invalid_audio",
                "upload_timeout",
                "audio_too_large",
                "unsupported_audio",
            }:
                failure = engine_failure("engine_error")
            raise failure
        if response.status_code == 409:
            raise engine_failure("model_conflict")
        if response.status_code == 503:
            raise engine_failure("engine_unavailable")
        raise engine_failure("engine_error")

    async def recording_policy(self, expected: RecordingPolicy) -> EngineRecordingPolicy:
        """Fail closed for old/malformed engines and mismatched startup configuration."""
        try:
            response = await self.client.get("/recording-policy", timeout=3)
        except httpx.TimeoutException as error:
            raise engine_failure("engine_timeout") from error
        except httpx.RequestError as error:
            raise engine_failure("engine_unavailable") from error
        if response.status_code in {404, 405}:
            raise engine_failure("configuration_mismatch")
        if not response.is_success:
            raise engine_failure("engine_unavailable")
        try:
            policy = EngineRecordingPolicy.from_wire(response.json())
        except (ValueError, ValidationError) as error:
            raise engine_failure("configuration_mismatch") from error
        if policy.model_dump() != expected.model_dump():
            raise engine_failure("configuration_mismatch")
        return policy

    async def transcribe(
        self, audio: bytes, model: ModelId = "phonon-2", *, policy: RecordingPolicy | None = None
    ) -> Transcription:
        """Send an in-memory WAV upload and reject malformed upstream responses."""
        if policy is not None:
            await self.recording_policy(policy)
        response = await self._request(
            "POST",
            "/transcribe",
            audio=audio,
            model=model,
            policy_revision=policy.policy_revision if policy else None,
        )
        try:
            return Transcription.model_validate(response.json())
        except (ValueError, ValidationError) as error:
            raise engine_failure("engine_error") from error

    async def models(
        self,
        model: ModelId | None = None,
        action: Literal["download", "activate", "delete"] | None = None,
    ) -> ModelsStatus:
        """Fetch state or start one explicit model action."""
        response = (
            await self._request("GET", "/models", timeout=3)
            if action is None
            else await self._request("POST", f"/models/{model}/{action}", timeout=5)
        )
        try:
            return ModelsStatus.model_validate(response.json())
        except (ValueError, ValidationError) as error:
            raise engine_failure("engine_error") from error
