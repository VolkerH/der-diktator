"""Configuration shared by the web routes and command line."""

import os
from dataclasses import dataclass, field
from pathlib import Path


def default_data_directory() -> Path:
    """Keep chats in the user's home directory unless configured otherwise."""
    return Path.home() / ".phonon" / "chats"


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
        configured = os.environ.get("PHONON_DATA_DIR")
        directory = data_directory or (
            Path(configured).expanduser() if configured else default_data_directory()
        )
        return cls(
            engine_url=os.environ.get("PHONON_ENGINE_URL", "http://127.0.0.1:8010"),
            data_directory=directory,
        )
