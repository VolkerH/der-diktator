# 0004. Current transcript plus append-only edit history

Status: Accepted (2026-10-08)

Discussion: [#15](https://github.com/VolkerH/der-diktator/issues/15) —
[collaboration follow-up](https://github.com/VolkerH/der-diktator/issues/15#issuecomment-6060764920),
[review of the reviews §2, §4](https://github.com/VolkerH/der-diktator/issues/15#issuecomment-6061024479),
[accepted corrections and no-audio sessions](https://github.com/VolkerH/der-diktator/issues/15#issuecomment-6061509440);
[#5](https://github.com/VolkerH/der-diktator/issues/5),
[#16](https://github.com/VolkerH/der-diktator/issues/16).

## Context

The browser saves the complete transcript after a short debounce, so the server cannot tell what
changed. #16 wants a timeline of recordings, edits and retranscriptions, and later shared editing.
#5 wants dictation without stored audio; its privacy concern is the voice (biometric data), not
the transcript.

## Decision

- Each chat has a **materialized current transcript** plus an **append-only application edit
  history**, both updated atomically by one service. Search, export and titles read the current
  transcript. Database journaling is not the edit history.
- History entries record accepted, coalesced edit batches with a server-derived actor, a unique
  operation ID, and versioned payloads.
- **Document revision**, **chat event sequence**, and **metadata revisions** are separate
  counters. A title change or a recording is not a text operation.
- Imported chats start with a **baseline snapshot**; earlier edits cannot be reconstructed.
- **Generating** a transcription or correction is separate from **applying** it. Applying is an
  idempotent document edit with a base revision and an anchor, rechecking membership and target
  when it happens. #7's preview/accept flow stays. Provenance stores the source revision and
  range; how anchors move after later edits is specified with the protocol
  ([0005](0005-collaborative-editing-protocol.md)).
- **Restoring** an earlier version appends a new edit; history is never rewritten.
- **Dictation without stored audio (#5)** is recorded as an ordinary text edit inserting the
  transcript. The edit carries optional session metadata
  `{duration_seconds, audio_retention: "not_stored", model}` and has no recording ID, audio file,
  playback or retranscription. Clients render that metadata as #5's "Audio not saved" pill, in the
  chat and in the timeline. Recordings with retained audio keep their own recording entry. #5's
  session-ID and idempotency rules apply to the edit, so a retry cannot insert text twice.

## Consequences

- #5 needs no separate metadata-only recording entry.
- History keeps text later deleted from the current transcript. Before history is shown to other
  members, #16 defines what new members and viewers can see, how history is purged, and how chat
  deletion and exports treat it. Append-only during editing does not mean impossible to purge.
- History data can inform later correction learning (#7), which remains separate work.
