"""Validate the PCM WAV format produced by the browser recorder."""

import io
import wave
from dataclasses import dataclass


@dataclass(frozen=True)
class RecordingInfo:
    """Duration and sample count of a validated recording."""

    sample_count: int
    duration_seconds: float


def validate_recording(audio: bytes, *, max_duration_seconds: int) -> RecordingInfo:
    """Require complete, nonempty, 16 kHz mono 16-bit PCM WAV audio."""
    try:
        with wave.open(io.BytesIO(audio), "rb") as recording:
            if (
                recording.getnchannels() != 1
                or recording.getframerate() != 16_000
                or recording.getsampwidth() != 2
                or recording.getcomptype() != "NONE"
            ):
                raise ValueError("The recording must be a 16 kHz mono 16-bit PCM WAV file.")
            sample_count = recording.getnframes()
            if sample_count == 0:
                raise ValueError("The recording is empty. Record some speech and try again.")
            duration = sample_count / 16_000
            if duration > max_duration_seconds:
                raise ValueError("The recording exceeds the allowed duration limit.")
            remaining = sample_count
            while remaining:
                frames = min(remaining, 32_768)
                if len(recording.readframes(frames)) != frames * 2:
                    raise ValueError("The recording is incomplete. Record again and retry.")
                remaining -= frames
    except (wave.Error, EOFError) as error:
        raise ValueError("The recording could not be read as PCM WAV audio.") from error
    return RecordingInfo(sample_count=sample_count, duration_seconds=duration)
