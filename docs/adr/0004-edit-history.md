# 0004. Current transcript plus append-only edit history

Status: Accepted (2026-10-08)

Discussion: [#15](https://github.com/VolkerH/der-diktator/issues/15) —
[collaboration follow-up](https://github.com/VolkerH/der-diktator/issues/15#issuecomment-6060764920),
[review of the reviews §2, §4](https://github.com/VolkerH/der-diktator/issues/15#issuecomment-6061024479),
[accepted corrections and no-audio sessions](https://github.com/VolkerH/der-diktator/issues/15#issuecomment-6061509440);
[PR review refining session history](https://github.com/VolkerH/der-diktator/pull/17#issuecomment-6061964903);
[#5](https://github.com/VolkerH/der-diktator/issues/5),
[#16](https://github.com/VolkerH/der-diktator/issues/16).

## Context

The browser saves the complete transcript after a short debounce. The server can calculate a diff
between snapshots, but cannot recover the original sequence of editing operations or their intent.
#16 wants a timeline of recordings, edits and retranscriptions, and later shared editing.
#5 wants dictation without stored audio; its privacy concern is the voice (biometric data), not
the transcript.

## Decision

- Each chat has a **materialized current transcript** plus an **append-only application edit
  history**, both updated atomically by one service. Search, export and titles read the current
  transcript. Database journaling is not the edit history.
- History records accepted, coalesced edit batches and dictation sessions with a server-derived
  actor, unique operation IDs, and versioned payloads.
- **Document revision**, **chat event sequence**, and **metadata revisions** are separate
  counters. A title change or a recording is not a text operation.
- Imported chats start with a **baseline snapshot**; earlier edits cannot be reconstructed.
- **Generating** a transcription or correction is separate from **applying** it. Applying is an
  idempotent document edit with a base revision and an anchor, rechecking membership and target
  when it happens. #7's preview/accept flow stays. Provenance stores the source revision and
  range; how anchors move after later edits is specified with the protocol
  ([0005](0005-collaborative-editing-protocol.md)).
- **Restoring** an earlier version appends a new edit; history is never rewritten.
- **Dictation without stored audio (#5)** always has one logical **dictation-session history entry**
  identified by a stable session ID, carrying duration, `audio_retention: "not_stored"`, model and
  outcome. Successful, empty and interrupted sessions use the same structure. Clients render one
  "Audio not saved" pill per session in the chat and timeline. There is no recording row, recording
  ID, audio file, playback or retranscription. Retained audio keeps its recording entry.
- Zero or more text edits link to that session; each accepted edit has its own operation ID. Session
  finalization and edit application are independently deduplicated, so retries neither add pills nor
  insert text twice. Session metadata alone does not advance the document revision. #5 specifies
  checkpoints/finalization and their history representation, preserves confirmed text on
  interruption, and distinguishes an interrupted or unknown outcome from successful completion.
  Multiple lifecycle events, if needed, project to the same logical session entry.

## Consequences

- #5 needs no recording row. Session metadata has one representation regardless of text output;
  it is not duplicated on each text edit. This replaces the earlier proposal to attach it directly
  to the inserting edit.
- History keeps text later deleted from the current transcript. Before history is shown to other
  members, #16 defines what new members and viewers can see, how history is purged, and how chat
  deletion and exports treat it. Append-only during editing does not mean impossible to purge.
- History data can inform later correction learning (#7), which remains separate work.
