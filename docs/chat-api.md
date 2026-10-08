# Chat API

## Chat and text validators

`Chat` bodies include `revision` and `text_revision`, initially 1. Every response containing a `Chat`
(`GET /api/chats/{id}`, both create routes, and `PUT /api/chats/{id}/text`) carries a quoted,
opaque whole-chat `ETag` and an additive `Text-ETag`. The existing text PUT still returns a `Chat`;
its `ETag` therefore validates that complete response, while `Text-ETag` is the acknowledged text
validator for the next save. Clients retain header values verbatim, including their quotes.

`GET /api/chats/{id}/text` is the canonical text read: it returns `{text, text_revision}` and its
`ETag` is the text validator. Text PUT checks `If-Match` against this text validator. Chat DELETE
checks it against the whole-chat validator. Validators include resource scope, chat ID and a
persisted creation incarnation, so an old validator cannot match a deleted and recreated chat,
even when its revision number repeats. Weak validators do not match; a list of strong validators
matches if it contains the current one. `If-Match: *` matches any existing accessible resource.

A changed text increments both revisions and `updated`; saving identical text changes neither.
A new recording increments the whole-chat revision and `updated`, leaving text and its validator
unchanged. A retry of an existing create/upload changes no revision or recency field. Membership
changes, when introduced, must increment the whole-chat revision. Reads and rejected writes
change neither representation nor recency. Precondition comparison and commit share the same
serialized mutation. A stale precondition returns 412 `revision_conflict` and writes nothing.

`GET /api/chats` returns an opaque `etag` on each `ChatSummary`, captured from the listed
chat version. This is the whole-chat validator for conditional deletion, including sidebar
entries. Clients send the server value verbatim rather than constructing it from revision
numbers. A stale list entry therefore cannot delete a chat changed since that list was read.

A missing `If-Match` remains accepted for legacy clients with last-writer-wins semantics.

## Client obligations

The browser always supplies the acknowledged validator for saves and deletes. Making
preconditions mandatory is a later rollout decision. On a text-save 412 it stops that chat's autosave,
drops queued saves and retains the editor draft. “Load latest” requires discard confirmation;
“Copy my version” preserves the draft. Navigation after any failed save requires explicit discard
confirmation. Deleting another sidebar chat does not navigate: it must not prompt for, save or
discard the current draft or retained audio. Deleting the current chat suspends new autosaves,
waits for submitted saves to finish, and uses the acknowledged whole-chat validator. A client
acknowledges a whole-chat validator only together with everything it covers: a complete `Chat`
response (whose recordings it shows), or an upload that was the only change (see below). Failed
deletion preserves the draft and retained audio; successful deletion discards them. Closing-page
saves carry `If-Match` and are skipped for conflicted drafts and during current-chat deletion.
Drafts and retained recording buffers are tab-local; closing the tab does not persist unsaved material.

## Create and upload retries

`PUT /api/chats/{id}` accepts a client-chosen lowercase 32-hex ID and no creation options
(no body, `null`, or `{}`); unknown fields return 422. It creates an empty chat with 201, or
returns the accessible existing chat with 200 without resetting later edits. An ID held by an
inaccessible chat returns 409 `idempotency_conflict`. Bodyless `POST /api/chats` still generates
an ID and returns 201. Clients choose an ID once and keep it after a lost response or failed attempt.

`PUT /api/chats/{id}/recordings/{recording_id}` accepts validated PCM WAV with `audio/wav`
(or `audio/x-wav`), using the same limits as the existing POST upload. It returns `Recording`
with 201 on creation and 200 for a matching retry. Identity compares SHA-256 of the exact WAV
bytes, not normalized samples. The same recording ID and different bytes, including an ID held
by another chat, return 409 `idempotency_conflict` without changing the winning file or chat.
Missing/inaccessible chats return 404 `chat_not_found`. The existing POST upload still chooses
a new recording ID and returns 201.

Both recording upload routes return an explicit `Chat-ETag` header: the whole-chat validator
captured atomically with the upload transaction, or with the matching retry lookup. They do
not send that value in the standard `ETag` header, because the returned body is a Recording.
`Chat-Revision` carries the parent `revision` that `Chat-ETag` validates. That version may
include changes made elsewhere, so a client adopts `Chat-ETag` only when `Chat-Revision` is
exactly one more than the revision it last acknowledged, i.e. its own upload was the only
change. Otherwise it keeps its previous chat validator, and a later conditional delete returns
412 instead of removing changes the client never saw. Clients retain their existing text
validator and draft; a later text save must still conflict if another client changed the text.
No full-chat GET is needed after upload.

Legacy recording IDs are discoverable in `GET /api/chats/{id}` and can be reused in PUT retries;
recovery of nullable hashes does not depend on accidental random-ID collisions.

The service serializes lookup, file finalization, row commit and cleanup with deletion/recreation.
Incoming validation and hashing run before the mutation lock; file I/O does not hold a database
transaction. Existing legacy recording rows have a nullable hash: a retry computes and persists
the original file's hash, then compares it. If that original audio is missing or unreadable,
the retry returns 404 `recording_not_found` and preserves its unknown identity. Restoring the
original file allows a subsequent retry. A crash before commit may leave an unreferenced WAV;
retry overwrites it durably before inserting the row, or startup sweeping removes it. After
commit, retry returns the stored row. Parallel requests produce one resource and retain the
winner's bytes.

There is no tombstone for chosen IDs: a chat ID can create a new incarnation after deletion.
A recording ID can be reused once its owning chat and recording row have been deleted. Retry
responses report current resource state rather than a historical response. There is no generic
`Idempotency-Key` ledger; transcription/share commands retain their own future recovery contract.

## Shared chat names

Every `Chat` and `ChatSummary` includes canonical `title` and nullable
`custom_title`. Python owns automatic naming: normalize transcript whitespace,
use its first 48 Unicode code points with the existing word-boundary ellipsis,
or `New chat` for empty text. Custom names take precedence through subsequent
text edits, recording uploads and retranscriptions. Titles are shared among
chat members. Old SQLite/legacy-imported chats start with `custom_title: null`.

`Chat` also includes `title_revision`, initially 1. Every complete-chat response
now carries `Title-ETag`, alongside its existing whole-chat and text validators.
`GET /api/chats/{id}/title` returns `{title, custom_title, title_revision}` with
that title validator in `ETag`. An additive `Chat-Revision` header reports the
parent snapshot revision so clients can order title observations from this read
and complete-chat responses. This ordering value does not acknowledge the full
chat or refresh a text/deletion validator. The strong scoped validator covers exactly those
fields, plus resource scope and creation incarnation. An automatic name change
invalidates it; transcript edits under a custom name and recording uploads do
not. The persisted metadata revision advances only when the override changes.

`PUT /api/chats/{id}/title` requires `{"custom_title": "My notes"}` or
`{"custom_title": null}` to restore automatic naming. Missing fields, wrong
types and unknown fields return 422 `validation_error`. Strings are trimmed and
must contain 1–120 Unicode code points. Controls, surrogate characters and line
separators (including at the edges) return 422 `invalid_title`; ordinary Unicode,
emoji and literal markup are accepted. Invalid requests mutate nothing.

Title PUT checks optional `If-Match` against the **title** validator, atomically
with the mutation. Strong lists and `*` follow the existing precondition rules;
stale/weak/wrong-scope values return 412 `revision_conflict`. Omission retains
legacy unconditional semantics. Missing/inaccessible chats return the same 404
`chat_not_found`. A database write failure returns 500 `storage_error`, rolls
back the mutation and exposes no internal diagnostics. A successful request
returns a complete `Chat` with all three validators. Changed overrides advance
whole-chat/title revisions and `updated`, preserving `text_revision`, text and
recordings. An identical normalized override changes nothing. After a lost
response, read the title and compare before retrying against its current validator.

The browser displays acknowledged server titles while transcript autosaves are
pending. Its labelled dialog supports Enter to save, Escape/Cancel to close and
“Use automatic name” to reset. Cancelling an unpersisted chat creates nothing;
a nonempty rename creates it lazily. Rename waits for queued text saves, captures
the target/navigation version, and preserves newer editor drafts and retained
audio. A conflict keeps the entered name, reads current title metadata and
requires an explicit second save. Metadata responses never refresh a stale text
validator. The browser adopts a whole-chat validator from a title response only
if that response's text version was already acknowledged; otherwise unseen text
continues to block conditional deletion. Late responses cannot replace a newer
acknowledged title or a different open chat.

Clients track the newest parent revision from which they observed title metadata
independently of the complete-chat revision they acknowledged for deletion. This
includes metadata-only conflict reads. A newer title response may contain text
still awaiting acknowledgment; a delayed older autosave response must then keep
the newer title, override and title validator while acknowledging its own text.
