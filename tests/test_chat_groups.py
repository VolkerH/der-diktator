"""Private group lifecycle, validators and retry identities through HTTP and SQLite."""

import asyncio
import shutil
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import patch

import pytest
from sqlalchemy import event, select
from sqlalchemy.exc import OperationalError

from diktator.chats import ChatService
from diktator.config import Settings
from diktator.db import DATABASE_NAME, open_engine, session_scope, upgrade_schema
from diktator.db.rows import LOCAL_USER_ID, ChatMemberRow, ChatRow, GroupRow, UserRow
from diktator.errors import ApiFailure
from diktator.groups import GroupService
from tests.test_app import client_for
from tests.test_audio import make_wav
from tests.test_chats import transcribing_engine

CHAT = "c" * 32
GROUP = "a" * 32
OTHER_GROUP = "b" * 32


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.mark.anyio
async def test_group_delete_keeps_shared_chat_audio_recency_and_survives_restart(
    tmp_path: Path,
) -> None:
    settings = Settings(data_directory=tmp_path)
    async with client_for(transcribing_engine, settings) as client:
        group = await client.put(f"/api/groups/{GROUP}", json={"name": "  Work 😀  "})
        assert group.status_code == 201
        assert group.json()["name"] == "Work 😀"
        assert group.headers["etag"] == group.json()["etag"]
        created = await client.put(f"/api/chats/{CHAT}", json={"group_id": GROUP})
        assert created.status_code == 201
        assert "group_id" not in created.json()
        await client.put(f"/api/chats/{CHAT}/text", json={"text": "Full original transcript"})
        await client.put(f"/api/chats/{CHAT}/title", json={"custom_title": "Shared name"})
        recording_id = "d" * 32
        await client.put(
            f"/api/chats/{CHAT}/recordings/{recording_id}",
            content=make_wav(),
            headers={"Content-Type": "audio/wav"},
        )
        before = await client.get(f"/api/chats/{CHAT}")
        placement = await client.get(f"/api/chats/{CHAT}/group")
        assert placement.json()["group_id"] == GROUP
        assert placement.headers["etag"] == placement.json()["etag"]
        summary = (await client.get("/api/chats", params={"q": "transcript"})).json()[0]
        assert summary["group_id"] == GROUP
        assert summary["placement_etag"] == placement.headers["etag"]
        renamed = await client.put(
            f"/api/groups/{GROUP}/name",
            json={"name": "New label"},
            headers={"If-Match": group.headers["etag"]},
        )
        assert renamed.json()["revision"] == 2
        assert (
            await client.delete(f"/api/groups/{GROUP}", headers={"If-Match": group.headers["etag"]})
        ).status_code == 412
        assert (
            await client.delete(
                f"/api/groups/{GROUP}", headers={"If-Match": renamed.headers["etag"]}
            )
        ).status_code == 204
        after = await client.get(f"/api/chats/{CHAT}")
        assert after.json() == before.json()
        for header in ("etag", "text-etag", "title-etag"):
            assert after.headers[header] == before.headers[header]
        moved = await client.get(f"/api/chats/{CHAT}/group")
        assert moved.json()["group_id"] is None
        assert moved.json()["placement_revision"] == 2
        assert moved.headers["etag"] != placement.headers["etag"]
        assert (
            await client.get(f"/api/chats/{CHAT}/recordings/{recording_id}")
        ).content == make_wav()
        assert (
            await client.put(f"/api/chats/{CHAT}", json={"group_id": GROUP})
        ).json() == before.json()
        assert (await client.put(f"/api/chats/{CHAT}", json={"group_id": None})).status_code == 200
    async with client_for(transcribing_engine, settings) as client:
        assert (await client.get("/api/groups")).json() == []
        assert (await client.get(f"/api/chats/{CHAT}")).json() == before.json()
        assert (await client.get(f"/api/chats/{CHAT}/group")).json() == moved.json()


@pytest.mark.anyio
async def test_group_retry_identity_rename_and_duplicate_names(tmp_path: Path) -> None:
    async with client_for(transcribing_engine, Settings(data_directory=tmp_path)) as client:
        first = await client.put(f"/api/groups/{GROUP}", json={"name": "Same"})
        second = await client.post("/api/groups", json={"name": "Same"})
        assert second.status_code == 201
        renamed = await client.put(f"/api/groups/{GROUP}/name", json={"name": "Renamed"})
        retried = await client.put(f"/api/groups/{GROUP}", json={"name": " Same "})
        assert retried.status_code == 200
        assert retried.json() == renamed.json()
        assert (
            await client.put(f"/api/groups/{GROUP}", json={"name": "Renamed"})
        ).status_code == 200
        unchanged = await client.put(
            f"/api/groups/{GROUP}/name",
            json={"name": "Renamed"},
            headers={"If-Match": renamed.headers["etag"]},
        )
        assert unchanged.json() == renamed.json()
        groups = (await client.get("/api/groups")).json()
        assert [group["id"] for group in groups] == [first.json()["id"], second.json()["id"]]


@pytest.mark.anyio
async def test_moves_have_private_preconditions_and_preserve_other_validators(
    tmp_path: Path,
) -> None:
    async with client_for(transcribing_engine, Settings(data_directory=tmp_path)) as client:
        for group_id in (GROUP, OTHER_GROUP):
            await client.put(f"/api/groups/{group_id}", json={"name": "Label"})
        original = await client.put(f"/api/chats/{CHAT}")
        placement = await client.get(f"/api/chats/{CHAT}/group")
        results = await asyncio.gather(
            *(
                client.put(
                    f"/api/chats/{CHAT}/group",
                    json={"group_id": group_id},
                    headers={"If-Match": placement.headers["etag"]},
                )
                for group_id in (GROUP, OTHER_GROUP)
            )
        )
        assert sorted(response.status_code for response in results) == [200, 412]
        winner = next(response for response in results if response.status_code == 200)
        same = await client.put(
            f"/api/chats/{CHAT}/group",
            json={"group_id": winner.json()["group_id"]},
            headers={"If-Match": winner.headers["etag"]},
        )
        assert same.json() == winner.json()
        for invalid in ("W/" + winner.headers["etag"], original.headers["etag"]):
            assert (
                await client.put(
                    f"/api/chats/{CHAT}/group",
                    json={"group_id": None},
                    headers={"If-Match": invalid},
                )
            ).status_code == 412
        current = await client.get(f"/api/chats/{CHAT}")
        assert current.json() == original.json()
        assert current.headers["etag"] == original.headers["etag"]
        # Matching original input never resets the moved placement; current input is not identity.
        assert (await client.put(f"/api/chats/{CHAT}")).status_code == 200
        assert (
            await client.put(f"/api/chats/{CHAT}", json={"group_id": winner.json()["group_id"]})
        ).status_code == 200
        assert (
            await client.delete(
                f"/api/chats/{CHAT}", headers={"If-Match": original.headers["etag"]}
            )
        ).status_code == 204
        await client.put(f"/api/chats/{CHAT}")
        assert (await client.get(f"/api/chats/{CHAT}/group")).headers["etag"] != placement.headers[
            "etag"
        ]


@pytest.mark.parametrize(
    "name", ["", "  ", "x" * 81, "line\nname", "\ttrim", "a\x00b", "a\u2028b", "a\u2029b"]
)
@pytest.mark.anyio
async def test_invalid_names_are_explicit_and_do_not_create(tmp_path: Path, name: str) -> None:
    async with client_for(transcribing_engine, Settings(data_directory=tmp_path)) as client:
        result = await client.put(f"/api/groups/{GROUP}", json={"name": name})
        assert result.status_code == 422
        assert result.json()["code"] == "invalid_group_name"
        assert (await client.get("/api/groups")).json() == []


@pytest.mark.parametrize("body", [{}, {"group_id": "invalid"}, {"group_id": None, "other": 1}])
@pytest.mark.anyio
async def test_placement_requires_a_valid_explicit_destination(tmp_path: Path, body: dict) -> None:
    async with client_for(transcribing_engine, Settings(data_directory=tmp_path)) as client:
        await client.put(f"/api/chats/{CHAT}")
        result = await client.put(f"/api/chats/{CHAT}/group", json=body)
        assert result.status_code == 422
        assert result.json()["code"] == "validation_error"


@pytest.mark.anyio
async def test_missing_group_fails_new_create_without_creating_chat(tmp_path: Path) -> None:
    async with client_for(transcribing_engine, Settings(data_directory=tmp_path)) as client:
        for path in ("/api/chats", f"/api/chats/{CHAT}"):
            method = client.post if path == "/api/chats" else client.put
            result = await method(path, json={"group_id": GROUP})
            assert result.status_code == 404
            assert result.json()["code"] == "group_not_found"
        assert (await client.get("/api/chats")).json() == []


def test_group_and_placement_are_actor_private_with_shared_membership(service: ChatService) -> None:
    groups = GroupService(service.engine)
    with session_scope(service.engine, write=True) as session:
        session.add(UserRow(id="other", created=datetime.now(UTC)))
    private, _ = groups.create(LOCAL_USER_ID, "Private", GROUP)
    other, _ = groups.create("other", "Other", OTHER_GROUP)
    shared, _ = service.create_with_id(LOCAL_USER_ID, CHAT, GROUP)
    assert groups.list("other") == [other]
    operations = (
        lambda: groups.get("other", private.id),
        lambda: groups.rename("other", private.id, "Probe"),
        lambda: groups.delete("other", private.id),
        lambda: groups.placement("other", shared.id),
        lambda: groups.move("other", shared.id, other.id),
    )
    for operation in operations:
        with pytest.raises(ApiFailure) as error:
            operation()
        assert error.value.status_code == 404
    with session_scope(service.engine, write=True) as session:
        session.add(ChatMemberRow(chat_id=CHAT, user_id="other", role="owner"))
    mine = groups.placement(LOCAL_USER_ID, CHAT)
    theirs = groups.placement("other", CHAT)
    assert theirs.group_id is None and theirs.etag != mine.etag
    for destination in (None, GROUP, OTHER_GROUP):
        assert service.create_with_id("other", CHAT, destination) == (shared, False)
    with pytest.raises(ApiFailure) as error:
        groups.move("other", CHAT, GROUP)
    assert error.value.code == "group_not_found"
    theirs = groups.move("other", CHAT, OTHER_GROUP, theirs.etag)
    groups.delete(LOCAL_USER_ID, GROUP)
    assert groups.placement("other", CHAT) == theirs
    assert groups.placement(LOCAL_USER_ID, CHAT).group_id is None
    assert service.get("other", CHAT).etag == shared.etag
    assert service.list("other")[0].group_id == OTHER_GROUP
    assert service.list(LOCAL_USER_ID)[0].group_id is None
    recreated, created = groups.create("other", "Private", GROUP)
    assert created and recreated.etag != private.etag


def test_concurrent_group_creation_and_rename_preconditions(service: ChatService) -> None:
    groups = GroupService(service.engine)
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(groups.create, LOCAL_USER_ID, "Same", GROUP) for _ in range(2)]
        results = [future.result() for future in futures]
    assert sorted(created for _, created in results) == [False, True]
    etag = results[0][0].etag

    def rename(name: str) -> str:
        try:
            groups.rename(LOCAL_USER_ID, GROUP, name, etag)
            return "ok"
        except ApiFailure as error:
            return error.code

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(rename, ("A", "B"))) == ["ok", "revision_conflict"]


@pytest.mark.anyio
async def test_delete_failure_rolls_back_placements_and_reports_storage_error(
    tmp_path: Path,
) -> None:
    async with client_for(transcribing_engine, Settings(data_directory=tmp_path)) as client:
        await client.put(f"/api/groups/{GROUP}", json={"name": "Keep"})
        await client.put(f"/api/chats/{CHAT}", json={"group_id": GROUP})
        original = await client.get(f"/api/chats/{CHAT}/group")
        from sqlalchemy.orm import Session

        delete = Session.delete

        def fail_delete(session, row):
            if isinstance(row, GroupRow):
                raise OperationalError("statement", {}, Exception("private disk diagnostic"))
            return delete(session, row)

        with patch.object(Session, "delete", fail_delete):
            failed = await client.delete(f"/api/groups/{GROUP}")
        assert failed.status_code == 500
        assert failed.json()["code"] == "storage_error"
        assert "private disk diagnostic" not in failed.text
        assert (await client.get(f"/api/chats/{CHAT}/group")).json() == original.json()
        assert (await client.get(f"/api/groups/{GROUP}")).status_code == 200
        assert (await client.put(f"/api/groups/{GROUP}", json={"name": "Keep"})).status_code == 200


def test_upgrade_released_database_defaults_preserve_chats_members_and_audio(
    tmp_path: Path,
) -> None:
    shutil.copyfile(
        Path(__file__).parent / "fixtures/database/0002.sqlite3", tmp_path / DATABASE_NAME
    )
    with sqlite3.connect(tmp_path / DATABASE_NAME) as db:
        db.execute(
            "INSERT INTO chats (id,created,updated,text,created_by,revision,text_revision,"
            "incarnation) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (
                CHAT,
                "2026-10-08 10:00:00",
                "2026-10-08 11:00:00",
                "Before",
                LOCAL_USER_ID,
                3,
                2,
                "f" * 32,
            ),
        )
        db.execute(
            "INSERT INTO chat_members(chat_id,user_id,role) VALUES(?,?,?)",
            (CHAT, LOCAL_USER_ID, "owner"),
        )
        db.execute(
            "INSERT INTO recordings(id,chat_id,created,duration_seconds,audio_path,audio_sha256) "
            "VALUES(?,?,?,?,?,?)",
            ("d" * 32, CHAT, "2026-10-08 11:00:00", 1.0, f"{CHAT}/{'d' * 32}.wav", None),
        )
    audio_path = tmp_path / CHAT / f"{'d' * 32}.wav"
    audio_path.parent.mkdir()
    audio_path.write_bytes(make_wav())
    engine = open_engine(tmp_path / DATABASE_NAME)
    try:
        upgrade_schema(engine, tmp_path)
        groups = GroupService(engine)
        assert groups.list(LOCAL_USER_ID) == []
        placement = groups.placement(LOCAL_USER_ID, CHAT)
        assert placement.group_id is None and placement.placement_revision == 1
        with session_scope(engine) as session:
            chat = session.get(ChatRow, CHAT)
            assert chat is not None
            assert (chat.text, chat.revision, chat.text_revision) == ("Before", 3, 2)
        groups.create(LOCAL_USER_ID, "Migrated", GROUP)
        groups.move(LOCAL_USER_ID, CHAT, GROUP)
        assert (
            ChatService(tmp_path, engine).recording_audio(LOCAL_USER_ID, CHAT, "d" * 32)
            == make_wav()
        )
        assert audio_path.read_bytes() == make_wav()
        upgrade_schema(engine, tmp_path)
        assert groups.placement(LOCAL_USER_ID, CHAT).group_id == GROUP
        with engine.connect() as connection:
            assert connection.exec_driver_sql("PRAGMA foreign_key_check").all() == []
    finally:
        engine.dispose()


@pytest.mark.anyio
async def test_grouped_chat_failed_commit_rolls_back_then_same_identity_retries(
    tmp_path: Path,
) -> None:
    from sqlalchemy.orm import Session

    async with client_for(transcribing_engine, Settings(data_directory=tmp_path)) as client:
        await client.put(f"/api/groups/{GROUP}", json={"name": "Keep"})

        def fail_new_membership(session: Session) -> None:
            if session.scalar(select(ChatMemberRow.chat_id).where(ChatMemberRow.chat_id == CHAT)):
                # Initial membership is already flushed when the complete Chat is built.
                raise OperationalError("commit", {}, Exception("private disk diagnostic"))

        event.listen(Session, "before_commit", fail_new_membership)
        try:
            failed = await client.put(f"/api/chats/{CHAT}", json={"group_id": GROUP})
        finally:
            event.remove(Session, "before_commit", fail_new_membership)
        assert failed.status_code == 500 and failed.json()["code"] == "storage_error"
        assert "private disk diagnostic" not in failed.text
        assert (await client.get("/api/chats")).json() == []
        assert (await client.get(f"/api/chats/{CHAT}/group")).status_code == 404
        assert (await client.put(f"/api/chats/{CHAT}", json={"group_id": GROUP})).status_code == 201
        assert (await client.get(f"/api/chats/{CHAT}/group")).json()["group_id"] == GROUP


def test_group_delete_racing_chat_create_never_leaves_a_deleted_destination(
    service: ChatService,
) -> None:
    groups = GroupService(service.engine)
    groups.create(LOCAL_USER_ID, "Temporary", GROUP)

    def create() -> str:
        try:
            service.create_with_id(LOCAL_USER_ID, CHAT, GROUP)
            return "created"
        except ApiFailure as error:
            return error.code

    with ThreadPoolExecutor(max_workers=2) as pool:
        created = pool.submit(create)
        deleted = pool.submit(groups.delete, LOCAL_USER_ID, GROUP)
        result = created.result()
        deleted.result()
    assert groups.list(LOCAL_USER_ID) == []
    if result == "created":
        assert groups.placement(LOCAL_USER_ID, CHAT).group_id is None
        assert service.create_with_id(LOCAL_USER_ID, CHAT, GROUP)[1] is False
    else:
        assert result == "group_not_found"
        assert service.list(LOCAL_USER_ID) == []
    with service.engine.connect() as connection:
        assert connection.exec_driver_sql("PRAGMA foreign_key_check").all() == []


@pytest.mark.anyio
async def test_failed_group_read_is_an_error_not_an_empty_registry(tmp_path: Path) -> None:
    async with client_for(transcribing_engine, Settings(data_directory=tmp_path)) as client:
        await client.put(f"/api/groups/{GROUP}", json={"name": "Keep"})
        with patch(
            "diktator.groups.session_scope",
            side_effect=OperationalError("query", {}, Exception("private storage diagnostic")),
        ):
            failed = await client.get("/api/groups")
        assert failed.status_code == 500
        assert failed.json()["code"] == "storage_error"
        assert "private storage diagnostic" not in failed.text
        assert (await client.get("/api/groups")).json()[0]["name"] == "Keep"


@pytest.mark.anyio
async def test_http_actor_dependency_scopes_groups_and_placement(tmp_path: Path) -> None:
    import httpx
    from fastapi.routing import APIRoute

    from diktator.app import create_app

    app = create_app(Settings(data_directory=tmp_path))
    route = next(
        route for route in app.routes if isinstance(route, APIRoute) and route.path == "/api/groups"
    )
    actor_dependency = route.dependant.dependencies[0].call
    assert actor_dependency is not None
    current_actor = LOCAL_USER_ID
    app.dependency_overrides[actor_dependency] = lambda: current_actor
    async with app.router.lifespan_context(app):
        service = app.state.storage.chats
        with session_scope(service.engine, write=True) as session:
            session.add(UserRow(id="other", created=datetime.now(UTC)))
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            await client.put(f"/api/groups/{GROUP}", json={"name": "Private"})
            shared = await client.put(f"/api/chats/{CHAT}", json={"group_id": GROUP})
            mine = await client.get(f"/api/chats/{CHAT}/group")
            current_actor = "other"
            assert (await client.get("/api/groups")).json() == []
            assert (await client.get(f"/api/groups/{GROUP}")).json()["code"] == "group_not_found"
            assert (await client.get(f"/api/chats/{CHAT}/group")).json()["code"] == "chat_not_found"
            with session_scope(service.engine, write=True) as session:
                session.add(ChatMemberRow(chat_id=CHAT, user_id="other", role="owner"))
            theirs = await client.get(f"/api/chats/{CHAT}/group")
            assert theirs.json()["group_id"] is None
            assert theirs.headers["etag"] != mine.headers["etag"]
            assert (await client.get(f"/api/chats/{CHAT}")).json() == shared.json()
            wrong_scope = await client.put(
                f"/api/chats/{CHAT}/group",
                json={"group_id": None},
                headers={"If-Match": mine.headers["etag"]},
            )
            assert wrong_scope.status_code == 412
            denied = await client.put(
                f"/api/chats/{CHAT}/group",
                json={"group_id": GROUP},
                headers={"If-Match": theirs.headers["etag"]},
            )
            assert denied.status_code == 404 and denied.json()["code"] == "group_not_found"
            retry = await client.put(f"/api/chats/{CHAT}", json={"group_id": GROUP})
            assert retry.status_code == 200 and retry.json() == shared.json()


def test_group_downgrade_preserves_members_recordings_and_text(service: ChatService) -> None:
    """Rollback with foreign keys enabled must preserve all pre-group resources."""
    from alembic import command
    from alembic.config import Config

    groups = GroupService(service.engine)
    groups.create(LOCAL_USER_ID, "Project", GROUP)
    service.create_with_id(LOCAL_USER_ID, CHAT, GROUP)
    service.update_text(LOCAL_USER_ID, CHAT, "Keep this transcript")
    with service.engine.begin() as connection:
        connection.exec_driver_sql(
            "INSERT INTO recordings VALUES (?, ?, ?, ?, ?, ?)",
            ("d" * 32, CHAT, "2026-10-08 10:00:00", 1.0, "recording.wav", "digest"),
        )
        before = {
            table: connection.exec_driver_sql(f"SELECT * FROM {table}").all()
            for table in ("chats", "recordings")
        }
        config = Config()
        config.set_main_option(
            "script_location", str(Path(__file__).parents[1] / "src/diktator/db/migrations")
        )
        config.attributes["connection"] = connection
        assert connection.exec_driver_sql("PRAGMA foreign_keys").scalar() == 1
        command.downgrade(config, "0003_chat_titles")
        for table, rows in before.items():
            assert connection.exec_driver_sql(f"SELECT * FROM {table}").all() == rows
        assert connection.exec_driver_sql("SELECT * FROM chat_members").all() == [
            (CHAT, LOCAL_USER_ID, "owner")
        ]
        assert connection.exec_driver_sql("PRAGMA foreign_key_check").all() == []
        command.upgrade(config, "head")
    assert service.get(LOCAL_USER_ID, CHAT).text == "Keep this transcript"
    assert groups.placement(LOCAL_USER_ID, CHAT).group_id is None


@pytest.mark.anyio
async def test_recreated_group_rejects_previous_incarnation_validator(tmp_path: Path) -> None:
    async with client_for(transcribing_engine, Settings(data_directory=tmp_path)) as client:
        first = await client.put(f"/api/groups/{GROUP}", json={"name": "Before"})
        await client.delete(f"/api/groups/{GROUP}")
        recreated = await client.put(f"/api/groups/{GROUP}", json={"name": "After"})
        assert recreated.status_code == 201
        assert recreated.headers["etag"] != first.headers["etag"]
        stale = {"If-Match": first.headers["etag"]}
        assert (await client.delete(f"/api/groups/{GROUP}", headers=stale)).status_code == 412
        assert (
            await client.put(f"/api/groups/{GROUP}/name", json={"name": "Stale"}, headers=stale)
        ).status_code == 412
        assert (await client.get(f"/api/groups/{GROUP}")).json()["name"] == "After"
