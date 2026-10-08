"""CPU adapters with lazily imported native inference dependencies."""

import asyncio
import importlib
import io
import os
import sys
import wave
from array import array
from collections.abc import Iterable, Iterator
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Protocol, cast

import httpx

from diktator.engine import EngineClient, Transcription
from diktator.inference.process import stop_process
from diktator.models import ModelId


class Backend(Protocol):
    """A loaded model; all calls are serialized by ModelManager."""

    stream_endpoint: str | None

    async def load(self, directory: Path) -> None: ...
    async def transcribe(self, audio: bytes) -> str: ...
    async def close(self) -> None: ...
    def alive(self) -> bool: ...


class PhononBackend:
    """Keep Fermion's existing live implementation in an owned subprocess."""

    def __init__(self, port: int = 8011) -> None:
        self.port = port
        self.url = f"http://127.0.0.1:{port}"
        self.stream_endpoint: str | None = self.url
        self.process: asyncio.subprocess.Process | None = None
        # The outer HTTP request has a timeout; this owned task must remain alive
        # while Fermion still decodes, even if that request stops waiting.
        self.client = httpx.AsyncClient(
            base_url=self.url,
            timeout=httpx.Timeout(None, connect=5),
            trust_env=False,
        )

    async def load(self, directory: Path) -> None:
        # Refuse an occupied port rather than accidentally using another process.
        try:
            _reader, writer = await asyncio.open_connection("127.0.0.1", self.port)
        except OSError:
            pass
        else:
            writer.close()
            await writer.wait_closed()
            raise RuntimeError(f"Phonon's internal port {self.port} is occupied.")
        self.process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-c",
            "from fermion.cli import main; main()",
            "serve",
            str(directory),
            "--served-model-name",
            "phonon-2",
            "--host",
            "127.0.0.1",
            "--port",
            str(self.port),
            env={**os.environ, "HF_HUB_OFFLINE": "1"},
        )
        async with asyncio.timeout(180):
            while self.alive():
                if await EngineClient(self.client).is_ready():
                    return
                await asyncio.sleep(0.25)
        raise RuntimeError("Phonon-2 could not start. Check the server log and retry.")

    def alive(self) -> bool:
        return self.process is not None and self.process.returncode is None

    async def transcribe(self, audio: bytes) -> str:
        try:
            response = await self.client.post(
                "/v1/audio/transcriptions",
                files={"file": ("recording.wav", audio, "audio/wav")},
                data={"model": "phonon-2", "response_format": "json"},
            )
            response.raise_for_status()
            return Transcription.model_validate(response.json()).text
        except (httpx.HTTPError, ValueError):
            # A lost connection need not stop native work in the child. Reap it
            # before ModelManager can release this inference reservation.
            await self.close()
            raise

    async def close(self) -> None:
        if self.process is not None:
            await stop_process(self.process)
        await self.client.aclose()


def pcm_samples(audio: bytes) -> array[int]:
    """Decode already validated little-endian PCM without importing NumPy."""
    with wave.open(io.BytesIO(audio), "rb") as wav:
        samples = array("h", wav.readframes(wav.getnframes()))
    if sys.byteorder != "little":
        samples.byteswap()
    return samples


def audio_windows(samples: array[int], sample_rate: int = 16_000) -> Iterator[array[int]]:
    """Cover all samples exactly once, preferring a quiet 100 ms cut at 25-30 s.

    Continuous speech can require a forced cut at 30 s; words across that boundary
    may suffer. Pauses during long dictations give the decoder cleaner boundaries.
    """
    start = 0
    maximum = 30 * sample_rate
    step = max(1, sample_rate // 10)
    while start < len(samples):
        end = min(start + maximum, len(samples))
        if end < len(samples):
            candidates = range(start + 25 * sample_rate, end, step)
            quiet = min(candidates, key=lambda i: sum(s * s for s in samples[i : i + step]))
            energy = sum(s * s for s in samples[quiet : quiet + step]) / step
            if energy < 327 * 327:
                end = quiet + step // 2
        yield samples[start:end]
        start = end


class RecognitionResult(Protocol):
    text: str


class RecognitionStream(Protocol):
    result: RecognitionResult

    def accept_waveform(self, sample_rate: int, waveform: object) -> None: ...


class Recognizer(Protocol):
    def create_stream(self) -> RecognitionStream: ...
    def decode_stream(self, stream: RecognitionStream) -> None: ...


class ParakeetBackend:
    """The optional native recognizer is owned by a single long-lived worker."""

    stream_endpoint = None

    def __init__(self, threads: int = 4) -> None:
        self.threads = threads
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="parakeet")
        self.recognizer: Recognizer | None = None

    def _load(self, directory: Path) -> None:
        sherpa = importlib.import_module("sherpa_onnx")
        self.recognizer = cast(
            Recognizer,
            sherpa.OfflineRecognizer.from_transducer(
                encoder=str(directory / "encoder.int8.onnx"),
                decoder=str(directory / "decoder.int8.onnx"),
                joiner=str(directory / "joiner.int8.onnx"),
                tokens=str(directory / "tokens.txt"),
                num_threads=self.threads,
                sample_rate=16000,
                feature_dim=80,
                decoding_method="greedy_search",
                model_type="nemo_transducer",
                provider="cpu",
            ),
        )

    async def load(self, directory: Path) -> None:
        await asyncio.get_running_loop().run_in_executor(self.pool, self._load, directory)

    def alive(self) -> bool:
        return self.recognizer is not None

    def _transcribe(self, audio: bytes) -> str:
        if self.recognizer is None:
            raise RuntimeError("Parakeet is not loaded.")
        np = importlib.import_module("numpy")
        parts: list[str] = []
        for chunk in audio_windows(pcm_samples(audio)):
            # Do not ask the recognizer to invent words for digital silence.
            if not any(chunk):
                continue
            waveform = np.asarray(chunk, dtype=np.float32) / 32768.0
            stream = self.recognizer.create_stream()
            stream.accept_waveform(16000, waveform)
            self.recognizer.decode_stream(stream)
            parts.append(stream.result.text.strip())
        return " ".join(part for part in parts if part)

    async def transcribe(self, audio: bytes) -> str:
        return await asyncio.get_running_loop().run_in_executor(self.pool, self._transcribe, audio)

    async def close(self) -> None:
        # ModelManager waits for native work before close; release it on its worker.
        def release() -> None:
            self.recognizer = None

        await asyncio.get_running_loop().run_in_executor(self.pool, release)
        self.pool.shutdown(wait=True)


class WhisperRecognizer(Protocol):
    def transcribe(
        self,
        audio: object,
        *,
        task: str,
        multilingual: bool,
        vad_filter: bool,
        condition_on_previous_text: bool,
    ) -> tuple[Iterable[RecognitionResult], object]: ...


class WhisperBackend:
    """Local faster-whisper model, decoded in INT8 on one CPU worker.

    Iterating segments performs inference, so both creation and consumption of
    the lazy iterator stay on the worker owned by the model manager.
    """

    stream_endpoint = None

    def __init__(self, threads: int = 4) -> None:
        self.threads = threads
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="whisper")
        self.recognizer: WhisperRecognizer | None = None

    def _load(self, directory: Path) -> None:
        whisper = importlib.import_module("faster_whisper")
        self.recognizer = cast(
            WhisperRecognizer,
            whisper.WhisperModel(
                str(directory),
                device="cpu",
                compute_type="int8",
                cpu_threads=self.threads,
                num_workers=1,
                local_files_only=True,
            ),
        )

    async def load(self, directory: Path) -> None:
        await asyncio.get_running_loop().run_in_executor(self.pool, self._load, directory)

    def alive(self) -> bool:
        return self.recognizer is not None

    def _transcribe(self, audio: bytes) -> str:
        if self.recognizer is None:
            raise RuntimeError("Whisper is not loaded.")
        samples = pcm_samples(audio)
        if not any(samples):
            return ""
        np = importlib.import_module("numpy")
        waveform = np.asarray(samples, dtype=np.float32) / 32768.0
        segments, _info = self.recognizer.transcribe(
            waveform,
            task="transcribe",
            multilingual=True,
            vad_filter=True,
            condition_on_previous_text=False,
        )
        return " ".join(text for segment in segments if (text := segment.text.strip()))

    async def transcribe(self, audio: bytes) -> str:
        return await asyncio.get_running_loop().run_in_executor(self.pool, self._transcribe, audio)

    async def close(self) -> None:
        def release() -> None:
            self.recognizer = None

        await asyncio.get_running_loop().run_in_executor(self.pool, release)
        self.pool.shutdown(wait=True)


def create_backend(model_id: ModelId) -> Backend:
    if model_id == "phonon-2":
        return PhononBackend(port=int(os.environ.get("DIKTATOR_PHONON_PORT", "8011")))
    threads = max(1, int(os.environ.get("DIKTATOR_CPU_THREADS", "4")))
    if model_id == "parakeet-v3":
        return ParakeetBackend(threads=threads)
    if model_id == "whisper-large-v3-turbo":
        return WhisperBackend(threads=threads)
    raise ValueError("Unknown speech model.")
