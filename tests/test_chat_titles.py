"""Shared title behavior exercised through HTTP, SQLite and independent actors."""

import asyncio
import shutil
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import patch

import pytest
from sqlalchemy.exc import OperationalError

from diktator.chats import ChatService
from diktator.config import Settings
from diktator.db import DATABASE_NAME, open_engine, session_scope, upgrade_schema
from diktator.db.rows import LOCAL_USER_ID, ChatMemberRow, UserRow
from diktator.errors import ApiFailure
from tests.test_app import client_for
from tests.test_audio import make_wav
from tests.test_chats import transcribing_engine

CHAT_ID = "c" * 32


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.mark.anyio
async def test_manual_titles_survive_text_audio_and_restart_then_reset(tmp_path: Path) -> None:
    settings = Settings(data_directory=tmp_path)
    async with client_for(transcribing_engine, settings) as client:
        created = await client.put(f"/api/chats/{CHAT_ID}")
        named = await client.put(
            f"/api/chats/{CHAT_ID}/title",
            json={"custom_title": "  😀 Notes  "},
            headers={"If-Match": created.headers["title-etag"]},
        )
        assert named.status_code == 200
        assert named.json()["title"] == named.json()["custom_title"] == "😀 Notes"
        assert named.json()["title_revision"] == 2
        assert named.json()["text_revision"] == 1
        assert named.headers["text-etag"] == created.headers["text-etag"]
        assert named.headers["etag"] != created.headers["etag"]
        no_op = await client.put(
            f"/api/chats/{CHAT_ID}/title",
            json={"custom_title": "😀 Notes"},
            headers={"If-Match": named.headers["title-etag"]},
        )
        assert no_op.json() == named.json()
        assert no_op.headers["etag"] == named.headers["etag"]
        await client.put(f"/api/chats/{CHAT_ID}/text", json={"text": "Canonical automatic name"})
        await client.put(
            f"/api/chats/{CHAT_ID}/recordings/{'d' * 32}",
            content=make_wav(),
            headers={"Content-Type": "audio/wav"},
        )
        details = await client.get(f"/api/chats/{CHAT_ID}")
        assert details.json()["title"] == "😀 Notes"
        assert details.headers["title-etag"] == named.headers["title-etag"]
        listed = (await client.get("/api/chats")).json()[0]
        assert listed["title"] == listed["custom_title"] == "😀 Notes"
    async with client_for(transcribing_engine, settings) as client:
        current = await client.get(f"/api/chats/{CHAT_ID}")
        assert current.json()["title"] == "😀 Notes"
        reset = await client.put(
            f"/api/chats/{CHAT_ID}/title",
            json={"custom_title": None},
            headers={"If-Match": current.headers["title-etag"]},
        )
        assert reset.json()["title"] == "Canonical automatic name"
        assert reset.json()["custom_title"] is None
        assert reset.json()["text_revision"] == current.json()["text_revision"]
        title = await client.get(f"/api/chats/{CHAT_ID}/title")
        assert title.json() == {
            key: reset.json()[key] for key in ("title", "custom_title", "title_revision")
        }
        assert title.headers["etag"] == reset.headers["title-etag"]
        assert int(title.headers["chat-revision"]) == reset.json()["revision"]


@pytest.mark.parametrize(
    "value",
    [
        "",
        "  ",
        "a" * 121,
        "line\nname",
        "\tname",
        "name\x00",
        "name\x7f",
        "name\u2028",
        "name\u2029",
    ],
)
@pytest.mark.anyio
async def test_invalid_title_strings_do_not_mutate(tmp_path: Path, value: str) -> None:
    async with client_for(transcribing_engine, Settings(data_directory=tmp_path)) as client:
        created = await client.put(f"/api/chats/{CHAT_ID}")
        invalid = await client.put(f"/api/chats/{CHAT_ID}/title", json={"custom_title": value})
        assert invalid.status_code == 422
        assert invalid.json()["code"] == "invalid_title"
        assert isinstance(invalid.json()["detail"], str)
        assert (await client.get(f"/api/chats/{CHAT_ID}")).json() == created.json()


@pytest.mark.anyio
async def test_title_request_schema_and_unicode_limit(tmp_path: Path) -> None:
    async with client_for(transcribing_engine, Settings(data_directory=tmp_path)) as client:
        await client.put(f"/api/chats/{CHAT_ID}")
        for body in ({}, {"custom_title": 12}, {"custom_title": "name", "text": "discard"}, None):
            invalid = await client.put(f"/api/chats/{CHAT_ID}/title", json=body)
            assert invalid.status_code == 422
            assert invalid.json()["code"] == "validation_error"
        accepted = await client.put(
            f"/api/chats/{CHAT_ID}/title", json={"custom_title": "😀" * 120}
        )
        assert accepted.status_code == 200
        assert accepted.json()["title"] == "😀" * 120
        missing = await client.put(f"/api/chats/{'e' * 32}/title", json={"custom_title": "name"})
        assert missing.status_code == 404
        assert missing.json()["code"] == "chat_not_found"


@pytest.mark.anyio
async def test_scoped_conflicts_and_atomic_parallel_title_writes(tmp_path: Path) -> None:
    async with client_for(transcribing_engine, Settings(data_directory=tmp_path)) as client:
        created = await client.put(f"/api/chats/{CHAT_ID}")
        text = await client.put(f"/api/chats/{CHAT_ID}/text", json={"text": "Automatic"})
        assert text.headers["title-etag"] != created.headers["title-etag"]
        for validator in (
            created.headers["title-etag"],
            text.headers["etag"],
            "W/" + text.headers["title-etag"],
        ):
            stale = await client.put(
                f"/api/chats/{CHAT_ID}/title",
                json={"custom_title": "Stale"},
                headers={"If-Match": validator},
            )
            assert stale.status_code == 412
            assert stale.json()["code"] == "revision_conflict"
        responses = await asyncio.gather(
            *(
                client.put(
                    f"/api/chats/{CHAT_ID}/title",
                    json={"custom_title": name},
                    headers={"If-Match": text.headers["title-etag"]},
                )
                for name in ("A", "B")
            )
        )
        assert sorted(result.status_code for result in responses) == [200, 412]
        winner = next(result for result in responses if result.status_code == 200)
        saved = await client.put(
            f"/api/chats/{CHAT_ID}/text",
            json={"text": "Different transcript"},
            headers={"If-Match": text.headers["text-etag"]},
        )
        assert saved.status_code == 200
        assert saved.json()["title"] == winner.json()["title"]
        assert saved.headers["title-etag"] == winner.headers["title-etag"]
        assert (await client.delete(f"/api/chats/{CHAT_ID}")).status_code == 204
        recreated = await client.put(f"/api/chats/{CHAT_ID}")
        assert recreated.headers["title-etag"] != created.headers["title-etag"]


def test_title_membership_scope_and_shared_visibility(service: ChatService) -> None:
    chat = service.create(LOCAL_USER_ID)
    with session_scope(service.engine, write=True) as session:
        session.add(UserRow(id="other", created=datetime.now(UTC)))
    for operation in (
        lambda: service.get("other", chat.id),
        lambda: service.update_title("other", chat.id, "Secret"),
    ):
        with pytest.raises(ApiFailure) as error:
            operation()
        assert error.value.code == "chat_not_found"
    with session_scope(service.engine, write=True) as session:
        session.add(ChatMemberRow(chat_id=chat.id, user_id="other", role="owner"))
    service.update_title("other", chat.id, "Shared name")
    assert service.get(LOCAL_USER_ID, chat.id).title == "Shared name"


def test_released_schema_title_defaults_and_persistence(tmp_path: Path) -> None:
    shutil.copyfile(
        Path(__file__).parent / "fixtures/database/0002.sqlite3", tmp_path / DATABASE_NAME
    )
    with sqlite3.connect(tmp_path / DATABASE_NAME) as database:
        database.execute(
            "INSERT INTO chats (id, created, updated, text, created_by, revision, text_revision, "
            "incarnation) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                CHAT_ID,
                "2026-10-08 10:00:00",
                "2026-10-08 11:00:00",
                "Before migration",
                LOCAL_USER_ID,
                3,
                2,
                "a" * 32,
            ),
        )
        database.execute(
            "INSERT INTO chat_members (chat_id, user_id, role) VALUES (?, ?, ?)",
            (CHAT_ID, LOCAL_USER_ID, "owner"),
        )
    engine = open_engine(tmp_path / DATABASE_NAME)
    try:
        upgrade_schema(engine, tmp_path)
        service = ChatService(tmp_path, engine)
        chat = service.get(LOCAL_USER_ID, CHAT_ID)
        assert chat.text == chat.title == "Before migration"
        assert (chat.revision, chat.text_revision) == (3, 2)
        assert chat.custom_title is None
        assert chat.title_revision == 1
        service.update_title(LOCAL_USER_ID, chat.id, "Migrated name")
        assert service.get(LOCAL_USER_ID, chat.id).title == "Migrated name"
    finally:
        engine.dispose()


@pytest.mark.anyio
async def test_failed_title_commit_rolls_back_and_reports_storage_error(tmp_path: Path) -> None:
    async with client_for(transcribing_engine, Settings(data_directory=tmp_path)) as client:
        created = await client.put(f"/api/chats/{CHAT_ID}")
        original = ChatService._model

        def fail_after_flush(service, session, row):
            model = original(service, session, row)
            if row.custom_title == "Lost":
                raise OperationalError("statement", {}, Exception("private disk diagnostic"))
            return model

        with patch("diktator.chats.ChatService._model", fail_after_flush):
            failed = await client.put(f"/api/chats/{CHAT_ID}/title", json={"custom_title": "Lost"})
        assert failed.status_code == 500
        assert failed.json() == {
            "code": "storage_error",
            "detail": "The name could not be saved. Try again.",
        }
        assert (await client.get(f"/api/chats/{CHAT_ID}")).json() == created.json()


@pytest.mark.anyio
async def test_title_text_and_audio_mutations_preserve_each_other(tmp_path: Path) -> None:
    async with client_for(transcribing_engine, Settings(data_directory=tmp_path)) as client:
        await client.put(f"/api/chats/{CHAT_ID}")
        named = await client.put(f"/api/chats/{CHAT_ID}/title", json={"custom_title": "Initial"})
        results = await asyncio.gather(
            client.put(
                f"/api/chats/{CHAT_ID}/title",
                json={"custom_title": "Final name"},
                headers={"If-Match": named.headers["title-etag"]},
            ),
            client.put(
                f"/api/chats/{CHAT_ID}/text",
                json={"text": "Final transcript"},
                headers={"If-Match": named.headers["text-etag"]},
            ),
            client.put(
                f"/api/chats/{CHAT_ID}/recordings/{'d' * 32}",
                content=make_wav(),
                headers={"Content-Type": "audio/wav"},
            ),
        )
        assert [result.status_code for result in results] == [200, 200, 201]
        current = (await client.get(f"/api/chats/{CHAT_ID}")).json()
        assert current["title"] == current["custom_title"] == "Final name"
        assert current["text"] == "Final transcript"
        assert len(current["recordings"]) == 1
        assert (current["revision"], current["text_revision"], current["title_revision"]) == (
            5,
            2,
            3,
        )
