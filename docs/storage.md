# Storage API behavior

The SQLite foundation retains the existing HTTP routes and `Chat`, `ChatSummary`
and `Recording` JSON shapes. The backend supplies the seeded local actor through
an internal dependency; requests cannot choose an actor. Every chat-scoped read
or mutation checks membership. Creator metadata does not grant access, and
missing and inaccessible chats share `chat_not_found` responses.

Creation sets `created` and `updated` to the same UTC timestamp. Every successful
text replacement and recording upload advances `updated`; reading and listing
chats do not. Lists sort by `updated` descending, with chat ID as the tie breaker.
Recordings sort by creation time and ID. Legacy import preserves the original
creation and update instants and the import-time transcript independently of a
chat's later deletion.

Recording metadata is committed after the WAV is durably finalized. A failed
commit rolls back the row and attempts to remove the new file. Chat deletion
commits before folder cleanup; cleanup failures are logged. Startup reconciles abandoned files in folders known
to the database or durable import ledger. Unknown folders and their temporary
files are retained for recovery; a failed deletion of a new chat leaves unknown
leftovers until an operator resolves them. A recording row with unavailable audio returns
`recording_not_found`, and restoring its original WAV requires no API change.
Database sessions and blocking file work execute outside the event loop.

This foundation preserves the existing last-writer-wins text replacement and
server-generated POST IDs. Conditional writes and retry-safe client IDs are a
separate rollout; clients should not assume those guarantees are available yet.


Audio references store paths relative to the data root, in the authorized chat's
folder with a hexadecimal filename and `.wav` suffix. Playback uses the stored
path and rejects absolute paths, traversal and symlinks. The storage layout is
independent of the actor. Missing audio does not remove metadata.

For directory ownership, migration, backup and retention operations, see the
[README](../README.md#storage-and-migration).
