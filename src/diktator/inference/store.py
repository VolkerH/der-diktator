"""Atomic, explicit model installation into the application's data directory."""

import asyncio
import fcntl
import hashlib
import json
import os
import shutil
import sys
from collections.abc import AsyncIterator, Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

import httpx
from platformdirs import user_data_path

from diktator.inference.process import stop_process
from diktator.models import ModelId, model_info

CATALOG_VERSION = 1
PARAKEET_REPO = "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8"
PARAKEET_REVISION = "2bda32ec70b097a55adaa07d9a7173915b43cc78"


@dataclass(frozen=True)
class ModelFile:
    name: str
    size: int | None
    sha256: str | None


# Published LFS hashes at the pinned upstream revision. Tokens are a small Git
# file pinned by that same revision, checked structurally before installation.
PARAKEET_FILES = (
    ModelFile(
        "encoder.int8.onnx",
        652184281,
        "acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247",
    ),
    ModelFile(
        "decoder.int8.onnx",
        11845275,
        "179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e",
    ),
    ModelFile(
        "joiner.int8.onnx",
        6355277,
        "3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3",
    ),
    ModelFile("tokens.txt", None, None),
)


def models_directory() -> Path:
    """Weights are application data, independent of chat storage overrides."""
    configured = os.environ.get("DIKTATOR_MODELS_DIR")
    return Path(configured).expanduser() if configured else user_data_path("diktator") / "models"


@contextmanager
def exclusive_lock(path: Path) -> Iterator[None]:
    """Coordinate CLI and GUI processes; the OS releases locks after a crash."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError("Another model operation is running. Try again shortly.") from error
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


class ModelStore:
    """Only complete model directories are promoted into the visible store."""

    def __init__(self, root: Path) -> None:
        self.root = root

    def path(self, model_id: str) -> Path:
        return self.root / model_info(model_id).id

    def installed(self, model_id: str) -> bool:
        directory = self.path(model_id)
        try:
            manifest = json.loads((directory / "installed.json").read_text())
            if manifest["version"] != CATALOG_VERSION or manifest["model"] != model_id:
                return False
            files = manifest["files"]
            required = (
                {item.name for item in PARAKEET_FILES}
                if model_id == "parakeet-v3"
                else {"config.json", "packed_manifest.json", "model.fermion"}
            )
            return (
                isinstance(files, dict)
                and required <= files.keys()
                and all(
                    isinstance(name, str)
                    and Path(name).name == name
                    and isinstance(size, int)
                    and size > 0
                    and (directory / name).is_file()
                    and (directory / name).stat().st_size == size
                    for name, size in files.items()
                )
            )
        except (OSError, ValueError, KeyError, TypeError):
            return False

    def preference(self) -> ModelId:
        try:
            return model_info((self.root / "selected-model").read_text().strip()).id
        except (OSError, ValueError):
            return "phonon-2"

    def select(self, model_id: ModelId) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        temporary = self.root / ".selected-model.tmp"
        temporary.write_text(model_info(model_id).id + "\n")
        temporary.replace(self.root / "selected-model")

    async def install(self, model_id: ModelId, report: Callable[[str], None]) -> None:
        """Explicit download, at most one hour; failed staging is safe to retry."""
        destination = self.path(model_id)
        with exclusive_lock(self.root / ".install.lock"):
            if self.installed(model_id):
                return
            stage = self.root / f".{model_id}.download"
            shutil.rmtree(stage, ignore_errors=True)
            stage.mkdir()
            try:
                async with asyncio.timeout(3600):
                    if model_id == "phonon-2":
                        await download_phonon(stage, report)
                    else:
                        await download_parakeet(stage, report)
                files = {p.name: p.stat().st_size for p in stage.iterdir() if p.is_file()}
                (stage / "installed.json").write_text(
                    json.dumps(
                        {
                            "version": CATALOG_VERSION,
                            "model": model_id,
                            "files": files,
                        }
                    )
                )
                # Only an incomplete old installation can reach this path.
                if destination.exists():
                    shutil.rmtree(destination)
                stage.replace(destination)
            finally:
                shutil.rmtree(stage, ignore_errors=True)


async def write_verified_file(chunks: AsyncIterator[bytes], path: Path, spec: ModelFile) -> None:
    """Stream bounded bytes and verify the published digest before promotion."""
    digest = hashlib.sha256()
    count = 0
    with path.open("wb") as output:
        async for chunk in chunks:
            count += len(chunk)
            if count > (spec.size if spec.size is not None else 200_000):
                raise ValueError(f"Unexpected size for {spec.name}. Retry the download.")
            digest.update(chunk)
            output.write(chunk)
    if (spec.size is not None and count != spec.size) or (
        spec.sha256 is not None and digest.hexdigest() != spec.sha256
    ):
        raise ValueError(f"Verification failed for {spec.name}. Retry the download.")
    if spec.name == "tokens.txt":
        rows = path.read_text().splitlines()
        if len(rows) != 8193 or rows[0] != "<unk> 0" or rows[-1].rsplit(" ", 1)[-1] != "8192":
            raise ValueError("The downloaded vocabulary is incomplete.")


async def download_parakeet(stage: Path, report: Callable[[str], None]) -> None:
    async with httpx.AsyncClient(
        follow_redirects=True, timeout=httpx.Timeout(60, connect=15)
    ) as client:
        for index, spec in enumerate(PARAKEET_FILES, start=1):
            report(f"Downloading Parakeet v3 (file {index} of {len(PARAKEET_FILES)})…")
            url = f"https://huggingface.co/{PARAKEET_REPO}/resolve/{PARAKEET_REVISION}/{spec.name}"
            async with client.stream("GET", url) as response:
                response.raise_for_status()
                await write_verified_file(response.aiter_bytes(), stage / spec.name, spec)


async def download_phonon(stage: Path, report: Callable[[str], None]) -> None:
    """Use Fermion's pinned archive verification, isolated from existing caches."""
    report("Downloading and verifying Phonon-2…")
    cache = stage / "cache"
    environment = {
        **os.environ,
        "FERMION_CACHE_DIR": str(cache),
        "HF_HUB_DOWNLOAD_TIMEOUT": "60",
        "HF_HUB_ETAG_TIMEOUT": "15",
    }
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        "from fermion.cli import main; main()",
        "transcribe",
        "phonon-2",
        "--download-only",
        "unused.wav",
        env=environment,
    )
    try:
        if await process.wait() != 0:
            raise RuntimeError("Phonon-2 download failed. Check the server log and retry.")
    finally:
        await stop_process(process)
    model = cache / "speech" / "FermionResearch__Phonon-2" / "model_phonon2_c4c_int6"
    for name in ("config.json", "packed_manifest.json", "model.fermion"):
        shutil.move(model / name, stage / name)
    shutil.rmtree(cache)
