"""Relay bounded browser PCM and live transcripts to the persistent engine."""

import asyncio
import json
import logging
from collections.abc import AsyncIterator, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from typing import Protocol
from urllib.parse import urlsplit, urlunsplit

from fastapi import WebSocket, WebSocketDisconnect
from websockets.asyncio.client import connect
from websockets.exceptions import WebSocketException

from diktator.config import Settings
from diktator.errors import ApiFailure, StreamErrorEvent, engine_failure
from diktator.models import ModelId

logger = logging.getLogger(__name__)


class EngineStream(Protocol):
    """Only the operations needed from an upstream WebSocket connection."""

    async def send(self, message: str | bytes) -> None: ...

    async def recv(self) -> str | bytes: ...


StreamConnector = Callable[[str], AbstractAsyncContextManager[EngineStream]]


class StreamError(ApiFailure):
    """A refused audio frame or malformed engine response."""

    def __init__(self, message: str, code: str = "engine_error", status_code: int = 502) -> None:
        # Retain the HTTP classification for shared failures. StreamErrorEvent sends
        # only message/code; no HTTP status is sent after the WebSocket is accepted.
        super().__init__(message, code, status_code)


def stream_failure(error: Exception) -> ApiFailure:
    """Keep local coded failures; sanitize transport and protocol diagnostics."""
    if isinstance(error, ApiFailure):
        return error
    if isinstance(error, TimeoutError):
        return engine_failure("engine_timeout")
    if isinstance(error, (OSError, WebSocketException)):
        return engine_failure("engine_unavailable")
    return engine_failure("engine_error")


def stream_url(
    engine_url: str, model: ModelId | None = None, policy_revision: str | None = None
) -> str:
    """Use the configured inference host for its matching WebSocket endpoint."""
    parts = urlsplit(engine_url)
    if parts.scheme not in {"http", "https"} or not parts.netloc:
        raise ValueError("The inference endpoint must be an HTTP or HTTPS URL.")
    scheme = "wss" if parts.scheme == "https" else "ws"
    query = f"model={model}" if model else ""
    if policy_revision:
        query += (
            f"&policy_revision={policy_revision}" if query else f"policy_revision={policy_revision}"
        )
    return urlunsplit((scheme, parts.netloc, "/v1/audio/stream", query, ""))


@asynccontextmanager
async def connect_engine(url: str) -> AsyncIterator[EngineStream]:
    """Disable compression, fragmentation, and environment proxies for local PCM."""
    async with connect(
        url,
        proxy=None,
        compression=None,
        open_timeout=10,
        close_timeout=2,
        max_size=1_048_576,
        # Fermion answers pings between synchronous decodes; a slow CPU decode
        # must not be mistaken for a dead connection. Finalization is timed below.
        ping_interval=None,
    ) as connection:
        yield connection


async def relay_stream(
    browser: WebSocket,
    engine: EngineStream,
    settings: Settings,
    *,
    on_done: Callable[[], None] | None = None,
    on_forward: Callable[[], None] | None = None,
    initial_message: str | None = None,
    finalization_margin_seconds: float = 0,
) -> None:
    """Run both directions concurrently, keeping the engine open through finalization."""

    async def upload_audio() -> None:
        received_bytes = 0
        max_bytes = settings.max_duration_seconds * 16_000 * 2
        initialized = False

        async def forward(message: str | bytes) -> None:
            nonlocal initialized
            # Mark uncertain native ownership before either send: a failed
            # write can still have delivered data to the decoder.
            if on_forward is not None:
                on_forward()
            if not initialized and initial_message is not None:
                await engine.send(initial_message)
            initialized = True
            await engine.send(message)

        while True:
            frame = await browser.receive()
            if frame["type"] == "websocket.disconnect":
                raise WebSocketDisconnect(frame.get("code", 1000))
            audio = frame.get("bytes")
            if audio is not None:
                if len(audio) > settings.max_stream_frame_bytes:
                    raise StreamError(
                        "An audio frame was too large. Stop recording and retry.",
                        "audio_too_large",
                        413,
                    )
                if len(audio) % 2:
                    raise StreamError(
                        "PCM frames must contain whole 16-bit samples.", "invalid_audio", 400
                    )
                received_bytes += len(audio)
                if received_bytes > max_bytes:
                    raise StreamError(
                        "The recording exceeds the allowed duration limit.", "invalid_audio", 400
                    )
                if audio:
                    await forward(audio)
                continue
            try:
                control = json.loads(frame.get("text") or "")
            except ValueError as error:
                raise StreamError(
                    "Invalid live transcription control message.", "validation_error", 422
                ) from error
            if control != {"type": "end"}:
                raise StreamError(
                    "Only an end message is accepted during recording.", "validation_error", 422
                )
            await forward(json.dumps(control))
            return

    async def receive_transcripts() -> None:
        while True:
            message = await engine.recv()
            try:
                event = json.loads(message)
            except ValueError as error:
                raise StreamError("The engine returned an invalid live transcript.") from error
            if not isinstance(event, dict) or event.get("type") not in (
                "partial",
                "final",
                "done",
                "error",
            ):
                raise StreamError("The engine returned an unknown live event.")
            field = "message" if event["type"] == "error" else "text"
            if not isinstance(event.get(field), str):
                raise StreamError("The engine returned an invalid live transcript.")
            if event["type"] == "error":
                logger.warning(
                    "Upstream live error (code=%r): %r", event.get("code"), event["message"]
                )
                failure = engine_failure(event.get("code"))
                event = StreamErrorEvent(message=str(failure), code=failure.code).model_dump()
            if event["type"] == "done" and on_done is not None:
                on_done()
            await browser.send_json(event)
            if event["type"] in {"done", "error"}:
                return

    upload = asyncio.create_task(upload_audio())
    transcripts = asyncio.create_task(receive_transcripts())
    try:
        completed, _pending = await asyncio.wait(
            {upload, transcripts}, return_when=asyncio.FIRST_COMPLETED
        )
        for task in completed:
            task.result()
        if transcripts not in completed:
            async with asyncio.timeout(
                settings.recording_policy.live_finalization_timeout_seconds
                + finalization_margin_seconds
            ):
                await transcripts
    finally:
        upload.cancel()
        transcripts.cancel()
        await asyncio.gather(upload, transcripts, return_exceptions=True)
