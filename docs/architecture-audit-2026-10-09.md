# Architecture after the settings delivery

Reviewed 2026-10-09 against main
[`91815a7`](https://github.com/VolkerH/der-diktator/commit/91815a7cd752a9b57bcaf04c78d94b169894be23).
This is a source audit and roadmap reconciliation. Its follow-up recording plan
is proposed until reviewed; this documentation changes no runtime behavior.

## Delivered foundation and fit

The current architecture remains appropriate for the personal/family target:
FastAPI services, one SQLite owner, separate inference/model ownership and browser
clients over public APIs. No database replacement, generic event bus, queue or
session framework is warranted by the next recording feature.

PRs [#20](https://github.com/VolkerH/der-diktator/pull/20),
[#21](https://github.com/VolkerH/der-diktator/pull/21) and
[#22](https://github.com/VolkerH/der-diktator/pull/22)
(foundation [#18](https://github.com/VolkerH/der-diktator/issues/18)) delivered the shared
errors, SQLAlchemy/Alembic storage and conditional writes/resource retries.
`storage.py`, `db/`, `chats.py` and `preferences.py` preserve separate API/persistence
models, short transactions, actor-scoped access and preferences. The accepted
ADRs describe both delivered foundation and future gates; acceptance is not a
claim that edit history, authentication or collaboration already exists.

Since the previous roadmap update, PRs
[#29](https://github.com/VolkerH/der-diktator/pull/29),
[#35](https://github.com/VolkerH/der-diktator/pull/35),
[#36](https://github.com/VolkerH/der-diktator/pull/36) and
[#37](https://github.com/VolkerH/der-diktator/pull/37) merged Linux CPU Docker
packaging, strict WAV attachment, persisted keyboard bindings/navigation and the
Settings dialog/read-only web limits. Packaging is not native-host certification;
Docker CI remains manual-only. Sharing is platform handoff, not delivery history.

## Source-backed findings

| Finding                                                                           | Evidence at the reviewed commit                                                                                                                                                                                                                                   | Consequence and owner                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Limits agree only by matching defaults.                                           | `config.Settings` defaults to 600 s, 20,000,044 bytes and 180 s; `from_environment` loads only engine URL/data directory. `inference/server.create_engine` separately constructs `Settings()`. `effective_settings.py` explicitly publishes only web enforcement. | An injected web configuration can differ from engine policy. The settings API is honest about this; it is not an engine agreement protocol. #6/#9 must add validated shared policy and admission/discovery agreement before longer capture.        |
| Capture stops and sample acceptance have separate authorities.                    | `static/app.js` checks elapsed time from a 60 ms UI interval; `recorder.js` silently stops appending after its fixed sample cap and clamps the final join; `recorder-worklet.js` continues posting until a stop message.                                          | A delayed UI timer can leave the microphone/UI active after accepted samples stop; worklet messages may queue while the main thread is throttled. Fix the capture/controller seam in #6, with sample-driven termination and explicit finalization. |
| Retained memory scales with native capture rate and full-length copies.           | `recorder.js` retains Float32 chunks, joins them, and uses `OfflineAudioContext` when the browser cannot create 16 kHz capture. `audio.js` then allocates a PCM WAV.                                                                                              | Current capture is duration-bounded in the main thread, but increasing duration multiplies memory and queued-message risk. Bound retention/conversion before shipping the requested 30-minute default; measure actual peaks. #6 owns this work.    |
| Timeout budgets are independent.                                                  | `config.py` and `static/live.js` use 180 s; `static/request.js` uses 190 s for all requests. Batch engine work uses an owned shielded task.                                                                                                                       | A longer capture does not imply sufficient batch/finalization waiting. #6 needs explicit budgets and truthful recovery; #12 remains responsible for durable observable jobs/queues if introduced.                                                  |
| Live native ownership is weaker than batch ownership.                             | `ModelManager.transcribe` shields its owned task. `ModelManager.stream` unconditionally clears `streaming` when its context exits, including relay timeout/disconnect. Its test checks ownership only within that scope.                                          | There is no acknowledgement proving native work stopped before admission reopens. [#39](https://github.com/VolkerH/der-diktator/issues/39) tracks this existing contract gap. Native overlap has not been reproduced by this audit.                |
| `app.js` coordinates many unrelated flows, but existing modules are useful seams. | Recording start/stop mixes model readiness, insertion, microphone, stream, timing, saving and busy flags. Device capture, transport, models, keyboard and chat requests already have modules.                                                                     | Extract the recording controller when changing #6; do not rewrite the whole client or introduce a framework. Keep editor/draft behavior and resource retries intact.                                                                               |

Preference/default handling is a strength to preserve: `Preferences.etag` hashes
the full resolved representation, updates check it in the SQLite write transaction,
and dialogs preserve conflicting drafts. Recording policy can alter effective
defaults after restart, so its new derived preference fields must participate in
that same validator. A second browser-only preference store would regress this.

## Issue decisions and validation boundary

**Close #18 as delivered.** Current source/tests cover the planned error, storage,
import/recovery, concurrency and draft-protection contracts. Merged PR descriptions
record full `make check` runs and real Chromium record/save/reload/retranscribe on
copied existing data. PR #22's manual run preceded its final follow-up commits;
those commits have targeted automated regressions. This audit does not present
that historical browser evidence as a fresh hardware test.

For this reconciliation, focused tests were rerun for API schemas, SQLite settings
and migrations, data-directory ownership, import recovery, conditional writes and
read-only effective settings. See [PR #40](https://github.com/VolkerH/der-diktator/pull/40)
for the exact result.
The narrow follow-up #39 does not reopen #18's scoped foundation acceptance or
imply that a generic job system was part of it.

**Keep #15 open.** Its remaining gates are recording/retention, observable jobs,
edit/session history and anchored result application, authentication/revocation,
collaboration protocol selection, and later operational settings/packaging. Update
its delivered table and obsolete next-four-slices list to reflect merged main.

**Keep #9 open.** Preamble/sharing/keyboard preferences and safe web limits are
delivered. Recording interval settings join #6 next. Authorized network/path edits,
real configuration-file precedence, coordinated restart and storage relocation
remain undelivered. Do not label startup-only Python defaults as already configurable
through environment or a settings file.

The [recording policy plan](plans/recording-policy.md) defines two reviewable
feature PRs with a safe 600-second intermediate release and an integrated
30-minute interval/warning/extension delivery. A design PR holds these durable
contracts; #39 is the only new independent implementation issue from this audit.
