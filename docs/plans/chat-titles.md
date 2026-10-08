# Shared chat titles (#2)

Scope: canonical Python title derivation, shared nullable custom titles in SQLite,
conditional rename/reset API, and an accessible browser title editor. Follow ADRs
0001–0004 and the existing conditional-write contract. Search and groups follow
in separate changes.

- Migrate from 0002 with nullable `custom_title` and independent `title_revision`.
- Return canonical titles in all chat details and summaries. Preserve the existing
  48-code-point automatic rule. Trim overrides, accept 1–120 Unicode code points,
  reject controls and line separators, and use the shared error envelope.
- Define a title subresource with its own strong validator covering the effective
  title, override and metadata revision. Rename changes whole-chat/title revisions
  and recency, never the text revision. No-op updates change nothing.
- Keep browser drafts, acknowledged text validators and recordings safe when title
  responses arrive. Use server titles, keyboard-accessible Save/Cancel/reset, lazy
  creation, explicit conflict retry, and existing recording/transcription guards.

Acceptance: HTTP tests cover validation, persistence/migration, title survival
through text/audio mutations, membership isolation, scoped conflicts and no-ops.
Separate frontend tests cover cancel/laziness, keyboard actions, canonical literal
labels, failed/conflicted requests and pending/newer drafts. Refresh OpenAPI and
run `make check`; use browser validation if available. Commit for independent
review before publication.

Implemented with a computed canonical Python title, SQLite migration
`0003_chat_titles`, typed title read/write schemas and independent validators.
Chromium checks passed on desktop and phone with demo API responses: Enter,
Escape, focus return, rename/reset across autosave, literal labels, Unicode
length and truncation, with zero page errors. Browser evidence is separate from
HTTP/SQLite acceptance; no model inference or microphone claim is made here.

Review correction: title observation ordering is independent of the complete-chat
version acknowledged for deletion. A delayed autosave must not replace a newer
rename or conflict-read title while its text version is still unacknowledged.
The title GET exposes its parent snapshot in `Chat-Revision` for this purpose;
regressions cover both response orders and conservative deletion acknowledgment.
