"""Live transport loss never relinquishes uncertain native ownership."""

import asyncio
import sys
from pathlib import Path
from typing import override

import pytest

from diktator.inference.manager import ModelConflict, ModelManager
from diktator.inference.process import stop_process
from diktator.inference.store import ModelStore
from tests.test_audio import make_wav
from tests.test_models import FakeBackend, install_fixture

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


class PendingNativeBackend(FakeBackend):
    def __init__(self) -> None:
        super().__init__()
        self.loaded = True
        self.stop_started = asyncio.Event()
        self.allow_stop = asyncio.Event()
        self.native_pending = True
        self.close_calls = 0
        self.fail_stop = False

    @override
    async def close(self) -> None:
        self.close_calls += 1
        self.stop_started.set()
        await self.allow_stop.wait()
        if self.fail_stop:
            raise RuntimeError("native stop could not be confirmed")
        self.native_pending = False
        self.closed = True


def ready_manager(tmp_path: Path) -> tuple[ModelManager, PendingNativeBackend]:
    backend = PendingNativeBackend()
    store = ModelStore(tmp_path)
    install_fixture(store, "phonon-2")
    replacement = FakeBackend()
    replacement.finish.set()
    manager = ModelManager(store, lambda _: replacement)
    manager.backend, manager.active = backend, "phonon-2"
    return manager, backend


async def assert_admission_is_closed(manager: ModelManager) -> None:
    assert manager.busy
    with pytest.raises(ModelConflict) as error:
        await manager.transcribe("phonon-2", make_wav())
    assert error.value.code == "model_busy"
    with pytest.raises(ModelConflict) as error:
        async with manager.stream("phonon-2"):
            pytest.fail("a second stream was admitted")
    assert error.value.code == "model_busy"
    for operation in (manager.activate, manager.delete):
        with pytest.raises(ModelConflict) as error:
            operation("phonon-2")
        assert error.value.code == "model_busy"


@pytest.mark.parametrize("termination", ["disconnect", "timeout", "native_error", "cancellation"])
async def test_abnormal_exit_keeps_native_reserved_through_repeated_cleanup_cancellation(
    tmp_path: Path,
    termination: str,
) -> None:
    manager, backend = ready_manager(tmp_path)
    entered = asyncio.Event()
    finish_capture = asyncio.Event()

    async def request() -> None:
        async with manager.stream("phonon-2") as reservation:
            reservation.forward()
            entered.set()
            await finish_capture.wait()
            if termination == "timeout":
                raise TimeoutError
            if termination == "native_error":
                raise ValueError("invalid native event")

    task = asyncio.create_task(request())
    await entered.wait()
    if termination == "cancellation":
        task.cancel()
    else:
        finish_capture.set()
    await backend.stop_started.wait()
    assert backend.native_pending and backend.close_calls == 1
    await assert_admission_is_closed(manager)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    # Repeated cancellation of the request cannot cancel its owned stop/reap task.
    task.cancel()
    await assert_admission_is_closed(manager)
    assert manager.stream_cleanup is not None and not manager.stream_cleanup.cancelled()
    backend.allow_stop.set()
    await manager.stream_cleanup
    assert not backend.native_pending
    assert not manager.busy
    assert manager.job is not None
    await manager.job
    assert manager.backend is not backend
    assert manager.require("phonon-2") is manager.backend
    assert manager.status().active == "phonon-2"
    assert backend.close_calls == 1
    await manager.close()
    assert backend.close_calls == 1


async def test_normal_done_reuses_loaded_backend(tmp_path: Path) -> None:
    manager, backend = ready_manager(tmp_path)
    async with manager.stream("phonon-2") as reservation:
        reservation.complete()
    assert not manager.busy
    assert manager.require("phonon-2") is backend
    async with manager.stream("phonon-2") as reservation:
        reservation.complete()
    assert backend.close_calls == 0
    backend.allow_stop.set()
    await manager.close()


async def test_failed_cleanup_keeps_reservation_and_reports_honest_state(tmp_path: Path) -> None:
    manager, backend = ready_manager(tmp_path)
    backend.fail_stop = True
    backend.allow_stop.set()
    with pytest.raises(RuntimeError):
        async with manager.stream("phonon-2") as reservation:
            reservation.forward()
    assert backend.native_pending
    await assert_admission_is_closed(manager)
    assert manager.status().models[0].state == "error"
    assert "Restart" in manager.status().models[0].message
    # Shutdown retries the backend stop instead of pretending failed cleanup succeeded.
    backend.fail_stop = False
    await manager.close()
    assert not backend.native_pending


@pytest.mark.parametrize("already_cleaning", [False, True])
async def test_shutdown_adopts_cleanup_once_and_survives_requester_cancellation(
    tmp_path: Path,
    already_cleaning: bool,
) -> None:
    manager, backend = ready_manager(tmp_path)
    entered = asyncio.Event()
    exit_stream = asyncio.Event()

    async def recording() -> None:
        async with manager.stream("phonon-2") as reservation:
            reservation.forward()
            entered.set()
            await exit_stream.wait()
            if not already_cleaning:
                reservation.complete()

    request = asyncio.create_task(recording())
    await entered.wait()
    if already_cleaning:
        exit_stream.set()
        await backend.stop_started.wait()
    closing = asyncio.create_task(manager.close())
    await asyncio.sleep(0)
    assert manager.shutdown is not None
    await backend.stop_started.wait()
    assert backend.close_calls == 1
    if not already_cleaning:
        # A late done while shutdown is already stopping must not reopen admission.
        exit_stream.set()
        await request
    await assert_admission_is_closed(manager)
    closing.cancel()
    with pytest.raises(asyncio.CancelledError):
        await closing
    await assert_admission_is_closed(manager)
    assert manager.shutdown is not None and not manager.shutdown.cancelled()
    backend.allow_stop.set()
    await manager.shutdown
    await request
    assert backend.close_calls == 1
    assert not backend.native_pending
    assert manager.backend is None


async def test_owned_cleanup_kills_and_reaps_uncooperative_child(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    child = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        "import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); "
        "print('ready',flush=True); time.sleep(60)",
        stdout=asyncio.subprocess.PIPE,
    )
    assert child.stdout is not None
    assert await child.stdout.readline() == b"ready\n"
    manager, backend = ready_manager(tmp_path)

    async def stop_owned_child() -> None:
        backend.close_calls += 1
        backend.stop_started.set()
        await backend.allow_stop.wait()
        await stop_process(child, grace_seconds=0.01)
        backend.native_pending = False
        backend.closed = True

    monkeypatch.setattr(backend, "close", stop_owned_child)

    async def disconnected() -> None:
        async with manager.stream("phonon-2") as reservation:
            reservation.forward()

    request = asyncio.create_task(disconnected())
    try:
        await backend.stop_started.wait()
        request.cancel()
        with pytest.raises(asyncio.CancelledError):
            await request
        await assert_admission_is_closed(manager)
        assert child.returncode is None
        backend.allow_stop.set()
        assert manager.stream_cleanup is not None
        await asyncio.wait_for(manager.stream_cleanup, timeout=2)
        assert child.returncode is not None
        assert not manager.busy and manager.backend is not backend
        assert backend.close_calls == 1
    finally:
        if child.returncode is None:
            await stop_process(child, grace_seconds=0.01)
        await manager.close()


async def test_shutdown_waits_for_recovery_load_then_stops_replacement(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager, backend = ready_manager(tmp_path)
    replacement = FakeBackend()
    load_started, allow_load = asyncio.Event(), asyncio.Event()

    async def load(_directory: Path) -> None:
        load_started.set()
        await allow_load.wait()
        replacement.loaded = True

    monkeypatch.setattr(replacement, "load", load)
    manager.factory = lambda _: replacement
    backend.allow_stop.set()
    async with manager.stream("phonon-2") as reservation:
        reservation.forward()
    await load_started.wait()
    closing = asyncio.create_task(manager.close())
    await asyncio.sleep(0)
    assert manager.busy and not replacement.closed
    allow_load.set()
    await closing
    assert replacement.closed and backend.close_calls == 1


async def test_failed_recovery_load_reports_error_and_requires_explicit_activation(
    tmp_path: Path,
) -> None:
    manager, backend = ready_manager(tmp_path)
    replacement = FakeBackend()
    replacement.fail_load = True
    manager.factory = lambda _: replacement
    backend.allow_stop.set()
    async with manager.stream("phonon-2") as reservation:
        reservation.forward()
    assert manager.job is not None
    await manager.job
    assert not manager.busy and manager.backend is None
    assert manager.status().models[0].state == "error"
    assert "Use model" in manager.status().models[0].message
    with pytest.raises(ModelConflict, match="not active"):
        await manager.transcribe("phonon-2", make_wav())
    await manager.close()
