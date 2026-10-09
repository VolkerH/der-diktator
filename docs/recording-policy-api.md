# Recording policy

Both services load one immutable validated `RecordingPolicy` at startup. The
shipped hard ceiling is **3600 seconds**, with a **1800-second** default recording
interval. This release integrates cross-process agreement, native ownership,
interval preferences, bounded capture, countdown warnings and full extensions.

## Startup inputs

Defaults can be overridden by the following environment variables. Both entrypoints,
`scripts/run.sh` and the container's two subprocesses inherit the same environment.
An independently launched engine must receive the same values as the web process.
Invalid configuration fails startup. Python injection uses the same validation.
There is no recording-policy CLI override, configuration file or operator API write
in this release. Existing host/port/data-directory CLI options retain their meaning.
Changes require restarting both services; a saved profile preference cannot raise
an operator ceiling.

| Environment variable                         | Default | Meaning                                                        |
| -------------------------------------------- | ------- | -------------------------------------------------------------- |
| `DIKTATOR_RECORDING_HARD_LIMIT_SECONDS`      | 3600    | Whole-minute ceiling, at least 60 seconds                      |
| `DIKTATOR_WAV_CONTAINER_ALLOWANCE_BYTES`     | 800044  | Body allowance beyond maximum PCM; 44 to 1048576 bytes         |
| `DIKTATOR_MAX_STREAM_FRAME_BYTES`            | 65536   | Even frame budget; 2 to 1048576 bytes                          |
| `DIKTATOR_UPLOAD_TIMEOUT_SECONDS`            | 180     | Deadline for reading a WAV request body on each service        |
| `DIKTATOR_BATCH_TIMEOUT_SECONDS`             | 180     | Engine response wait after WAV validation and native admission |
| `DIKTATOR_LIVE_FINALIZATION_TIMEOUT_SECONDS` | 180     | Engine wait for terminal events after sending `end`            |
| `DIKTATOR_CLIENT_TIMEOUT_MARGIN_SECONDS`     | 10      | Extra wait at each outer transport boundary                    |

Timeouts must be positive finite seconds, with combined browser deadlines fitting
the signed 32-bit millisecond timer range. The hard ceiling derives
`max_pcm_bytes = hard_limit_seconds * 16000 * 2` for mono 16 kHz PCM16. The WAV
body budget is `max_audio_bytes = max_pcm_bytes + wav_container_allowance_bytes`.
At the default ceiling the budget is 116,000,044 bytes, including the existing
800,044-byte metadata allowance. The body limit and the decoded sample-count limit are independent;
metadata allowance never permits longer audio. Both services reject excess data
without truncation, including accumulated live frames and stored-clip retranscription.
Each live frame must contain whole 16-bit samples.

The browser retains mono 16 kHz PCM16 independently of native sample rate, with
a worklet sample budget and bounded pending messages. Raising the operator
ceiling beyond 3600 seconds is outside the measured delivery scope. Capture
duration is separate from model performance and device acceptance.

## Discovery and admission

Engine `GET /recording-policy` returns these typed fields:

```json
{
  "protocol_version": 1,
  "hard_limit_seconds": 3600,
  "wav_container_allowance_bytes": 800044,
  "max_stream_frame_bytes": 65536,
  "upload_timeout_seconds": 180.0,
  "batch_timeout_seconds": 180.0,
  "live_finalization_timeout_seconds": 180.0,
  "client_timeout_margin_seconds": 10.0,
  "client_deadlines_ms": { "upload": 190000, "batch": 570000, "live": 200000 },
  "max_pcm_bytes": 115200000,
  "max_audio_bytes": 116000044,
  "policy_revision": "sha256-of-canonical-policy"
}
```

Web `GET /api/recording-policy` validates the engine's full representation, derived
budgets, protocol and revision against its startup policy. Its success response
has the same enforcement fields plus `preference_etag`, the opaque validator from
one read of the shared local profile, and interval fields:

- `recording_interval_seconds`: effective next-recording interval;
- `requested_recording_interval_seconds`: saved request or product default;
- `default_recording_interval_seconds`: 1800-second product default;
- `recording_interval_is_default`: whether the profile follows that default;
- `recording_interval_constrained` and `recording_interval_constraint_reason`;
- `min_recording_interval_seconds`, `max_recording_interval_seconds` and
  `recording_interval_step_seconds`: 60, current hard ceiling and 60.

The effective interval is constrained by the operator ceiling. Existing saved
requests survive a lowered ceiling; new explicit writes above it are rejected.
The ETag covers effective defaults and policy-derived fields. A settings save
applies to the next recording. Each accepted extension adds the frozen original
interval; a full interval must fit below the frozen ceiling. Reads create no preference row and reserve no model.
The response contains no endpoint, path or secret. It is a discovery snapshot,
not a promise of model readiness or survival across service restart.

A missing/old engine capability, malformed policy, changed revision or disagreement
returns 503 `configuration_mismatch`. An unreachable/unavailable engine returns
503 `engine_unavailable`; a discovery timeout returns 504 `engine_timeout`.
`configuration_mismatch` requires the operator to restart both services with
matching configuration inputs. Clients show the mismatch and retain audio; they
do not automatically retry discovery or inference for this failure.
The browser obtains discovery before opening its microphone. Browser, TUI and other
clients can use the same endpoint; every web inference admission also rechecks
agreement, including existing clients that never request discovery.

After comparison, the web sends `X-Recording-Policy-Revision` on the internal batch
request and `policy_revision` in the internal live URL. The engine rejects a stale
revision before reserving native work, covering a restart between discovery and
admission. These internal preconditions are optional for direct legacy engine clients,
which still face current hard limits. A revision is neither authentication nor an
idempotency key. PCM configuration stays `{"sample_rate":16000,"format":"pcm_s16le"}`.

`GET /api/settings` remains a web-only snapshot with its separate display revision;
it does not attest engine agreement. It adds `upload_timeout_seconds` and
`client_timeout_margin_seconds` plus the derived integer `client_upload_timeout_ms`.
Audio save clients use the published deadline without engine
discovery, so short WAV upload/playback/export remain usable when inference is
unavailable or mismatched. The settings revision covers these added budgets too.
A failed or malformed settings read does not prevent the browser from saving: it
uses its earlier generic 190,000 ms wait. That wait may expire before an increased
operator budget; retained WAV bytes and upload identity allow explicit recovery.
Preference ETags include the interval default, effective values and policy-derived
limits. See [preferences API](preferences-export-api.md).

## Waiting and recovery

Upload timeouts return 408 `upload_timeout`. The engine's batch timeout returns
504 `engine_timeout` while its shielded native task continues to own the model.
The web's upstream batch read wait uses the batch budget plus one margin, while
its write wait uses the upload budget plus one margin. Connect/pool waits are five
seconds.
The backend publishes typed integer `client_deadlines_ms` fields `upload`, `batch`
and `live`; all clients consume these values without reproducing arithmetic.
The backend derives batch from two upload phases, one batch phase and three
margins, upload from one upload phase plus one margin, and live from finalization
plus two margins. Stored-clip inference uses the same conservative batch deadline.
For live completion the engine waits `live_finalization`, and the web waits
`live_finalization + margin` before the published client deadline.
Capture duration is a sample budget, independent of these post-capture waits.
Larger waits do not guarantee that every model finishes within them.

The engine validates live configuration but defers forwarding it to Fermion until
the first accepted nonempty PCM frame or `end`. This matters because Fermion
0.2.10 `server.py::_ws_run` calls `eng.warm()` after configuration, before waiting
for PCM. No-configuration, configuration-only, and empty-frame disconnects now
leave the native decoder idle and keep the model loaded, including browser
microphone denial after `ready`. Any first native send marks uncertain ownership
before the write, including a write that fails after partial delivery.

After forwarding native work, only upstream `done` acknowledges successful
completion and permits reuse. Disconnect, timeout, error or frame rejection starts
an owned stop/reap task, blocking inference, activation and deletion until stop is
confirmed. Repeated cancellation cannot cancel cleanup; shutdown adopts that task.
A failed stop keeps admission busy and reports a model error requiring engine
restart. Successful cleanup reloads the interrupted model as an owned activation
job; it never starts activation during shutdown. Shutdown that begins during reload
waits for loading and then closes the replacement. Failed reload exposes a model
error and requires explicit activation. A rejected admission before reservation
does not stop another owner's work. Late `done` cannot reopen shutdown admission.

The browser saves its complete WAV after a live failure, then polls model status
within the published batch deadline until the recorded model is ready and idle.
It submits batch inference once. Cleanup/reload failure, service failure, model
switch or readiness deadline expiry leaves the clip and restored editor available
and displays recovery instructions. It never reactivates a different selected model
or repeats a failed inference request automatically.

Terminal `partial`/`final`/`done`/`error` event meanings remain compatible. `ready`
still acknowledges the web relay connection; a later model admission failure is
possible. Transport closure never means successful completion. Clients retain
captured audio through finalization and preserve the WAV/upload identifier after
failure for explicit recovery. Saving audio and starting inference remain separate
operations. A retry during native decoding or cleanup can return `model_busy`;
there is no automatic unchanged inference retry, durable job result or exactly-once guarantee.

Validation uses fake native backends, ASGI clients, synthetic audio and a tiny owned
subprocess for stop/kill/reap. It establishes policy/software ownership behavior,
not real microphone, mobile, model latency or native-host acceptance. Docker CI
remains manual-only; this policy change requires no image build or model download.

## Client capture obligations

Fetch discovery before microphone access, then freeze policy, original interval,
model identity and waiting budgets. Start the presentation clock at actual capture
start and reconcile it with accepted 16 kHz samples. A one-minute interval warns
immediately. Warnings are visible and announced accessibly even when an audio beep
is muted or unavailable; suspended browsers cannot promise timely sound.

The browser worklet enforces the current sample deadline and hard cap. Extensions
are acknowledged before updating the displayed deadline. Stop, automatic expiry,
late extension and startup teardown finalize once; the normal stopped acknowledgement
follows the permitted PCM tail. At most eight 2048-sample messages plus a partial
batch await acknowledgement. If the tab cannot keep up, capture stops explicitly
and its received audio remains available for saving/recovery. A missing stop
acknowledgement saves only the received prefix and warns that the unconfirmed tail
may be missing. Such interrupted capture is never presented as continuing normally.

Native-rate fallback uses a bounded 63-tap low-pass FIR with fractional phases,
retaining PCM16 chunks instead of a native-rate full-duration Float32 recording.
Live transport converts only bounded chunks and follows the discovered frame
budget; its pending socket buffer remains limited to 1 MiB. Batch WAV creation
uses a Blob over PCM chunks without a full-duration join/resampling allocation.
This retained mode keeps audio for upload retries and live fallback; it does not
implement no-retention sessions or exactly-once inference.

The 180-second batch/live finalization defaults are independent of capture length.
Synthetic full-duration capture measurements do not show that any real speech
model transcribes a 30- or 60-minute recording within those waits. Operators can
configure matching budgets on both services. Real microphone/mobile behavior and
representative real-model accuracy/latency remain separate acceptance evidence.
See [capture measurements](validation/recording-intervals.md).
