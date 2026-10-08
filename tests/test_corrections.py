"""The correction contract is testable without a browser, speech engine or LLM download."""

import asyncio
import json
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import replace
from pathlib import Path
from typing import override

import httpx
import pytest

from diktator.app import create_app
from diktator.config import Settings
from diktator.corrections import (
    DEFAULT_LANGUAGES,
    DEFAULT_MODEL,
    EVENT_SCHEMA,
    PROMPTS,
    SYSTEM_PROMPT,
    CorrectionMode,
    CorrectionRequest,
    CorrectionService,
    CorrectionSettings,
)
from diktator.errors import ApiFailure

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def chunk(content: object = None, reason: str | None = None) -> str:
    return (
        "data: "
        + json.dumps({"choices": [{"delta": {"content": content}, "finish_reason": reason}]})
        + "\n\n"
    )


def complete(text: object = "Corrected.") -> str:
    return chunk(None) + chunk(text) + chunk(None, "stop") + "data: [DONE]\n\n"


@asynccontextmanager
async def api(
    tmp_path: Path,
    handler: Callable[[httpx.Request], httpx.Response],
    config: CorrectionSettings | None = None,
) -> AsyncIterator[httpx.AsyncClient]:
    settings = Settings(
        data_directory=tmp_path,
        correction=config or CorrectionSettings(base_url="http://local-model/v1"),
    )
    app = create_app(settings, correction_transport=httpx.MockTransport(handler))
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://app") as client,
    ):
        yield client


def events(response: httpx.Response) -> list[dict[str, object]]:
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["content-type"].startswith("application/x-ndjson")
    return [json.loads(line) for line in response.text.splitlines()]


async def test_disabled_discovery_and_generation(tmp_path: Path) -> None:
    def unexpected(_request: httpx.Request) -> httpx.Response:
        pytest.fail("Disabled correction must not contact a provider")

    async with api(tmp_path, unexpected, CorrectionSettings()) as client:
        capability = (await client.get("/api/corrections/capabilities")).json()
        assert capability["configured"] is False
        assert capability["model"] is None
        assert capability["default_mode"] == "paragraphs"
        assert capability["languages"] == list(DEFAULT_LANGUAGES)
        assert capability["language"] == ", ".join(DEFAULT_LANGUAGES)
        assert len(capability["modes"]) == 3
        response = await client.post("/api/corrections", json={"text": "hello"})
        assert response.status_code == 503
        assert response.json()["code"] == "correction_disabled"


@pytest.mark.parametrize("mode", list(PROMPTS))
async def test_modes_text_only_prompt_and_non_mutating_preview(
    tmp_path: Path, mode: CorrectionMode
) -> None:
    captured: list[httpx.Request] = []

    def provider(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(200, text=complete("  Café 🙂 corrected.\n"))

    config = CorrectionSettings(base_url="http://local-model/v1", api_key="operator-secret")
    async with api(tmp_path, provider, config) as client:
        original = "\t Café 🙂 wrong. \n"
        stream = events(
            await client.post("/api/corrections", json={"text": original, "mode": mode})
        )
        assert stream[-1] == {
            "type": "done",
            "text": "\t Café 🙂 corrected. \n",
            "mode": mode,
            "model": DEFAULT_MODEL,
        }
        assert any(item["type"] == "delta" for item in stream)
        assert (await client.get("/api/chats")).json() == []
        capabilities = (await client.get("/api/corrections/capabilities")).json()
        assert "operator-secret" not in json.dumps(capabilities)
        assert capabilities["configured"] is True
    request = captured[0]
    assert str(request.url) == "http://local-model/v1/chat/completions"
    assert request.headers["authorization"] == "Bearer operator-secret"
    payload = json.loads(request.content)
    assert payload["messages"][1] == {"role": "user", "content": original.strip()}
    assert payload["messages"][0]["content"] == SYSTEM_PROMPT + PROMPTS[mode]
    assert payload["stream"] is True
    assert payload["temperature"] == 0
    assert payload["max_tokens"] == 1536


@pytest.mark.parametrize(
    ("body", "status", "code"),
    [
        ({"text": " "}, 422, "correction_empty_selection"),
        ({"text": "x" * 4001}, 413, "correction_input_too_large"),
        ({"text": "hello", "mode": "translate"}, 422, "validation_error"),
        ({"text": "hello", "endpoint": "http://arbitrary"}, 422, "validation_error"),
        ({"text": "hello", "start": 1}, 422, "validation_error"),
    ],
)
async def test_rejected_input_never_contacts_provider(
    tmp_path: Path, body: dict[str, object], status: int, code: str
) -> None:
    def unexpected(_request: httpx.Request) -> httpx.Response:
        pytest.fail("Rejected input reached the provider")

    async with api(tmp_path, unexpected) as client:
        response = await client.post("/api/corrections", json=body)
        assert response.status_code == status
        assert response.json()["code"] == code


@pytest.mark.parametrize(
    ("body", "code"),
    [
        (chunk("Partial"), "correction_incomplete"),
        (chunk("Partial", "length") + "data: [DONE]\n\n", "correction_incomplete"),
        (chunk("Partial", "content_filter"), "correction_incomplete"),
        (chunk("Partial") + "data: [DONE]\n\n", "correction_incomplete"),
        (chunk("Partial", "stop"), "correction_incomplete"),
        (complete(" \n"), "correction_empty"),
        (complete("x" * 8001), "correction_output_too_large"),
        (complete({"unexpected": "object"}), "correction_provider_error"),
        ("data: not-json\n\n", "correction_provider_error"),
        ('data: {"choices":[{"delta":[]}]}\n\n', "correction_provider_error"),
        ("data: " + "x" * 40_000, "correction_provider_error"),
    ],
)
async def test_partial_malformed_empty_and_truncated_never_complete(
    tmp_path: Path, body: str, code: str
) -> None:
    async with api(tmp_path, lambda _: httpx.Response(200, text=body)) as client:
        stream = events(await client.post("/api/corrections", json={"text": "Original"}))
        assert stream[-1]["type"] == "error"
        assert stream[-1]["code"] == code
        assert all(item["type"] != "done" for item in stream)
        # Failure releases local admission; a repeat reaches the same provider failure.
        repeated = events(await client.post("/api/corrections", json={"text": "Original"}))
        assert repeated[-1]["code"] == code


@pytest.mark.parametrize("failure", ["timeout", "unavailable", "http"])
async def test_safe_provider_failure(tmp_path: Path, failure: str) -> None:
    def provider(request: httpx.Request) -> httpx.Response:
        if failure == "timeout":
            raise httpx.ReadTimeout("secret-provider-path", request=request)
        if failure == "unavailable":
            raise httpx.ConnectError("secret-provider-path", request=request)
        return httpx.Response(500, text="secret-provider-path")

    async with api(tmp_path, provider) as client:
        response = await client.post("/api/corrections", json={"text": "Original"})
        stream = events(response)
        assert stream[-1]["code"] == (
            "correction_timeout" if failure == "timeout" else "correction_unavailable"
        )
        assert "secret-provider-path" not in response.text


class WaitingStream(httpx.AsyncByteStream):
    def __init__(self) -> None:
        self.closed = False

    @override
    async def __aiter__(self) -> AsyncIterator[bytes]:
        yield chunk("Partial").encode()
        await asyncio.sleep(60)

    @override
    async def aclose(self) -> None:
        self.closed = True


async def test_concurrency_and_disconnect_release_local_slot_and_close_provider() -> None:
    upstream = WaitingStream()
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _: httpx.Response(200, stream=upstream))
    ) as client:
        service = CorrectionService(CorrectionSettings(base_url="http://local/v1"), client)
        draft = CorrectionRequest(text="Original")
        service.admit(draft)
        with pytest.raises(ApiFailure, match="Another correction") as failure:
            service.admit(draft)
        assert failure.value.code == "correction_busy"
        stream = service.stream(draft)
        assert json.loads(await anext(stream))["type"] == "delta"
        await stream.aclose()
        assert not service.busy
        assert upstream.closed
        service.admit(draft)


async def test_total_deadline_terminates_slow_stream(tmp_path: Path) -> None:
    upstream = WaitingStream()
    config = CorrectionSettings(base_url="http://local/v1", timeout_seconds=0.01)
    async with api(tmp_path, lambda _: httpx.Response(200, stream=upstream), config) as client:
        stream = events(await client.post("/api/corrections", json={"text": "Original"}))
        assert stream[-1]["code"] == "correction_timeout"
        assert upstream.closed


async def test_provider_settings_prompts_and_event_schema(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    prompts = tmp_path / "prompts.json"
    prompts.write_text(json.dumps({key: "Operator prompt " + key for key in PROMPTS}))
    monkeypatch.setenv("DIKTATOR_CORRECTION_URL", "http://localhost:18017/v1")
    monkeypatch.setenv("DIKTATOR_CORRECTION_PROMPTS_FILE", str(prompts))
    config = CorrectionSettings.from_environment()
    assert config.prompts["spelling"] == "Operator prompt spelling"
    assert Settings.from_environment(tmp_path).correction == config
    with pytest.raises(ValueError, match="prompts"):
        replace(config, prompts={})
    with pytest.raises(ValueError, match="HTTP"):
        replace(config, base_url="file:///tmp/private")
    schema = Path(__file__).parents[1] / "docs/schemas/correction-event.json"
    assert json.loads(schema.read_text()) == EVENT_SCHEMA


@pytest.mark.parametrize(
    "selected",
    [
        "  Do not order the sensor. Alice has 2400 euros.  ",
        "  Bestelle den Sensor nicht. Alice hat 2400 Euro.  ",
        "  Ne commandez pas le capteur. Alice a 2400 euros.  ",
        "  No pidas el sensor. Alice tiene 2400 euros.  ",
    ],
)
async def test_multilingual_selection_stays_exact_at_the_provider_boundary(
    tmp_path: Path, selected: str
) -> None:
    def provider(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        assert payload["messages"][1]["content"] == selected.strip()
        return httpx.Response(200, text=complete(selected.strip()))

    async with api(tmp_path, provider) as client:
        result = events(await client.post("/api/corrections", json={"text": selected}))
        assert result[-1]["type"] == "done"
        assert result[-1]["text"] == selected


async def test_language_declarations_follow_operator_configuration(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = CorrectionSettings(base_url="http://local/v1", model="another-local-model")
    assert config.language_labels == ()
    async with api(tmp_path, lambda _: httpx.Response(200, text=complete()), config) as client:
        capabilities = (await client.get("/api/corrections/capabilities")).json()
        assert capabilities["languages"] == []
        assert capabilities["language"] == "Unspecified"

    monkeypatch.setenv("DIKTATOR_CORRECTION_MODEL", "another-local-model")
    monkeypatch.setenv("DIKTATOR_CORRECTION_LANGUAGES", "German, French")
    configured = CorrectionSettings.from_environment()
    assert configured.language_labels == ("German", "French")
    monkeypatch.setenv("DIKTATOR_CORRECTION_LANGUAGES", "")
    assert CorrectionSettings.from_environment().language_labels == ()
    with pytest.raises(ValueError, match="languages"):
        replace(config, languages=("",))
