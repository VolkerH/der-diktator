"""Keyboard preference contracts, independent of a browser and inference."""

from pathlib import Path

import pytest

from diktator.config import Settings
from tests.test_app import client_for, healthy_engine


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.mark.anyio
async def test_keyboard_defaults_persistence_conflicts_and_reset(tmp_path: Path) -> None:
    settings = Settings(data_directory=tmp_path)
    async with client_for(healthy_engine, settings) as client:
        initial = await client.get("/api/preferences")
        data = initial.json()
        assert data["keyboard_bindings_is_default"]
        assert data["keyboard_bindings"] == data["default_keyboard_bindings"]
        assert {action["id"] for action in data["keyboard_actions"]} == data[
            "keyboard_bindings"
        ].keys()
        missing = await client.patch("/api/preferences", json={"keyboard_bindings": {}})
        assert missing.status_code == 428
        saved = await client.patch(
            "/api/preferences",
            json={"keyboard_bindings": {"copy": None, "search_chats": "Mod+Shift+K"}},
            headers={"If-Match": initial.headers["etag"]},
        )
        assert saved.status_code == 200
        assert saved.json()["keyboard_bindings"]["copy"] is None
        assert not saved.json()["keyboard_bindings_is_default"]
        stale = await client.patch(
            "/api/preferences",
            json={"reset": ["keyboard_bindings"]},
            headers={"If-Match": initial.headers["etag"]},
        )
        assert stale.status_code == 412
    async with client_for(healthy_engine, settings) as client:
        current = await client.get("/api/preferences")
        assert current.json() == saved.json()
        # Updating an unrelated preference preserves saved keyboard overrides.
        preamble = await client.patch(
            "/api/preferences",
            json={"copy_preamble": "Custom"},
            headers={"If-Match": current.headers["etag"]},
        )
        assert preamble.json()["keyboard_bindings"] == saved.json()["keyboard_bindings"]
        reset = await client.patch(
            "/api/preferences",
            json={"reset": ["keyboard_bindings"]},
            headers={"If-Match": preamble.headers["etag"]},
        )
        assert reset.json()["keyboard_bindings_is_default"]
        assert reset.json()["keyboard_bindings"] == data["default_keyboard_bindings"]
        assert reset.json()["copy_preamble"] == "Custom"


@pytest.mark.anyio
async def test_invalid_keyboard_updates_do_not_write() -> None:
    async with client_for(healthy_engine) as client:
        initial = await client.get("/api/preferences")
        for body in (
            {"keyboard_bindings": None},
            {"keyboard_bindings": {"unknown": None}},
            {"keyboard_bindings": {"copy": "a"}},
            {"keyboard_bindings": {"copy": "Mod+C"}},
            {"keyboard_bindings": {"copy": "Mod+Shift+T"}},
            {"keyboard_bindings": {"copy": "Mod+Shift+1"}},
            {"keyboard_bindings": {"copy": 4}},
            {"keyboard_bindings": {}, "reset": ["keyboard_bindings"]},
        ):
            response = await client.patch(
                "/api/preferences", json=body, headers={"If-Match": initial.headers["etag"]}
            )
            assert response.status_code == 422, body
            assert response.json()["code"] == "validation_error"
            assert (await client.get("/api/preferences")).headers["etag"] == initial.headers["etag"]
