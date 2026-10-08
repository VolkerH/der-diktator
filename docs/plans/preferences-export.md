# Preamble preferences and draft export (#4, initial #9 slice)

Use the merged SQLite, actor and conditional-write contracts. This slice stores only
`copy_preamble` per server-resolved user. Operator settings and other #9 settings remain later work.

Acceptance:

- Persist default, edits and explicit reset in SQLite, with required preference If-Match,
  atomic conflicts and a stable error envelope. Reads expose defaults and limits.
- Export the exact supplied unsaved draft without touching chats or history. Plain output
  preserves bytes represented by the input string; Markdown uses a safe backtick fence.
- Offer prepared copying through Share… and an accessible preference dialog. Retain prepared output for
  clipboard retry/manual copy, ignore stale draft/navigation results, and retain preference
  drafts on failure/conflict. Cancel and Escape restore focus.
- Document HTTP schemas, bounds, errors, retry semantics and client obligations. Verify API
  behavior independently of JavaScript and client behavior independently of the backend.
- Run make check and available browser checks before review; publication follows independent review.
