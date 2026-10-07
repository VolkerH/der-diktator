"""WAV validation protects the engine from malformed or oversized recordings."""

import io
import wave

import pytest

from diktator.audio import validate_recording


def make_wav(*, rate: int = 16_000, channels: int = 1, width: int = 2, frames: int = 160) -> bytes:
    """Produce a small PCM recording without an audio device or model."""
    output = io.BytesIO()
    with wave.open(output, "wb") as recording:
        recording.setnchannels(channels)
        recording.setsampwidth(width)
        recording.setframerate(rate)
        recording.writeframes(b"\0" * frames * channels * width)
    return output.getvalue()


def test_valid_recording_reports_actual_duration() -> None:
    info = validate_recording(make_wav(), max_duration_seconds=600)
    assert info.sample_count == 160
    assert info.duration_seconds == 0.01


@pytest.mark.parametrize("audio", [b"", b"not a recording", make_wav()[:20], make_wav()[:-1]])
def test_rejects_unreadable_or_truncated_recordings(audio: bytes) -> None:
    with pytest.raises(ValueError):
        validate_recording(audio, max_duration_seconds=600)


@pytest.mark.parametrize("audio", [make_wav(rate=48_000), make_wav(channels=2), make_wav(width=1)])
def test_requires_the_browser_wire_format(audio: bytes) -> None:
    with pytest.raises(ValueError, match="16 kHz mono 16-bit"):
        validate_recording(audio, max_duration_seconds=600)


def test_rejects_empty_recording() -> None:
    with pytest.raises(ValueError, match="empty"):
        validate_recording(make_wav(frames=0), max_duration_seconds=600)


def test_duration_limit_is_enforced_from_audio_not_a_client_claim() -> None:
    with pytest.raises(ValueError, match="limit"):
        validate_recording(make_wav(frames=16_001), max_duration_seconds=1)
