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
waits for submitted saves to finish, and uses the acknowledged whole-chat validator. Failed
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
with 200 for both creation and a matching retry. Identity compares SHA-256 of the exact WAV
bytes, not normalized samples. The same recording ID and different bytes, including an ID held
by another chat, return 409 `idempotency_conflict` without changing the winning file or chat.
Missing/inaccessible chats return 404 `chat_not_found`. The existing POST upload still chooses
a new recording ID and returns 201.

Both recording upload routes return an explicit `Chat-ETag` header: the whole-chat validator
captured atomically with the upload transaction, or with the matching retry lookup. They do
not send that value in the standard `ETag` header, because the returned body is a Recording.
An upload acknowledges audio storage and the resulting parent version, not text the client
has never read. Clients retain their existing text validator and draft; a later text save must
still conflict if another client changed the text. No full-chat GET is needed after upload.

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
