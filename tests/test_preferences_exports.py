"""Application behavior through HTTP, with no browser or inference model."""

import re
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path

import pytest
from sqlalchemy import Connection, event
from sqlalchemy.exc import OperationalError

from diktator.chats import ChatService
from diktator.config import Settings
from diktator.db import session_scope
from diktator.db.rows import LOCAL_USER_ID, PreferenceRow, UserRow
from diktator.errors import ApiFailure
from diktator.exports import format_export
from diktator.preferences import DEFAULT_PREAMBLE, PreferenceService, PreferenceUpdate
from tests.test_app import client_for, healthy_engine


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.mark.anyio
async def test_shared_profile_persists_resets_and_never_changes_chats(tmp_path: Path) -> None:
    settings = Settings(data_directory=tmp_path)
    async with client_for(healthy_engine, settings) as first:
        initial = await first.get("/api/preferences")
        chat = (await first.post("/api/chats")).json()
        updated = await first.patch(
            "/api/preferences",
            json={"copy_preamble": "  Dictated 🌻\nCustom  "},
            headers={"If-Match": initial.headers["etag"]},
        )
        assert updated.status_code == 200
        assert updated.json()["revision"] == 2
        assert updated.headers["etag"] != initial.headers["etag"]
        assert (await first.get(f"/api/chats/{chat['id']}")).json() == chat
    # A new application lifetime and client uses the same profile.
    async with client_for(healthy_engine, settings) as second:
        saved = await second.get("/api/preferences")
        assert saved.json()["copy_preamble"] == "  Dictated 🌻\nCustom  "
        assert saved.headers["etag"] == updated.headers["etag"]
        conflict = await second.patch(
            "/api/preferences",
            json={"copy_preamble": "Stale replacement"},
            headers={"If-Match": initial.headers["etag"]},
        )
        assert conflict.status_code == 412
        assert conflict.json()["code"] == "revision_conflict"
        assert conflict.json()["detail"] == "These preferences changed elsewhere."
        assert (await second.get("/api/preferences")).json() == saved.json()
        reset = await second.patch(
            "/api/preferences",
            json={"reset": ["copy_preamble"]},
            headers={"If-Match": saved.headers["etag"]},
        )
        assert reset.json()["copy_preamble"] == DEFAULT_PREAMBLE
        assert reset.json()["revision"] == 3
        noop = await second.patch(
            "/api/preferences",
            json={},
            headers={"If-Match": reset.headers["etag"]},
        )
        assert noop.headers["etag"] == reset.headers["etag"]


@pytest.mark.anyio
async def test_preference_validation_required_conditions_and_operator_separation() -> None:
    async with client_for(healthy_engine) as client:
        initial = await client.get("/api/preferences")
        missing = await client.patch("/api/preferences", json={"copy_preamble": "New"})
        assert missing.status_code == 428
        assert missing.json()["code"] == "precondition_required"
        for body in (
            {"copy_preamble": " "},
            {"copy_preamble": None},
            {"copy_preamble": "a" * 4_001},
            {"copy_preamble": "New", "reset": ["copy_preamble"]},
            {"reset": ["host"]},
            {"host": "0.0.0.0"},
            {"user_id": "other"},
        ):
            bad = await client.patch(
                "/api/preferences", json=body, headers={"If-Match": initial.headers["etag"]}
            )
            assert bad.status_code == 422
            assert bad.json()["code"] == "validation_error"
        weak = await client.patch(
            "/api/preferences", json={}, headers={"If-Match": "W/" + initial.headers["etag"]}
        )
        assert weak.status_code == 412
        listed = await client.patch(
            "/api/preferences",
            json={},
            headers={"If-Match": '"other", ' + initial.headers["etag"]},
        )
        assert listed.status_code == 200
        assert (await client.get("/api/preferences")).json() == initial.json()


@pytest.mark.anyio
async def test_export_uses_unsaved_snapshot_without_chat_side_effects() -> None:
    async with client_for(healthy_engine) as client:
        chat = (await client.post("/api/chats")).json()
        draft = "  unsaved 🌻\n\nMarkdown **bold** `inline`\n``````\nend  "
        plain = await client.post("/api/exports", json={"text": draft})
        assert plain.json() == {"text": draft, "media_type": "text/plain"}
        prepared = await client.post(
            "/api/exports", json={"text": draft, "format": "with_preamble"}
        )
        assert prepared.json() == {
            "text": DEFAULT_PREAMBLE + "\n\n```````text\n" + draft + "\n```````",
            "media_type": "text/markdown",
        }
        assert (await client.get(f"/api/chats/{chat['id']}")).json() == chat
        prefs = await client.get("/api/preferences")
        await client.patch(
            "/api/preferences",
            json={"copy_preamble": "<b>Literal</b> {text}"},
            headers={"If-Match": prefs.headers["etag"]},
        )
        changed = await client.post("/api/exports", json={"text": draft, "format": "with_preamble"})
        assert changed.json()["text"].startswith("<b>Literal</b> {text}\n\n")
        preview = await client.post(
            "/api/exports/preview", json={"copy_preamble": "Unsaved preference"}
        )
        assert preview.json()["text"].startswith("Unsaved preference\n\n")
        assert (await client.get("/api/preferences")).json()[
            "copy_preamble"
        ] == "<b>Literal</b> {text}"


@pytest.mark.anyio
async def test_export_limits_empty_unknown_and_missing_fields() -> None:
    async with client_for(healthy_engine, Settings(max_text_characters=5)) as client:
        for text in ("", " \n\t"):
            result = await client.post("/api/exports", json={"text": text})
            assert result.status_code == 400
            assert result.json()["code"] == "invalid_export"
        result = await client.post("/api/exports", json={"text": "123456"})
        assert result.status_code == 413
        assert result.json()["code"] == "text_too_large"
        for body in ({}, {"text": "text", "format": "html"}, {"text": "text", "chat_id": "x"}):
            result = await client.post("/api/exports", json=body)
            assert result.status_code == 422


@pytest.mark.parametrize("text", ["🌻\n", "  \ntext\n\n", "~~~\n````x\n ", "one\r\ntwo\r\n"])
def test_formatter_keeps_exact_draft_and_only_adds_required_closing_newline(text: str) -> None:
    result = format_export(text, "Literal preamble")
    fence = "`" * max(3, max((len(part) for part in re.findall(r"`+", text)), default=0) + 1)
    assert (
        result.text
        == f"Literal preamble\n\n{fence}text\n{text}"
        + ("" if text.endswith("\n") else "\n")
        + fence
    )
    assert format_export(text).text == text


def test_actor_isolation_and_atomic_parallel_preference_writes(service: ChatService) -> None:
    with session_scope(service.engine, write=True) as session:
        session.add(UserRow(id="other", created=datetime.now(UTC)))
    preferences = PreferenceService(service.engine)
    initial = preferences.get(LOCAL_USER_ID)

    def update(text: str) -> str:
        try:
            preferences.update(
                LOCAL_USER_ID, PreferenceUpdate(copy_preamble=text), initial.etag(LOCAL_USER_ID)
            )
            return "saved"
        except ApiFailure as error:
            return error.code

    with ThreadPoolExecutor(max_workers=2) as executor:
        assert sorted(executor.map(update, ["First", "Second"])) == ["revision_conflict", "saved"]
    assert preferences.get(LOCAL_USER_ID).revision == 2
    assert preferences.get("other").copy_preamble == DEFAULT_PREAMBLE
    assert preferences.get("other").etag("other") != initial.etag(LOCAL_USER_ID)


def test_failed_commit_rolls_back_and_corrupt_preferences_are_not_defaulted(
    service: ChatService,
) -> None:
    preferences = PreferenceService(service.engine)
    initial = preferences.get(LOCAL_USER_ID)

    def fail_commit(_connection: Connection) -> None:
        raise OperationalError("internal path secret", {}, Exception("full disk"))

    event.listen(service.engine, "commit", fail_commit)
    try:
        with pytest.raises(ApiFailure) as failure:
            preferences.update(
                LOCAL_USER_ID, PreferenceUpdate(copy_preamble="New"), initial.etag(LOCAL_USER_ID)
            )
        assert failure.value.code == "persistence_failed"
        assert "secret" not in str(failure.value)
    finally:
        event.remove(service.engine, "commit", fail_commit)
    assert preferences.get(LOCAL_USER_ID) == initial
    with session_scope(service.engine, write=True) as session:
        session.add(PreferenceRow(user_id=LOCAL_USER_ID, copy_preamble=" ", revision=2))
    with pytest.raises(ApiFailure) as failure:
        preferences.get(LOCAL_USER_ID)
    assert failure.value.code == "preferences_unavailable"


@pytest.mark.anyio
async def test_default_mode_tracks_releases_but_equal_custom_text_does_not(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = Settings(data_directory=tmp_path)
    async with client_for(healthy_engine, settings) as client:
        initial = await client.get("/api/preferences")
        custom = await client.patch(
            "/api/preferences",
            json={"copy_preamble": DEFAULT_PREAMBLE},
            headers={"If-Match": initial.headers["etag"]},
        )
        assert custom.json()["revision"] == 2
        assert custom.json()["copy_preamble_is_default"] is False
        monkeypatch.setattr("diktator.preferences.DEFAULT_PREAMBLE", "Updated server default")
        changed = await client.get("/api/preferences")
        assert changed.json()["copy_preamble"] == DEFAULT_PREAMBLE
        assert changed.headers["etag"] != custom.headers["etag"]
        reset = await client.patch(
            "/api/preferences",
            json={"reset": ["copy_preamble"]},
            headers={"If-Match": changed.headers["etag"]},
        )
        assert reset.json()["revision"] == 3
        assert reset.json()["copy_preamble_is_default"] is True
    monkeypatch.setattr("diktator.preferences.DEFAULT_PREAMBLE", "Next release default")
    async with client_for(healthy_engine, settings) as client:
        following = await client.get("/api/preferences")
        assert following.json()["copy_preamble"] == "Next release default"
        assert following.json()["revision"] == 3
        assert following.headers["etag"] != reset.headers["etag"]
        noop = await client.patch(
            "/api/preferences",
            json={"reset": ["copy_preamble"]},
            headers={"If-Match": following.headers["etag"]},
        )
        assert noop.headers["etag"] == following.headers["etag"]


@pytest.mark.anyio
@pytest.mark.parametrize("value", ["", " \n\t", "x" * 4001, None])
async def test_preview_and_save_share_preamble_validation(value: str | None) -> None:
    async with client_for(healthy_engine) as client:
        for method, path in (
            (client.patch, "/api/preferences"),
            (client.post, "/api/exports/preview"),
        ):
            response = await method(path, json={"copy_preamble": value}, headers={"If-Match": "*"})
            assert response.status_code == 422
            assert response.json()["code"] == "validation_error"


@pytest.mark.anyio
async def test_explicit_wildcard_reset_repairs_corrupt_preferences(tmp_path: Path) -> None:
    from diktator.storage import open_storage

    settings = Settings(data_directory=tmp_path)
    storage = open_storage(settings)
    with session_scope(storage.engine, write=True) as session:
        session.add(PreferenceRow(user_id=LOCAL_USER_ID, copy_preamble=" ", revision=7))
    storage.close()
    async with client_for(healthy_engine, settings) as client:
        assert (await client.get("/api/preferences")).status_code == 503
        for payload, validator in (
            ({}, "*"),
            ({"copy_preamble": "New"}, "*"),
            ({"reset": ["copy_preamble"]}, '"old"'),
        ):
            response = await client.patch(
                "/api/preferences", json=payload, headers={"If-Match": validator}
            )
            assert response.status_code == 503
        repaired = await client.patch(
            "/api/preferences", json={"reset": ["copy_preamble"]}, headers={"If-Match": "*"}
        )
        assert repaired.status_code == 200
        assert repaired.json()["copy_preamble"] == DEFAULT_PREAMBLE
        assert repaired.json()["copy_preamble_is_default"] is True
        assert repaired.json()["revision"] == 8
        assert (await client.get("/api/preferences")).json() == repaired.json()


@pytest.mark.anyio
async def test_sharing_choice_persists_and_preserves_other_preferences(tmp_path: Path) -> None:
    settings = Settings(data_directory=tmp_path)
    async with client_for(healthy_engine, settings) as client:
        initial = await client.get("/api/preferences")
        assert initial.json()["share_include_preamble"] is False
        saved = await client.patch(
            "/api/preferences",
            json={"share_include_preamble": True},
            headers={"If-Match": initial.headers["etag"]},
        )
        assert saved.status_code == 200
        assert saved.json()["revision"] == 2
        assert saved.json()["copy_preamble_is_default"] is True
        conflict = await client.patch(
            "/api/preferences",
            json={"copy_preamble": "Stale draft"},
            headers={"If-Match": initial.headers["etag"]},
        )
        assert conflict.status_code == 412
        edited = await client.patch(
            "/api/preferences",
            json={"copy_preamble": "Custom wording"},
            headers={"If-Match": saved.headers["etag"]},
        )
        assert edited.json()["share_include_preamble"] is True
        assert edited.json()["revision"] == 3
    async with client_for(healthy_engine, settings) as client:
        persisted = await client.get("/api/preferences")
        assert persisted.json()["share_include_preamble"] is True
        assert persisted.headers["etag"] == edited.headers["etag"]
        noop = await client.patch(
            "/api/preferences",
            json={"share_include_preamble": True},
            headers={"If-Match": persisted.headers["etag"]},
        )
        assert noop.headers["etag"] == persisted.headers["etag"]
        reset = await client.patch(
            "/api/preferences",
            json={"reset": ["share_include_preamble"]},
            headers={"If-Match": noop.headers["etag"]},
        )
        assert reset.json()["share_include_preamble"] is False
        assert reset.json()["copy_preamble"] == "Custom wording"
        assert reset.json()["revision"] == 4


@pytest.mark.anyio
@pytest.mark.parametrize("value", [None, "true", "false", 1, 0, [], {}])
async def test_sharing_choice_rejects_non_boolean_values(value: object) -> None:
    async with client_for(healthy_engine) as client:
        invalid = await client.patch(
            "/api/preferences",
            json={"share_include_preamble": value},
            headers={"If-Match": "*"},
        )
        assert invalid.status_code == 422
        assert invalid.json()["code"] == "validation_error"
        conflict = await client.patch(
            "/api/preferences",
            json={"share_include_preamble": True, "reset": ["share_include_preamble"]},
            headers={"If-Match": "*"},
        )
        assert conflict.status_code == 422
