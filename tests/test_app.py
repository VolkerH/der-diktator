"""Exercise the browser-facing API against an injected inference HTTP transport."""

from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager

import httpx
import pytest

from phonon_web.app import create_app
from phonon_web.config import Settings
from tests.test_audio import make_wav

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    """Run HTTP tests in one event loop without a network server or worker portal."""
    return "asyncio"


@asynccontextmanager
async def client_for(
    handler: Callable[[httpx.Request], httpx.Response],
    settings: Settings | None = None,
) -> AsyncIterator[httpx.AsyncClient]:
    app = create_app(settings, transport=httpx.MockTransport(handler))
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://testserver"
        ) as client,
    ):
        yield client


def healthy_engine(_request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json={"status": "ok", "model": "FermionResearch/Phonon-2"})


async def test_page_and_audio_worklet_are_served_from_the_application() -> None:
    async with client_for(healthy_engine) as client:
        page = await client.get("/")
        assert page.status_code == 200
        assert 'id="transcript"' in page.text
        assert 'src="/assets/app.js"' in page.text
        assert (await client.get("/assets/recorder-worklet.js")).status_code == 200
        assert (await client.get("/assets/missing.js")).status_code == 404


async def test_health_checks_the_model_identity() -> None:
    async with client_for(healthy_engine) as client:
        assert (await client.get("/api/health")).json() == {
            "ready": True,
            "max_duration_seconds": 600,
        }
    async with client_for(
        lambda _: httpx.Response(200, json={"status": "ok", "model": "phonon-1"})
    ) as client:
        assert (await client.get("/api/health")).json()["ready"] is False


@pytest.mark.parametrize("payload", [[], None, {"status": "ok"}, {"status": "ok", "model": []}])
async def test_unusable_health_response_is_not_ready(payload: object) -> None:
    async with client_for(lambda _: httpx.Response(200, json=payload)) as client:
        assert (await client.get("/api/health")).json()["ready"] is False


async def test_valid_audio_is_forwarded_in_fermion_multipart_format() -> None:
    audio = make_wav()
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(200, json={"text": "Hello from WSL."})

    async with client_for(handler) as client:
        response = await client.post(
            "/api/transcribe", content=audio, headers={"Content-Type": "audio/wav"}
        )
    assert response.status_code == 200
    assert response.json() == {"text": "Hello from WSL."}
    assert len(captured) == 1
    upstream = captured[0]
    assert upstream.url.path == "/v1/audio/transcriptions"
    assert upstream.headers["content-type"].startswith("multipart/form-data;")
    body = upstream.content
    assert b'filename="recording.wav"' in body
    assert b'name="model"\r\n\r\nphonon-2' in body
    assert audio in body


async def test_silence_can_return_an_empty_transcript() -> None:
    async with client_for(lambda _: httpx.Response(200, json={"text": ""})) as client:
        response = await client.post(
            "/api/transcribe", content=make_wav(), headers={"Content-Type": "audio/wav"}
        )
    assert response.status_code == 200
    assert response.json() == {"text": ""}


@pytest.mark.parametrize(
    ("body", "content_type", "status"),
    [(b"not audio", "audio/wav", 400), (make_wav(), "audio/webm", 415), (b"", "audio/wav", 400)],
)
async def test_invalid_audio_never_reaches_the_engine(
    body: bytes, content_type: str, status: int
) -> None:
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, json={"text": "unexpected"})

    async with client_for(handler) as client:
        response = await client.post(
            "/api/transcribe", content=body, headers={"Content-Type": content_type}
        )
    assert response.status_code == status
    assert calls == []


async def test_upload_limit_applies_to_streamed_bodies_without_content_length() -> None:
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, json={"text": "unexpected"})

    async def chunks() -> AsyncIterator[bytes]:
        yield b"a" * 30
        yield b"b" * 30

    async with client_for(handler, Settings(max_audio_bytes=50)) as client:
        response = await client.post(
            "/api/transcribe",
            content=chunks(),
            headers={"Content-Type": "audio/wav"},
        )
    assert response.status_code == 413
    assert calls == []


@pytest.mark.parametrize("exception", [httpx.ConnectError, httpx.ReadTimeout])
async def test_engine_failures_have_actionable_http_statuses(
    exception: type[httpx.RequestError],
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise exception("unavailable", request=request)

    async with client_for(handler) as client:
        assert (await client.get("/api/health")).json()["ready"] is False
        response = await client.post(
            "/api/transcribe", content=make_wav(), headers={"Content-Type": "audio/wav"}
        )
    expected_status = 504 if exception is httpx.ReadTimeout else 503
    assert response.status_code == expected_status
    assert isinstance(response.json()["detail"], str)


@pytest.mark.parametrize("payload", [{"text": 42}, {"unexpected": "text"}, []])
async def test_malformed_engine_transcription_is_rejected(payload: object) -> None:
    async with client_for(lambda _: httpx.Response(200, json=payload)) as client:
        response = await client.post(
            "/api/transcribe", content=make_wav(), headers={"Content-Type": "audio/wav"}
        )
    assert response.status_code == 502


@pytest.mark.parametrize(
    ("upstream_status", "expected_status"), [(503, 503), (500, 502), (404, 502)]
)
async def test_upstream_error_does_not_leak_internal_response(
    upstream_status: int, expected_status: int
) -> None:
    async with client_for(
        lambda _: httpx.Response(upstream_status, text="private engine details")
    ) as client:
        response = await client.post(
            "/api/transcribe", content=make_wav(), headers={"Content-Type": "audio/wav"}
        )
    assert response.status_code == expected_status
    assert "private engine details" not in response.text
