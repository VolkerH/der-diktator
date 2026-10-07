"""Configuration shared by the web routes and command line."""

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    """Keep the inference service separate from the browser-facing application."""

    engine_url: str = "http://127.0.0.1:8010"
    transcription_timeout_seconds: float = 180.0
    max_audio_bytes: int = 20_000_044
    max_duration_seconds: int = 600

    @classmethod
    def from_environment(cls) -> "Settings":
        """Read the inference endpoint; remaining limits are application defaults."""
        return cls(engine_url=os.environ.get("PHONON_ENGINE_URL", "http://127.0.0.1:8010"))
