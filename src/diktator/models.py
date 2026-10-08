"""Shared model identities and wire contracts; no inference dependencies."""

from typing import Literal

from pydantic import BaseModel, ConfigDict

ModelId = Literal["phonon-2", "parakeet-v3", "whisper-large-v3-turbo"]


class ModelInfo(BaseModel):
    """An allowlisted model and its user-visible capabilities."""

    model_config = ConfigDict(frozen=True, strict=True)
    id: ModelId
    name: str
    languages: str
    language_labels: list[str]
    download_mb: int
    live: bool
    license: str = "CC-BY-4.0"
    source: str


CATALOG: tuple[ModelInfo, ...] = (
    ModelInfo(
        id="phonon-2",
        name="Phonon-2",
        languages="English",
        language_labels=["English"],
        download_mb=164,
        live=True,
        source="https://huggingface.co/FermionResearch/Phonon-2",
    ),
    ModelInfo(
        id="parakeet-v3",
        name="Parakeet v3",
        languages="German, English + 23 languages",
        language_labels=["German", "English", "+23 languages"],
        download_mb=671,
        live=False,
        source="https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3",
    ),
    ModelInfo(
        id="whisper-large-v3-turbo",
        name="Whisper large-v3-turbo",
        languages="German, English and many other languages",
        language_labels=["German", "English", "Multilingual"],
        download_mb=1622,
        live=False,
        license="MIT",
        source="https://huggingface.co/dropbox-dash/faster-whisper-large-v3-turbo",
    ),
)


def model_info(model_id: str) -> ModelInfo:
    """Reject arbitrary model names before constructing paths or URLs."""
    for model in CATALOG:
        if model.id == model_id:
            return model
    raise ValueError("Unknown speech model.")


class ModelStatus(ModelInfo):
    model_config = ConfigDict(frozen=False, strict=True)

    installed: bool
    state: Literal["missing", "installed", "downloading", "loading", "ready", "error"]
    message: str = ""


class ModelsStatus(BaseModel):
    model_config = ConfigDict(strict=True)
    active: ModelId | None
    preferred: ModelId = "phonon-2"
    busy: bool
    models: list[ModelStatus]
