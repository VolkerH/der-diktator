"""Typed boundary to Fermion's persistent HTTP inference server."""

import httpx
from pydantic import BaseModel, ConfigDict, ValidationError


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
        """Check that the healthy server actually serves Phonon-2."""
        try:
            response = await self.client.get("/health", timeout=2.0)
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, ValueError):
            return False
        return (
            isinstance(payload, dict)
            and payload.get("status") == "ok"
            and payload.get("model") in ("phonon-2", "FermionResearch/Phonon-2")
        )

    async def transcribe(self, audio: bytes) -> Transcription:
        """Send an in-memory WAV upload and reject malformed upstream responses."""
        try:
            response = await self.client.post(
                "/v1/audio/transcriptions",
                files={"file": ("recording.wav", audio, "audio/wav")},
                data={"model": "phonon-2", "response_format": "json"},
            )
            response.raise_for_status()
        except httpx.TimeoutException as error:
            raise EngineUnavailable("Transcription timed out. Try again.", 504) from error
        except httpx.HTTPStatusError as error:
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
