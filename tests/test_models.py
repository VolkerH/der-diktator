"""Model lifecycle tests run without weights, Torch, NumPy or ONNX Runtime."""

import asyncio
import hashlib
import json
import sys
import threading
from array import array
from collections.abc import AsyncIterator, Callable, Iterator
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from typing import override

import httpx
import pytest

from diktator.inference.backends import Backend, WhisperBackend, audio_windows, create_backend
from diktator.inference.manager import ModelConflict, ModelManager
from diktator.inference.server import create_engine
from diktator.inference.store import (
    CATALOG_VERSION,
    ModelFile,
    ModelStore,
    exclusive_lock,
    models_directory,
    required_files,
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
    names = required_files(model)
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
    with pytest.raises(ModelConflict, match="loading") as conflict:
        await manager.transcribe("phonon-2", make_wav())
    assert conflict.value.code == "model_loading"
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
    with pytest.raises(ModelConflict, match="busy"):
        manager.delete("phonon-2")
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
            manager.delete("phonon-2")
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
    with pytest.raises(ModelConflict, match="busy"):
        manager.delete("parakeet-v3")
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
@pytest.mark.parametrize("model", ["parakeet-v3", "whisper-large-v3-turbo"])
async def test_web_proxy_model_routes_and_conflicts(model: str) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(409, json={"detail": "Finish the current recording first."})

    async with client_for(handler) as client:
        for path in (
            f"/api/models/{model}/activate",
            f"/api/models/{model}/download",
            f"/api/models/{model}/delete",
            f"/api/transcribe?model={model}",
        ):
            response = await client.post(
                path, content=make_wav(), headers={"Content-Type": "audio/wav"}
            )
            assert response.status_code == 409
            assert response.json()["code"] == "model_conflict"
            assert "Finish the current recording first." not in response.text
        assert (await client.post("/api/models/unknown/download")).status_code == 422
    assert len(requests) == 4
    assert requests[-1].url.params["model"] == model


@pytest.mark.anyio
@pytest.mark.parametrize("model", ["parakeet-v3", "whisper-large-v3-turbo"])
async def test_download_cancellation_cleans_staging_and_releases_lock(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    model: ModelId,
) -> None:
    started = asyncio.Event()

    async def stalled(stage: Path, _report: Callable[[str], None]) -> None:
        (stage / "partial").write_bytes(b"partial")
        started.set()
        await asyncio.Event().wait()

    download = "download_whisper" if model == "whisper-large-v3-turbo" else "download_parakeet"
    monkeypatch.setattr(f"diktator.inference.store.{download}", stalled)
    manager = ModelManager(ModelStore(tmp_path))
    manager.download(model)
    await started.wait()
    await manager.close()
    assert not (tmp_path / f".{model}.download").exists()
    with exclusive_lock(tmp_path / ".install.lock"):
        assert not manager.store.installed(model)


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


@pytest.mark.anyio
async def test_whisper_local_int8_loading_and_lazy_inference_stay_on_worker(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    owner = threading.get_ident()
    worker_ids: list[int] = []
    fail = False
    decode_calls = 0

    class Waveform:
        def __init__(self, samples: array[int], dtype: str) -> None:
            assert dtype == "float32"
            self.samples = samples

        def __truediv__(self, scale: float) -> list[float]:
            return [sample / scale for sample in self.samples]

    class NativeModel:
        def __init__(self, path: str, **options: object) -> None:
            worker_ids.append(threading.get_ident())
            assert path == str(tmp_path)
            assert options == {
                "device": "cpu",
                "compute_type": "int8",
                "cpu_threads": 4,
                "num_workers": 1,
                "local_files_only": True,
            }

        def transcribe(
            self, audio: object, **options: object
        ) -> tuple[Iterator[SimpleNamespace], None]:
            nonlocal decode_calls
            decode_calls += 1
            worker_ids.append(threading.get_ident())
            assert isinstance(audio, list) and audio[-1] == 0.5
            assert options["task"] == "transcribe"
            assert options["multilingual"] is True
            assert options["vad_filter"] is True

            def segments() -> Iterator[SimpleNamespace]:
                worker_ids.append(threading.get_ident())
                yield SimpleNamespace(text=" Hallo, ")
                if fail:
                    raise RuntimeError("later segment failed")
                yield SimpleNamespace(text=" this is English. ")

            return segments(), None

    monkeypatch.setitem(sys.modules, "faster_whisper", SimpleNamespace(WhisperModel=NativeModel))
    monkeypatch.setitem(sys.modules, "numpy", SimpleNamespace(asarray=Waveform, float32="float32"))
    backend = create_backend("whisper-large-v3-turbo")
    assert isinstance(backend, WhisperBackend)
    try:
        await backend.load(tmp_path)
        assert backend.alive() and backend.stream_endpoint is None
        assert await backend.transcribe(make_wav()) == ""
        assert decode_calls == 0
        audio = make_wav()[:-2] + b"\x00\x40"
        assert await backend.transcribe(audio) == "Hallo, this is English."
        fail = True
        with pytest.raises(RuntimeError, match="later segment"):
            await backend.transcribe(audio)
        assert len(set(worker_ids)) == 1 and owner not in worker_ids
    finally:
        await backend.close()
    assert not backend.alive()


@pytest.mark.anyio
async def test_whisper_download_install_activate_and_restart(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from diktator.inference import store as store_module

    payloads = {
        "model.bin": b"model weights",
        "config.json": b'{"lang_ids": [50259]}',
        "preprocessor_config.json": b'{"feature_size": 128}',
        "tokenizer.json": b'{"model": {"vocab": {"hello": 0}}}',
        "vocabulary.json": b'["hello"]',
    }
    specs = tuple(
        ModelFile(name, len(data), hashlib.sha256(data).hexdigest())
        for name, data in payloads.items()
    )
    monkeypatch.setattr(store_module, "WHISPER_FILES", specs)
    visited: list[str] = []
    original_client = httpx.AsyncClient

    def respond(request: httpx.Request) -> httpx.Response:
        assert store_module.WHISPER_REVISION in request.url.path
        assert store_module.WHISPER_REPO in request.url.path
        name = request.url.path.rsplit("/", 1)[1]
        visited.append(name)
        return httpx.Response(200, content=payloads[name])

    def client(**options: object) -> httpx.AsyncClient:
        return original_client(transport=httpx.MockTransport(respond))

    monkeypatch.setattr(store_module.httpx, "AsyncClient", client)
    store = ModelStore(tmp_path)
    backend = FakeBackend()
    backend.stream_endpoint = None
    backend.finish.set()
    manager = ModelManager(store, lambda _: backend)
    model: ModelId = "whisper-large-v3-turbo"
    await manager.start()
    assert visited == []
    manager.download(model)
    assert manager.job is not None
    await manager.job
    assert set(visited) == payloads.keys()
    assert store.installed(model)
    manager.activate(model)
    await manager.job
    assert manager.active == model and store.preference() == model
    assert await manager.transcribe(model, make_wav()) == "Hallo, this is mixed dictation."
    with pytest.raises(ModelConflict, match=r"Whisper.*Turn off Live text") as conflict:
        async with manager.stream(model):
            pytest.fail("Whisper has no live protocol")
    assert conflict.value.code == "live_transcription_unsupported"
    await manager.close()
    restarted = ModelManager(store, lambda _: FakeBackend())
    await restarted.start()
    assert restarted.job is not None
    await restarted.job
    assert restarted.active == model
    await restarted.close()
    (store.path(model) / "tokenizer.json").unlink()
    assert not store.installed(model)


@pytest.mark.anyio
@pytest.mark.parametrize("payload", [b"<!DOCTYPE html>", b"{}", b"null", b"[]"])
async def test_download_rejects_invalid_or_empty_json(tmp_path: Path, payload: bytes) -> None:
    async def chunks() -> AsyncIterator[bytes]:
        yield payload

    with pytest.raises(ValueError):
        await write_verified_file(
            chunks(), tmp_path / "config.json", ModelFile("config.json", None, None)
        )


@pytest.mark.anyio
@pytest.mark.parametrize("model", ["phonon-2", "parakeet-v3", "whisper-large-v3-turbo"])
async def test_delete_active_model_unloads_before_removal_and_keeps_other_data(
    tmp_path: Path,
    model: ModelId,
) -> None:
    store = ModelStore(tmp_path / "models")
    for item in ("phonon-2", "parakeet-v3", "whisper-large-v3-turbo"):
        install_fixture(store, item)
    chats = tmp_path / "chats"
    chats.mkdir()
    (chats / "recording.wav").write_bytes(b"keep")

    class CheckingBackend(FakeBackend):
        @override
        async def close(self) -> None:
            assert store.installed(model)
            await super().close()

    backend = CheckingBackend()
    manager = ModelManager(store, lambda _: backend)
    manager.activate(model)
    assert manager.job is not None
    await manager.job
    manager.delete(model)
    assert next(item for item in manager.status().models if item.id == model).state == "deleting"
    with pytest.raises(ModelConflict):
        manager.activate(model)
    with pytest.raises(ModelConflict):
        manager.download(model)
    with pytest.raises(ModelConflict):
        await manager.transcribe(model, make_wav())
    await manager.job
    assert backend.closed and manager.active is None and manager.backend is None
    assert not store.path(model).exists()
    assert all(item.installed for item in manager.status().models if item.id != model)
    assert (chats / "recording.wav").read_bytes() == b"keep"
    # Deleting a missing model is harmless, and restart does not auto-switch models.
    manager.delete(model)
    await manager.job
    await manager.close()
    restarted = ModelManager(store)
    await restarted.start()
    assert restarted.job is None
    await restarted.close()


@pytest.mark.anyio
async def test_delete_inactive_model_route_and_unknown_identity(tmp_path: Path) -> None:
    store = ModelStore(tmp_path)
    install_fixture(store, "phonon-2")
    install_fixture(store, "parakeet-v3")
    backend = FakeBackend()
    manager = ModelManager(store, lambda _: backend)
    async with engine_client(manager) as client:
        assert manager.job is not None
        await manager.job
        assert (await client.post("/models/unknown/delete")).status_code == 422
        response = await client.post("/models/parakeet-v3/delete")
        assert response.status_code == 202
        assert response.json()["models"][1]["state"] == "deleting"
        await manager.job
        assert not store.path("parakeet-v3").exists()
        assert manager.active == "phonon-2" and backend.alive()


@pytest.mark.anyio
async def test_failed_delete_preserves_files_and_releases_reservation(tmp_path: Path) -> None:
    store = ModelStore(tmp_path)
    install_fixture(store, "parakeet-v3")
    manager = ModelManager(store)
    with exclusive_lock(tmp_path / ".install.lock"):
        manager.delete("parakeet-v3")
        assert manager.job is not None
        await manager.job
    assert store.installed("parakeet-v3")
    assert manager.status().models[1].state == "error"
    assert not manager.working
    manager.delete("parakeet-v3")
    await manager.job
    assert manager.status().models[1].state == "missing"
    await manager.close()


@pytest.mark.anyio
async def test_shutdown_waits_for_deletion_worker(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = ModelStore(tmp_path)
    install_fixture(store, "parakeet-v3")
    started = asyncio.Event()
    finish = threading.Event()
    loop = asyncio.get_running_loop()
    delete = store.delete

    def slow_delete(model: ModelId) -> None:
        loop.call_soon_threadsafe(started.set)
        if not finish.wait(timeout=5):
            raise TimeoutError("test did not release deletion worker")
        delete(model)

    monkeypatch.setattr(store, "delete", slow_delete)
    manager = ModelManager(store)
    manager.delete("parakeet-v3")
    await started.wait()
    closing = asyncio.create_task(manager.close())
    try:
        await asyncio.sleep(0)
        assert not closing.done()
        with pytest.raises(ModelConflict, match="already running"):
            manager.download("parakeet-v3")
    finally:
        finish.set()
        await closing
    assert not store.path("parakeet-v3").exists()


@pytest.mark.anyio
@pytest.mark.parametrize(
    "code",
    ["model_loading", "model_deleting", "model_busy", "model_not_active", "model_not_installed"],
)
async def test_engine_http_classifies_model_admission(tmp_path: Path, code: str) -> None:
    store = ModelStore(tmp_path)
    install_fixture(store, "phonon-2")
    backend = FakeBackend()
    manager = ModelManager(store, lambda _: backend)
    async with engine_client(manager) as client:
        assert manager.job is not None
        await manager.job
        reserved: asyncio.Task[None] | None = None
        if code in {"model_loading", "model_deleting"}:

            async def hold_reservation() -> None:
                await asyncio.Event().wait()

            reserved = asyncio.create_task(hold_reservation())
            manager.job = reserved
            manager.job_kind = "load" if code == "model_loading" else "delete"
        manager.streaming = code == "model_busy"
        try:
            path = (
                "/models/parakeet-v3/activate"
                if code == "model_not_installed"
                else "/transcribe?model=parakeet-v3"
                if code == "model_not_active"
                else "/transcribe?model=phonon-2"
            )
            response = await client.post(path, content=make_wav())
            assert response.status_code == 409
            assert response.json()["code"] == code
            assert isinstance(response.json()["detail"], str)
        finally:
            manager.streaming = False
            if reserved is not None:
                reserved.cancel()
                await asyncio.gather(reserved, return_exceptions=True)
                manager.job = None


@pytest.mark.anyio
@pytest.mark.parametrize(
    "path",
    [
        "/api/models",
        "/api/models/phonon-2/download",
        "/api/models/phonon-2/activate",
        "/api/models/phonon-2/delete",
    ],
)
@pytest.mark.parametrize("failure", ["timeout", "transport", "invalid", "unknown", "busy"])
async def test_model_proxy_uses_the_same_failure_mapping(path: str, failure: str) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if failure == "timeout":
            raise httpx.ReadTimeout("private", request=request)
        if failure == "transport":
            raise httpx.ConnectError("private", request=request)
        if failure == "invalid":
            return httpx.Response(200, json=[])
        return httpx.Response(
            409,
            json={"detail": "private", "code": "model_busy" if failure == "busy" else "unknown"},
        )

    async with client_for(handler) as client:
        response = await client.request("GET" if path == "/api/models" else "POST", path)
    status, code = {
        "timeout": (504, "engine_timeout"),
        "transport": (503, "engine_unavailable"),
        "invalid": (502, "engine_error"),
        "unknown": (502, "engine_error"),
        "busy": (409, "model_busy"),
    }[failure]
    assert response.status_code == status
    assert response.json()["code"] == code
    assert "private" not in response.text
