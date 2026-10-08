"""Filesystem durability shared by audio, legacy moves and database backups."""

import os
from pathlib import Path


def sync_directory(directory: Path) -> None:
    """Persist renames on platforms that provide directory fsync."""
    if os.name == "nt":
        return
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
