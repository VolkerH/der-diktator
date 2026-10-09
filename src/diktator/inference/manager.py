"""Single-model lifecycle and cancellation-safe admission for inference."""

import asyncio
import logging
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass

from diktator.errors import ENGINE_ERRORS, ApiFailure
from diktator.inference.backends import Backend, create_backend
from diktator.inference.store import ModelStore
from diktator.models import CATALOG, ModelId, ModelsStatus, ModelStatus, model_info

logger = logging.getLogger(__name__)


class ModelConflict(ApiFailure):
    """An operation cannot proceed against the currently reserved model."""

    def __init__(self, code: str) -> None:
        status, message = ENGINE_ERRORS[code]
        super().__init__(message, code, status)


@dataclass
class StreamReservation:
    """Track native work separately from a client connection awaiting capture."""

    endpoint: str
    completed: bool = False
    forwarded: bool = False

    def forward(self) -> None:
        self.forwarded = True

    def complete(self) -> None:
        self.completed = True


class ModelManager:
    """Only the event-loop thread changes lifecycle state; workers own inference."""

    def __init__(self, store: ModelStore, factory: Callable[[ModelId], Backend] = create_backend):
        self.store = store
        self.factory = factory
        self.backend: Backend | None = None
        self.active: ModelId | None = None
        self.job: asyncio.Task[None] | None = None
        self.job_model: ModelId | None = None
        self.job_kind: str | None = None
        self.message = ""
        self.errors: dict[ModelId, str] = {}
        self.inference: asyncio.Task[str] | None = None
        self.streaming = False
        self.stream_cleanup: asyncio.Task[None] | None = None
        self.shutdown: asyncio.Task[None] | None = None

    @property
    def busy(self) -> bool:
        return (
            self.streaming
            or self.shutdown is not None
            or (self.stream_cleanup is not None and not self.stream_cleanup.done())
            or (self.inference is not None and not self.inference.done())
        )

    @property
    def working(self) -> bool:
        return self.job is not None and not self.job.done()

    def status(self) -> ModelsStatus:
        alive = self.backend is not None and self.backend.alive()
        models = []
        for info in CATALOG:
            installed = self.store.installed(info.id)
            status = ModelStatus(
                **info.model_dump(),
                installed=installed,
                state="installed" if installed else "missing",
            )
            if info.id == self.active and alive:
                status.state = "ready"
            elif info.id == self.active:
                status.state = "error"
                status.message = "The engine stopped. Choose Use model to reload it."
            if info.id in self.errors:
                status.state = "error"
                status.message = self.errors[info.id]
            if self.working and info.id == self.job_model:
                if self.job_kind == "download":
                    status.state = "downloading"
                elif self.job_kind == "delete":
                    status.state = "deleting"
                else:
                    status.state = "loading"
                status.message = self.message
            models.append(status)
        return ModelsStatus(
            active=self.active if alive else None,
            preferred=self.store.preference(),
            busy=self.busy,
            models=models,
        )

    def download(self, model_id: ModelId) -> None:
        model_info(model_id)
        if self.working:
            if self.job_model == model_id and self.job_kind == "download":
                return
            raise ModelConflict("model_busy")
        if self.store.installed(model_id):
            return
        self.errors.pop(model_id, None)
        self.job_model, self.job_kind = model_id, "download"
        self.message = "Starting download…"
        self.job = asyncio.create_task(self._download(model_id))

    async def _download(self, model_id: ModelId) -> None:
        def report(message: str) -> None:
            self.message = message

        try:
            await self.store.install(model_id, report)
        except Exception:
            logger.exception("Model download failed: %s", model_id)
            self.errors[model_id] = (
                "Download failed. Check network access and free disk space, then retry."
            )

    def activate(self, model_id: ModelId) -> None:
        model_info(model_id)
        if self.busy or self.working:
            raise ModelConflict("model_busy")
        if not self.store.installed(model_id):
            raise ModelConflict("model_not_installed")
        if self.active == model_id and self.backend is not None and self.backend.alive():
            return
        self.errors.pop(model_id, None)
        self.job_model, self.job_kind = model_id, "load"
        self.message = "Loading model…"
        # Reserve synchronously before yielding to another request.
        self.job = asyncio.create_task(self._activate(model_id))

    async def _activate(self, model_id: ModelId) -> None:
        try:
            previous, self.backend = self.backend, None
            self.active = None
            if previous is not None:
                await previous.close()
            backend = self.factory(model_id)
            self.backend = backend
            await backend.load(self.store.path(model_id))
            self.store.select(model_id)
            self.active = model_id
        except Exception:
            logger.exception("Model activation failed: %s", model_id)
            if self.backend is not None:
                await self.backend.close()
            self.backend = None
            self.errors[model_id] = (
                "Model could not load. Check the server log, then choose Use model to retry."
            )

    def delete(self, model_id: ModelId) -> None:
        """Reserve deletion before yielding; HTTP disconnects cannot interrupt it."""
        model_info(model_id)
        if self.busy or self.working:
            raise ModelConflict("model_busy")
        self.errors.pop(model_id, None)
        self.job_model, self.job_kind = model_id, "delete"
        self.message = "Deleting downloaded model…"
        self.job = asyncio.create_task(self._delete(model_id))

    async def _delete(self, model_id: ModelId) -> None:
        try:
            if self.active == model_id:
                if self.backend is not None:
                    await self.backend.close()
                self.backend = None
                self.active = None
            await asyncio.to_thread(self.store.delete, model_id)
        except Exception:
            logger.exception("Model deletion failed: %s", model_id)
            self.errors[model_id] = "Could not delete the download. Check the server log and retry."

    def require(self, model_id: ModelId) -> Backend:
        model_info(model_id)
        if self.working and self.job_kind == "load":
            raise ModelConflict("model_loading")
        if self.working and self.job_kind == "delete":
            raise ModelConflict("model_deleting")
        if self.active != model_id or self.backend is None or not self.backend.alive():
            raise ModelConflict("model_not_active")
        if self.busy:
            raise ModelConflict("model_busy")
        return self.backend

    async def transcribe(self, model_id: ModelId, audio: bytes) -> str:
        backend = self.require(model_id)
        task = asyncio.create_task(backend.transcribe(audio))
        self.inference = task
        # Retrieve errors even when the requesting HTTP connection has disappeared.
        task.add_done_callback(
            lambda completed: completed.exception() if not completed.cancelled() else None
        )
        return await asyncio.shield(task)

    @asynccontextmanager
    async def stream(self, model_id: ModelId) -> AsyncIterator[StreamReservation]:
        backend = self.require(model_id)
        if backend.stream_endpoint is None:
            raise ModelConflict("live_transcription_unsupported")
        reservation = StreamReservation(backend.stream_endpoint)
        self.stream_cleanup = None
        self.streaming = True
        try:
            yield reservation
        finally:
            if reservation.completed or not reservation.forwarded:
                self.streaming = False
            else:
                # WebSocket closure alone is no acknowledgement of native decode
                # completion. This owned task survives repeated requester cancellation.
                await asyncio.shield(self._start_stream_cleanup(backend, model_id))

    def _start_stream_cleanup(self, backend: Backend, model_id: ModelId) -> asyncio.Task[None]:
        if self.stream_cleanup is None:
            self.stream_cleanup = asyncio.create_task(self._abort_stream(backend, model_id))
            self.stream_cleanup.add_done_callback(
                lambda task: task.exception() if not task.cancelled() else None
            )
        return self.stream_cleanup

    async def _abort_stream(self, backend: Backend, model_id: ModelId) -> None:
        try:
            await backend.close()
        except Exception:
            self.errors[model_id] = "Live cleanup failed. Restart the engine before using a model."
            logger.exception("Native live cleanup failed; retaining reservation")
            raise
        # close() confirms stop/reap; only now can other native work be admitted.
        if self.backend is backend:
            self.backend = None
            self.active = None
        self.streaming = False
        if self.shutdown is None:
            # Reserve recovery before yielding. The owned load survives the
            # requesting socket, just like an explicit activation operation.
            self.errors.pop(model_id, None)
            self.job_model, self.job_kind = model_id, "load"
            self.message = "Reloading model after interrupted live transcription…"
            self.job = asyncio.create_task(self._activate(model_id))

    async def start(self) -> None:
        preferred = self.store.preference()
        if self.store.installed(preferred):
            self.activate(preferred)

    async def close(self) -> None:
        if self.shutdown is None:
            self.shutdown = asyncio.create_task(self._close())
            self.shutdown.add_done_callback(
                lambda task: task.exception() if not task.cancelled() else None
            )
        await asyncio.shield(self.shutdown)

    async def _close(self) -> None:
        if self.streaming and self.backend is not None and self.active is not None:
            self._start_stream_cleanup(self.backend, self.active)
        if self.stream_cleanup is not None:
            with suppress(Exception):
                await asyncio.shield(self.stream_cleanup)
        if self.job is not None:
            # Downloads can be cancelled safely; native model loading cannot.
            if self.job_kind == "download":
                self.job.cancel()
            with suppress(asyncio.CancelledError):
                await asyncio.shield(self.job)
        if self.inference is not None:
            with suppress(Exception):
                await asyncio.shield(self.inference)
        if self.backend is not None:
            await self.backend.close()
