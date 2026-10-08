# Preferences and draft exports

These APIs use the server-resolved user profile, shared across browser, TUI and other clients.
Operator configuration is outside this API. OpenAPI describes the request and response schemas.

## Preferences

`GET /api/preferences` returns `copy_preamble`, `copy_preamble_is_default`, `revision` (initially 1),
`default_copy_preamble`, `max_copy_preamble_characters` (4,000) and `share_include_preamble`
(default false). The sharing choice is a user preference persisted across clients and restarts;
clients use it to choose the export format before opening their device share interface. Missing rows and SQL NULL
follow the current server default. Custom text equal to that default remains custom.
Reads do not create rows. The opaque strong ETag hashes the full representation and actor:
unlike chat revisions, it must also change when a release changes server defaults or limits.

`PATCH /api/preferences` accepts `copy_preamble`, the strict boolean `share_include_preamble`,
and/or a `reset` list naming these fields. Sharing reset restores false. Setting and resetting
the same field is invalid; null and non-boolean sharing values return 422. Omitted fields
remain unchanged. Reset stores NULL so future server defaults apply. Changing between custom
and default mode advances revision even when the effective text is identical; no-ops do not.
Accepted text retains its whitespace and Unicode. GET and PATCH both return ETag.

Writes require `If-Match`: missing means 428 `precondition_required`; stale or weak means
412 `revision_conflict`, without writes. Strong validator lists and `*` follow the shared
conditional-write convention. Checks and writes share a transaction. On conflict retain the
draft, read current values and reconcile. After response loss or `persistence_failed`, refetch
before retrying because the original write may have committed.

Empty, whitespace-only, null, overlong or unknown values and set/reset conflicts return
422 `validation_error`. Unreadable stored preferences return 503 `preferences_unavailable`;
an explicit reset with `If-Match: *` repairs a corrupt row without first reading it. Other
writes cannot bypass corrupt-value validation. Write failures return 503 `persistence_failed`
and roll back. Preferences never change chats, recordings, recency or history.

## Draft preparation

`POST /api/exports` takes the exact current draft as `{text, format?: "plain" | "with_preamble"}`
and returns `{text, media_type}`. Plain output preserves the string exactly. Preamble output
uses the user's current preamble, a blank line and a fenced `text` block; its backtick fence
is longer than any backtick run in the draft (minimum three). Only a missing final newline
is added before the closing fence. Preambles are literal text, without template expansion.

The configured transcript limit (default 1,000,000 Unicode characters) returns 413
`text_too_large`; whitespace-only drafts return 400 `invalid_export`; invalid fields or formats
return 422 `validation_error`. Preamble read failures return 503 `preferences_unavailable`.
Plain export does not read preferences. Nothing is saved, copied or delivered. Retries have
no write effects, although changed saved preferences can change the result.

`POST /api/exports/preview` takes `{copy_preamble}` and formats a fixed server example without
saving. It uses the same preamble validation and 422 `validation_error` as preference updates.

## Client obligations

Supply the complete unsaved draft and discard results that no longer match its identity,
text or inactive recording state. Retain the exact response string for clipboard/share retries;
text controls can normalize CRLF. Clients provide device permissions, user gestures and manual
copy fallback while preserving editor text and selection. Keep preference drafts on errors;
only explicit reset means follow-default, even when custom text equals the default wording.
Application preferences are persisted by the backend, not solely in browser storage.
