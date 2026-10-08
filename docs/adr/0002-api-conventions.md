# 0002. One set of HTTP and streaming API conventions

Status: Accepted (2026-10-08)

Discussion: [#15](https://github.com/VolkerH/der-diktator/issues/15) —
[architecture review §2](https://github.com/VolkerH/der-diktator/issues/15#issuecomment-6060520952),
[review of the reviews §1, §5](https://github.com/VolkerH/der-diktator/issues/15#issuecomment-6061024479),
[accepted corrections](https://github.com/VolkerH/der-diktator/issues/15#issuecomment-6061509440).

## Context

[AGENTS.md](../../AGENTS.md) requires typed contracts that a browser, a TUI, or another client can
use. The roadmap plans each specified errors, revisions, idempotency and events independently and
had started to disagree (for example 412 versus 409 for the same `revision_conflict`).

## Decision

Maintain [API conventions](../api-conventions.md) as the shared contract. Feature plans refer to it
and describe only their additions. It covers:

- **Errors:** one JSON envelope with a human-readable `detail` string (compatible with existing
  clients), a stable machine-readable `code`, and optional context. FastAPI validation and HTTP
  errors are mapped to the same envelope. A registry lists codes, statuses and retry guidance.
- **Conditional writes:** `ETag`/`If-Match`, and **412** for a failed precondition. **409** for
  distinct logical conflicts, such as reusing an idempotency key with different input. Clients
  keep their local draft on conflict and refetch before retrying.
- **Idempotency:** client-supplied keys on non-idempotent requests, scoped to actor and operation,
  reserved atomically and compared against an input hash. Pending and uncertain outcomes are
  represented; behavior after a key expires is defined. No exactly-once guarantee for inference or
  external side effects.
- **Timestamps:** RFC 3339 in UTC.
- **Streams:** shared envelope conventions (`type`, sequence, identifiers), but **finite job
  streams** and **long-lived subscriptions** are distinct: different sequence scopes, and only jobs
  have a single authoritative terminal state. Streaming schemas are published alongside OpenAPI.
- **Compatibility:** additive changes by default; breaking changes are documented.
- **Busy inference:** the engine rejects requests while busy. Queuing requires an explicit,
  bounded queue and cancellation policy (#12).

## Consequences

- A test snapshots the generated OpenAPI document so contract changes are visible in review.
  Behavioral tests through HTTP, without browser JavaScript, remain required.
- Existing per-issue plans keep their feature-specific codes but defer general rules to this
  document.
