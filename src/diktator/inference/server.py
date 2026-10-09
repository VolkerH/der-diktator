"""Loopback model service; model management and inference share one owner."""

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI, Header, Request, WebSocket, WebSocketDisconnect
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
from diktator.recording_policy import RecordingPolicy
from diktator.streaming import (
    StreamError,
    connect_engine,
    relay_stream,
    stream_failure,
    stream_url,
)

logger = logging.getLogger(__name__)


def create_engine(manager: ModelManager | None = None, settings: Settings | None = None) -> FastAPI:
    """Inject a manager for tests without loading or downloading any model."""
    manager = manager or ModelManager(ModelStore(models_directory()))
    settings = settings or Settings.from_environment()

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

    def require_revision(revision: str | None) -> None:
        if revision is not None and revision != settings.recording_policy.policy_revision:
            raise engine_failure("configuration_mismatch")

    @app.get("/recording-policy")
    async def recording_policy() -> RecordingPolicy:
        return settings.recording_policy

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

    @app.post("/transcribe", responses=error_responses(400, 408, 409, 413, 422, 502, 503, 504))
    async def transcribe(
        request: Request,
        model: ModelId,
        x_recording_policy_revision: str | None = Header(default=None),
    ) -> Transcription:
        require_revision(x_recording_policy_revision)
        audio = bytearray()
        try:
            async with asyncio.timeout(settings.recording_policy.upload_timeout_seconds):
                async for chunk in request.stream():
                    audio.extend(chunk)
                    if len(audio) > settings.max_audio_bytes:
                        raise ApiFailure(
                            "The recording is too large. "
                            f"The limit is {settings.max_audio_bytes} bytes.",
                            "audio_too_large",
                            413,
                        )
        except TimeoutError as error:
            raise ApiFailure(
                "Audio upload timed out. Keep the recording and retry saving.",
                "upload_timeout",
                408,
            ) from error
        try:
            validate_recording(bytes(audio), max_duration_seconds=settings.max_duration_seconds)
        except ValueError as error:
            raise ApiFailure(str(error), "invalid_audio", 400) from error
        try:
            async with asyncio.timeout(settings.recording_policy.batch_timeout_seconds):
                return Transcription(text=await manager.transcribe(model, bytes(audio)))
        except ModelConflict:
            raise
        except TimeoutError as error:
            raise engine_failure("engine_timeout") from error
        except Exception as error:
            logger.exception("Transcription failed")
            raise ApiFailure(
                "Transcription failed. The recording can be retried.", "engine_error", 502
            ) from error

    @app.websocket("/v1/audio/stream")
    async def live(
        browser: WebSocket, model: ModelId = "phonon-2", policy_revision: str | None = None
    ) -> None:
        await browser.accept()
        try:
            require_revision(policy_revision)
            async with (
                manager.stream(model) as reservation,
                connect_engine(stream_url(reservation.endpoint)) as upstream,
            ):
                # Require a text configuration before accepting binary PCM frames.
                frame = await browser.receive()
                if frame["type"] == "websocket.disconnect":
                    raise WebSocketDisconnect(frame.get("code", 1000))
                configuration = frame.get("text")
                if not isinstance(configuration, str):
                    raise StreamError(
                        "Send a text configuration before live audio.", "validation_error", 422
                    )
                try:
                    config = json.loads(configuration)
                except ValueError as error:
                    raise StreamError(
                        "Invalid live audio configuration.", "validation_error", 422
                    ) from error
                if config != {"sample_rate": 16000, "format": "pcm_s16le"}:
                    raise StreamError("Unsupported live audio format.", "unsupported_audio", 415)
                # Fermion 0.2.10 warms the decoder on configuration. Keep it
                # idle until capture actually supplies PCM or an end control.
                await relay_stream(
                    browser,
                    upstream,
                    settings,
                    on_done=reservation.complete,
                    on_forward=reservation.forward,
                    initial_message='{"sample_rate":16000,"format":"pcm_s16le"}',
                )
        except WebSocketDisconnect:
            pass
        except (
            ApiFailure,
            StreamError,
            OSError,
            TimeoutError,
            ValueError,
            WebSocketException,
        ) as error:
            failure = stream_failure(error)
            with suppress(WebSocketDisconnect, RuntimeError):
                await browser.send_json(
                    StreamErrorEvent(message=str(failure), code=failure.code).model_dump()
                )
        finally:
            if browser.application_state == WebSocketState.CONNECTED:
                with suppress(WebSocketDisconnect, RuntimeError):
                    await browser.close()

    return app
