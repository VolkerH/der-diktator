"""Exercise the browser-facing API against an injected inference HTTP transport."""

from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import pytest

from diktator.app import create_app
from diktator.config import Settings
from diktator.recording_policy import RecordingPolicy
from tests.helpers import isolated_settings
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
    with isolated_settings(settings) as settings:

        def capable_engine(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/recording-policy":
                return httpx.Response(200, json=settings.recording_policy.model_dump())
            return handler(request)

        app = create_app(settings, transport=httpx.MockTransport(capable_engine))
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
        assert 'id="live-mode" type="checkbox" checked' in page.text
        assert (await client.get("/assets/live.js")).status_code == 200
        assert (await client.get("/assets/recorder-worklet.js")).status_code == 200
        splash = await client.get("/assets/splash.svg")
        assert splash.headers["content-type"].startswith("image/svg+xml")
        assert "Der Diktator" in page.text
        assert (await client.get("/assets/missing.js")).status_code == 404


async def test_health_checks_the_model_identity() -> None:
    async with client_for(healthy_engine) as client:
        assert (await client.get("/api/health")).json() == {
            "ready": True,
            "max_duration_seconds": 3600,
        }
    async with client_for(
        lambda _: httpx.Response(200, json={"status": "ok", "model": "phonon-1"})
    ) as client:
        assert (await client.get("/api/health")).json()["ready"] is False


@pytest.mark.parametrize("payload", [[], None, {"status": "ok"}, {"status": "ok", "model": []}])
async def test_unusable_health_response_is_not_ready(payload: object) -> None:
    async with client_for(lambda _: httpx.Response(200, json=payload)) as client:
        assert (await client.get("/api/health")).json()["ready"] is False


async def test_valid_audio_is_forwarded_with_the_requested_model() -> None:
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
    assert upstream.url.path == "/transcribe"
    assert upstream.url.params["model"] == "phonon-2"
    assert upstream.headers["content-type"] == "audio/wav"
    assert upstream.content == audio


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
    assert response.json()["code"] == ("unsupported_audio" if status == 415 else "invalid_audio")
    assert calls == []


async def test_upload_limit_applies_to_streamed_bodies_without_content_length() -> None:
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, json={"text": "unexpected"})

    async def chunks() -> AsyncIterator[bytes]:
        yield b"a" * 1_000_000
        yield b"b" * 1_000_000

    async with client_for(
        handler,
        Settings(
            recording_policy=RecordingPolicy(
                hard_limit_seconds=60, wav_container_allowance_bytes=44
            )
        ),
    ) as client:
        response = await client.post(
            "/api/transcribe",
            content=chunks(),
            headers={"Content-Type": "audio/wav"},
        )
    assert response.status_code == 413
    assert response.json()["code"] == "audio_too_large"
    assert "1920044 bytes" in response.json()["detail"]
    assert "ten minutes" not in response.text
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
    assert response.json()["code"] == (
        "engine_timeout" if expected_status == 504 else "engine_unavailable"
    )


@pytest.mark.parametrize("payload", [{"text": 42}, {"unexpected": "text"}, []])
async def test_malformed_engine_transcription_is_rejected(payload: object) -> None:
    async with client_for(lambda _: httpx.Response(200, json=payload)) as client:
        response = await client.post(
            "/api/transcribe", content=make_wav(), headers={"Content-Type": "audio/wav"}
        )
    assert response.status_code == 502
    assert response.json()["code"] == "engine_error"


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
    assert response.json()["code"] == (
        "engine_unavailable" if expected_status == 503 else "engine_error"
    )


@pytest.mark.parametrize(
    ("code", "status"),
    [
        ("model_busy", 409),
        ("model_loading", 409),
        ("model_deleting", 409),
        ("model_not_active", 409),
        ("model_not_installed", 409),
        ("live_transcription_unsupported", 409),
        ("model_conflict", 409),
        ("audio_too_large", 413),
        ("unsupported_audio", 415),
        ("invalid_audio", 400),
        ("validation_error", 422),
        ("engine_unavailable", 503),
        ("engine_timeout", 504),
        ("engine_error", 502),
    ],
)
async def test_engine_error_codes_survive_both_transcription_routes(
    tmp_path: Path, code: str, status: int
) -> None:
    async with client_for(
        lambda _: httpx.Response(
            status, json={"detail": "private engine diagnostics", "code": code}
        ),
        Settings(data_directory=tmp_path),
    ) as client:
        chat_id = (await client.post("/api/chats")).json()["id"]
        recording_id = (
            await client.post(
                f"/api/chats/{chat_id}/recordings",
                content=make_wav(),
                headers={"Content-Type": "audio/wav"},
            )
        ).json()["id"]
        for path in (
            "/api/transcribe",
            f"/api/chats/{chat_id}/recordings/{recording_id}/transcribe",
        ):
            response = await client.post(
                path, content=make_wav(), headers={"Content-Type": "audio/wav"}
            )
            assert response.status_code == status
            assert response.json()["code"] == code
            assert isinstance(response.json()["detail"], str)
            assert "private" not in response.text


@pytest.mark.parametrize(
    ("status", "payload"),
    [
        (409, {"code": "private_code", "detail": "private"}),
        (409, {"code": "engine_timeout", "detail": "private"}),
        (409, {"code": ["model_busy"], "detail": "private"}),
        (409, {"code": "model_busy", "detail": ["private"]}),
        (503, {"code": "private_code", "detail": "private"}),
    ],
)
async def test_unknown_or_invalid_engine_envelope_is_a_sanitized_bad_gateway(
    status: int, payload: object
) -> None:
    async with client_for(lambda _: httpx.Response(status, json=payload)) as client:
        response = await client.post(
            "/api/transcribe", content=make_wav(), headers={"Content-Type": "audio/wav"}
        )
    assert response.status_code == 502
    assert response.json()["code"] == "engine_error"
    assert "private" not in response.text


@pytest.mark.parametrize("payload", [None, [], {"detail": "private model diagnostics"}])
async def test_legacy_engine_409_is_a_model_conflict(payload: object) -> None:
    async with client_for(lambda _: httpx.Response(409, json=payload)) as client:
        response = await client.post(
            "/api/transcribe", content=make_wav(), headers={"Content-Type": "audio/wav"}
        )
    assert response.status_code == 409
    assert response.json()["code"] == "model_conflict"
    assert "private" not in response.text


async def test_validation_context_has_field_diagnostics_without_submitted_values(
    tmp_path: Path,
) -> None:
    async with client_for(
        healthy_engine, Settings(data_directory=tmp_path, max_text_characters=3)
    ) as client:
        chat_id = (await client.post("/api/chats")).json()["id"]
        response = await client.put(
            f"/api/chats/{chat_id}/text", json={"text": "private transcript"}
        )
    assert response.status_code == 422
    payload = response.json()
    assert isinstance(payload["detail"], str)
    assert payload["code"] == "validation_error"
    assert payload["context"]["errors"][0]["loc"] == ["body", "text"]
    assert "private transcript" not in response.text
    assert "input" not in payload["context"]["errors"][0]


async def test_routing_and_asset_errors_use_the_envelope_and_preserve_headers() -> None:
    async with client_for(healthy_engine) as client:
        for path in ("/missing", "/assets/missing.js"):
            response = await client.get(path)
            assert response.status_code == 404
            assert response.json()["code"] == "not_found"
            assert isinstance(response.json()["detail"], str)
        response = await client.put("/api/health")
        assert response.status_code == 405
        assert response.json()["code"] == "method_not_allowed"
        assert "GET" in response.headers["allow"]


async def test_upload_deadline_code_cannot_describe_model_operations() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            408, json={"detail": "private upstream details", "code": "upload_timeout"}
        )

    async with client_for(handler) as client:
        for method, path in [("GET", "/api/models"), ("POST", "/api/models/phonon-2/download")]:
            response = await client.request(method, path)
            assert response.status_code == 502
            assert response.json()["code"] == "engine_error"
