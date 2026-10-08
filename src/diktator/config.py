"""Configuration shared by the web routes and command line."""

import json
import os
import shutil
from contextlib import suppress
from dataclasses import dataclass, field
from pathlib import Path

from platformdirs import user_data_path


def default_data_directory() -> Path:
    """The platform's per-user data folder, e.g. ~/.local/share/diktator/chats on Linux."""
    return user_data_path("diktator", appauthor=False) / "chats"


def legacy_data_directories() -> list[Path]:
    """Chat folders used by earlier versions, most recent first."""
    return [Path.home() / ".diktator" / "chats", Path.home() / ".phonon" / "chats"]


def migrate_chats(legacy: Path, target: Path) -> bool:
    """Resume a selected legacy move under the target's lifetime ownership lock.

    A lock-only target is unused. The marker identifies the one permitted source
    and pending child; arbitrary populated targets are never merged. Copies are
    staged before rename, leaving the source intact until its child is finalized.
    """
    from diktator.chats import sync_directory
    from diktator.db import LOCK_NAME

    marker = target / ".legacy-migration.json"
    staging = target / ".legacy-move.tmp"
    if marker.exists():
        state = json.loads(marker.read_text())
        if state["source"] != str(legacy.resolve()):
            return False
    else:
        if not legacy.is_dir():
            return False
        if target.exists() and any(path.name != LOCK_NAME for path in target.iterdir()):
            return False
        target.mkdir(parents=True, exist_ok=True)
        state = {"source": str(legacy.resolve()), "pending": None}

    def persist() -> None:
        temporary = marker.with_suffix(".tmp")
        with temporary.open("w") as stream:
            json.dump(state, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, marker)
        sync_directory(target)

    def remove(path: Path) -> None:
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path)
        else:
            path.unlink()

    def move_child(name: str) -> None:
        if name in {".", "..", LOCK_NAME} or Path(name).name != name:
            raise ValueError("Invalid legacy migration child")
        source, destination = legacy / name, target / name
        if not destination.exists() and not destination.is_symlink():
            if staging.exists() or staging.is_symlink():
                remove(staging)
            if source.is_dir() and not source.is_symlink():
                shutil.copytree(source, staging, symlinks=True)
            elif source.is_symlink():
                staging.symlink_to(os.readlink(source))
            else:
                shutil.copy2(source, staging)
            # Ensure all copied bytes survive before deleting the source.
            if staging.is_dir() and not staging.is_symlink():
                for file in staging.rglob("*"):
                    if file.is_file() and not file.is_symlink():
                        with file.open("rb") as stream:
                            os.fsync(stream.fileno())
                for directory in reversed(list(staging.rglob("*"))):
                    if directory.is_dir() and not directory.is_symlink():
                        sync_directory(directory)
                sync_directory(staging)
            elif not staging.is_symlink():
                with staging.open("rb") as stream:
                    os.fsync(stream.fileno())
            os.replace(staging, destination)
            sync_directory(target)
        if source.exists() or source.is_symlink():
            remove(source)
            sync_directory(legacy)
        state["pending"] = None
        persist()

    persist()
    if state["pending"]:
        move_child(state["pending"])
    if legacy.is_dir():
        for child in sorted(legacy.iterdir()):
            if (target / child.name).exists() or (target / child.name).is_symlink():
                raise RuntimeError(f"Legacy migration would overwrite {target / child.name}")
            state["pending"] = child.name
            persist()
            move_child(child.name)
        legacy.rmdir()
        with suppress(OSError):
            legacy.parent.rmdir()
    marker.unlink()
    sync_directory(target)
    return True


@dataclass(frozen=True)
class Settings:
    """Keep the inference service separate from the browser-facing application."""

    engine_url: str = "http://127.0.0.1:8010"
    transcription_timeout_seconds: float = 180.0
    max_audio_bytes: int = 20_000_044
    max_duration_seconds: int = 600
    max_stream_frame_bytes: int = 65_536
    max_text_characters: int = 1_000_000
    data_directory: Path = field(default_factory=default_data_directory)

    @classmethod
    def from_environment(cls, data_directory: Path | None = None) -> "Settings":
        """Read the inference endpoint and chat storage; remaining limits are defaults."""
        configured = os.environ.get("DIKTATOR_DATA_DIR")
        directory = data_directory or (
            Path(configured).expanduser() if configured else default_data_directory()
        )
        return cls(
            engine_url=os.environ.get("DIKTATOR_ENGINE_URL", "http://127.0.0.1:8010"),
            data_directory=directory,
        )
