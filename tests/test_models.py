"""Model lifecycle tests run without weights, Torch, NumPy or ONNX Runtime."""

import asyncio
import hashlib
import json
from array import array
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import pytest

from diktator.inference.backends import Backend, audio_windows
from diktator.inference.manager import ModelConflict, ModelManager
from diktator.inference.server import create_engine
from diktator.inference.store import (
    CATALOG_VERSION,
    ModelFile,
    ModelStore,
    exclusive_lock,
    models_directory,
    write_verified_file,
)
from diktator.models import ModelId
from tests.test_app import client_for
from tests.test_audio import make_wav


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def install_fixture(store: ModelStore, model: ModelId) -> None:
    directory = store.path(model)
    directory.mkdir(parents=True, exist_ok=True)
    names = (
        ["config.json", "packed_manifest.json", "model.fermion"]
        if model == "phonon-2"
        else ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"]
    )
    for name in names:
        (directory / name).write_bytes(b"fixture")
    (directory / "installed.json").write_text(
        json.dumps(
            {
                "version": CATALOG_VERSION,
                "model": model,
                "files": dict.fromkeys(names, 7),
            }
        )
    )


class FakeBackend:
    stream_endpoint: str | None = "http://127.0.0.1:8011"

    def __init__(self) -> None:
        self.loaded = False
        self.closed = False
        self.started = asyncio.Event()
        self.finish = asyncio.Event()
        self.fail_load = False
        self.fail_decode = False

    async def load(self, directory: Path) -> None:
        assert directory.is_dir()
        if self.fail_load:
            raise RuntimeError("load failed")
        self.loaded = True

    def alive(self) -> bool:
        return self.loaded and not self.closed

    async def transcribe(self, audio: bytes) -> str:
        assert audio == make_wav()
        self.started.set()
        await self.finish.wait()
        if self.fail_decode:
            raise RuntimeError("later chunk failed")
        return "Hallo, this is mixed dictation."

    async def close(self) -> None:
        self.closed = True


@pytest.mark.anyio
async def test_cancelled_request_keeps_native_inference_owned_until_completion(
    tmp_path: Path,
) -> None:
    store = ModelStore(tmp_path)
    install_fixture(store, "phonon-2")
    install_fixture(store, "parakeet-v3")
    backend = FakeBackend()
    manager = ModelManager(store, lambda _: backend)
    manager.activate("phonon-2")
    assert manager.job is not None
    with pytest.raises(ModelConflict, match="loading"):
        await manager.transcribe("phonon-2", make_wav())
    await manager.job
    request = asyncio.create_task(manager.transcribe("phonon-2", make_wav()))
    await backend.started.wait()
    request.cancel()
    with pytest.raises(asyncio.CancelledError):
        await request
    assert manager.busy and not backend.closed
    with pytest.raises(ModelConflict, match="busy"):
        manager.activate("parakeet-v3")
    with pytest.raises(ModelConflict, match="busy"):
        await manager.transcribe("phonon-2", make_wav())
    with pytest.raises(ModelConflict, match="busy"):
        async with manager.stream("phonon-2"):
            pytest.fail("stream was admitted during decoding")
    backend.finish.set()
    assert manager.inference is not None
    await manager.inference
    assert not manager.busy
    await manager.close()
    assert backend.closed


@pytest.mark.anyio
async def test_stream_owns_model_until_disconnect_and_refuses_stale_model(tmp_path: Path) -> None:
    store = ModelStore(tmp_path)
    install_fixture(store, "phonon-2")
    backend = FakeBackend()
    manager = ModelManager(store, lambda _: backend)
    await manager.start()
    assert manager.job is not None
    await manager.job
    async with manager.stream("phonon-2"):
        with pytest.raises(ModelConflict, match="busy"):
            manager.activate("phonon-2")
    assert not manager.busy
    with pytest.raises(ModelConflict, match="not active"):
        await manager.transcribe("parakeet-v3", make_wav())
    await manager.close()


@pytest.mark.anyio
async def test_selection_persists_only_after_success_and_failed_load_can_retry(
    tmp_path: Path,
) -> None:
    store = ModelStore(tmp_path)
    for model in ("phonon-2", "parakeet-v3"):
        install_fixture(store, model)
    backends: list[FakeBackend] = []

    def factory(model: ModelId) -> Backend:
        backend = FakeBackend()
        backend.fail_load = model == "parakeet-v3"
        backends.append(backend)
        return backend

    manager = ModelManager(store, factory)
    await manager.start()
    assert manager.job is not None
    await manager.job
    assert store.preference() == "phonon-2"
    manager.activate("parakeet-v3")
    await manager.job
    assert manager.active is None
    assert all(backend.closed for backend in backends)
    assert store.preference() == "phonon-2"
    assert manager.status().models[1].state == "error"
    backend = FakeBackend()
    backend.stream_endpoint = None
    manager.factory = lambda _: backend
    manager.activate("parakeet-v3")
    await manager.job
    assert store.preference() == "parakeet-v3"
    with pytest.raises(ModelConflict, match="Turn off Live text"):
        async with manager.stream("parakeet-v3"):
            pytest.fail("Parakeet has no live protocol")
    await manager.close()
    restarted = ModelManager(store, lambda _: FakeBackend())
    await restarted.start()
    assert restarted.job is not None
    await restarted.job
    assert restarted.active == "parakeet-v3"
    await restarted.close()


def test_paths_and_complete_markers(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path))
    monkeypatch.delenv("DIKTATOR_MODELS_DIR", raising=False)
    monkeypatch.setenv("DIKTATOR_DATA_DIR", str(tmp_path / "custom-chats"))
    assert models_directory() == tmp_path / "diktator" / "models"
    store = ModelStore(models_directory())
    with pytest.raises(ValueError, match="Unknown"):
        store.path("../arbitrary")
    install_fixture(store, "parakeet-v3")
    assert store.installed("parakeet-v3")
    (store.path("parakeet-v3") / "encoder.int8.onnx").write_bytes(b"partial")
    # Same-size damage is caught by the native loader; truncated files fail status.
    (store.path("parakeet-v3") / "encoder.int8.onnx").write_bytes(b"short")
    assert not store.installed("parakeet-v3")
    monkeypatch.setenv("DIKTATOR_MODELS_DIR", str(tmp_path / "custom-models"))
    assert models_directory() == tmp_path / "custom-models"


@pytest.mark.anyio
async def test_failed_download_never_becomes_installed_and_retry_releases_lock(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = ModelStore(tmp_path)
    count = 0
    entered = asyncio.Event()
    finish = asyncio.Event()

    async def download(stage: Path, report: Callable[[str], None]) -> None:
        nonlocal count
        count += 1
        report("Downloading…")
        (stage / "partial").write_bytes(b"bad")
        entered.set()
        await finish.wait()
        if count == 1:
            raise OSError("disk full")
        install_fixture(ModelStore(stage.parent), "parakeet-v3")
        # Populate staging with a complete stand-in payload, then remove the fixture.
        complete = store.path("parakeet-v3")
        for file in complete.iterdir():
            file.rename(stage / file.name)
        complete.rmdir()
        (stage / "partial").unlink()
        (stage / "installed.json").unlink()

    monkeypatch.setattr("diktator.inference.store.download_parakeet", download)
    manager = ModelManager(store)
    manager.download("parakeet-v3")
    job = manager.job
    manager.download("parakeet-v3")
    assert manager.job is job
    await entered.wait()
    assert not store.installed("parakeet-v3")
    assert manager.status().models[1].state == "downloading"
    with (
        pytest.raises(RuntimeError, match="Another model"),
        exclusive_lock(tmp_path / ".install.lock"),
    ):
        pytest.fail("installation lock was not held")
    finish.set()
    assert job is not None
    await job
    assert manager.status().models[1].state == "error"
    assert not store.installed("parakeet-v3")
    manager.download("parakeet-v3")
    assert manager.job is not None
    await manager.job
    assert store.installed("parakeet-v3")
    manager.download("parakeet-v3")
    assert count == 2
    await manager.close()


@pytest.mark.anyio
async def test_digest_and_size_validation(tmp_path: Path) -> None:
    async def chunks() -> AsyncIterator[bytes]:
        yield b"hello"
        yield b" world"

    good = ModelFile("encoder.int8.onnx", 11, hashlib.sha256(b"hello world").hexdigest())
    await write_verified_file(chunks(), tmp_path / good.name, good)
    for bad in (
        ModelFile(good.name, 12, good.sha256),
        ModelFile(good.name, 11, "bad"),
        ModelFile(good.name, 4, good.sha256),
    ):
        with pytest.raises(ValueError):
            await write_verified_file(chunks(), tmp_path / bad.name, bad)


@pytest.mark.parametrize("length", [0, 1, 2999, 3000, 3001, 6000, 6041, 60_000])
@pytest.mark.parametrize("level", [0, 1000])
def test_audio_windows_are_bounded_and_cover_every_sample(length: int, level: int) -> None:
    samples = array("h", [level] * length)
    windows = list(audio_windows(samples, sample_rate=100))
    assert all(0 < len(window) <= 3000 for window in windows)
    assert sum(windows, array("h")) == samples


def test_long_recording_cuts_at_pause() -> None:
    samples = array("h", [1000] * 6000)
    samples[2700:2800] = array("h", [0] * 100)
    windows = list(audio_windows(samples, sample_rate=100))
    assert 2700 <= len(windows[0]) <= 2800
    assert sum(windows, array("h")) == samples


@asynccontextmanager
async def engine_client(manager: ModelManager) -> AsyncIterator[httpx.AsyncClient]:
    app = create_engine(manager)
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://engine",
        ) as client,
    ):
        yield client


@pytest.mark.anyio
async def test_engine_routes_do_not_download_on_startup_and_validate_model_identity(
    tmp_path: Path,
) -> None:
    store = ModelStore(tmp_path)
    manager = ModelManager(store, lambda _: FakeBackend())
    async with engine_client(manager) as client:
        assert (await client.get("/health")).json()["status"] == "waiting"
        assert manager.job is None
        models = (await client.get("/models")).json()
        assert all(item["state"] == "missing" for item in models["models"])
        assert (await client.post("/models/arbitrary/download")).status_code == 422
        assert (await client.post("/models/parakeet-v3/activate")).status_code == 409
        response = await client.post("/transcribe?model=parakeet-v3", content=make_wav())
        assert response.status_code == 409
        assert (
            await client.post("/transcribe?model=parakeet-v3", content=b"bad")
        ).status_code == 400


@pytest.mark.anyio
async def test_web_proxy_model_routes_and_conflicts() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(409, json={"detail": "Finish the current recording first."})

    async with client_for(handler) as client:
        for path in (
            "/api/models/parakeet-v3/activate",
            "/api/models/parakeet-v3/download",
            "/api/transcribe?model=parakeet-v3",
        ):
            response = await client.post(
                path, content=make_wav(), headers={"Content-Type": "audio/wav"}
            )
            assert response.status_code == 409
            assert response.json()["detail"] == "Finish the current recording first."
        assert (await client.post("/api/models/unknown/download")).status_code == 422
    assert len(requests) == 3
    assert requests[-1].url.params["model"] == "parakeet-v3"


@pytest.mark.anyio
async def test_download_cancellation_cleans_staging_and_releases_lock(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    started = asyncio.Event()

    async def stalled(stage: Path, _report: Callable[[str], None]) -> None:
        (stage / "partial").write_bytes(b"partial")
        started.set()
        await asyncio.Event().wait()

    monkeypatch.setattr("diktator.inference.store.download_parakeet", stalled)
    manager = ModelManager(ModelStore(tmp_path))
    manager.download("parakeet-v3")
    await started.wait()
    await manager.close()
    assert not (tmp_path / ".parakeet-v3.download").exists()
    with exclusive_lock(tmp_path / ".install.lock"):
        assert not manager.store.installed("parakeet-v3")


@pytest.mark.anyio
async def test_later_decode_failure_never_returns_partial_success(tmp_path: Path) -> None:
    store = ModelStore(tmp_path)
    install_fixture(store, "phonon-2")
    backend = FakeBackend()
    backend.fail_decode = True
    backend.finish.set()
    manager = ModelManager(store, lambda _: backend)
    async with engine_client(manager) as client:
        assert manager.job is not None
        await manager.job
        response = await client.post("/transcribe?model=phonon-2", content=make_wav())
        assert response.status_code == 502
        assert "text" not in response.json()
        assert not manager.busy
        assert (await client.get("/models")).json()["models"][0]["state"] == "ready"


@pytest.mark.anyio
async def test_phonon_adapter_keeps_model_name_and_disables_inner_read_timeout() -> None:
    from diktator.inference.backends import PhononBackend

    backend = PhononBackend()
    assert backend.client.timeout.read is None
    await backend.client.aclose()
    requests = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"text": "Test."})

    backend.client = httpx.AsyncClient(base_url=backend.url, transport=httpx.MockTransport(handler))
    try:
        assert await backend.transcribe(make_wav()) == "Test."
        request = requests[0]
        assert request.url.path == "/v1/audio/transcriptions"
        assert b'name="model"\r\n\r\nphonon-2' in request.content
        assert make_wav() in request.content
    finally:
        await backend.close()


@pytest.mark.anyio
async def test_child_that_ignores_terminate_is_killed_and_reaped() -> None:
    import sys

    from diktator.inference.process import stop_process

    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); "
        "print('ready', flush=True); time.sleep(60)",
        stdout=asyncio.subprocess.PIPE,
    )
    assert process.stdout is not None
    assert await process.stdout.readline() == b"ready\n"
    await asyncio.wait_for(stop_process(process, grace_seconds=0.01), timeout=2)
    assert process.returncode is not None and process.returncode < 0
