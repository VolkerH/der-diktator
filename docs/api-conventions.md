# API conventions

Status: shared design contract from [ADR 0002](adr/0002-api-conventions.md). The existing-error
envelope, live error codes, chat/text conditional writes and safe-create retries are implemented.
Each feature documents and tests adoption, compatibility and its additions.
Browser, TUI and other clients share this contract; responsibilities follow [AGENTS.md](../AGENTS.md).

## Schemas and errors

Use Pydantic API models separately from database rows. Publish HTTP schemas in OpenAPI and stream
schemas alongside it. Specify defaults, side effects, limits, authorization and completion behavior.
Actor identity comes from server context, never a client/session identifier.

HTTP errors use a human-readable `detail` string, stable `code` and optional structured `context`:

```json
{
  "detail": "This resource changed after you read it.",
  "code": "revision_conflict"
}
```

Clients use status/code, not message text. Map FastAPI validation and HTTP errors to this envelope;
validation details belong in context, not an array-valued `detail`. Keep context free of inaccessible
information and internal diagnostics. Clients must also tolerate legacy/intermediary error formats.

The error codes below are implemented:

| Code                                       | HTTP | Meaning / client action                                                           |
| ------------------------------------------ | ---- | --------------------------------------------------------------------------------- |
| `chat_not_found`                           | 404  | Missing or inaccessible chat; show the same message for both.                     |
| `recording_not_found`                      | 404  | Recording missing from an accessible chat, or its audio file is missing.          |
| `audio_too_large`                          | 413  | Upload exceeds the byte limit; reduce it.                                         |
| `unsupported_audio`                        | 415  | Unsupported media type; use the documented audio format.                          |
| `invalid_audio`                            | 400  | Invalid audio or violated audio constraints; correct the input.                   |
| `model_busy`                               | 409  | Inference or another model operation occupies the engine; wait and refresh state. |
| `model_loading` / `model_deleting`         | 409  | Model lifecycle transition; refresh state before retrying.                        |
| `model_not_active` / `model_not_installed` | 409  | Activate/download the requested model; waiting alone is insufficient.             |
| `live_transcription_unsupported`           | 409  | Choose a supported mode/model; never silently change audio-retention policy.      |
| `model_conflict`                           | 409  | Legacy/unclassified model conflict; refresh state, do not assume busy.            |
| `engine_unavailable`                       | 503  | Engine unreachable/unavailable; check health and reconcile any submitted work.    |
| `engine_error`                             | 502  | Upstream failure or invalid response; outcome may be uncertain.                   |
| `engine_timeout`                           | 504  | Timed out waiting for the engine; work may still be running.                      |
| `validation_error`                         | 422  | Invalid request fields; correct them.                                             |
| `revision_conflict`                        | 412  | Preserve the draft, fetch current state and reconcile.                            |
| `idempotency_conflict`                     | 409  | Same key, different input; reconcile the original operation.                      |

For authenticated chat access, missing and inaccessible resources have the same public 404 status
and body, without distinguishing context. Apply this to chat-scoped audio, history and subscriptions
as well: a recording request for a missing or inaccessible chat returns `chat_not_found`, and
`recording_not_found` only applies within an accessible chat. Check chat access before recording
access. A viewer's forbidden write to an otherwise visible chat is a separate authorization case.

The internal engine API uses the same envelope and code registry. Registered codes must match their
HTTP status. Keep upstream diagnostics in server logs; use authored public messages at the client
boundary. Register further feature errors with their statuses and recovery guidance. Implemented
route behavior and compatibility details are documented in [API errors](api-errors.md).

### Terminal live errors

Finite audio streams use a terminal error event with a human-readable string `message` and an
optional `code` for compatibility with older peers:

```json
{
  "type": "error",
  "message": "The model is loading. Wait for it to become ready.",
  "code": "model_loading"
}
```

The typed schema is published in [schemas/stream-error.json](schemas/stream-error.json). Only `done`
means successful completion. An error or disconnect does not confirm native inference cancellation.
Clients retain captured audio through finalization and warn on live failure so the user can retry
explicitly. See [API errors](api-errors.md) for the existing routes and transport behavior.

## Conditional writes

Use opaque, strong `ETag` validators and `If-Match`. Each endpoint defines the read representation and
validator scope; clients preserve the quoted value. A strong validator changes whenever its
representation changes. A subresource that is written independently, such as a chat's text, has its
own representation and validator; the parent resource's validator covers every change to the parent.
Check and commit atomically: a stale validator returns 412 and applies no mutation. Return the new
validator or document how to retrieve it.

Keep drafts on conflict. Fetching a new validator and resending the old full-text replacement can
erase another person's edits. Conditional saves remain the interim contract until the
[collaboration prototype](adr/0005-collaborative-editing-protocol.md) establishes merging. Document,
chat-event and metadata revisions stay separate; metadata alone does not advance text revisions.

Subresource validators can accompany a parent representation in a scoped header such as
`Text-ETag`. [The chat API](chat-api.md) defines implemented routes and client obligations.

## Retries and idempotency

Plain resource replacement/deletion (PUT/DELETE) normally needs no idempotency key. This does not
promise identical retry responses or deduplicate history: enforce preconditions and avoid duplicate
user-visible events where required. A retry may find an already-deleted resource or a stale validator.
Commands whose duplication creates extra effects need deduplication: creating chats and recordings,
starting transcription, applying results, sending shares and recording dictation sessions/edits.

Prefer client-chosen resource IDs where the command creates exactly one resource. The client
generates a random ID (UUID-sized) once per logical create and reuses it on retry, e.g.
`PUT /api/chats/{id}`. A repeat with the same input returns the existing resource; the same ID with
different input, or an ID already used by an inaccessible resource, returns 409
`idempotency_conflict`. This needs no ledger, and crash recovery follows the resource's own
database/file boundary. Use `Idempotency-Key` for commands that cannot be expressed this way.

Creation routes document 201 for creation, 200 for a matching retry and 409 for mismatches,
or any compatibility exception. Client-chosen chat and recording IDs have no tombstones;
see [the chat API](chat-api.md) for deletion, recreation and exact upload retry semantics.

For `Idempotency-Key` commands, and equivalent stream/session identifiers:

- Scope to actor, operation and target; reserve atomically before admission. Hash normalized effective
  input, including applicable preconditions. Different input with the same key returns 409.
- A matching retry returns the original result or pending/uncertain status without repeating work.
  Recheck authorization. A completed operation must not fail solely because its own mutation advanced
  the revision. Changed input after reconciliation needs a new key.
- Define recovery across database/engine boundaries; do not promise exactly-once external effects.
  Publish retention/expiry behavior. Reconcile unknown outcomes rather than blindly retrying after
  timeout, disconnect or expiry. A forgotten key does not prove that work never ran.

Busy means rejected, not queued. A queue needs explicit admission and cancellation rules in
[#12](https://github.com/VolkerH/der-diktator/issues/12).

## Time and streams

Timestamps are RFC 3339 UTC (`Z` or `+00:00`). Revisions/sequences establish ordering; timestamps do
not. Specify which actions change recency fields such as `updated`.

Typed events use `type` with documented sequence/correlation identifiers. Finite jobs have one
authoritative terminal state: completed, failed or cancelled. Long-lived subscriptions use feed
cursors; disconnect is not completion or cancellation. Lost terminal events need a recovery path.
Cancellation remains a request until confirmed; disconnect does not prove native work stopped.
Specify cumulative versus delta text and provisional versus confirmed content.

Chat history is the durable catch-up source. Publish after commit; prevent gaps between catch-up and
subscription. Bound slow clients/catch-up and define recovery for expired cursors. Authorize reads
and live delivery, including revocation. Do not leak private group events; filtered sequence gaps
are not evidence of lost events unless the feed contract says so. This does not rename the current
audio events or choose SSE versus WebSocket.

## Adoption and open decisions

Prefer additive changes. Required inputs, changed meanings and terminal behavior need an explicit
compatibility path. Unknown optional fields/events must not become successful completion. Review
OpenAPI/event schemas and test HTTP/stream behavior without browser JavaScript, including conflicts,
retries, disconnects and authorization; test client behavior separately.

Before each feature ships, specify validator scope and missing-precondition responses, key retention
and pending/uncertain recovery, stream schemas/cursor limits, and recency rules. Collaboration's
wire format, offsets, anchors and merge policy remain gated by
[ADR 0005](adr/0005-collaborative-editing-protocol.md). These are shared contracts to settle before
implementation, not choices for individual clients.

## Chat recency

Creation sets `created` and `updated` to the same UTC timestamp. Text replacement
sets `updated` during its database mutation; saving identical text changes nothing. Uploads update recency after audio
finalization to the later of the database mutation time and the stored `updated`,
so a text save during finalization cannot be overwritten by an earlier timestamp.
The recording keeps its upload-start `created` timestamp. Reading and listing
chats do not change recency. Lists sort by `updated` descending, with chat ID as
the tie breaker.
Recordings sort by creation time and ID. Legacy import preserves the original
creation and update instants and the import-time transcript independently of a
chat's later deletion.
