"""Serve the browser interface and bounded audio uploads from the same origin."""

import pathlib
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from typing import Annotated

import httpx
from fastapi import FastAPI, HTTPException, Path, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import Response
from pydantic import BaseModel, Field
from starlette.websockets import WebSocketState
from websockets.exceptions import WebSocketException

from diktator.audio import RecordingInfo, validate_recording
from diktator.chats import Chat, ChatStore, ChatSummary, Recording
from diktator.config import Settings
from diktator.engine import EngineClient, Transcription
from diktator.errors import (
    ApiFailure,
    StreamErrorEvent,
    error_responses,
    install_error_handlers,
)
from diktator.models import ModelId, ModelsStatus
from diktator.streaming import (
    StreamConnector,
    StreamError,
    connect_engine,
    relay_stream,
    stream_failure,
    stream_url,
)

STATIC_DIRECTORY = pathlib.Path(__file__).parent / "static"
MEDIA_TYPES = {".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml"}
ChatId = Annotated[str, Path(pattern=r"^[0-9a-f]{32}$")]


def create_app(
    settings: Settings | None = None,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
    stream_connector: StreamConnector = connect_engine,
) -> FastAPI:
    """Create an application with injectable HTTP and streaming engine boundaries."""
    settings = settings or Settings.from_environment()
    client = httpx.AsyncClient(
        base_url=settings.engine_url,
        timeout=settings.transcription_timeout_seconds,
        transport=transport,
        trust_env=False,
    )
    engine = EngineClient(client)
    store = ChatStore(settings.data_directory)

    class TextUpdate(BaseModel):
        text: str = Field(max_length=settings.max_text_characters)

    # The bundled interface is small: load once rather than reading files per request.
    html = (STATIC_DIRECTORY / "index.html").read_bytes()
    assets = {
        path.name: path.read_bytes()
        for path in STATIC_DIRECTORY.iterdir()
        if path.suffix in MEDIA_TYPES
    }

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        async with client:
            yield

    app = FastAPI(title="Der Diktator", lifespan=lifespan)
    install_error_handlers(app)

    @app.get("/", include_in_schema=False)
    async def index() -> Response:
        return Response(html, media_type="text/html")

    @app.get("/assets/{filename}", include_in_schema=False)
    async def asset(filename: str) -> Response:
        content = assets.get(filename)
        if content is None:
            raise HTTPException(404, "Asset not found.")
        return Response(content, media_type=MEDIA_TYPES[pathlib.Path(filename).suffix])

    @app.get("/api/health")
    async def health() -> dict[str, bool | int]:
        return {
            "ready": await engine.is_ready(),
            "max_duration_seconds": settings.max_duration_seconds,
        }

    @app.get("/api/models", responses=error_responses(409, 422, 502, 503, 504))
    async def models() -> ModelsStatus:
        return await engine.models()

    @app.post(
        "/api/models/{model}/download",
        status_code=202,
        responses=error_responses(409, 422, 502, 503, 504),
    )
    async def download_model(model: ModelId) -> ModelsStatus:
        return await engine.models(model, "download")

    @app.post(
        "/api/models/{model}/activate",
        status_code=202,
        responses=error_responses(409, 422, 502, 503, 504),
    )
    async def activate_model(model: ModelId) -> ModelsStatus:
        return await engine.models(model, "activate")

    @app.post(
        "/api/models/{model}/delete",
        status_code=202,
        responses=error_responses(409, 422, 502, 503, 504),
    )
    async def delete_model(model: ModelId) -> ModelsStatus:
        return await engine.models(model, "delete")

    async def read_recording(request: Request) -> tuple[bytes, RecordingInfo]:
        content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if content_type not in {"audio/wav", "audio/x-wav"}:
            raise ApiFailure("Send the recording as PCM WAV audio.", "unsupported_audio", 415)
        audio = bytearray()
        async for chunk in request.stream():
            if len(audio) + len(chunk) > settings.max_audio_bytes:
                raise ApiFailure(
                    f"The recording is too large. The limit is {settings.max_audio_bytes} bytes.",
                    "audio_too_large",
                    413,
                )
            audio.extend(chunk)
        recording = bytes(audio)
        try:
            info = validate_recording(recording, max_duration_seconds=settings.max_duration_seconds)
        except ValueError as error:
            raise ApiFailure(str(error), "invalid_audio", 400) from error
        return recording, info

    @app.post("/api/transcribe", responses=error_responses(400, 409, 413, 415, 422, 502, 503, 504))
    async def transcribe(request: Request, model: ModelId = "phonon-2") -> Transcription:
        recording, _info = await read_recording(request)
        return await engine.transcribe(recording, model)

    @app.get("/api/chats")
    async def list_chats() -> list[ChatSummary]:
        return store.list()

    @app.post("/api/chats", status_code=201)
    async def create_chat() -> Chat:
        return store.create()

    @app.get("/api/chats/{chat_id}", responses=error_responses(404, 422))
    async def get_chat(chat_id: ChatId) -> Chat:
        return store.get(chat_id)

    @app.put("/api/chats/{chat_id}/text", responses=error_responses(404, 422))
    async def update_text(chat_id: ChatId, update: TextUpdate) -> Chat:
        return store.update_text(chat_id, update.text)

    @app.delete("/api/chats/{chat_id}", status_code=204, responses=error_responses(404, 422))
    async def delete_chat(chat_id: ChatId) -> None:
        store.delete(chat_id)

    @app.post(
        "/api/chats/{chat_id}/recordings",
        status_code=201,
        responses=error_responses(400, 404, 413, 415, 422),
    )
    async def add_recording(chat_id: ChatId, request: Request) -> Recording:
        store.get(chat_id)
        audio, info = await read_recording(request)
        return store.add_recording(chat_id, audio, info.duration_seconds)

    @app.get("/api/chats/{chat_id}/recordings/{recording_id}", responses=error_responses(404, 422))
    async def recording_audio(chat_id: ChatId, recording_id: ChatId) -> Response:
        return Response(store.recording_audio(chat_id, recording_id), media_type="audio/wav")

    @app.post(
        "/api/chats/{chat_id}/recordings/{recording_id}/transcribe",
        responses=error_responses(400, 404, 409, 413, 415, 422, 502, 503, 504),
    )
    async def transcribe_recording(
        chat_id: ChatId, recording_id: ChatId, model: ModelId = "phonon-2"
    ) -> Transcription:
        return await engine.transcribe(store.recording_audio(chat_id, recording_id), model)

    @app.websocket("/api/stream")
    async def live_transcription(browser: WebSocket, model: ModelId = "phonon-2") -> None:
        await browser.accept()
        try:
            async with stream_connector(stream_url(settings.engine_url, model)) as upstream:
                await upstream.send('{"sample_rate":16000,"format":"pcm_s16le"}')
                await browser.send_json({"type": "ready"})
                await relay_stream(browser, upstream, settings)
        except WebSocketDisconnect:
            pass
        except (OSError, TimeoutError, WebSocketException, StreamError, ValueError) as error:
            failure = stream_failure(error)
            if (
                browser.client_state == WebSocketState.CONNECTED
                and browser.application_state == WebSocketState.CONNECTED
            ):
                with suppress(WebSocketDisconnect):
                    await browser.send_json(
                        StreamErrorEvent(message=str(failure), code=failure.code).model_dump()
                    )
        finally:
            if (
                browser.client_state == WebSocketState.CONNECTED
                and browser.application_state == WebSocketState.CONNECTED
            ):
                with suppress(WebSocketDisconnect):
                    await browser.close()

    return app
