# API errors

Implemented behavior for the web and engine services, following the shared
[API conventions](api-conventions.md). HTTP contracts are published at each service's
`/openapi.json`; live error schemas accompany them in
[schemas/stream-error.json](schemas/stream-error.json).

## HTTP errors

Both web and engine HTTP APIs return the shared error envelope. `context` is omitted when absent;
validation errors include `context.errors` containing field `loc`, `type` and `msg`, with submitted
values and exception objects omitted. FastAPI's 422 response now has a string `detail` instead of an array; this is the
only changed field shape. Browser clients show `detail`, attach an optional string `code` to the
thrown error, and tolerate legacy, non-JSON and non-string-detail responses with a generic message.

Every declared error response in `/openapi.json` references `ApiError`, including 422. Checked-in
snapshots in `tests/snapshots/` cover both services. Request-validation diagnostics are for correcting
inputs; they do not include upstream diagnostics. Routing and static-asset failures also use the
envelope: 404 `not_found` and 405 `method_not_allowed`. Other explicitly raised HTTP exceptions use
`http_error` and their authored public message; status-specific headers such as `Allow` are preserved.

The web upload boundary accepts `audio/wav` and `audio/x-wav`, enforces the configured byte limit
while reading and checks recording duration and WAV validity before invoking inference.
The 413 message reports `max_audio_bytes`, rather than assuming a fixed duration. Model and
transcription requests share the same engine mapping: a recognized code must match its registered
HTTP status and arrive in a valid error envelope. Its public message is selected locally by code;
upstream `detail` and `context` are discarded. Unknown codes, status/code mismatches, malformed coded
envelopes and invalid successful responses become 502 `engine_error`. Legacy code-less 409 and 503
responses map to `model_conflict` and `engine_unavailable` respectively. No message parsing is used.
Model admission and mapping share canonical public messages, including the generic live-mode refusal;
registered codes do not make arbitrary upstream text safe to display. The configured engine URL can
refer to a remote host. Upstream live errors are logged on the server before sanitizing their message.
Health checks keep their existing `{ready: false}` behavior when the engine cannot be checked.

A rejected model admission has not been queued. Timeout, transport loss and upstream failures can
leave the outcome uncertain; clients must retain audio and reconcile engine state before an explicit
retry. Failed inference requests are not automatically retried. Live failures trigger owned
stop/reap and model reload; the browser waits for readiness before one batch fallback
using the complete saved WAV. Recovery failures preserve audio and require explicit
action. Native batch timeouts have no job recovery or cancellation confirmation.

Policy discovery and inference admission add 503 `configuration_mismatch` for a
missing/old engine policy capability or disagreement, distinct from an unreachable
engine's `engine_unavailable`. Operators restart both services with matching inputs to
resolve `configuration_mismatch`; clients do not automatically retry it. Both services enforce 408 `upload_timeout` while
reading WAV request bodies. Batch 504 `engine_timeout` can leave native inference
running; retain audio and wait before retrying. See [recording policy](recording-policy-api.md).

## Live errors

The engine `/v1/audio/stream` and web `/api/stream` use this additive terminal event:

```json
{
  "type": "error",
  "message": "The model is loading. Wait for it to become ready.",
  "code": "model_loading"
}
```

Its typed schema is published in [schemas/stream-error.json](schemas/stream-error.json), alongside
HTTP OpenAPI. `message` stays a string; `code` is optional for compatibility with older peers. New
engine and web failures carry it. The relay validates registered codes and replaces upstream error
messages with the public message for that code. Unknown, malformed or code-less upstream error
events become `engine_error`; arbitrary upstream fields and diagnostics are discarded. Non-error
`partial`, `final` and `done` events keep their existing fields and names.

Local oversize PCM frames use `audio_too_large`; exceeding the cumulative recording-duration limit
uses `invalid_audio`; invalid control/configuration requests use `validation_error` or
`unsupported_audio`. A bad model query emits `validation_error` and closes with code 1008. Connection
failures use `engine_unavailable`, finalization timeouts use `engine_timeout`, and malformed upstream
events use `engine_error`. An error event ends the relay and closes the socket. `ready` means the web
relay connection opened; an engine admission failure can arrive immediately afterwards. Only `done`
is successful completion. A disconnect or error never proves that native inference was cancelled.
Normal native `done` permits model reuse. Abnormal teardown after reservation owns
backend stop/reap through cancellation; model mutations and new inference stay
busy until stop is confirmed. Successful cleanup leaves the model unloaded; failed
cleanup stays busy and reports a model error. Clients retain their capture buffer through finalization and show a warning on live failure, so the
user can explicitly retry the retained recording.

## Model route responses

The web model listing (`GET /api/models`) and model actions
(`POST /api/models/{model}/download`, `activate` and `delete`) declare 409 for engine conflicts,
422 for rejected request fields, 502 for invalid engine responses, 503 for unavailable connections
and 504 for timeouts. This includes coded upstream conflicts and validation errors on listing.
Audio validation and upload-limit codes are invalid for these routes and map to sanitized
502 `engine_error`; transcription routes retain their audio-specific errors. The engine model listing
has no operational error response declaration; its model actions declare 409 and 422.
