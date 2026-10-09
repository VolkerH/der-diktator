"""Agreement, boundary enforcement and timeout tests require no native model."""

import asyncio
import struct
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import override

import httpx
import pytest
from fastapi import FastAPI
from fastapi.routing import APIRoute
from pydantic import ValidationError
from sqlalchemy import text

from diktator.app import create_app
from diktator.config import Settings
from diktator.inference.manager import ModelManager
from diktator.inference.server import create_engine
from diktator.inference.store import ModelStore
from diktator.recording_policy import RecordingPolicy
from tests.test_app import client_for, healthy_engine
from tests.test_audio import make_wav
from tests.test_models import FakeBackend

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@asynccontextmanager
async def web_client(
    tmp_path: Path,
    handler: Callable[[httpx.Request], httpx.Response],
    policy: RecordingPolicy | None = None,
) -> AsyncIterator[tuple[httpx.AsyncClient, FastAPI]]:
    app = create_app(
        Settings(data_directory=tmp_path, recording_policy=policy or RecordingPolicy()),
        transport=httpx.MockTransport(handler),
    )
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://web") as client,
    ):
        yield client, app


def test_startup_policy_is_immutable_and_preserves_existing_defaults() -> None:
    policy = RecordingPolicy()
    assert policy.hard_limit_seconds == 600
    assert policy.client_deadlines_ms.model_dump() == {
        "upload": 190_000,
        "batch": 570_000,
        "live": 200_000,
    }
    assert policy.max_pcm_bytes == 19_200_000
    assert policy.max_audio_bytes == 20_000_044
    assert policy == Settings().recording_policy
    with pytest.raises(ValidationError):
        policy.hard_limit_seconds = 1800
    with pytest.raises(ValidationError):
        Settings(recording_policy=RecordingPolicy.model_construct(hard_limit_seconds=1))


@pytest.mark.parametrize(
    "changes",
    [
        {"hard_limit_seconds": 0},
        {"hard_limit_seconds": 61},
        {"hard_limit_seconds": 60.0},
        {"hard_limit_seconds": True},
        {"wav_container_allowance_bytes": 43},
        {"wav_container_allowance_bytes": 1_048_577},
        {"max_stream_frame_bytes": 3},
        {"max_stream_frame_bytes": 0},
        {"max_stream_frame_bytes": 1_048_578},
        {"upload_timeout_seconds": 0},
        {"upload_timeout_seconds": 1e10},
        {"upload_timeout_seconds": 1e308},
        {"batch_timeout_seconds": float("inf")},
        {"live_finalization_timeout_seconds": float("nan")},
        {"client_timeout_margin_seconds": -1},
        {"unknown": 1},
    ],
)
def test_invalid_injected_policy_is_rejected(changes: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        RecordingPolicy.model_validate(changes)


def test_environment_is_shared_by_both_service_factories(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DIKTATOR_RECORDING_HARD_LIMIT_SECONDS", "60")
    monkeypatch.setenv("DIKTATOR_WAV_CONTAINER_ALLOWANCE_BYTES", "100")
    monkeypatch.setenv("DIKTATOR_MAX_STREAM_FRAME_BYTES", "1000")
    monkeypatch.setenv("DIKTATOR_UPLOAD_TIMEOUT_SECONDS", "2.5")
    monkeypatch.setenv("DIKTATOR_BATCH_TIMEOUT_SECONDS", "3.5")
    monkeypatch.setenv("DIKTATOR_LIVE_FINALIZATION_TIMEOUT_SECONDS", "4.5")
    monkeypatch.setenv("DIKTATOR_CLIENT_TIMEOUT_MARGIN_SECONDS", "0.5")
    web_settings = Settings.from_environment(tmp_path)
    policy = web_settings.recording_policy
    assert policy.hard_limit_seconds == 60
    assert policy.max_audio_bytes == 1_920_100
    assert policy.max_stream_frame_bytes == 1000
    assert policy.upload_timeout_seconds == 2.5
    assert policy.batch_timeout_seconds == 3.5
    assert policy.live_finalization_timeout_seconds == 4.5
    assert policy.client_timeout_margin_seconds == 0.5
    engine = create_engine(ModelManager(ModelStore(tmp_path / "models")))
    endpoint = next(
        route.endpoint
        for route in engine.routes
        if isinstance(route, APIRoute) and route.path == "/recording-policy"
    )
    assert asyncio.run(endpoint()) == policy
    monkeypatch.setenv("DIKTATOR_BATCH_TIMEOUT_SECONDS", "nan")
    with pytest.raises(ValidationError):
        Settings.from_environment(tmp_path)
    with pytest.raises(ValidationError):
        create_engine(ModelManager(ModelStore(tmp_path / "other-models")))


async def test_discovery_agrees_without_reserving_model_or_creating_preferences(
    tmp_path: Path,
) -> None:
    policy = RecordingPolicy()
    calls: list[str] = []

    def upstream(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        return httpx.Response(200, json=policy.model_dump())

    async with web_client(tmp_path, upstream) as (client, app):
        before = await client.get("/api/preferences")
        response = await client.get("/api/recording-policy")
        body = response.json()
        assert response.status_code == 200
        assert body == policy.model_dump() | {"preference_etag": before.headers["ETag"]}
        assert "interval" not in response.text
        assert "http" not in response.text
        assert str(tmp_path) not in response.text
        assert calls == ["/recording-policy"]
        # Discovery performs a read only. No preference row or model reservation.
        with app.state.storage.engine.connect() as connection:
            assert connection.execute(text("SELECT count(*) FROM preferences")).scalar() == 0
        assert (await client.get("/api/preferences")).headers["ETag"] == before.headers["ETag"]
        assert (await client.get("/api/settings")).json()["policy_revision"] != body[
            "policy_revision"
        ]


@pytest.mark.parametrize(
    ("status", "payload", "code"),
    [
        (404, {}, "configuration_mismatch"),
        (405, {}, "configuration_mismatch"),
        (200, {}, "configuration_mismatch"),
        (200, {"protocol_version": 0}, "configuration_mismatch"),
        (200, RecordingPolicy(hard_limit_seconds=60).model_dump(), "configuration_mismatch"),
        (
            200,
            RecordingPolicy().model_dump() | {"policy_revision": "false"},
            "configuration_mismatch",
        ),
        (200, RecordingPolicy().model_dump() | {"max_audio_bytes": 1}, "configuration_mismatch"),
        (
            200,
            RecordingPolicy().model_dump()
            | {"client_deadlines_ms": {"upload": 1, "batch": 2, "live": 3}},
            "configuration_mismatch",
        ),
        (503, {"private": "native traceback"}, "engine_unavailable"),
    ],
)
async def test_discovery_and_inference_admission_fail_closed_but_upload_access_survives(
    tmp_path: Path,
    status: int,
    payload: object,
    code: str,
) -> None:
    calls: list[str] = []

    def upstream(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        return httpx.Response(status, json=payload)

    async with web_client(tmp_path, upstream) as (client, _app):
        for path, method, content in [
            ("/api/recording-policy", "GET", None),
            ("/api/transcribe", "POST", make_wav()),
        ]:
            response = await client.request(
                method, path, content=content, headers={"Content-Type": "audio/wav"}
            )
            assert response.status_code == 503
            assert response.json()["code"] == code
            assert "traceback" not in response.text
        assert calls == ["/recording-policy", "/recording-policy"]
        chat = (await client.post("/api/chats")).json()
        recording_url = f"/api/chats/{chat['id']}/recordings/{'a' * 32}"
        assert (
            await client.put(
                recording_url, content=make_wav(), headers={"Content-Type": "audio/wav"}
            )
        ).status_code == 201
        assert (await client.get(recording_url)).content == make_wav()
        assert (await client.post(f"{recording_url}/transcribe")).json()["code"] == code
        assert len(calls) == 3


async def test_policy_is_rechecked_after_discovery_and_revision_is_passed_to_engine(
    tmp_path: Path,
) -> None:
    policy = RecordingPolicy()
    requests: list[httpx.Request] = []

    def upstream(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path == "/recording-policy":
            return httpx.Response(200, json=policy.model_dump())
        assert request.headers["X-Recording-Policy-Revision"] == policy.policy_revision
        return httpx.Response(
            503, json={"code": "configuration_mismatch", "detail": "private restart details"}
        )

    async with web_client(tmp_path, upstream) as (client, _app):
        assert (await client.get("/api/recording-policy")).status_code == 200
        response = await client.post(
            "/api/transcribe", content=make_wav(), headers={"Content-Type": "audio/wav"}
        )
        assert response.json()["code"] == "configuration_mismatch"
        assert [request.url.path for request in requests] == [
            "/recording-policy",
            "/recording-policy",
            "/transcribe",
        ]


async def test_stored_clip_is_revalidated_after_operator_lowers_ceiling(tmp_path: Path) -> None:
    audio = make_wav(frames=61 * 16_000)
    async with client_for(healthy_engine, Settings(data_directory=tmp_path)) as client:
        chat_id = (await client.post("/api/chats")).json()["id"]
        path = f"/api/chats/{chat_id}/recordings/{'b' * 32}"
        assert (
            await client.put(path, content=audio, headers={"Content-Type": "audio/wav"})
        ).status_code == 201
    calls: list[httpx.Request] = []

    def unreachable(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        raise httpx.ConnectError("no engine", request=request)

    async with web_client(tmp_path, unreachable, RecordingPolicy(hard_limit_seconds=60)) as (
        client,
        _app,
    ):
        assert (await client.get(path)).content == audio
        rejection = await client.post(f"{path}/transcribe")
        assert rejection.status_code == 400
        assert rejection.json()["code"] == "invalid_audio"
        assert calls == []


def add_metadata(audio: bytes, size: int) -> bytes:
    chunk = b"JUNK" + struct.pack("<I", size) + bytes(size)
    changed = audio[:12] + chunk + audio[12:]
    return changed[:4] + struct.pack("<I", len(changed) - 8) + changed[8:]


class ImmediateBackend(FakeBackend):
    @override
    async def transcribe(self, audio: bytes) -> str:
        return "Accepted."


@pytest.mark.parametrize("service", ["web", "engine"])
async def test_duration_and_wav_container_budgets_are_independent(
    tmp_path: Path, service: str
) -> None:
    policy = RecordingPolicy(hard_limit_seconds=60, wav_container_allowance_bytes=100)
    manager = ModelManager(ModelStore(tmp_path / "models"), lambda _: ImmediateBackend())
    backend = ImmediateBackend()
    backend.loaded = True
    manager.backend, manager.active = backend, "phonon-2"
    settings = Settings(data_directory=tmp_path / "data", recording_policy=policy)
    engine = create_engine(manager, settings)
    web = create_app(settings, transport=httpx.ASGITransport(app=engine))
    app = web if service == "web" else engine
    path = "/api/transcribe" if service == "web" else "/transcribe?model=phonon-2"
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        for frames in [959_999, 960_000]:
            assert (
                await client.post(
                    path, content=make_wav(frames=frames), headers={"Content-Type": "audio/wav"}
                )
            ).status_code == 200
        response = await client.post(
            path, content=make_wav(frames=960_001), headers={"Content-Type": "audio/wav"}
        )
        assert response.status_code == 400 and response.json()["code"] == "invalid_audio"
        at_budget = add_metadata(make_wav(frames=960_000), 48)
        assert len(at_budget) == policy.max_audio_bytes
        assert (
            await client.post(path, content=at_budget, headers={"Content-Type": "audio/wav"})
        ).status_code == 200
        above_budget = add_metadata(make_wav(frames=960_000), 50)
        response = await client.post(
            path, content=above_budget, headers={"Content-Type": "audio/wav"}
        )
        assert response.status_code == 413 and response.json()["code"] == "audio_too_large"
    await manager.close()


async def test_engine_rejects_revision_change_before_native_admission(tmp_path: Path) -> None:
    manager = ModelManager(ModelStore(tmp_path))
    app = create_engine(manager)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://engine"
    ) as client:
        response = await client.post(
            "/transcribe?model=phonon-2",
            content=b"bad",
            headers={"X-Recording-Policy-Revision": "old"},
        )
        assert response.status_code == 503
        assert response.json()["code"] == "configuration_mismatch"
        assert not manager.busy


@pytest.mark.parametrize("service", ["web", "engine"])
async def test_upload_deadline_is_authoritative_in_both_services(
    tmp_path: Path, service: str
) -> None:
    policy = RecordingPolicy(upload_timeout_seconds=0.01)
    settings = Settings(data_directory=tmp_path, recording_policy=policy)
    app = (
        create_app(settings)
        if service == "web"
        else create_engine(ModelManager(ModelStore(tmp_path / "models")), settings)
    )

    async def stalled() -> AsyncIterator[bytes]:
        yield b"RIFF"
        await asyncio.sleep(1)
        yield b"WAVE"

    path = "/api/transcribe" if service == "web" else "/transcribe?model=phonon-2"
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.post(path, content=stalled(), headers={"Content-Type": "audio/wav"})
        assert response.status_code == 408
        assert response.json()["code"] == "upload_timeout"


async def test_engine_batch_timeout_preserves_native_reservation(tmp_path: Path) -> None:
    backend = FakeBackend()
    backend.loaded = True
    manager = ModelManager(ModelStore(tmp_path))
    manager.backend, manager.active = backend, "phonon-2"
    app = create_engine(
        manager, Settings(recording_policy=RecordingPolicy(batch_timeout_seconds=0.01))
    )
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://engine"
        ) as client:
            response = await client.post("/transcribe?model=phonon-2", content=make_wav())
            assert response.status_code == 504
            assert response.json()["code"] == "engine_timeout"
            assert manager.busy
            assert (await client.post("/models/phonon-2/activate")).json()["code"] == "model_busy"
    finally:
        backend.finish.set()
        await manager.close()


async def test_upstream_http_waits_use_distinct_upload_and_batch_budgets(tmp_path: Path) -> None:
    policy = RecordingPolicy(upload_timeout_seconds=300, batch_timeout_seconds=60)
    calls: list[httpx.Request] = []

    def upstream(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/recording-policy":
            return httpx.Response(200, json=policy.model_dump())
        calls.append(request)
        assert request.extensions["timeout"] == {
            "connect": 5,
            "pool": 5,
            "write": 310.0,
            "read": 70.0,
        }
        return httpx.Response(200, json={"text": "complete"})

    async with web_client(tmp_path, upstream, policy) as (client, _app):
        response = await client.post(
            "/api/transcribe", content=make_wav(), headers={"Content-Type": "audio/wav"}
        )
        assert response.status_code == 200
        assert len(calls) == 1
