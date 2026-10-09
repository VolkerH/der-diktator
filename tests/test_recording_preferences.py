"""Recording defaults, operator constraints and concurrency through the shared profile."""

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from sqlalchemy import text

from diktator.chats import ChatService
from diktator.config import Settings
from diktator.db import session_scope
from diktator.db.rows import LOCAL_USER_ID, PreferenceRow
from diktator.errors import ApiFailure
from diktator.preferences import PreferenceService, PreferenceUpdate
from tests.test_app import client_for, healthy_engine


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def test_default_reads_do_not_create_rows_and_policy_changes_invalidate_etags(
    service: ChatService,
) -> None:
    preferences = PreferenceService(service.engine, hard_limit_seconds=3600)
    initial = preferences.get(LOCAL_USER_ID)
    assert initial.effective_default_recording_interval_seconds == 1800
    assert initial.recording_interval_seconds == 1800
    assert initial.recording_interval_is_default
    with service.engine.connect() as connection:
        assert connection.execute(text("SELECT count(*) FROM preferences")).scalar() == 0
    constrained = PreferenceService(service.engine, hard_limit_seconds=600).get(LOCAL_USER_ID)
    assert constrained.requested_recording_interval_seconds == 1800
    assert constrained.default_recording_interval_seconds == 1800
    assert constrained.effective_default_recording_interval_seconds == 600
    assert constrained.recording_interval_seconds == 600
    assert constrained.recording_interval_constrained
    assert constrained.recording_interval_constraint_reason
    assert constrained.revision == initial.revision
    assert constrained.etag(LOCAL_USER_ID) != initial.etag(LOCAL_USER_ID)


def test_lower_ceiling_preserves_requested_value_and_rejects_new_invalid_writes(
    service: ChatService,
) -> None:
    preferences = PreferenceService(service.engine, hard_limit_seconds=3600)
    initial = preferences.get(LOCAL_USER_ID)
    saved = preferences.update(
        LOCAL_USER_ID,
        PreferenceUpdate(recording_interval_seconds=2400),
        initial.etag(LOCAL_USER_ID),
    )
    lower = PreferenceService(service.engine, hard_limit_seconds=600)
    constrained = lower.get(LOCAL_USER_ID)
    assert constrained.recording_interval_seconds == 600
    assert constrained.requested_recording_interval_seconds == 2400
    assert not constrained.recording_interval_is_default
    assert constrained.revision == saved.revision
    with pytest.raises(ApiFailure) as stale:
        lower.update(
            LOCAL_USER_ID, PreferenceUpdate(copy_preamble="Stale"), saved.etag(LOCAL_USER_ID)
        )
    assert stale.value.code == "revision_conflict"
    with pytest.raises(ApiFailure) as invalid:
        lower.update(
            LOCAL_USER_ID,
            PreferenceUpdate(recording_interval_seconds=660),
            constrained.etag(LOCAL_USER_ID),
        )
    assert invalid.value.code == "invalid_recording_interval"
    updated = lower.update(
        LOCAL_USER_ID,
        PreferenceUpdate(copy_preamble="Still editable"),
        constrained.etag(LOCAL_USER_ID),
    )
    assert updated.requested_recording_interval_seconds == 2400
    restored = preferences.get(LOCAL_USER_ID)
    assert restored.recording_interval_seconds == 2400
    assert not restored.recording_interval_constrained
    reset = lower.update(
        LOCAL_USER_ID,
        PreferenceUpdate(reset=["recording_interval_seconds"]),
        updated.etag(LOCAL_USER_ID),
    )
    assert reset.recording_interval_is_default
    assert reset.recording_interval_seconds == 600
    assert reset.requested_recording_interval_seconds == 1800
    assert reset.copy_preamble == "Still editable"


def test_interval_writes_are_atomic_across_clients(service: ChatService) -> None:
    preferences = PreferenceService(service.engine)
    etag = preferences.get(LOCAL_USER_ID).etag(LOCAL_USER_ID)

    def save(seconds: int) -> str:
        try:
            preferences.update(
                LOCAL_USER_ID, PreferenceUpdate(recording_interval_seconds=seconds), etag
            )
            return "saved"
        except ApiFailure as error:
            return error.code

    with ThreadPoolExecutor(max_workers=2) as executor:
        assert sorted(executor.map(save, [60, 120])) == ["revision_conflict", "saved"]
    assert preferences.get(LOCAL_USER_ID).revision == 2


def test_corrupt_interval_requires_explicit_reset(service: ChatService) -> None:
    preferences = PreferenceService(service.engine)
    with session_scope(service.engine, write=True) as session:
        session.add(PreferenceRow(user_id=LOCAL_USER_ID, recording_interval_seconds=61))
    with pytest.raises(ApiFailure, match="cannot be read"):
        preferences.get(LOCAL_USER_ID)
    repaired = preferences.update(
        LOCAL_USER_ID, PreferenceUpdate(reset=["recording_interval_seconds"]), "*"
    )
    assert repaired.recording_interval_is_default


@pytest.mark.anyio
async def test_interval_api_persistence_reset_and_strict_validation(tmp_path: Path) -> None:
    settings = Settings(data_directory=tmp_path)
    async with client_for(healthy_engine, settings) as client:
        initial = await client.get("/api/preferences")
        for value in (None, True, 60.0, "60", 0, 61, -60):
            invalid = await client.patch(
                "/api/preferences",
                json={"recording_interval_seconds": value},
                headers={"If-Match": initial.headers["etag"]},
            )
            assert invalid.status_code == 422, value
        conflict = await client.patch(
            "/api/preferences",
            json={"recording_interval_seconds": 60, "reset": ["recording_interval_seconds"]},
            headers={"If-Match": initial.headers["etag"]},
        )
        assert conflict.status_code == 422
        assert (await client.get("/api/preferences")).headers["etag"] == initial.headers["etag"]
        assert (
            await client.patch("/api/preferences", json={"recording_interval_seconds": 60})
        ).status_code == 428
        saved = await client.patch(
            "/api/preferences",
            json={"recording_interval_seconds": 60},
            headers={"If-Match": initial.headers["etag"]},
        )
        assert saved.status_code == 200
        assert saved.json()["recording_interval_seconds"] == 60
    async with client_for(healthy_engine, settings) as client:
        persisted = await client.get("/api/preferences")
        assert persisted.json() == saved.json()
        assert (
            await client.patch(
                "/api/preferences", json={}, headers={"If-Match": initial.headers["etag"]}
            )
        ).status_code == 412
        unchanged = await client.patch(
            "/api/preferences",
            json={"share_include_preamble": True},
            headers={"If-Match": persisted.headers["etag"]},
        )
        assert unchanged.json()["recording_interval_seconds"] == 60
        reset = await client.patch(
            "/api/preferences",
            json={"reset": ["recording_interval_seconds"]},
            headers={"If-Match": unchanged.headers["etag"]},
        )
        assert reset.json()["recording_interval_is_default"]
        assert reset.json()["recording_interval_seconds"] == min(
            1800, settings.max_duration_seconds
        )


def test_default_change_invalidates_validator_without_overwriting_explicit_interval(
    service: ChatService, monkeypatch: pytest.MonkeyPatch
) -> None:
    preferences = PreferenceService(service.engine)
    initial = preferences.get(LOCAL_USER_ID)
    saved = preferences.update(
        LOCAL_USER_ID,
        PreferenceUpdate(recording_interval_seconds=1800),
        initial.etag(LOCAL_USER_ID),
    )
    monkeypatch.setattr("diktator.preferences.DEFAULT_RECORDING_INTERVAL_SECONDS", 1200)
    current = preferences.get(LOCAL_USER_ID)
    assert current.recording_interval_seconds == 1800
    assert current.default_recording_interval_seconds == 1200
    assert current.effective_default_recording_interval_seconds == 1200
    assert current.revision == saved.revision
    assert current.etag(LOCAL_USER_ID) != saved.etag(LOCAL_USER_ID)
    reset = preferences.update(
        LOCAL_USER_ID,
        PreferenceUpdate(reset=["recording_interval_seconds"]),
        current.etag(LOCAL_USER_ID),
    )
    assert reset.recording_interval_seconds == 1200


def test_whole_minute_ceiling_is_inclusive(service: ChatService) -> None:
    preferences = PreferenceService(service.engine, hard_limit_seconds=3600)
    initial = preferences.get(LOCAL_USER_ID)
    saved = preferences.update(
        LOCAL_USER_ID,
        PreferenceUpdate(recording_interval_seconds=3600),
        initial.etag(LOCAL_USER_ID),
    )
    assert saved.recording_interval_seconds == 3600
    assert not saved.recording_interval_constrained


@pytest.mark.anyio
async def test_agreed_snapshot_matches_one_preference_read_and_policy_hash(tmp_path: Path) -> None:
    settings = Settings(data_directory=tmp_path)
    async with client_for(healthy_engine, settings) as client:
        initial = await client.get("/api/preferences")
        snapshot = await client.get("/api/recording-policy")
        assert snapshot.status_code == 200
        data = snapshot.json()
        assert data["recording_interval_seconds"] == 1800
        assert data["warning_lead_seconds"] == 60
        assert data["extension_seconds"] == 1800
        assert data["client_deadlines_ms"]["upload"] == 1_054_000
        assert data["hard_limit_seconds"] == 3600
        assert data["preference_etag"] == initial.headers["etag"]
        assert data["policy_revision"] == settings.recording_policy.policy_revision
        assert data["max_audio_bytes"] == 116_000_044
        saved = await client.patch(
            "/api/preferences",
            json={"recording_interval_seconds": 60},
            headers={"If-Match": initial.headers["etag"]},
        )
        updated = (await client.get("/api/recording-policy")).json()
        assert updated["recording_interval_seconds"] == 60
        assert updated["extension_seconds"] == 60
        assert updated["preference_etag"] == saved.headers["etag"]
        assert updated["policy_revision"] == data["policy_revision"]


@pytest.mark.anyio
async def test_snapshot_exposes_operator_constrained_default(tmp_path: Path) -> None:
    from httpx import Request, Response

    from diktator.recording_policy import RecordingPolicy

    settings = Settings(
        data_directory=tmp_path, recording_policy=RecordingPolicy(hard_limit_seconds=600)
    )

    def configured_engine(request: Request) -> Response:
        if request.url.path == "/recording-policy":
            return Response(200, json=settings.recording_policy.model_dump())
        return healthy_engine(request)

    async with client_for(configured_engine, settings) as client:
        data = (await client.get("/api/recording-policy")).json()
        assert data["hard_limit_seconds"] == 600
        assert data["requested_recording_interval_seconds"] == 1800
        assert data["recording_interval_seconds"] == 600
        assert data["recording_interval_constrained"]
        assert data["recording_interval_constraint_reason"]
