"""Shared test setup that keeps default application storage isolated."""

from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import replace
from pathlib import Path
from tempfile import TemporaryDirectory

from diktator.config import Settings, default_data_directory


@contextmanager
def isolated_settings(settings: Settings | None = None) -> Iterator[Settings]:
    """Preserve explicit test roots and replace the real user's default root."""
    with TemporaryDirectory(prefix="diktator-test-") as directory:
        configured = settings or Settings()
        if configured.data_directory == default_data_directory():
            configured = replace(configured, data_directory=Path(directory))
        yield configured
