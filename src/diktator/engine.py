"""Typed boundary to Fermion's persistent HTTP inference server."""

from typing import Literal

import httpx
from pydantic import BaseModel, ConfigDict, ValidationError

from diktator.models import ModelId, ModelsStatus


class Transcription(BaseModel):
    """The transcript returned to the browser."""

    model_config = ConfigDict(strict=True)
    text: str


class EngineUnavailable(Exception):
    """An inference request failed with a message suitable for the interface."""

    def __init__(self, message: str, status_code: int = 503) -> None:
        super().__init__(message)
        self.status_code = status_code


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

    async def transcribe(self, audio: bytes, model: ModelId = "phonon-2") -> Transcription:
        """Send an in-memory WAV upload and reject malformed upstream responses."""
        try:
            response = await self.client.post(
                "/transcribe",
                params={"model": model},
                content=audio,
                headers={"Content-Type": "audio/wav"},
            )
            response.raise_for_status()
        except httpx.TimeoutException as error:
            raise EngineUnavailable("Transcription timed out. Try again.", 504) from error
        except httpx.HTTPStatusError as error:
            if error.response.status_code == 409:
                raise EngineUnavailable(self.conflict_message(error.response), 409) from error
            status = 503 if error.response.status_code == 503 else 502
            raise EngineUnavailable(
                "The transcription engine could not process the audio.", status
            ) from error
        except httpx.RequestError as error:
            raise EngineUnavailable(
                "The transcription engine is not ready. Try again shortly."
            ) from error
        try:
            return Transcription.model_validate(response.json())
        except (ValueError, ValidationError) as error:
            raise EngineUnavailable(
                "The transcription engine returned an invalid response.", 502
            ) from error

    @staticmethod
    def conflict_message(response: httpx.Response) -> str:
        """Preserve actionable model conflicts, without leaking arbitrary errors."""
        try:
            detail = response.json().get("detail")
            if isinstance(detail, str):
                return detail
        except (ValueError, AttributeError):
            pass
        return "The engine is busy or a different model is active. Retry shortly."

    async def models(
        self,
        model: ModelId | None = None,
        action: Literal["download", "activate", "delete"] | None = None,
    ) -> ModelsStatus:
        """Fetch state or start one explicit model action."""
        try:
            response = (
                await self.client.get("/models", timeout=3)
                if action is None
                else await self.client.post(f"/models/{model}/{action}", timeout=5)
            )
            if response.status_code == 409:
                raise EngineUnavailable(self.conflict_message(response), 409)
            response.raise_for_status()
            return ModelsStatus.model_validate(response.json())
        except (httpx.HTTPError, ValueError, ValidationError) as error:
            raise EngineUnavailable(
                "The model service is unavailable. Check that make run is running."
            ) from error
