"""Canonical matching, scoped SQLite listing and browser-free HTTP search behavior."""

from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import patch

import pytest
from sqlalchemy.exc import OperationalError

from diktator.chats import ChatService
from diktator.config import Settings
from diktator.db import session_scope
from diktator.db.rows import LOCAL_USER_ID, ChatMemberRow, UserRow
from diktator.errors import ApiFailure
from diktator.search import one_edit_apart, parse_query, tokens
from tests.test_app import client_for
from tests.test_chats import transcribing_engine


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.mark.parametrize(
    ("query", "text", "matches"),
    [
        ("meeting", "There is a meeting after lunch", True),
        ("meet", "meeting", True),
        ("meting", "meeting", True),
        ("meetting", "meeting", True),
        ("metting", "meeting", True),
        ("meeitng", "meeting", True),
        ("metign", "meeting", False),
        ("plan", "pan", True),
        ("plan", "plaid", False),
        ("cat", "bat", False),
        ("art", "heart", False),
        ("ca", "caterpillar", True),
        ("absent lunch", "meeting after lunch", True),
        ("ABSENT,\tLUNCH!", "meeting after lunch", True),
        ("Straße", "STRASSE", True),
        ("strase", "Straße", True),
        ("cafe", "café", True),
        ("für", "fur", False),
        ("Ｃａｆé", "cafe\u0301", True),
        ("İstanbul", "İSTANBUL", True),
        ("कि", "कि", True),
        ("42", "note 42", True),
        ("none", "", False),
        ("", "", True),
        ("  \t", "", True),
        (".*[]", "Anything", True),
        ("^meeting$", "meeting", True),
    ],
)
def test_matching_contract(query: str, text: str, matches: bool) -> None:
    assert parse_query(query).matches(text, "New chat") is matches


@pytest.mark.parametrize(
    ("left", "right", "matches"),
    [
        ("", "", True),
        ("", "a", True),
        ("a", "", True),
        ("abcd", "abdc", True),
        ("abcd", "adbc", False),
        ("abcd", "xycd", False),
        ("abcd", "abcdef", False),
    ],
)
def test_bounded_one_edit_comparison(left: str, right: str, matches: bool) -> None:
    assert one_edit_apart(left, right) is matches
    assert one_edit_apart(right, left) is matches


def test_query_normalization_and_distinct_limits() -> None:
    assert tokens("one_two—three 42 Cafe\u0301 कि") == ("one", "two", "three", "42", "café", "कि")
    assert parse_query("Straße STRASSE \u212a K \uff2b").terms == ("strasse", "k")
    assert len(parse_query(" ".join(f"word{i}" for i in range(16))).terms) == 16
    assert parse_query("same " * 17).terms == ("same",)
    assert parse_query("😀" * 256).terms == ()
    for value in ("😀" * 257, " ".join(f"word{i}" for i in range(17))):
        with pytest.raises(ApiFailure) as error:
            parse_query(value)
        assert error.value.code == "invalid_search_query"
        assert error.value.status_code == 422


def test_search_uses_only_membership_scoped_current_records(service: ChatService) -> None:
    shared = service.create(LOCAL_USER_ID)
    private = service.create(LOCAL_USER_ID)
    service.update_text(LOCAL_USER_ID, shared.id, "Public notes with a final meeting")
    service.update_text(LOCAL_USER_ID, private.id, "Private meeting")
    with session_scope(service.engine, write=True) as session:
        session.add(UserRow(id="other", created=datetime.now(UTC)))
        session.flush()
        session.add(ChatMemberRow(chat_id=shared.id, user_id="other", role="owner"))
    assert [summary.id for summary in service.list("other", "meeting")] == [shared.id]
    assert service.list("other", "private") == []
    assert service.list("nonexistent", "meeting") == []
    service.update_title("other", shared.id, "Gemeinsame Notizen")
    assert [summary.id for summary in service.list(LOCAL_USER_ID, "notizen")] == [shared.id]
    service.delete(LOCAL_USER_ID, shared.id)
    assert service.list("other", "notizen") == []


@pytest.mark.anyio
async def test_http_search_full_text_custom_names_order_and_unchanged_representation(
    tmp_path: Path,
) -> None:
    async with client_for(transcribing_engine, Settings(data_directory=tmp_path)) as client:
        first = (await client.post("/api/chats")).json()["id"]
        second = (await client.post("/api/chats")).json()["id"]
        empty = (await client.post("/api/chats")).json()["id"]
        first_text = "Opening sentence " * 15 + "buried keyword MEETING"
        await client.put(f"/api/chats/{first}/text", json={"text": first_text})
        await client.put(f"/api/chats/{second}/text", json={"text": "Lunch notes"})
        await client.put(f"/api/chats/{second}/title", json={"custom_title": "Straße & Café"})
        before = {
            chat_id: (await client.get(f"/api/chats/{chat_id}")).json()
            for chat_id in (first, second, empty)
        }
        ordinary = (await client.get("/api/chats")).json()
        assert [item["id"] for item in ordinary] == [second, first, empty]
        for query in (None, "", " \t", "[]?!"):
            response = await client.get("/api/chats", params={} if query is None else {"q": query})
            assert response.status_code == 200
            assert response.json() == ordinary
        buried = await client.get("/api/chats", params={"q": "keyword"})
        assert buried.json() == [ordinary[1]]
        assert "keyword" not in buried.json()[0]["title"]
        combined = await client.get("/api/chats", params={"q": "meeitng lunch"})
        assert combined.json() == ordinary[:2]
        assert (await client.get("/api/chats", params={"q": "STRASSE"})).json() == [ordinary[0]]
        assert (await client.get("/api/chats", params={"q": "Cafe\u0301"})).json() == [ordinary[0]]
        assert (await client.get("/api/chats", params={"q": "unfindable"})).json() == []
        assert set(ordinary[0]) == {
            "id",
            "title",
            "custom_title",
            "updated",
            "recording_count",
            "group_id",
            "placement_etag",
            "etag",
        }
        for chat_id in before:
            assert (await client.get(f"/api/chats/{chat_id}")).json() == before[chat_id]
        # Subsequent reads see committed text, title reset and deletion immediately.
        await client.put(f"/api/chats/{first}/text", json={"text": "Changed words"})
        assert (await client.get("/api/chats", params={"q": "keyword"})).json() == []
        await client.put(f"/api/chats/{second}/title", json={"custom_title": None})
        assert (await client.get("/api/chats", params={"q": "strasse"})).json() == []
        await client.delete(f"/api/chats/{second}")
        assert (await client.get("/api/chats", params={"q": "lunch"})).json() == []


@pytest.mark.anyio
async def test_http_query_bounds_and_explicit_storage_failures(tmp_path: Path) -> None:
    async with client_for(transcribing_engine, Settings(data_directory=tmp_path)) as client:
        for query in ("😀" * 257, " ".join(f"word{i}" for i in range(17))):
            response = await client.get("/api/chats", params={"q": query})
            assert response.status_code == 422
            assert response.json()["code"] == "invalid_search_query"
            assert isinstance(response.json()["detail"], str)
        assert (await client.get("/api/chats", params={"q": "😀" * 256})).status_code == 200
        with patch(
            "diktator.chats.session_scope",
            side_effect=OperationalError("query", {}, Exception("private storage detail")),
        ):
            response = await client.get("/api/chats", params={"q": "meeting"})
        assert response.status_code == 500
        assert response.json() == {
            "code": "storage_error",
            "detail": "Saved chats could not be loaded. Try again.",
        }


@pytest.mark.anyio
async def test_search_excludes_placeholder_and_truncated_title_artifacts(tmp_path: Path) -> None:
    async with client_for(transcribing_engine, Settings(data_directory=tmp_path)) as client:
        await client.post("/api/chats")
        for query in ("new", "chat", "chats", "neww"):
            assert (await client.get("/api/chats", params={"q": query})).json() == []
        chat_id = (await client.post("/api/chats")).json()["id"]
        word = "Donaudampfschifffahrtsgesellschaftskapitänswitwenrente"
        chat = (await client.put(f"/api/chats/{chat_id}/text", json={"text": word})).json()
        title_token = tokens(chat["title"])[0]
        query = title_token[:-1] + "x"
        assert not parse_query(query).matches(word, "")
        assert (await client.get("/api/chats", params={"q": query})).json() == []
        await client.put(f"/api/chats/{chat_id}/title", json={"custom_title": "New chat"})
        assert len((await client.get("/api/chats", params={"q": "new"})).json()) == 1
