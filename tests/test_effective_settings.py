"""Settings are safe read-only snapshots, independent of profile preferences."""

from pathlib import Path

import pytest

from diktator.config import Settings
from tests.test_app import client_for, healthy_engine


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.mark.anyio
async def test_settings_show_running_limits_without_disclosing_operator_details(
    tmp_path: Path,
) -> None:
    configured = Settings(
        data_directory=tmp_path / "private-name",
        engine_url="http://secret:password@private-host",
        max_text_characters=1234,
    )
    async with client_for(healthy_engine, configured) as client:
        response = await client.get("/api/settings")
        assert response.status_code == 200
        body = response.json()
        assert body["client_upload_timeout_ms"] == 190_000
        assert body["operator_editable"] is False
        assert body["profile_scope"] == "shared_local_profile"
        assert body["model_selection"] == "instance_model_api"
        assert {limit["id"]: limit["value"] for limit in body["limits"]} == {
            "recording_seconds": 600,
            "audio_bytes": 20_000_044,
            "text_characters": 1234,
        }
        for limit in body["limits"]:
            assert limit["source"] == "application_configuration"
            assert limit["editable"] is False
            assert limit["restart_required"] is True
        assert "private" not in response.text
        assert "password" not in response.text
        assert (await client.get("/api/settings")).json() == body
        assert (
            await client.patch("/api/settings", json={"max_duration_seconds": 1800})
        ).status_code == 405
        assert (await client.get("/api/settings")).json() == body


@pytest.mark.anyio
async def test_snapshot_revision_changes_with_enforcement(tmp_path: Path) -> None:
    async with client_for(healthy_engine, Settings(data_directory=tmp_path)) as client:
        before = (await client.get("/api/settings")).json()
    async with client_for(
        healthy_engine, Settings(data_directory=tmp_path, max_text_characters=77)
    ) as client:
        after = (await client.get("/api/settings")).json()
    assert before["policy_revision"] != after["policy_revision"]
