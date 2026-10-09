# Recording policy and interval delivery (#6 / #9)

Status: **Proposed implementation plan**, reviewed against main `91815a7` on
2026-10-09. This document adds no recording capability. The existing browser and
both services still default to 600 seconds. See the
[architecture audit](../architecture-audit-2026-10-09.md) for source evidence.

## Delivery and scope

Use **two feature PRs**, with the second based on the first:

1. **Shared recording policy and live ownership.** Add validated startup policy,
   engine discovery and agreement checks, safe public discovery, typed limits and
   compatible timeout plumbing; fix [#39](https://github.com/VolkerH/der-diktator/issues/39).
   Keep the shipped ceiling and browser interval at **600 seconds** in this PR.
   Do not expose an editable recording interval or claim longer capture support.
   This independently useful intermediate release detects configuration disagreement
   and preserves native ownership. It references #6/#9 and can close #39 if all
   its teardown cases are resolved.
2. **Recording intervals in Settings and bounded capture with warnings/extensions.**
   Deliver the preference, effective snapshot, recorder changes, Settings field,
   countdown/beep and extension control together. The requested default is
   **1800 seconds**; enable it only in this complete path. Target an initial hard
   ceiling of **3600 seconds**, validated to permit one full default extension.
   A 7200-second ceiling remains a candidate requiring resource measurements, not an
   accepted supported limit. This PR may close #6 when its acceptance is met;
   it leaves operator editing, restart orchestration and relocation in #9 open.

Do not make all of #9, #12 jobs, #5 no-retention sessions, or collaboration a
prerequisite. Existing capture retains audio for upload and fallback; this work
must not introduce a no-retention claim. Preserve that future seam without
building its persistence/history protocol now. Keep Docker CI manual-only;
policy tests do not require rebuilding an image or downloading models.

## Policy owner and discovery

Define one immutable validated Python recording-policy type, used by the web
application and engine at startup. It owns the hard duration ceiling, WAV byte
budget, stream frame budget and batch/finalization timeout budgets. Derive the
PCM body allowance from `hard_limit_seconds * 16000 * 2`; add a fixed default
WAV-container allowance of **800,044 bytes**, including the usual 44-byte header
and bounded metadata. This allowance does not scale with duration: the default
600-second policy must yield exactly today's **20,000,044-byte** budget, so
already accepted WAVs with metadata do not become invalid. Document any supported
allowance override and its bounds. The separate duration check remains authoritative.
Reject invalid/nonfinite values and incompatible budgets at startup. Keep the
hard ceiling an integer multiple of 60, at least 60 seconds.

Use explicit environment overrides plus defaults for this narrow policy first,
with any implemented CLI override taking precedence over environment. Document
only configuration sources actually supported; a generic configuration file and
operator settings editor are later #9 work. Both service entrypoints must load
the same inputs, including container/subprocess startup. Injection in tests must
use the same validation. The engine owns enforcement for inference and the web
owns upload/storage enforcement; sharing a class alone does not prove agreement.

Add typed engine policy discovery and have the web compare enforcement-relevant
values/revision before accepting new inference. The web sends its agreed revision
with every internal batch admission (`X-Recording-Policy-Revision`) and live
admission (`policy_revision` in the internal URL). The engine validates this
precondition atomically before reserving native work, rejecting a stale revision
with `configuration_mismatch`, including a restart between discovery and admission.
Add a safe public recording snapshot, preferably `GET /api/recording-policy`, containing:

- a protocol version and agreed policy revision, hard ceiling, byte/frame budgets;
- request/upload and live-finalization budgets with units and clear meanings,
  plus backend-derived `client_deadlines_ms` for upload, batch and live waiting;
- in PR 2, requested/default/effective interval and whether it was constrained,
  plus backend-defined `extension_seconds` and `warning_lead_seconds` (60 seconds);
- the preference validator identifying the preference snapshot used, without
  creating a preference row or reserving the model.

The web builds this response from one preference read and the effective agreed
policy. Do not repurpose `/api/settings.policy_revision`: it currently hashes
only a web settings display. Keep that endpoint compatible with additive fields:
publish engine-independent `upload_timeout_seconds`,
`client_timeout_margin_seconds` and backend-derived `client_upload_timeout_ms`
there, so audio-save clients can discover their budgets even if engine discovery
fails. Its display revision covers these added fields but does not attest engine
agreement. Document this relationship to the new agreement revision. Expose no
addresses, paths or secrets.
Model selection stays in the model API; policy discovery is not a model reservation
or a guarantee that a selected model is still ready when capture begins.

Discovery failure or disagreement prevents the new browser from starting capture.
Register a stable `configuration_mismatch` error (503) in the shared engine/web
error registry and as a live terminal-event `code`. Document its recovery:
the operator must restart both services with matching policy; clients must not
retry automatically. Distinguish it from an unreachable engine. Enforce agreement
at inference admission as well as discovery, so other web API clients cannot
bypass it. Legacy direct engine clients without the optional revision precondition
remain subject to current hard limits. A missing/old engine policy capability fails
closed for coordinated recording; it must never be interpreted as a long-duration
capability. Keep existing short upload/playback/export access usable where no engine
is required. Existing clients without a snapshot remain subject to server hard
limits; they gain no extension/default guarantees. Additive HTTP fields/endpoints
must not change existing PCM configuration or terminal event meanings.

Do not promise that a snapshot survives a service restart. A disconnect is failure,
not completion; retained audio stays available for recovery. Revalidate batch or
stored-recording inference against the current policy and give a clear rejection
if the operator reduced limits since capture. Never silently truncate accepted
input. External clients may send a policy revision for diagnostic/precondition
checks; the required internal admission precondition still applies. A revision is
not authentication, retention permission or an idempotency key.

## Interval preferences and frozen capture

Use the existing SQLite preferences service and migration mechanism. Omission of
`recording_interval_seconds` leaves it unchanged; explicit reset restores following
the backend default, and null is invalid. Accept integer seconds, multiples of 60,
from 60 up to the current operator ceiling. Use the existing required `If-Match`,
428/412 errors and atomic preference updates. A numeric revision alone is
insufficient: the strong preference ETag must also cover effective defaults and policy-derived
fields, as it already covers keyboard and preamble defaults.

The effective default is `min(1800, hard_limit_seconds)`. For a saved request,
the effective interval is `min(requested_recording_interval_seconds, hard_limit_seconds)`.
Preserve that saved request when a later restart lowers the ceiling; expose both
requested and constrained effective values and the reason. New invalid explicit
writes are rejected, not silently clamped. The Settings dialog must show the
effective next-recording interval and any constraint. Reads do not rewrite stored preferences, and a
policy/default change must invalidate an old preference validator. A default of
1800 is a shipped product default only once PR 2's complete path is validated.

Before opening the microphone, fetch the agreed snapshot. Freeze it for this
recording, including original effective interval, extension amount, warning lead,
ceiling, model selection and budgets; a subsequent settings save affects the next
recording. Start timing at actual capture start. The original interval is the
constrained effective value,
`min(requested or default, hard_limit_seconds)`, rather than an unconstrained saved
request. For example, a saved request of 2400 seconds under an 1800-second ceiling
freezes an 1800-second interval and extension amount. The backend publishes that
same effective value as `extension_seconds`; each extension adds exactly this
frozen amount to the current deadline. If that whole interval would put the
deadline above the frozen ceiling, disable extension and explain why. Do not
shorten an advertised extension.

The cooperative interval belongs to client capture; server enforcement remains
sample/byte based at the hard ceiling. The typed snapshot publishes every rule
input a client needs: effective interval, extension amount, warning lead and
ceiling. The feature API document must list client obligations: freeze these
inputs at capture start, apply the published extension only when the whole amount
fits within the frozen ceiling, warn once per deadline using the published lead,
re-arm on extension, and stop/finalize once at the deadline or sample cap. Clients
retain capture buffers through finalization and preserve recovery audio after
failure. A TUI can use the same discovery and preference APIs with arithmetic and
its own device/presentation handling, without copying application constants.
No server session registry or WebSocket extension command is necessary for a local
soft deadline.

## Capture, warnings and memory

Extract the recording lifecycle/controller from `app.js` as it is changed. It
owns idle/starting/recording/stopping/finalizing transitions, the frozen policy,
mutable deadline, once-only stop and warnings. Keep DOM rendering and editor
selection in the browser; do not move client device state into Python. Keep upload
identity, conditional saves and draft preservation on their existing paths.

Enforce accepted samples at the capture boundary, with the worklet participating
in the budget and stopping when it is exhausted. A main-thread timer alone does
not bound queued worklet messages in a throttled tab. Reconcile extensions and
stop acknowledgements, preserve the permitted tail, and finalize exactly once
even if Stop, a deadline and a late extension arrive together. Presentation uses
a monotonic clock reconciled with captured samples. Browser suspension cannot
promise a timely beep, but must not silently drop capture while showing an
unqualified continuing-recording state once execution resumes.

Warn visibly and accessibly at the snapshot's `warning_lead_seconds` remaining
(backend value: 60 seconds), including immediately for a one-minute interval.
Initialize beep capability through the recording gesture,
warn once per deadline, and re-arm on extension. Keep the warning when sound is
muted/suspended. Announce automatic stopping and finalization explicitly.

Bound retained capture independently of the microphone's native sample rate.
Prefer incremental mono resampling/PCM16 retention with bounded conversion
chunks; preserve suitable Float32 frames only where live transport requires them.
Avoid full-duration native-rate Float32 chunks plus join plus OfflineAudioContext
copies. Validate resampling continuity and duration rather than assuming browser
support for a requested 16 kHz context. Release chunks/queues on every exit path.

For scale, 1800 seconds is 57.6 MB PCM16 or 115.2 MB Float32 at 16 kHz; at 48 kHz
native Float32 retention alone is 345.6 MB. These are byte counts, not measured
peak memory. Joining, browser audio buffers, encoding and server/model copies add
to the total. Measure peak memory for the chosen default and ceiling on target
browsers, including native-rate fallback, and bound pending transport/worker
queues. Synthetic tests establish bounds and correctness; they do not certify
mobile microphone behavior or real-model latency. Accelerated synthetic
full-duration browser capture is suitable for measuring the retained-buffer and
conversion budget at 1800/3600 seconds; label it as synthetic and record the
browser/sample rate. Real-time microphone, mobile and model-performance acceptance
remain separately reported evidence, not an open-ended prerequisite for delivering
and reviewing bounded software behavior.

## Timeouts, native work and retries

Replace unrelated 180/190-second browser/web assumptions with documented budgets
from policy. Distinguish capture duration, upload deadline, batch response wait and
post-end live finalization. Browser waiting should leave room for an authoritative
server failure before its own timeout. The backend derives the client deadlines
from these budgets; clients use the published millisecond values rather than
duplicating timeout formulas. An increased wait budget is not a claim
that all models finish long speech within it; record real-model timing separately.

Fix #39 before advertising longer sessions: normal `done` can release the stream
reservation; abnormal teardown must retain it until native completion or confirmed
stop/reap. Cleanup itself must survive cancellation of its requester. Report the
resulting model state honestly. The batch path already shields its native task;
preserve that ownership and never release resources merely because HTTP timed out.

A limit error requires changed input/policy, not an unchanged automatic retry.
Keep captured WAV/upload IDs for the current retained mode, honor existing resource
PUT deduplication, and distinguish saving audio from starting inference. A timeout
can leave transcription running; a recovery attempt can receive `model_busy`.
This feature does not promise exactly-once inference or replayable job results.

## Validation required in the feature PRs

- Browser-free API tests: defaults/reset/constraints, policy-sensitive preference
  ETags, concurrent writes, both process configurations, old/missing/mismatched
  engine capability, no secret disclosure, inference admission and current-policy
  retranscription of older clips. Update OpenAPI and event/error documentation.
- Duration/body/frame tests immediately below/at/above boundaries on both services,
  including accumulated live frames, WAV metadata allowance and retained uploads.
- Resource tests: native work survives transport loss, cleanup cancellation,
  model mutation blocked while uncertain, normal done reuses the model, shutdown.
- Separate worklet/recorder/controller tests: native-rate conversion, exact sample
  cap/tail, throttled main thread, bounded queues, one-minute warning, repeated
  extension/re-arm, whole-interval refusal, mid-recording preference changes,
  start failure, stop/extension races, existing failed-upload recovery.
- Full `make check` for each feature PR; real-browser warning/extension/Settings
  screenshots and short recording for the interface PR. Publish actual resource
  measurements and real-model timing with target/browser details and limitations.
  Do not claim hardware acceptance or a 7200-second ceiling from fake audio alone.
