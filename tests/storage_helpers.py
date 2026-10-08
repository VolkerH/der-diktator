"""Build legacy chat folders for migration recovery tests."""

from datetime import datetime, timedelta, timezone
from pathlib import Path

from diktator.chats import Chat, Recording
from tests.test_audio import make_wav


def legacy_chat(root: Path, *, missing: bool = False) -> Chat:
    created = datetime(2021, 1, 2, 3, 4, 5, 678901, tzinfo=timezone(timedelta(hours=2)))
    chat = Chat(
        id="a" * 32,
        created=created,
        updated=created + timedelta(days=1),
        text="legacy\n  transcript 🌻",
        recordings=[
            Recording(id="b" * 32, created=created + timedelta(seconds=1), duration_seconds=0.01)
        ],
    )
    folder = root / chat.id
    folder.mkdir()
    (folder / "chat.json").write_text(chat.model_dump_json())
    if not missing:
        (folder / f"{chat.recordings[0].id}.wav").write_bytes(make_wav())
    return chat
