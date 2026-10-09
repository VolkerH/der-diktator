# Recording interval validation

The original full-duration measurements were made on 2026-10-09 with headless Chromium **153.0.8010.12** on the local Linux
WSL environment. These checks validate the bounded software path. They use
synthetic audio and do not establish real microphone, phone hardware or speech
model accuracy/latency acceptance.

## Accelerated full-duration capture

These are historical measurements from the original eight-batch queue version;
the full-duration benchmark has not been rerun after the review changes below.
The benchmark subclasses the production `RecorderProcessor` in an actual
AudioWorklet and accelerates its synthetic source. Production resampling, sample
budgets, port acknowledgements, `MicrophoneRecorder` retention and WAV creation
remain active. It yields between eight-batch bursts so the real main-thread port
can acknowledge messages. This is synthetic source acceleration, rather than
30/60 minutes of elapsed microphone capture.

All four runs stopped at exactly the permitted 16 kHz sample count, produced the
expected PCM16 WAV size and released recorder chunks after stopping. Native-rate
fallback did not increase retained audio bytes.

| Native context rate | Captured duration | Retained PCM16 | Peak JS backing storage | Peak JS heap used | Renderer RSS baseline | Peak sampled renderer RSS |
| ------------------- | ----------------- | -------------- | ----------------------- | ----------------- | --------------------- | ------------------------- |
| 16 kHz              | 1800 s            | 57.60 MB       | 57.61 MB                | 3.11 MB           | 310.46 MB             | 514.73 MB                 |
| 16 kHz              | 3600 s            | 115.20 MB      | 115.21 MB               | 4.47 MB           | 298.06 MB             | 628.95 MB                 |
| 48 kHz              | 1800 s            | 57.60 MB       | 57.61 MB                | 3.10 MB           | 298.07 MB             | 504.71 MB                 |
| 48 kHz              | 3600 s            | 115.20 MB      | 115.21 MB               | 4.49 MB           | 298.07 MB             | 639.08 MB                 |

MB is decimal. CDP `Runtime.getHeapUsage` reports JavaScript heap and backing
storage separately; it omits some native/Blob allocations. RSS samples every
100 ms sum this browser's renderer processes from `/proc`, including native
allocations and renderer baseline costs. Shared pages can be counted in multiple
processes and brief peaks can occur between samples. These numbers are sampled
renderer memory evidence, not an exact allocation peak or total browser memory.
The input rate, exact bytes, accelerated wall time and raw measurements are in
[the JSON artifact](recording-capture-resources.json).

Retained audio is bounded by `hard_limit_seconds * 16000 * 2`. WAV construction
can add a Blob copy; the implementation makes no zero-copy promise. Pending
worklet transport in the measured version was bounded to eight 2048-sample
PCM16 messages plus a partial batch, under 37 KiB, with bounded FIR state.
The reviewed version uses 128 batches plus a partial batch, at most 516 KiB,
allowing about 16.384 seconds of main-thread delay. This raises the transport
allowance by at most 480 KiB; the historical RSS table is not a rerun of this version. The live socket has a 1 MiB pending
byte limit and follows the discovered per-frame budget. A stalled tab stops with
an explicit recovery notice rather than accumulating an unbounded message queue.

Reproduce with a locally installed Chromium:

```sh
uv run scripts/measure_recording_capture.py \
  --chromium /path/to/chromium \
  --output /tmp/recording-capture-resources.json
```

## Browser and correctness checks

Desktop 1280x1000 and phone-sized 390x844 browser checks used Chromium's synthetic
microphone and a mock engine. They exercised the 30-minute Settings default,
saving a one-minute interval, immediate accessible warning, acknowledged full
extension, re-armed warning behavior, and automatic stopping with an accelerated
presentation clock. Both viewports had no JavaScript errors or horizontal page
overflow. Screenshots and the short recording in the PR are labeled as synthetic
audio/mock transcription; the phone viewport is not phone hardware testing.

The original two-second deliberate main-thread stall triggered the old
eight-batch guard and recovered the received audio. That result documents the
previous threshold, not the current 128-batch behavior. New unit tests check
that two seconds of unacknowledged capture continue after acknowledgement,
and that a fully unacknowledged queue stops after 128 batches.

Client tests additionally cover irregular-block 16/44.1/48 kHz continuity, exact
sample caps and permitted tail, stop/extension/startup races, missing stop
acknowledgement prefix recovery, late extension acknowledgement correlation,
whole-interval refusal, warning re-arm, frozen settings and client waits, and
preservation of constrained requested preferences. FIR tests keep 1/4 kHz tone
RMS within 0.005/0.01 of the expected amplitude and reduce a 12 kHz input to RMS
below 0.003 at both native fallback rates, preventing speech-band aliasing.

The original complete `make check` passed: Ruff formatting/lint, Ty, **434 Python tests**,
Prettier, ESLint, TypeScript checking and **204 frontend tests**. Tests use CPU-only
fakes/mocks and do not download a model or rebuild a Docker image.

## Acceptance boundaries

The shipped interval/default path is validated at 1800/3600 seconds. Raising the
operator ceiling beyond 3600 is outside these measurements. Existing retained
upload identities, failed-upload recovery and terminal streaming event meanings
remain covered by the regression suite.

Batch and live finalization waits still default to 180 seconds and can be configured
consistently on both services. No real speech model was timed in this delivery;
these capture results do not prove that any model finishes a 30/60-minute recording
within that wait. Timeout can leave native inference owning the model, and a retry
can return `model_busy`. Real-time microphone behavior, mobile memory tolerance,
representative recognition accuracy and model throughput remain separate evidence.

## Review changes

The backend now publishes frozen warning and extension rules and resolves the
Use default preview. A required interval field catches empty input inline.
Capture-integrity notices preserve save/transcription failures; temporary
extension warnings clear when capture stops. Focused regression coverage checks
combined capture/save/transcription failure outcomes and backend-published values.

Default uploads scale with the maximum WAV body while retaining explicit overrides:
1044 seconds for the shipped ceiling, retaining the previous approximately
0.889 Mbit/s full-body throughput assumption before network overhead. Upload
collection avoids a retained bytearray plus bytes copy on CPython, and WAV
validation reads 65,536-byte blocks. Engine forwarding, engine body/native decode,
request-buffer growth and browser Blob costs remain. No new RSS measurement or
real 60-minute network upload is claimed by this review change.

Fresh review browser checks used Chromium's synthetic microphone and a mock
engine at desktop 1280x1000 and phone-sized 390x844. Empty input reports
`valueMissing` and blocks saving. Both viewports exercised default/reset, saving
a one-minute interval, immediate warning, acknowledged full extension and
accelerated-clock automatic stopping, with no JavaScript errors or page overflow.
A two-second main-thread stall continued capture without an interruption error.
An 18-second stall stopped with the integrity notice and saved the received WAV
through the recording resource path. These checks validate the revised queue;
they do not rerun the historical full-duration memory benchmark.

The revised complete `make check` passes Ruff formatting/lint, Ty, **447 Python
tests**, Prettier, ESLint, TypeScript checking and **235 frontend tests**. The
focused recorder/controller/policy/application frontend subset passes 188 tests.
