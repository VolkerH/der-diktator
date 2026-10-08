"""Snapshots complement behavior tests by making contract changes reviewable."""

import json
from pathlib import Path

import pytest

from diktator.app import create_app
from diktator.config import Settings
from diktator.errors import StreamErrorEvent
from diktator.inference.manager import ModelManager
from diktator.inference.server import create_engine
from diktator.inference.store import ModelStore

SNAPSHOTS = Path(__file__).parent / "snapshots"
STREAM_SCHEMA = Path(__file__).parents[1] / "docs" / "schemas" / "stream-error.json"


@pytest.mark.parametrize("service", ["web", "engine"])
def test_openapi_matches_snapshot_and_all_errors_use_api_error(
    tmp_path: Path, service: str
) -> None:
    app = (
        create_app(Settings(data_directory=tmp_path))
        if service == "web"
        else create_engine(ModelManager(ModelStore(tmp_path)))
    )
    schema = app.openapi()
    assert schema == json.loads((SNAPSHOTS / f"{service}-openapi.json").read_text())
    assert "HTTPValidationError" not in json.dumps(schema)
    assert schema["components"]["schemas"]["ApiError"]["properties"]["detail"]["type"] == "string"
    for path in schema["paths"].values():
        for operation in path.values():
            for status, response in operation["responses"].items():
                if int(status) >= 400:
                    assert response["content"]["application/json"]["schema"] == {
                        "$ref": "#/components/schemas/ApiError"
                    }
    # The generated 422 must not hide the operational failure declarations.
    transcribe = "/api/transcribe" if service == "web" else "/transcribe"
    statuses = set(schema["paths"][transcribe]["post"]["responses"])
    assert {"400", "409", "413", "422", "502"} <= statuses
    if service == "web":
        assert {"415", "503", "504"} <= statuses
        assert set(schema["paths"]["/api/models"]["get"]["responses"]) == {
            "200",
            "502",
            "503",
            "504",
        }
        for action in ("download", "activate", "delete"):
            assert set(schema["paths"][f"/api/models/{{model}}/{action}"]["post"]["responses"]) == {
                "202",
                "409",
                "422",
                "502",
                "503",
                "504",
            }


def test_published_stream_error_schema_matches_typed_event() -> None:
    assert StreamErrorEvent.model_json_schema() == json.loads(STREAM_SCHEMA.read_text())
