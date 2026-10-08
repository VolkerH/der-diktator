# API conventions

Status: initial design contract, implementing the decisions in
[ADR 0002](adr/0002-api-conventions.md). These conventions are targets for upcoming implementation;
this document does not change the running API. Existing routes do not yet consistently provide the
error codes, conditional writes, idempotency or stream envelopes described here. Each feature must
document and test its adoption, including compatibility with existing clients.

The browser, a TUI and other clients use the same application contract. The backend owns validation,
permissions, persistence, application preferences and resource limits. Clients own device access,
presentation, selection and undo, and fulfill documented capture/buffering obligations. See
[AGENTS.md](../AGENTS.md).

## Schemas and feature contracts

Define requests, responses and events as typed Pydantic models, separately from database rows.
Publish HTTP schemas in OpenAPI and streaming schemas alongside it. A feature specifies defaults,
side effects, resource limits, authorization, completion, cancellation and retry behavior. Actor
identity comes from server authentication/context; a client or operation identifier is not proof of
identity. Recheck access before returning a stored result or applying delayed work.

Feature plans refer here for common rules and describe their additions. The ADRs record architectural
decisions; endpoint documentation supplies concrete schemas and examples. Do not interpret proposed
endpoints or example payloads as implemented capabilities.

## Errors

Application HTTP errors use a JSON object with a human-readable `detail` string, a stable `code`,
and optional structured `context`:

```json
{
  "detail": "This resource changed after you read it.",
  "code": "revision_conflict"
}
```

Clients branch on `code` and HTTP status, not the wording of `detail`. Context is documented per code;
it must not expose inaccessible data or internal diagnostics. Map FastAPI validation and HTTP errors
to this envelope too. Validation details belong in structured context rather than changing `detail`
to an array. This is a change from FastAPI's default validation response and needs compatibility tests.

Initial common code registry (target behavior):

| Code                   | HTTP status | Client action                                                                 |
| ---------------------- | ----------- | ----------------------------------------------------------------------------- |
| `revision_conflict`    | 412         | Keep the draft; fetch current state and reconcile before submitting again.    |
| `idempotency_conflict` | 409         | The key was used for different input; reconcile the original operation first. |
| `validation_error`     | 422         | Correct the invalid input; repeating the same request will not fix it.        |

Add feature-specific codes, statuses and retry guidance when their contracts are defined. A 409
describes a logical conflict; it does not replace 412 for a failed `If-Match` precondition. A timeout
or lost connection alone does not establish whether a mutation succeeded. Clients must also handle
legacy or intermediary errors that do not have this envelope, without blindly retrying a mutation.

## Conditional writes and revisions

Use opaque, strong `ETag` validators and `If-Match` for revision-guarded writes. Clients preserve the
quoted validator exactly. Each endpoint defines which representation supplies its validator and
which changes invalidate it. A validator must cover the state that the write can overwrite; clients
must not substitute a timestamp or a validator from a different resource.

Check the precondition and commit the change atomically. A stale validator returns 412 with
`revision_conflict` and applies none of that mutation. Supply the resulting validator with the
successful response, or document how the client reads it. When enabling mandatory preconditions on
existing routes, specify the rollout and the response to a missing validator; do not silently treat a
missing validator as permission to overwrite newer data.

After a conflict, preserve the local draft and fetch current state. Do not simply attach the new
validator to the old full-text replacement: that can erase another person's edit. Conditional text
saves are the interim behavior in [ADR 0005](adr/0005-collaborative-editing-protocol.md). Automatic
merging requires the protocol prototype and a defined conflict policy.

Document revisions, chat event sequences and metadata revisions have distinct meanings. A
metadata-only history entry must not advance the document revision. See
[ADR 0004](adr/0004-edit-history.md).

## Idempotency and retries

Non-idempotent commands use a client-generated `Idempotency-Key`, kept unchanged when retrying the
same logical operation. A feature documents key format, scope, retention and how callers recover an
operation's status. Streaming/session identifiers must have an explicit relationship to operation
keys; an HTTP header alone does not define streaming deduplication.

- Scope the key to the authenticated actor and operation, including its target resource. Reserve it
  atomically before work is admitted, and compare a hash of the operation's effective input. Define
  normalization and include inputs that affect side effects, including applicable preconditions.
- A matching retry refers to the original operation. It must not start a second copy. Return its
  recorded result or documented pending/uncertain status; different input under the same key returns
  409 `idempotency_conflict`.
- Recheck current authorization before replaying a result. A retry of a completed, authorized
  operation must not reapply its mutation or fail solely because the original mutation advanced the
  resource revision. A reconciled command with changed input is a new operation with a new key.
- Record pending and uncertain outcomes as well as completed responses. Admission to the inference
  process and external side effects are not atomic with an application database transaction. Define
  recovery for that gap; do not promise exactly-once execution across processes.
- Publish the deduplication window and behavior after expiry. A forgotten key cannot by itself prove
  that an operation never ran. Clients must reconcile an unknown outcome instead of automatically
  resubmitting outside the guaranteed window. The storage/recovery mechanism is feature-specific.

The engine currently rejects work while busy. A waiting state requires an explicit bounded queue
with admission and cancellation rules in [#12](https://github.com/VolkerH/der-diktator/issues/12).
Do not interpret a busy response as successful admission.

## Time and ordering

Serialize timestamps as RFC 3339 in UTC, with `Z` or an explicit `+00:00` offset. API values must not
contain naive local datetimes. Timestamps describe time; revisions and sequence numbers determine
ordering and concurrency. Each feature specifies which actions change its recency fields, including
`updated`, so list ordering does not depend on a frontend's guess.

## Streaming and subscriptions

Use typed events discriminated by `type`, with documented sequence and correlation identifiers.
Define the concrete envelope in each streaming schema: sequence scope, initial value, ordering,
duplicate handling and relationship between request, operation and session identifiers. These
conventions do not rename the existing audio protocol's events or choose SSE versus WebSocket.

| Stream                  | Contract                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| Finite job              | One authoritative terminal state: completed, failed or cancelled.                              |
| Long-lived subscription | A sequence/cursor for its documented feed; disconnect is not a job completion or cancellation. |

A terminal event may be lost in transit. Job contracts define status recovery and whether replay is
supported. Cancellation is a request until the authoritative outcome confirms it; a disconnected
client does not establish that native inference has stopped. Define provisional versus confirmed
text and whether text events carry cumulative content or deltas.

For chat subscriptions, committed database history is the durable catch-up source. Publish changes
after commit, define reconnect cursors and bounded catch-up, and prevent gaps between catch-up and
live delivery. Specify slow-client handling and recovery when a cursor is no longer available.
Authorize both history reads and live delivery, and stop access on revocation. Private per-user
group changes must not leak through another member's feed. Sequence scopes must accommodate such
filtering; clients must not infer missing events from numeric gaps without that contract.

## Compatibility and verification

Prefer additive changes and document breaking changes with their migration path. Adding a required
input, changing a field's meaning, or changing terminal-event behavior is not automatically backward
compatible. Document how clients handle unknown optional fields and event types; unknown events
must not silently become a successful completion. Keep existing clients usable during adoption or
provide an explicit coordinated upgrade.

Review generated OpenAPI snapshots and published event schemas with contract changes. Exercise
application behavior through HTTP/streams without browser JavaScript, including conflicts, duplicate
requests, disconnects and authorization. Test client capture, draft preservation and presentation
separately. Schema snapshots complement behavioral tests; they do not replace them.

## Decisions still required before the affected features ship

- Per-command idempotency retention, pending/uncertain response shapes and recovery after expiry.
- Per-resource validator scope, missing-precondition responses and existing-client rollout.
- Per-stream wire schemas, cursor retention, resynchronization and slow-client limits.
- Recency rules and feature-specific error codes, registered with their implementing contracts.
- The collaborative editor/protocol, offset units, newline handling, anchor mapping and merge policy,
  selected through the [ADR 0005 prototype](adr/0005-collaborative-editing-protocol.md).

These are explicit implementation gates, not permission for each client to invent its own behavior.
