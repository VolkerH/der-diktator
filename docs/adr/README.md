# Architecture decision records

Each record states one architectural decision, its context, and its consequences. Discussion
happens in GitHub issues; the records keep the outcome. Git history shows how a record evolved.

Do not rewrite an accepted decision. Record a change in a new ADR that supersedes the old one, and
set the old record's status to `Superseded by NNNN`. Small clarifications that do not change the
decision may be edited in place.

Statuses: `Proposed` (direction agreed, open validation gate), `Accepted`, `Superseded by NNNN`.

| ADR                                            | Decision                                           | Status   |
| ---------------------------------------------- | -------------------------------------------------- | -------- |
| [0001](0001-sqlite-persistence.md)             | SQLite application data, audio and models as files | Accepted |
| [0002](0002-api-conventions.md)                | One set of HTTP and streaming API conventions      | Accepted |
| [0003](0003-ownership-and-membership.md)       | Actor context, chat membership, per-user groups    | Accepted |
| [0004](0004-edit-history.md)                   | Current transcript plus append-only edit history   | Accepted |
| [0005](0005-collaborative-editing-protocol.md) | Choose the editing protocol by prototype           | Proposed |

The discussion behind 0001–0005 is in
[#15](https://github.com/VolkerH/der-diktator/issues/15) and
[#16](https://github.com/VolkerH/der-diktator/issues/16). Client/backend responsibilities are
defined in [AGENTS.md](../../AGENTS.md).

[API conventions](../api-conventions.md) defines the shared implementation contract from ADR 0002,
including the decisions still required for individual features.
