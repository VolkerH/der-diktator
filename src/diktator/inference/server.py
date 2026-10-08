"""Loopback model service; model management and inference share one owner."""

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from starlette.websockets import WebSocketState
from websockets.exceptions import WebSocketException

from diktator.audio import validate_recording
from diktator.config import Settings
from diktator.engine import Transcription
from diktator.errors import (
    ApiFailure,
    StreamErrorEvent,
    engine_failure,
    error_responses,
    install_error_handlers,
)
from diktator.inference.manager import ModelConflict, ModelManager
from diktator.inference.store import ModelStore, exclusive_lock, models_directory
from diktator.models import ModelId, ModelsStatus
from diktator.streaming import StreamError, connect_engine, relay_stream, stream_url

logger = logging.getLogger(__name__)


def create_engine(manager: ModelManager | None = None) -> FastAPI:
    """Inject a manager for tests without loading or downloading any model."""
    manager = manager or ModelManager(ModelStore(models_directory()))
    settings = Settings()

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        # Selection and loaded models belong to exactly one service per store.
        with exclusive_lock(manager.store.root / ".service.lock"):
            await manager.start()
            try:
                yield
            finally:
                await manager.close()

    app = FastAPI(title="Diktator model service", lifespan=lifespan)
    install_error_handlers(app)

    @app.get("/models")
    async def models() -> ModelsStatus:
        return manager.status()

    @app.get("/health")
    async def health() -> dict[str, str | None]:
        state = manager.status()
        ready = any(model.state == "ready" for model in state.models)
        return {"status": "ok" if ready else "waiting", "model": state.active}

    @app.post("/models/{model_id}/download", status_code=202, responses=error_responses(409, 422))
    async def download(model_id: ModelId) -> ModelsStatus:
        manager.download(model_id)
        return manager.status()

    @app.post("/models/{model_id}/activate", status_code=202, responses=error_responses(409, 422))
    async def activate(model_id: ModelId) -> ModelsStatus:
        manager.activate(model_id)
        return manager.status()

    @app.post("/models/{model_id}/delete", status_code=202, responses=error_responses(409, 422))
    async def delete(model_id: ModelId) -> ModelsStatus:
        manager.delete(model_id)
        return manager.status()

    @app.post("/transcribe", responses=error_responses(400, 409, 413, 422, 502))
    async def transcribe(request: Request, model: ModelId) -> Transcription:
        audio = bytearray()
        async for chunk in request.stream():
            audio.extend(chunk)
            if len(audio) > settings.max_audio_bytes:
                raise ApiFailure(
                    f"The recording is too large. The limit is {settings.max_audio_bytes} bytes.",
                    "audio_too_large",
                    413,
                )
        try:
            validate_recording(bytes(audio), max_duration_seconds=settings.max_duration_seconds)
        except ValueError as error:
            raise ApiFailure(str(error), "invalid_audio", 400) from error
        try:
            return Transcription(text=await manager.transcribe(model, bytes(audio)))
        except ModelConflict:
            raise
        except Exception as error:
            logger.exception("Transcription failed")
            raise ApiFailure(
                "Transcription failed. The recording can be retried.", "engine_error", 502
            ) from error

    @app.websocket("/v1/audio/stream")
    async def live(browser: WebSocket, model: ModelId = "phonon-2") -> None:
        await browser.accept()
        try:
            async with (
                manager.stream(model) as endpoint,
                connect_engine(stream_url(endpoint)) as upstream,
            ):
                # The web service already sent this one fixed configuration.
                config = await browser.receive_json()
                if config != {"sample_rate": 16000, "format": "pcm_s16le"}:
                    raise StreamError("Unsupported live audio format.", "unsupported_audio", 415)
                await upstream.send('{"sample_rate":16000,"format":"pcm_s16le"}')
                await relay_stream(browser, upstream, settings)
        except WebSocketDisconnect:
            pass
        except (
            ModelConflict,
            StreamError,
            OSError,
            TimeoutError,
            ValueError,
            WebSocketException,
        ) as error:
            failure = (
                error
                if isinstance(error, (ModelConflict, StreamError))
                else engine_failure(
                    "engine_timeout"
                    if isinstance(error, TimeoutError)
                    else "engine_unavailable"
                    if isinstance(error, (OSError, WebSocketException))
                    else "engine_error"
                )
            )
            with suppress(WebSocketDisconnect, RuntimeError):
                await browser.send_json(
                    StreamErrorEvent(message=str(failure), code=failure.code).model_dump()
                )
        finally:
            if browser.application_state == WebSocketState.CONNECTED:
                with suppress(WebSocketDisconnect, RuntimeError):
                    await browser.close()

    return app
