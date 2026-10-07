"""Relay bounded browser PCM and live transcripts to the persistent engine."""

import asyncio
import json
from collections.abc import AsyncIterator, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from typing import Protocol
from urllib.parse import urlsplit, urlunsplit

from fastapi import WebSocket, WebSocketDisconnect
from websockets.asyncio.client import connect

from diktator.config import Settings


class EngineStream(Protocol):
    """Only the operations needed from an upstream WebSocket connection."""

    async def send(self, message: str | bytes) -> None: ...

    async def recv(self) -> str | bytes: ...


StreamConnector = Callable[[str], AbstractAsyncContextManager[EngineStream]]


class StreamError(Exception):
    """A refused audio frame or malformed engine response."""


def stream_url(engine_url: str) -> str:
    """Use the configured inference host for its matching WebSocket endpoint."""
    parts = urlsplit(engine_url)
    if parts.scheme not in {"http", "https"} or not parts.netloc:
        raise ValueError("The inference endpoint must be an HTTP or HTTPS URL.")
    scheme = "wss" if parts.scheme == "https" else "ws"
    return urlunsplit((scheme, parts.netloc, "/v1/audio/stream", "", ""))


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


async def relay_stream(browser: WebSocket, engine: EngineStream, settings: Settings) -> None:
    """Run both directions concurrently, keeping the engine open through finalization."""

    async def upload_audio() -> None:
        received_bytes = 0
        max_bytes = settings.max_duration_seconds * 16_000 * 2
        while True:
            frame = await browser.receive()
            if frame["type"] == "websocket.disconnect":
                raise WebSocketDisconnect(frame.get("code", 1000))
            audio = frame.get("bytes")
            if audio is not None:
                if len(audio) > settings.max_stream_frame_bytes:
                    raise StreamError("An audio frame was too large. Stop recording and retry.")
                received_bytes += len(audio)
                if received_bytes > max_bytes:
                    raise StreamError("The recording exceeds the allowed duration limit.")
                await engine.send(audio)
                continue
            try:
                control = json.loads(frame.get("text") or "")
            except ValueError as error:
                raise StreamError("Invalid live transcription control message.") from error
            if control != {"type": "end"}:
                raise StreamError("Only an end message is accepted during recording.")
            await engine.send(json.dumps(control))
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
            async with asyncio.timeout(settings.transcription_timeout_seconds):
                await transcripts
    finally:
        upload.cancel()
        transcripts.cancel()
        await asyncio.gather(upload, transcripts, return_exceptions=True)
