"""Exercise the real ASGI WebSocket route without opening network sockets."""

import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field

import pytest
from starlette.types import Message, Scope

from diktator.app import create_app
from diktator.config import Settings
from diktator.streaming import EngineStream, stream_url

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@dataclass
class FakeEngine:
    """Queues expose both sides of the inference boundary to each test."""

    incoming: asyncio.Queue[str | bytes] = field(default_factory=asyncio.Queue)
    sent: asyncio.Queue[str | bytes] = field(default_factory=asyncio.Queue)
    closed: bool = False
    receiving_cancelled: bool = False

    async def send(self, message: str | bytes) -> None:
        await self.sent.put(message)

    async def recv(self) -> str | bytes:
        try:
            return await self.incoming.get()
        except asyncio.CancelledError:
            self.receiving_cancelled = True
            raise


@dataclass
class BrowserSession:
    engine: FakeEngine
    incoming: asyncio.Queue[Message]
    outgoing: asyncio.Queue[Message]
    task: asyncio.Task[None]
    urls: list[str]

    async def receive(self) -> Message:
        return await asyncio.wait_for(self.outgoing.get(), timeout=2)

    async def event(self) -> dict[str, object]:
        message = await self.receive()
        assert message["type"] == "websocket.send"
        return json.loads(message["text"])

    async def audio(self, data: bytes) -> None:
        await self.incoming.put({"type": "websocket.receive", "bytes": data})

    async def end(self) -> None:
        await self.incoming.put({"type": "websocket.receive", "text": '{"type":"end"}'})


@asynccontextmanager
async def browser_for(
    settings: Settings | None = None,
    *,
    connection_error: bool = False,
    dropped_event: str | None = None,
) -> AsyncIterator[BrowserSession]:
    engine = FakeEngine()
    urls: list[str] = []

    @asynccontextmanager
    async def connect(url: str) -> AsyncIterator[EngineStream]:
        urls.append(url)
        if connection_error:
            raise OSError("private connection details")
        try:
            yield engine
        finally:
            engine.closed = True

    app = create_app(settings, stream_connector=connect)
    incoming: asyncio.Queue[Message] = asyncio.Queue()
    outgoing: asyncio.Queue[Message] = asyncio.Queue()

    async def send(message: Message) -> None:
        if (
            dropped_event
            and message["type"] == "websocket.send"
            and json.loads(message["text"])["type"] == dropped_event
        ):
            raise OSError("browser went away")
        await outgoing.put(message)

    scope: Scope = {
        "type": "websocket",
        "asgi": {"version": "3.0"},
        "scheme": "ws",
        "path": "/api/stream",
        "raw_path": b"/api/stream",
        "query_string": b"",
        "headers": [],
        "client": ("127.0.0.1", 1234),
        "server": ("127.0.0.1", 8080),
        "subprotocols": [],
    }
    async with app.router.lifespan_context(app):
        await incoming.put({"type": "websocket.connect"})
        task = asyncio.create_task(app(scope, incoming.get, send))
        browser = BrowserSession(engine, incoming, outgoing, task, urls)
        try:
            assert (await browser.receive())["type"] == "websocket.accept"
            yield browser
        finally:
            if not task.done():
                await incoming.put({"type": "websocket.disconnect", "code": 1000})
            await asyncio.wait_for(task, timeout=2)


async def ready(browser: BrowserSession) -> None:
    assert await browser.event() == {"type": "ready"}
    config = await asyncio.wait_for(browser.engine.sent.get(), timeout=2)
    assert isinstance(config, str)
    assert json.loads(config) == {"sample_rate": 16_000, "format": "pcm_s16le"}


async def test_audio_and_transcripts_flow_before_and_after_end() -> None:
    async with browser_for() as browser:
        await ready(browser)
        assert browser.urls == ["ws://127.0.0.1:8010/v1/audio/stream"]
        pcm = b"\x00\x00\xff\x7f"
        await browser.audio(pcm)
        assert await asyncio.wait_for(browser.engine.sent.get(), timeout=2) == pcm
        events = [
            {"type": "partial", "text": "Hello"},
            {"type": "partial", "text": "Hello world"},
            {"type": "final", "text": "Hello world.", "segment": 1},
        ]
        for event in events:
            await browser.engine.incoming.put(json.dumps(event))
            assert await browser.event() == event
        await browser.end()
        assert await asyncio.wait_for(browser.engine.sent.get(), timeout=2) == '{"type": "end"}'
        assert not browser.engine.closed, "the final transcript must arrive before closing"
        await browser.engine.incoming.put('{"type":"done","text":"Hello world."}')
        assert await browser.event() == {"type": "done", "text": "Hello world."}
        assert (await browser.receive())["type"] == "websocket.close"
        assert browser.engine.closed


@pytest.mark.parametrize(
    ("settings", "audio", "message"),
    [
        (Settings(max_stream_frame_bytes=4), b"a" * 6, "frame was too large"),
        (Settings(max_duration_seconds=1), b"a" * 32_002, "duration limit"),
    ],
)
async def test_stream_limits_refuse_audio_before_forwarding(
    settings: Settings, audio: bytes, message: str
) -> None:
    async with browser_for(settings) as browser:
        await ready(browser)
        await browser.audio(audio)
        event = await browser.event()
        assert event["type"] == "error"
        assert message in str(event["message"])
        assert browser.engine.sent.empty()
        assert (await browser.receive())["type"] == "websocket.close"


async def test_duration_limit_accumulates_across_frames() -> None:
    async with browser_for(Settings(max_duration_seconds=1)) as browser:
        await ready(browser)
        await browser.audio(b"a" * 20_000)
        assert len(await asyncio.wait_for(browser.engine.sent.get(), timeout=2)) == 20_000
        await browser.audio(b"a" * 20_000)
        assert (await browser.event())["type"] == "error"
        assert browser.engine.sent.empty()


@pytest.mark.parametrize("control", ['{"type":"config"}', "not JSON", "[]"])
async def test_unexpected_browser_control_is_rejected(control: str) -> None:
    async with browser_for() as browser:
        await ready(browser)
        await browser.incoming.put({"type": "websocket.receive", "text": control})
        assert (await browser.event())["type"] == "error"
        assert browser.engine.sent.empty()


@pytest.mark.parametrize("event", ["not JSON", "[]", '{"type":"partial","text":42}'])
async def test_malformed_upstream_event_is_reported(event: str) -> None:
    async with browser_for() as browser:
        await ready(browser)
        await browser.engine.incoming.put(event)
        assert (await browser.event())["type"] == "error"
        assert (await browser.receive())["type"] == "websocket.close"


async def test_engine_busy_message_is_forwarded_and_connection_closed() -> None:
    async with browser_for() as browser:
        await ready(browser)
        await browser.engine.incoming.put('{"type":"error","message":"engine busy"}')
        assert await browser.event() == {"type": "error", "message": "engine busy"}
        assert (await browser.receive())["type"] == "websocket.close"


async def test_unavailable_engine_reports_a_useful_error_without_internal_details() -> None:
    async with browser_for(connection_error=True) as browser:
        event = await browser.event()
        assert event["type"] == "error"
        assert "unavailable" in str(event["message"])
        assert "private" not in str(event["message"])
        assert (await browser.receive())["type"] == "websocket.close"


async def test_browser_disconnect_cancels_receiving_and_releases_engine() -> None:
    async with browser_for() as browser:
        await ready(browser)
        await browser.incoming.put({"type": "websocket.disconnect", "code": 1001})
        await asyncio.wait_for(browser.task, timeout=2)
        assert browser.engine.closed
        assert browser.engine.receiving_cancelled


async def test_finalization_timeout_releases_engine_and_reports_retry() -> None:
    async with browser_for(Settings(transcription_timeout_seconds=0.01)) as browser:
        await ready(browser)
        await browser.end()
        event = await browser.event()
        assert event["type"] == "error"
        assert "retry" in str(event["message"])
        assert (await browser.receive())["type"] == "websocket.close"
        assert browser.engine.closed


async def test_lost_browser_during_final_send_releases_engine_without_sending_again() -> None:
    async with browser_for(dropped_event="done") as browser:
        await ready(browser)
        await browser.end()
        await browser.engine.incoming.put('{"type":"done","text":"Finished."}')
        await asyncio.wait_for(browser.task, timeout=2)
        assert browser.engine.closed
        assert browser.outgoing.empty()


async def test_lost_browser_during_error_reporting_does_not_raise() -> None:
    async with browser_for(connection_error=True, dropped_event="error") as browser:
        await asyncio.wait_for(browser.task, timeout=2)
        assert browser.outgoing.empty()


@pytest.mark.parametrize(
    ("engine_url", "expected"),
    [
        ("http://127.0.0.1:8010", "ws://127.0.0.1:8010/v1/audio/stream"),
        ("https://example.org", "wss://example.org/v1/audio/stream"),
    ],
)
def test_stream_url_uses_the_configured_engine_host(engine_url: str, expected: str) -> None:
    assert stream_url(engine_url) == expected
