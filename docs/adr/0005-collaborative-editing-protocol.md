# 0005. Choose the editing protocol by prototype

Status: Proposed (2026-10-08) — gate: prototype results below

Discussion: [#15](https://github.com/VolkerH/der-diktator/issues/15) —
[collaboration follow-up](https://github.com/VolkerH/der-diktator/issues/15#issuecomment-6060764920),
[review of the reviews §3, §5](https://github.com/VolkerH/der-diktator/issues/15#issuecomment-6061024479),
[accepted corrections](https://github.com/VolkerH/der-diktator/issues/15#issuecomment-6061509440);
[#16](https://github.com/VolkerH/der-diktator/issues/16).

## Context

Whole-text saves that are rejected when stale cannot support two people editing one chat. A
`<textarea>` loses its undo stack and cursor when remote changes are applied. Candidate
approaches differ in where merging happens and what every client must implement. CodeMirror counts
positions in UTF-16 code units and `@codemirror/collab` uses its own change-set format, so a Python
protocol based on Unicode code points would not match it without explicit conversion.

## Decision

- **Until a protocol is chosen**, text saves are conditional (`If-Match`/412, see
  [0002](0002-api-conventions.md)). Clients keep their local draft on conflict. This is an interim
  contract, not the collaboration experience.
- **Choose the editor and wire protocol by prototype**, comparing at least a central-authority
  approach (for example CodeMirror 6 with `@codemirror/collab` and a Python authority) and a
  maintained CRDT used through the server (for example Yjs). The prototype includes a browser
  client, the Python server, and a plain HTTP client. It must demonstrate:
  - simultaneous insert, delete and replace;
  - emoji and combining characters;
  - pending local edits, reconnect, and retry deduplication;
  - selection mapping, and undo of one's own edits after remote changes.
- The protocol specification states offset units, newline handling and conversions explicitly.
- A full-text save with a base revision may be merged only where the merge policy is well defined;
  overlapping edits produce a recoverable conflict.
- Change notifications are published after commit; the database history is the durable catch-up
  source. Specify reconnect cursors, bounded catch-up, a subscribe/catch-up sequence that cannot
  miss changes, and authorization on both catch-up and live delivery, including revocation.
- Client-side rebasing and undo do not conflict with [AGENTS.md](../../AGENTS.md): permissions,
  accepted changes and persistence remain authoritative on the backend. Editor assets are bundled
  at build time; packaged installs need no Node service.

## Consequences

- When the prototype passes, a new ADR records the chosen protocol and supersedes this one.
- Live co-editing and collaborative undo follow #10's membership enforcement. Single-user edit
  history ([0004](0004-edit-history.md)) can ship earlier.
