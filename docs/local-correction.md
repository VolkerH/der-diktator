# Local correction design prototype

This unmerged prototype implements the selected-text workflow discussed in
[issue #7](https://github.com/VolkerH/der-diktator/issues/7). Select some transcript
text, choose **Fix selection…** (or right-click the selection), choose an editing
style, and generate a preview. Compare the original and suggestion before
accepting. **Undo correction** restores the exact previous editor text until the
next edit or navigation. Paragraph formatting is the initial style; spelling and
punctuation, and paragraphs with Markdown headings are also available.

The [MVP plan](plans/local-correction-prototype.md) records the scope and deferred
work. This is a working endpoint-backed interaction prototype. The smallest
model's output quality is insufficient for unattended correction.

## Run the prototype

Use an existing local server exposing streaming OpenAI-compatible chat
completions, or run llama.cpp independently. The speech engine and correction
server have separate lifecycles; correction works even when no speech model is
running. Nothing is downloaded or started by the app automatically.

The tested smallest candidate was the publisher's
[SmolLM2-360M-Instruct GGUF](https://huggingface.co/HuggingFaceTB/SmolLM2-360M-Instruct-GGUF),
using its Q8_0 artifact. The publisher repository provided Q8_0, so no unverified
third-party Q4 conversion was introduced. The
[llama.cpp server documentation](https://github.com/ggml-org/llama.cpp/tree/master/tools/server)
describes CPU execution and compatible chat completions.

With a downloaded `llama-server` and model file:

```bash
llama-server \
  --model /path/to/smollm2-360m-instruct-q8_0.gguf \
  --alias smollm2-360m-instruct \
  --host 127.0.0.1 --port 18017 \
  --ctx-size 4096 --threads 4 --parallel 1 --n-gpu-layers 0
```

From this worktree, in a second terminal:

```bash
DIKTATOR_CORRECTION_URL=http://127.0.0.1:18017/v1 \
DIKTATOR_CORRECTION_MODEL=smollm2-360m-instruct \
DIKTATOR_DATA_DIR=/tmp/phonon2-issue7-demo \
uv run --locked uvicorn diktator.app:create_app --factory \
  --host 127.0.0.1 --port 18018
```

Open <http://localhost:18018>. Use a fresh data directory for this prototype.
Only the selected text goes to the operator-configured correction server. There
is no cloud fallback. Do not configure a remote endpoint if your intended data
boundary is local-only. Run one web worker and one model slot for this MVP.

For the already installed environment used during development, the equivalent
app command was:

```bash
DIKTATOR_CORRECTION_URL=http://127.0.0.1:18017/v1 \
DIKTATOR_CORRECTION_MODEL=smollm2-360m-instruct \
DIKTATOR_DATA_DIR=/tmp/phonon2-issue7-demo \
PYTHONPATH=/tmp/phonon2-issue7-prototype/src \
/home/hilsenstein/phonon2/.venv/bin/python -m uvicorn \
  diktator.app:create_app --factory --host 127.0.0.1 --port 18018
```

## Operator configuration

`CorrectionSettings` in `src/diktator/corrections.py` owns the provider, prompts
and limits. Defaults are 4,000 selected Unicode characters, 8,000 output
characters, 1,536 generated tokens, a 90-second total deadline and one admitted
job per web process. Token limits and model context are different units from
characters; a provider may reject a selection that exceeds its token context.
The request schema also has a hard 16,000-character text ceiling. Python callers
can pass a configured `Settings(correction=CorrectionSettings(...))` to
`create_app` to adjust the normal limits.

| Environment variable               | Meaning                                                       |
| ---------------------------------- | ------------------------------------------------------------- |
| `DIKTATOR_CORRECTION_URL`          | Base URL including `/v1`; omitted means disabled.             |
| `DIKTATOR_CORRECTION_MODEL`        | Provider model ID; defaults to `smollm2-360m-instruct`.       |
| `DIKTATOR_CORRECTION_API_KEY`      | Optional Bearer credential, retained only on the server.      |
| `DIKTATOR_CORRECTION_PROMPTS_FILE` | Optional UTF-8 JSON file replacing the three editing prompts. |

A prompt file must contain nonempty strings for all three keys: `spelling`,
`paragraphs`, and `headings`. The shared Python system instruction is prepended
to each. Restart the app after configuration or prompt changes. These are
operator settings, not browser preferences. Mode choice applies only to the
current dialog; reopening uses the backend's default.

## HTTP and streaming contract

`GET /api/corrections/capabilities` returns `configured`, model identity, language,
mode IDs/labels, `default_mode`, character limits, timeout and concurrency.
`configured: true` means configuration exists; it is **not** a health check or a
claim that the model meets a quality threshold. Discovery does not contact the
provider and never exposes its URL, credential or prompts.

`POST /api/corrections` accepts this JSON and defaults `mode` to `paragraphs`:

```json
{ "text": "  selected dictated text  ", "mode": "paragraphs" }
```

Only text and mode are accepted. Chat IDs, browser offsets, prompts, provider
URLs and unknown fields are rejected. The endpoint has no chat, recording,
preference or edit-history side effects. It does not automatically retry.

After admission, HTTP 200 has content type `application/x-ndjson` and
`Cache-Control: no-store`. Each UTF-8 line is one event. The
[event JSON Schema](schemas/correction-event.json) is checked against the typed
Python event definitions. Events are:

```json
{"type":"delta","text":"Provisional words"}
{"type":"done","text":"  Authoritative replacement.  ","mode":"paragraphs","model":"smollm2-360m-instruct"}
```

Or the stream ends with an error instead of `done`:

```json
{
  "type": "error",
  "code": "correction_incomplete",
  "detail": "The correction was incomplete. Select less text and try again."
}
```

Deltas are presentation only. Only `done.text` is a candidate for acceptance.
The backend requires upstream `finish_reason: "stop"`, a nonempty result, limits
within bounds, and the SSE `[DONE]` marker. Length-limited, filtered, malformed,
empty and disconnected streams never produce an acceptable result. The backend
restores the selection's exact leading/trailing whitespace after removing model
edge whitespace; all other generated content needs human review.

Before streaming, failures use the existing `{detail, code}` JSON envelope:

| HTTP | Code                         | Meaning                                              |
| ---- | ---------------------------- | ---------------------------------------------------- |
| 503  | `correction_disabled`        | No provider configured.                              |
| 409  | `correction_busy`            | This web process already has an admitted correction. |
| 413  | `correction_input_too_large` | Selection exceeds the configured character limit.    |
| 422  | `correction_empty_selection` | Selection is empty or whitespace-only.               |
| 422  | `validation_error`           | Invalid fields, mode, types, or the schema ceiling.  |

After streaming starts, HTTP status remains 200 and the terminal error code is
one of `correction_unavailable`, `correction_timeout`,
`correction_provider_error`, `correction_incomplete`, `correction_empty`, or
`correction_output_too_large`. Provider diagnostic bodies are not exposed.
Explicit retries create new jobs. There is no job ID, durable replay or resume.

Cancellation/disconnect closes the HTTP request to the provider and releases
local admission. Native computation cancellation is provider-dependent and
unconfirmed. The app does **not** guarantee that native work has stopped before
another request is admitted. The tested llama.cpp server uses `--parallel 1` to
serialize actual computation. Multiworker/distributed admission and a native
cancellation acknowledgement protocol are deferred.

## Client obligations and persistence boundary

The browser snapshots the full editor text, selected range, navigation generation
and local edit generation. It rechecks all of them before applying, and invalidates
on editing (even editing back to the same text), navigation, recording, or a known
autosave conflict. Late output after cancellation is ignored. Selection indexes
remain entirely in the browser and slice its exact JavaScript string, preserving
emoji, Unicode and all text outside the selection. Generated text is never
rendered as HTML. A toolbar action provides a keyboard-accessible alternative to
right-click.

Accept replaces the local selection and submits the resulting full draft through
the existing serialized `If-Match` text-save path. It does not silently resolve
remote changes. A remote conflict leaves the accepted local draft visible and
keeps the existing **Load latest / Copy my version** recovery controls; a failed
save stays visibly unsaved. A deleted chat's save still fails. Undo is a guarded,
local one-step action that uses the same conditional persistence path. It is
separate from native textarea undo and is not durable history.

This is provisional integration with the current text API. It does not implement
the proposed idempotent anchored Accept operation, durable history or collaborative
protocol from [ADR 0004](adr/0004-edit-history.md) and
[ADR 0005](adr/0005-collaborative-editing-protocol.md). Other clients must retain
source text, require complete output and explicit acceptance, recheck their local
snapshot and use the current conditional write API themselves.

## Validation and observed quality

Validation on 2026-10-09 used the isolated worktree source, with `diktator.__file__`
confirmed as `/tmp/phonon2-issue7-prototype/src/diktator/__init__.py`.

- Ruff formatting/lint and ty: passed. Full Python suite: **384 passed**, including
  26 correction tests and the updated OpenAPI/event schema contract checks.
- Prettier, ESLint and TypeScript: passed. Full frontend suite: **166 passed**,
  including stream completion/error/cancellation, exact selection replacement,
  stale preview guards, Accept/Undo, context-menu action and remote save conflict.
- Real HTTP API and Chromium **153.0.8010.12** with the CPU model: passed preview,
  Accept, Undo, context-menu Cancel, outside-selection/edge-whitespace preservation,
  desktop (1280 × 900) and mobile (390 × 844) layouts, without horizontal overflow
  or JavaScript page errors. See [browser evidence](issue7-evidence/browser-smoke.json).
- Deterministic tests use injected providers. The separate
  [real-model smoke](issue7-evidence/model-smoke.json) exercised all three modes
  through the real backend service. They are different validation layers.

The actual runtime was official llama.cpp **b11514**, commit `de7fa0a3c`, CPU-only
with four threads, a 4,096-token context and one slot, on an Intel i7-12800H under
WSL2 Linux x86_64. The publisher's model revision was
`593b5a2e04c8f3e4ee880263f93e0bd2901ad47f`; the Q8_0 artifact was **386,404,992 bytes**,
SHA-256 `48ab3034d0dd401fbc721eb1df3217902fee7dab9078992d66431f09b7750201`.
The model/runtime live outside the repository.

**The smallest model did not pass a useful editing-quality threshold.** It left
misspellings unchanged, lowercased a proper name, sometimes wrapped output in
quotes, and failed to create requested paragraph breaks or headings. A real
browser preview changed a request not to order a sensor into a statement that
it had not been ordered, altering meaning. These observations justify explicit
review; protocol completion is not semantic validation. English is the only
intended prototype language, and no German-quality claim is made.

The single warm service samples showed first output around 0.20–0.27 seconds and
completion around 0.53–0.70 seconds. A separate warm HTTP sample was faster.
These synthetic samples are **not benchmarks** and establish neither cold-start
performance nor a general quality or latency guarantee.

![Desktop correction preview with original and suggestion](issue7-evidence/preview-desktop.png)

[Mobile preview screenshot](issue7-evidence/preview-mobile.png)
