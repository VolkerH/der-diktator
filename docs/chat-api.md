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

`PUT /api/chats/{id}` accepts a client-chosen lowercase 32-hex ID and an optional
`{"group_id": "32-hex-id"}` body. No body, `null`, `{}` or null group defaults to Unsorted;
unknown fields return 422. A new ID requires an actor-owned destination and returns 201.
An accessible existing ID returns the current shared Chat with 200, ignoring creation
options and preserving edits and private moves. An inaccessible ID returns 409
`idempotency_conflict`; a missing destination for a new ID returns 404 `group_not_found`.
`POST /api/chats` accepts the same body, generates an ID and returns 201. Retain the
chosen ID after a lost response; current placement is an independent subresource.
Failed database creation
returns 500 `storage_error` and rolls back the chat and initial membership together.

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

`Chat` and `ChatSummary` include the server's effective `title` and nullable
`custom_title`. Automatic names use the transcript's first 48 Unicode code
points with whitespace normalization and word-boundary truncation, or `New chat`
for empty text. A custom title persists through text and recording changes and
is shared among members. Existing chats start with no override.

`GET /api/chats/{id}/title` returns `{custom_title, title_revision}` and `ETag`.
The revision starts at 1 and advances only when the override changes. The same
validator appears as `Title-ETag` on complete-chat responses. Transcript edits
and recording uploads do not invalidate it. Read a complete `Chat` for its
effective title.

`PUT /api/chats/{id}/title` accepts `{"custom_title": "My notes"}` or
`{"custom_title": null}` to restore automatic naming. Strings are trimmed and
must contain 1–120 Unicode code points with at least one visible character.
Controls, surrogates, line separators and bidi embedding/override/isolate controls
return 422 `invalid_title`; emoji joiners and ordinary Unicode are accepted.
Missing, mistyped or unknown fields return 422 `validation_error`.

Optional `If-Match` checks the title validator atomically. Strong lists and `*`
follow the shared precondition rules; stale, weak or wrong-scope tokens return
412 `revision_conflict`. Omission permits unconditional writes. Missing or
inaccessible chats return 404 `chat_not_found`. Success returns a complete `Chat`
with all scoped validators. Changed overrides advance whole-chat/title revisions
and recency, preserving text, text revision and recordings. No-op updates change
nothing. After a lost response, read and compare before retrying.

Clients must preserve drafts and retained audio when applying metadata responses,
ignore older observations, and refresh text/deletion validators only when the
corresponding content has been acknowledged. The browser keeps entered names on
conflict and requires an explicit retry.

## Search accessible chats

`GET /api/chats?q=meeting` filters the ordinary typed `list[ChatSummary]` over the
actor's accessible SQLite chats. Matching reads the full current transcript and
any custom name; derived names and the “New chat” placeholder are not searched. Names and opaque summary validators are returned
unchanged. The response keeps `updated` descending and chat ID ascending on
ties; search does not rank, alter recency or mutate a chat. Omitted `q`, empty
strings, whitespace and queries containing no letter/number tokens return the
ordinary unfiltered list. No separate index or browser matcher is used.

The deterministic backend rules are:

- Apply Unicode NFKC normalization and case folding. Letters and numbers form
  tokens, keeping attached combining marks; whitespace, punctuation and
  underscores separate them. Distinct normalized query terms use OR semantics.
- A query term matches an exact transcript/custom-name token or the beginning of a
  token. For example, `meet` matches `meeting`.
- Query terms of at least four normalized code points also allow one insertion,
  deletion, substitution or adjacent transposition against a complete token.
  `meting`, `meetting`, `metting` and `meeitng` match `meeting`; `metign` does not.
  Shorter terms use exact/prefix matching. `STRASSE` matches `Straße` after
  normalization; `für` does not match `fur`. Queries are never regular expressions.

Raw queries accept up to 256 Unicode code points, before normalization, and up
to 16 distinct normalized terms. Repeated/case-equivalent words count once.
Violations return 422 `invalid_search_query` with the shared string-detail
error envelope, without silently truncating. SQLite failures return 500
`storage_error`, preserving the distinction from a successful empty result.
Existing unreadable legacy folders remain startup-import recovery material and
are not searchable until imported; SQLite search does not scan those folders.

Search is read-only and retryable. Cancellation/disconnection changes no state.
Each response reads a consistent SQLite snapshot; subsequent requests see newly
committed saves, renames and deletions. Large archives require scanning their
current transcripts, so latency grows with their size. Matching runs in the
list route's worker thread, outside the event loop.

The browser debounces input for 200 ms, immediately invalidates earlier
responses, and clears with a fresh ordinary list request. Loading and failed
requests hide results from different queries. Refreshes for the same query keep
existing rows visible, including on failure. Transient errors offer Retry; query
validation errors ask the user to shorten the query. Startup failures also show a
banner outside the mobile drawer. Retry opens the latest chat only while the
initial blank editor is untouched. Filtering never navigates or saves the editor, changes
its selection, or stops recording. An open chat remains open if its row is
excluded. Persisted mutations refresh the active query, and filtered results
never inject an unmatched local new-chat row. Unsaved draft words become
searchable after autosave succeeds. Search text is tab-local display state.

## Private groups and placement

`GET /api/groups` lists the current actor's groups by creation time, then ID. Each group
is `{id, name, created, revision, etag}`; individual reads and writes also return its
quoted `ETag` header. Groups belong to one actor. Missing and inaccessible groups both
return 404 `group_not_found`. Duplicate names are valid. Names are trimmed and must
contain 1–80 Unicode code points, with controls, surrogates and line separators rejected
before trimming (422 `invalid_group_name`). Missing/wrong/unknown fields use 422
`validation_error`. Names and placement never become storage paths.

`POST /api/groups` with `{"name": "Project"}` chooses an ID and returns 201.
`PUT /api/groups/{id}` creates with a lowercase 32-hex client ID. An existing own ID
returns the current group with 200, ignoring the supplied name and preserving renames.
An ID owned by another actor returns 409 `idempotency_conflict` without exposing metadata.
Reuse the same ID after an unknown creation outcome. Deleted IDs may create a fresh
incarnation with new validators; no tombstones or original inputs are stored.

`GET /api/groups/{id}` reads a group. `PUT /api/groups/{id}/name` takes the same name
body and checks optional `If-Match` against the group validator. Changed names increment
only the group's revision; identical names are no-ops. `DELETE /api/groups/{id}` checks
the same validator and returns 204. It atomically clears that actor's placements to
Unsorted and increments each affected placement revision before deleting the group.
It keeps chat IDs, text, shared titles, recordings, file locations, revisions and recency
unchanged. Repeated deletion returns the same scoped 404 as a missing group. Unsorted
is implicit `null`, has no group resource, and cannot be renamed/deleted. SQLite write
transactions serialize lifecycle and placement changes; cleanup is never deferred.

`GET /api/chats/{id}/group` returns `{chat_id, group_id, placement_revision, etag}` and
its own quoted `ETag`. `PUT` requires `{"group_id": "32-hex-id"}` or
`{"group_id": null}`. It requires chat membership and ownership of the destination.
Missing/inaccessible chats return 404 `chat_not_found`; missing/inaccessible targets
return 404 `group_not_found`. Optional `If-Match` checks this **placement** validator,
scoped to actor and chat incarnation. A changed destination increments only the private
placement revision; identical placement changes nothing. Group rename does not change
placement. Weak/stale or wrong-scope validators return 412 `revision_conflict`; strong
lists and `*` follow the existing rules. Missing headers retain serialized unconditional
writes. Group storage failures return 500 `storage_error`, never successful empty
registries or reset placement. Transactions roll back all affected rows on failure.

A `ChatSummary` adds actor-private `group_id` and `placement_etag`; its existing `etag`
still validates the shared **Chat**, for deletion. Shared `Chat` JSON deliberately omits
placement, keeping Chat/Text/Title/upload validators independent of private filing.
Two members can file the same chat differently. After a move, clients update only
placement metadata and never acknowledge unseen shared text/title/audio. Search spans
all accessible chats, independent of group, and keeps existing global recency order;
clients group those summaries for display without reimplementing the matcher.

The browser stores only fold state locally by stable group ID, tolerating unavailable
storage. Search temporarily expands matching groups without changing saved folds or
editor selection. Because chat/group lists are separate snapshots, a listed chat whose
group is not yet in the observed registry remains visible under a temporary “Unavailable
group” label until refresh; this never changes its stored placement. Global New chat starts in Unsorted; a group's New chat selects that
pending destination and remains lazy until saving text/audio or a title. Keep the chosen
chat ID across retries; an existing ID ignores creation options. After an
ambiguous write, refetch and compare before an explicit retry. If a draft's destination
was deleted, `group_not_found` proves the chosen chat ID is absent, so offer a fresh
Unsorted identity directly. Preserve its text/audio while resolving the error.

Group moves preserve unsaved or conflicted editor text. Search, autosave and uploads reuse the last group
registry; a registry load failure keeps accessible chats visible with their last known labels.

### External WAV attachments

The browser's **Attach WAV recording** paperclip opens the file picker; dropping
one file into the chat uses the same upload path. Multiple-file drops are rejected
without uploading, ordinary text drags remain native, and dropping files outside
the chat cannot navigate away from a draft. Both attachment methods send unchanged bytes to the
existing recording PUT endpoint with `Content-Type: audio/wav`. Browsers may
report another MIME type or none; the server validates the bytes. The accepted
format is 16 kHz mono signed 16-bit PCM WAV, within the operator's configured
byte and duration limits (defaults: 116,000,044 bytes and 3600 seconds). There is no
conversion, resampling, stereo downmixing, or compressed-audio support.

Uploading attaches a clip without modifying text or requiring a ready model.
Transcription is a separate explicit clip action that uses the existing selected
model and cursor/selection insertion behavior. Clients choose the recording ID
before upload and retain it across retries of an ambiguous response. The browser
locks editor and chat navigation while requests run. A retryable failed attachment
stays in a tab-local unsaved pill, whose action retries storage only; leaving the
chat or closing the tab can discard it. Validation failures (`invalid_audio`,
`unsupported_audio`, `audio_too_large`) show the server's feedback and require a
replacement file. Failed transcription leaves the saved clip available to retry.
