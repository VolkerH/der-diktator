"""Owned file-backed storage for synchronous service acceptance tests."""

from collections.abc import Iterator
from pathlib import Path

import pytest

from diktator.chats import ChatService
from diktator.config import Settings
from diktator.storage import open_storage


@pytest.fixture
def service(tmp_path: Path) -> Iterator[ChatService]:
    storage = open_storage(Settings(data_directory=tmp_path))
    try:
        yield storage.chats
    finally:
        storage.close()
