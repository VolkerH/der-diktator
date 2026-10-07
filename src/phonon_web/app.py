"""Serve the browser interface and bounded audio uploads from the same origin."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import Response
from starlette.websockets import WebSocketState
from websockets.exceptions import WebSocketException

from phonon_web.audio import validate_recording
from phonon_web.config import Settings
from phonon_web.engine import EngineClient, EngineUnavailable, Transcription
from phonon_web.streaming import (
    StreamConnector,
    StreamError,
    connect_engine,
    relay_stream,
    stream_url,
)

STATIC_DIRECTORY = Path(__file__).parent / "static"


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
    # The bundled interface is small: load once rather than reading files per request.
    html = (STATIC_DIRECTORY / "index.html").read_bytes()
    assets = {
        path.name: path.read_bytes()
        for path in STATIC_DIRECTORY.iterdir()
        if path.suffix in {".js", ".css"}
    }

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        async with client:
            yield

    app = FastAPI(title="Phonon dictation", lifespan=lifespan)

    @app.get("/", include_in_schema=False)
    async def index() -> Response:
        return Response(html, media_type="text/html")

    @app.get("/assets/{filename}", include_in_schema=False)
    async def asset(filename: str) -> Response:
        content = assets.get(filename)
        if content is None:
            raise HTTPException(404, "Asset not found.")
        media_type = "text/css" if filename.endswith(".css") else "text/javascript"
        return Response(content, media_type=media_type)

    @app.get("/api/health")
    async def health() -> dict[str, bool | int]:
        return {
            "ready": await engine.is_ready(),
            "max_duration_seconds": settings.max_duration_seconds,
        }

    @app.post("/api/transcribe")
    async def transcribe(request: Request) -> Transcription:
        content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if content_type not in {"audio/wav", "audio/x-wav"}:
            raise HTTPException(415, "Send the recording as PCM WAV audio.")
        audio = bytearray()
        async for chunk in request.stream():
            if len(audio) + len(chunk) > settings.max_audio_bytes:
                raise HTTPException(413, "The recording is too large. Keep it under ten minutes.")
            audio.extend(chunk)
        recording = bytes(audio)
        try:
            validate_recording(recording, max_duration_seconds=settings.max_duration_seconds)
        except ValueError as error:
            raise HTTPException(400, str(error)) from error
        try:
            return await engine.transcribe(recording)
        except EngineUnavailable as error:
            raise HTTPException(error.status_code, str(error)) from error

    @app.websocket("/api/stream")
    async def live_transcription(browser: WebSocket) -> None:
        await browser.accept()
        try:
            async with stream_connector(stream_url(settings.engine_url)) as upstream:
                await upstream.send('{"sample_rate":16000,"format":"pcm_s16le"}')
                await browser.send_json({"type": "ready"})
                await relay_stream(browser, upstream, settings)
        except WebSocketDisconnect:
            pass
        except (OSError, TimeoutError, WebSocketException, StreamError, ValueError) as error:
            message = (
                str(error)
                if isinstance(error, StreamError)
                else "Live transcription is unavailable. Stop recording and retry transcription."
            )
            if (
                browser.client_state == WebSocketState.CONNECTED
                and browser.application_state == WebSocketState.CONNECTED
            ):
                with suppress(WebSocketDisconnect):
                    await browser.send_json({"type": "error", "message": message})
        finally:
            if (
                browser.client_state == WebSocketState.CONNECTED
                and browser.application_state == WebSocketState.CONNECTED
            ):
                with suppress(WebSocketDisconnect):
                    await browser.close()

    return app
