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

Keyboard mappings and the action/default catalog use this same profile, revision and
conditional-write contract; see [keyboard API](keyboard-api.md).

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

## Recording intervals

`recording_interval_seconds` is a shared profile preference for the next
recording, stored as a nullable requested value in SQLite. The product default
is 1800 seconds. A PATCH must use an integer multiple of 60 between 60 and the
current operator ceiling, inclusive. Strings, booleans, fractional values and
null are invalid. Omitting the field preserves it; `reset: ["recording_interval_seconds"]`
resumes following the backend default. Setting and resetting together is invalid.
The existing required `If-Match` and atomic 428/412 behavior apply.

The response separates `requested_recording_interval_seconds` from effective
`recording_interval_seconds`. The latter is the lesser of the requested value
(or product default) and the current operator ceiling. It includes
`default_recording_interval_seconds`, `effective_default_recording_interval_seconds`,
`recording_interval_is_default`,
`recording_interval_constrained`, `recording_interval_constraint_reason`, and
`min_recording_interval_seconds`, `max_recording_interval_seconds`,
`recording_interval_step_seconds`. A constraint reason is null when unconstrained.

Reducing the operator ceiling never rewrites a saved requested interval. The
shorter effective value and reason are visible; raising the ceiling can restore
the saved interval. A new explicit write above the ceiling returns 422
`invalid_recording_interval` and changes nothing. Unrelated preference updates
still work while the saved interval is constrained. Reads create no preference
row. The strong ETag includes these derived fields and defaults, so policy or
product-default changes invalidate prior validators even without a row revision
change.

Read the agreed recording policy before opening the microphone and freeze the
returned interval and limits for that capture. A saved preference affects the
next recording. Settings must preserve dirty drafts on conflict and show any
operator constraint; saving an unrelated preference must not silently replace
a constrained requested interval with its displayed effective value.

The effective default is resolved by the backend under the current operator ceiling,
including when a custom interval is selected. Use default previews this published
value and resets the stored override. The complete preference ETag covers this
field, so changes to the product default or ceiling invalidate old validators.
An empty interval input uses required-field inline validation before any PATCH.
