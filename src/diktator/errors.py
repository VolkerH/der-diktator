"""Shared public error envelopes and the safe inference-error boundary."""

from typing import Literal

from fastapi import FastAPI, Request, WebSocket
from fastapi.exceptions import RequestValidationError, WebSocketRequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict
from starlette.exceptions import HTTPException


class ApiError(BaseModel):
    """An actionable public failure; context never contains internal diagnostics."""

    model_config = ConfigDict(strict=True)
    detail: str
    code: str
    context: dict[str, object] | None = None


class ApiFailure(Exception):
    """Carry a public code, status and message without coupling services to HTTP."""

    def __init__(
        self, detail: str, code: str, status_code: int, context: dict[str, object] | None = None
    ) -> None:
        super().__init__(detail)
        self.code = code
        self.status_code = status_code
        self.context = context

    def envelope(self) -> ApiError:
        return ApiError(detail=str(self), code=self.code, context=self.context)


class StreamErrorEvent(BaseModel):
    """Terminal live failure. Clients retain captured audio for an explicit retry."""

    type: Literal["error"] = "error"
    message: str
    code: str | None = None


# Shared engine messages are authored here, never copied from upstream diagnostics.
# Both model admission and the public mapper use these canonical definitions.
ENGINE_ERRORS: dict[str, tuple[int, str]] = {
    "model_busy": (409, "The engine is busy. Finish the recording or model operation first."),
    "model_loading": (409, "The model is loading. Wait for it to become ready."),
    "model_deleting": (409, "A model is being deleted. Wait for it to finish."),
    "model_not_active": (409, "The selected model is not active. Choose Use model and retry."),
    "model_not_installed": (409, "Download this model before using it."),
    "live_transcription_unsupported": (
        409,
        "This model transcribes after recording. Turn off Live text.",
    ),
    "model_conflict": (
        409,
        "The model operation conflicts with the engine state. Refresh and retry.",
    ),
    "audio_too_large": (413, "The recording exceeds the engine's audio limit."),
    "unsupported_audio": (415, "Send the recording as PCM WAV audio."),
    "invalid_audio": (400, "The engine rejected the audio. Check the recording format and limits."),
    "validation_error": (422, "The engine rejected the request fields."),
    "engine_unavailable": (503, "The transcription engine is not ready. Try again shortly."),
    "engine_timeout": (504, "Transcription timed out. Stop recording and retry transcription."),
    "engine_error": (502, "The transcription engine could not process the audio."),
}


def engine_failure(code: object, status_code: int | None = None) -> ApiFailure:
    """Accept only registered codes with matching HTTP status; discard upstream text."""
    entry = ENGINE_ERRORS.get(code) if isinstance(code, str) else None
    if entry is None or (status_code is not None and status_code != entry[0]):
        code = "engine_error"
        entry = ENGINE_ERRORS[code]
    return ApiFailure(entry[1], str(code), entry[0])


def error_responses(*statuses: int) -> dict[int | str, dict[str, object]]:
    """Declare the same envelope used by the handlers in OpenAPI."""
    return {status: {"model": ApiError} for status in statuses}


def validation_context(
    error: RequestValidationError | WebSocketRequestValidationError,
) -> dict[str, object]:
    """Keep field diagnostics, omitting submitted values and exception objects."""
    return {
        "errors": [
            {key: item[key] for key in ("type", "loc", "msg") if key in item}
            for item in error.errors()
        ]
    }


def install_error_handlers(app: FastAPI) -> None:
    """Apply the envelope to application, routing and request-validation failures."""

    @app.exception_handler(ApiFailure)
    async def failure(_request: Request, error: ApiFailure) -> JSONResponse:
        return JSONResponse(
            error.envelope().model_dump(exclude_none=True), status_code=error.status_code
        )

    @app.exception_handler(HTTPException)
    async def http_error(_request: Request, error: HTTPException) -> JSONResponse:
        code = {404: "not_found", 405: "method_not_allowed"}.get(error.status_code, "http_error")
        detail = error.detail if isinstance(error.detail, str) else "The request failed."
        return JSONResponse(
            ApiError(detail=detail, code=code).model_dump(exclude_none=True),
            status_code=error.status_code,
            headers=error.headers,
        )

    @app.exception_handler(RequestValidationError)
    async def invalid_request(_request: Request, error: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            ApiError(
                detail="The request fields are invalid.",
                code="validation_error",
                context=validation_context(error),
            ).model_dump(),
            status_code=422,
        )

    @app.exception_handler(WebSocketRequestValidationError)
    async def invalid_stream(socket: WebSocket, _error: WebSocketRequestValidationError) -> None:
        await socket.accept()
        await socket.send_json(
            StreamErrorEvent(
                message="The request fields are invalid.", code="validation_error"
            ).model_dump(exclude_none=True)
        )
        await socket.close(code=1008)
