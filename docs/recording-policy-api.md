# Recording policy

Both services load one immutable validated `RecordingPolicy` at startup. The
shipped duration ceiling and browser interval remain **600 seconds**. This release
adds cross-process agreement and native ownership; interval preferences, longer
capture, countdown warnings and extensions remain the next #6/#9 slice.

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
| `DIKTATOR_RECORDING_HARD_LIMIT_SECONDS`      | 600     | Whole-minute ceiling, at least 60 seconds                      |
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
At the default ceiling it remains 20,000,044 bytes, preserving earlier metadata
headroom. The body limit and the decoded sample-count limit are independent;
metadata allowance never permits longer audio. Both services reject excess data
without truncation, including accumulated live frames and stored-clip retranscription.
Each live frame must contain whole 16-bit samples.

The browser's existing capture path remains capped at the smaller of 600 seconds
and the agreed operator ceiling. Raising an environment value here does not
establish longer browser capture support or model performance acceptance.

## Discovery and admission

Engine `GET /recording-policy` returns these typed fields:

```json
{
  "protocol_version": 1,
  "hard_limit_seconds": 600,
  "wav_container_allowance_bytes": 800044,
  "max_stream_frame_bytes": 65536,
  "upload_timeout_seconds": 180.0,
  "batch_timeout_seconds": 180.0,
  "live_finalization_timeout_seconds": 180.0,
  "client_timeout_margin_seconds": 10.0,
  "max_pcm_bytes": 19200000,
  "max_audio_bytes": 20000044,
  "policy_revision": "sha256-of-canonical-policy"
}
```

Web `GET /api/recording-policy` validates the engine's full representation, derived
budgets, protocol and revision against its startup policy. Its success response
has the same fields plus `preference_etag`, the opaque validator from one read of
the shared local profile. Reads create no preference row and reserve no model.
The response contains no endpoint, path or secret. It is a discovery snapshot,
not a promise of model readiness or survival across service restart.

A missing/old engine capability, malformed policy, changed revision or disagreement
returns 503 `configuration_mismatch`. An unreachable/unavailable engine returns
503 `engine_unavailable`; a discovery timeout returns 504 `engine_timeout`.
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
`client_timeout_margin_seconds`. Audio save clients read these without engine
discovery, so short WAV upload/playback/export remain usable when inference is
unavailable or mismatched. The settings revision covers these added budgets too.
Preference ETags still cover their existing representation; policy-derived interval
fields and preference validation are delivered with the complete interval feature.

## Waiting and recovery

Upload timeouts return 408 `upload_timeout`. The engine's batch timeout returns
504 `engine_timeout` while its shielded native task continues to own the model.
The web's upstream batch read/write waits use the batch budget plus one margin.
The browser's direct batch deadline permits two upload phases, one batch phase
and three margins: `2 * upload + batch + 3 * margin`. Stored-clip inference uses
that same conservative deadline. Each upload's browser wait is `upload + margin`.
For live completion, the engine waits `live_finalization`, the web waits
`live_finalization + margin`, and the browser waits `live_finalization + 2 * margin`.
Capture duration is a sample budget, independent of these post-capture waits.
Larger waits do not guarantee that every model finishes within them.

Only upstream native `done` acknowledges successful live completion and permits
reuse of the loaded backend. A disconnect, timeout, error or rejected configuration
after native reservation triggers an owned stop/reap task. It keeps inference,
activation and deletion blocked until stop is confirmed. Repeated cancellation of
the requesting connection cannot cancel cleanup; shutdown adopts the same cleanup.
A failed stop keeps admission busy and reports a model error requiring engine
restart. Successful abnormal cleanup unloads the model and reports that it must
be activated again. A rejected admission before reservation does not stop another
owner's work. Shutdown cannot reopen admission on a late native `done`.

Terminal `partial`/`final`/`done`/`error` event meanings remain compatible. `ready`
still acknowledges the web relay connection; a later model admission failure is
possible. Transport closure never means successful completion. Clients retain
captured audio through finalization and preserve the WAV/upload identifier after
failure for explicit recovery. Saving audio and starting inference remain separate
operations. A retry during native decoding or cleanup can return `model_busy`;
there is no automatic unchanged retry, durable job result or exactly-once guarantee.

Validation uses fake native backends, ASGI clients, synthetic audio and a tiny owned
subprocess for stop/kill/reap. It establishes policy/software ownership behavior,
not real microphone, mobile, model latency or native-host acceptance. Docker CI
remains manual-only; this policy change requires no image build or model download.
