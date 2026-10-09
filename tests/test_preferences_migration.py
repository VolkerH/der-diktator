"""The preference migration follows groups without touching existing application data."""

from datetime import UTC, datetime
from pathlib import Path

from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text

from diktator.chats import ChatService
from diktator.db import DATABASE_NAME, open_engine, session_scope, upgrade_schema
from diktator.db.rows import LOCAL_USER_ID, RecordingRow
from diktator.groups import GroupService
from diktator.preferences import PreferenceService, PreferenceUpdate


def test_preferences_upgrade_preserves_populated_group_database(tmp_path: Path) -> None:
    config = Config()
    migrations = Path(__file__).parents[1] / "src/diktator/db/migrations"
    config.set_main_option("script_location", str(migrations))
    assert ScriptDirectory.from_config(config).get_heads() == ["0006_keyboard_bindings"]
    engine = open_engine(tmp_path / DATABASE_NAME)
    try:
        with engine.connect().execution_options(write=True) as connection:
            config.attributes["connection"] = connection
            command.upgrade(config, "0004_chat_groups")
        chats = ChatService(tmp_path, engine)
        chat = chats.create(LOCAL_USER_ID)
        groups = GroupService(engine)
        group, _created = groups.create(LOCAL_USER_ID, "Keep this group")
        groups.move(LOCAL_USER_ID, chat.id, group.id, None)
        with session_scope(engine, write=True) as session:
            session.add(
                RecordingRow(
                    id="a" * 32,
                    chat_id=chat.id,
                    created=datetime.now(UTC),
                    duration_seconds=1.5,
                    audio_path="preserved.wav",
                    audio_sha256="b" * 64,
                )
            )
        tables = ("users", "chats", "chat_members", "groups", "recordings")
        with engine.connect() as connection:
            before = {
                table: connection.execute(text(f"SELECT * FROM {table}")).all() for table in tables
            }
        upgrade_schema(engine, tmp_path)
        with engine.connect() as connection:
            for table in tables:
                assert connection.execute(text(f"SELECT * FROM {table}")).all() == before[table]
            assert connection.exec_driver_sql("PRAGMA foreign_key_check").all() == []
            assert (
                connection.exec_driver_sql("SELECT version_num FROM alembic_version").scalar()
                == "0006_keyboard_bindings"
            )
            assert connection.exec_driver_sql("SELECT count(*) FROM preferences").scalar() == 0
        preferences = PreferenceService(engine)
        default = preferences.get(LOCAL_USER_ID)
        assert default.copy_preamble_is_default is True
        assert default.share_include_preamble is False
        saved = preferences.update(
            LOCAL_USER_ID,
            PreferenceUpdate(share_include_preamble=True),
            default.etag(LOCAL_USER_ID),
        )
        assert saved.copy_preamble_is_default is True
    finally:
        engine.dispose()
    reopened = open_engine(tmp_path / DATABASE_NAME)
    try:
        upgrade_schema(reopened, tmp_path)
        assert PreferenceService(reopened).get(LOCAL_USER_ID) == saved
        assert GroupService(reopened).placement(LOCAL_USER_ID, chat.id).group_id == group.id
    finally:
        reopened.dispose()


def test_keyboard_upgrade_keeps_saved_preferences(tmp_path: Path) -> None:
    config = Config()
    config.set_main_option(
        "script_location", str(Path(__file__).parents[1] / "src/diktator/db/migrations")
    )
    engine = open_engine(tmp_path / DATABASE_NAME)
    try:
        with engine.connect().execution_options(write=True) as connection:
            config.attributes["connection"] = connection
            command.upgrade(config, "0005_preferences")
            connection.execute(
                text(
                    "INSERT INTO preferences "
                    "(user_id, copy_preamble, share_include_preamble, revision) "
                    "VALUES ('local', 'Keep me', 1, 7)"
                )
            )
            connection.commit()
        upgrade_schema(engine, tmp_path)
        saved = PreferenceService(engine).get(LOCAL_USER_ID)
        assert saved.copy_preamble == "Keep me"
        assert saved.share_include_preamble is True
        assert saved.revision == 7
        assert saved.keyboard_bindings_is_default is True
    finally:
        engine.dispose()
