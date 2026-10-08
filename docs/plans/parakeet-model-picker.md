# Parakeet v3 and model management

## Goal and scope

Add Parakeet TDT 0.6B v3 INT8 as a CPU option for German, English, and the
other supported European languages. Keep Phonon-2 and its working live mode.
Let the user choose a model, explicitly download missing weights, and see
installation/loading/error states in the browser. Store weights in
`platformdirs.user_data_path("diktator") / "models"`; allow
`DIKTATOR_MODELS_DIR` override independently of the existing chat directory.
Persist the successfully selected model under the models directory.

Parakeet initially supports recording followed by transcription, including
retranscription of stored recordings. Its offline recognizer does not provide
Phonon's live protocol. The UI advertises this capability and disables live text
for Parakeet; it restores the user's live preference on return to Phonon.
Mixed German/English accuracy and CPU latency require representative recordings.

Worktree: `/tmp/diktator-parakeet`; branch: `feat/parakeet-model-picker`.
Base: `7a518f9`. Primary checkout stays unchanged, including its untracked engine lock.

## Architecture

1. Keep the lightweight web environment separate from the inference environment.
   Add an app-owned engine service in the inference environment on port 8010.
   The engine owns model installation, loading, and inference. The browser calls
   web `/api/models` endpoints, which proxy typed requests to the engine.
2. Use a fixed typed catalog with exactly `phonon-2` and `parakeet-v3`.
   Each entry contains label, language summary, download size hint, license/source,
   and live capability. Reject unknown IDs before filesystem/network operations.
3. The engine serves model status, background download, and background activation.
   Expose installed/downloading/loading/ready/error states and actionable messages.
   Downloading does not implicitly change the active model. One install/load job
   at a time; repeated downloads are idempotent. Keep HTTP responsive during work.
4. Phonon is run in a managed child process using the pinned Fermion CLI and its
   existing HTTP/WebSocket implementation on a private loopback port. Give it a
   local installed model path, so selecting or starting cannot silently download.
   Bound startup waits and terminate/wait for children on replacement and shutdown.
   Parakeet uses sherpa-onnx's CPU offline transducer, lazily loaded on a single
   inference worker. Drop the old model before loading another to bound memory.
5. Serialize model switching with inference and streaming admission. Refuse a
   switch with HTTP 409 while inference/streaming is active; refuse new inference
   during loading. Reserve the slot before creating a background loading task.
   Capture the chosen model ID in every recording/transcription request and stream
   URL. Reject stale model IDs rather than transcribing under a different model.
6. Preserve WAV upload/storage limits and the existing batch fallback. Bound
   Parakeet inference windows for long recordings; prefer quiet cuts between
   25 and 30 seconds, ensure no samples are lost, and document forced-cut limits.
   Persist recording audio before transcribing as today. Chat formats stay compatible.

## Downloads and storage

- Fresh `make run` starts the UI and engine without downloading weights. GUI
  download buttons show approximate sizes, busy state, completion, and retry.
- Parakeet: download only encoder, decoder, joiner, and tokens from a fixed
  revision of the upstream sherpa-onnx maintainer's model repository. Verify file
  digests/sizes, use temporary files/directories and an atomic installation marker,
  and never expose an incomplete installation as usable. No archive extraction.
- Phonon: invoke the pinned Fermion download-only command into a staging cache.
  Fermion verifies its pinned archive/member digests. Promote only a completed
  model into the app model store and discard transfer cache after success.
- Model loading always uses local installed paths; downloads require the button
  or explicit CLI. Detect and report interrupted/failed installs; retry safely.
- Preserve old repository caches. Document explicit redownload into app storage
  rather than moving/deleting files that might be used by the primary checkout.
- Keep `make download-model MODEL=...` as a convenience using the same installer
  and storage location, with a cross-process filesystem lock preventing concurrent
  GUI/CLI installations. Install markers record catalog version and required files.

## Browser interaction

- Accessible labeled model selector near recorder, model status/help, and Download
  or Use model button. Missing models can be inspected without changing the active
  model. Selection and download are separate actions.
- Poll installation/loading status without overlapping requests. Render clear
  engine-offline/download-failed/load-failed states. Never claim an inactive model
  is ready. Recording disabled until the selected model is active and ready.
- Lock model controls during recording, save/finalization, and transcription;
  server admission remains authoritative for other tabs.
- Keep all existing chats, cursor insertion, stored audio, retry and copy behavior.
- After successful activation persist the model; startup reloads it only if
  installed. With no installed model, show download state, not endless starting.

## Validation and delivery

1. Fresh-context subagent reviews this plan before implementation; record findings
   and resolutions here.
2. Focused tests with injected downloader/backend cover unknown IDs, partial and
   failed downloads, idempotency, app paths, reload persistence, failed startup,
   busy switching, stale requests, child cleanup, and model capability behavior.
3. API tests cover model routes, proxy failures, batch identity and stream admission.
   Frontend tests cover selection, download/retry, readiness, recording locks,
   live preference restoration, and capture of model ID through fallback/retry.
4. Run repository `make check` (Ruff format/lint, ty, pytest, Prettier, ESLint,
   TypeScript, frontend tests); include inference code in checks while keeping
   default web tests free of heavyweight model downloads.
5. Where dependencies/network permit, load the actual Parakeet model and transcribe
   upstream sample WAVs, check real Phonon loading/streaming, and inspect desktop
   and phone layout. Report automated tests separately from actual model accuracy
   and microphone behavior. No claim of German/English acceptance without samples.
6. Update README/run/download commands and commit focused changes on this branch.
   No merge, push, or deployment requested.

## Review record

Reviewed before implementation; findings and resolutions follow.

### Fresh-context review completed

Reviewer `review_plan` approved the overall scope and identified these changes:

- Keep inference ownership until native work actually ends even after an HTTP
  timeout/disconnect. Shield worker tasks and release admission in task completion,
  not in the cancelled request's finally block. Competing inference receives 409.
- Start local-path Fermion with `--served-model-name phonon-2`.
- Bound download connect/read/overall time, subprocess terminate/kill/wait, and
  release installation locks on all exits. Test retry after failure.
- Test chunk coverage, silence, exact boundaries and tails; any failed chunk fails
  the whole transcription. Never return a partial batch result as complete.
- Failed activation leaves no active model, preserves the last successful saved
  preference, and exposes the failed target. Proxy 409 explanations intact.

Environment note: shell DNS for external downloads is unavailable. Runtime
installation and actual Parakeet accuracy are conditional validation; model-free
checks and the existing local Phonon runtime remain available.

## Implementation and validation record

- Added shared model catalog, app-owned inference service, explicit atomic
  installation, persisted activation, Parakeet CPU adapter, and Fermion child
  ownership. The GUI uses capability-aware selection with Download and Use model.
- Fresh-context implementation review found startup selection during Parakeet
  loading and Phonon's internal decode timeout could break ownership. Both are
  corrected, with regression tests. No further concrete blockers were reported.
- Python checks pass: Ruff formatting/lint, ty, and 84 tests. Frontend checks pass:
  Prettier, ESLint, TypeScript, and 37 tests. Tests exercise download failure/retry,
  checksum rejection, cancellation/locking, persisted selection, busy/stale model
  rejection, model-specific fallback, and forced child cleanup.
- The checks use the existing installed web dependencies with this worktree's
  `src` on PYTHONPATH. Fresh dependency installation could not run: external DNS
  is unavailable. The new engine dependency set and its lock need resolution on
  a networked host; no stale engine lock is committed.
- Existing local Phonon weights successfully loaded through Fermion's Python
  API and returned an empty transcript for one second of silence.
- Actual HTTP/WebSocket server smoke testing and Chromium layout checks were
  attempted but socket operations are forbidden in this environment. Child
  failure cleanup completed. Parakeet package/model download, actual multilingual
  transcription, browser layout, microphone use and end-to-end latency remain
  unverified. These limits do not change the automated test results above.
