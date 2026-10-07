import { MAX_DURATION_SECONDS, wordCount } from "./audio.js";
import { LiveTranscriber } from "./live.js";
import { MicrophoneRecorder } from "./recorder.js";

const recordButton = /** @type {HTMLButtonElement} */ (document.getElementById("record"));
const stopButton = /** @type {HTMLButtonElement} */ (document.getElementById("stop"));
const retryButton = /** @type {HTMLButtonElement} */ (document.getElementById("retry"));
const clearButton = /** @type {HTMLButtonElement} */ (document.getElementById("clear"));
const copyButton = /** @type {HTMLButtonElement} */ (document.getElementById("copy"));
const transcript = /** @type {HTMLTextAreaElement} */ (document.getElementById("transcript"));
const playback = /** @type {HTMLAudioElement} */ (document.getElementById("playback"));
const status = /** @type {HTMLElement} */ (document.getElementById("status"));
const errorMessage = /** @type {HTMLElement} */ (document.getElementById("error"));
const stage = /** @type {HTMLElement} */ (document.getElementById("stage"));
const meter = /** @type {HTMLCanvasElement} */ (document.getElementById("meter"));
const timer = /** @type {HTMLElement} */ (document.getElementById("timer"));
const count = /** @type {HTMLElement} */ (document.getElementById("word-count"));
const engineStatus = /** @type {HTMLElement} */ (document.getElementById("engine-status"));
const liveMode = /** @type {HTMLInputElement} */ (document.getElementById("live-mode"));
const recorder = new MicrophoneRecorder();
/** @type {LiveTranscriber | null} */
let activeStream = null;
let recording = false;
let busy = false;
let startedAt = 0;
/** @type {number | undefined} */
let timerId;
/** @type {Blob | null} */
let lastRecording = null;
/** @type {string | null} */
let playbackUrl = null;
/** Recent microphone levels for the scrolling meter, oldest first. */
const levels = new Array(160).fill(0);
let peakLevel = 0;
recorder.onLevel = (/** @type {number} */ level) => {
  peakLevel = Math.max(peakLevel, level);
};

/** Draw the level history as mirrored bars; quiet input still shows a baseline. */
function drawMeter() {
  const context = meter.getContext("2d");
  if (!context) return;
  const ratio = window.devicePixelRatio || 1;
  const width = Math.round(meter.clientWidth * ratio);
  const height = Math.round(meter.clientHeight * ratio);
  if (meter.width !== width || meter.height !== height) {
    meter.width = width;
    meter.height = height;
  }
  context.clearRect(0, 0, width, height);
  // Show as many recent levels as fit at a fixed bar pitch.
  const visible = levels.slice(-Math.max(1, Math.floor(width / (7 * ratio))));
  const step = width / visible.length;
  const bar = step * 0.55;
  const gradient = context.createLinearGradient(0, 0, width, 0);
  gradient.addColorStop(0, "#19d3a200");
  gradient.addColorStop(0.35, "#5eead4");
  gradient.addColorStop(0.75, "#ff7ab8");
  gradient.addColorStop(1, "#ffb199");
  context.fillStyle = gradient;
  visible.forEach((level, index) => {
    const size = Math.max(bar, Math.min(1, Math.sqrt(level * 8)) * height * 0.92);
    const x = index * step + (step - bar) / 2;
    context.beginPath();
    context.roundRect(x, (height - size) / 2, bar, size, bar / 2);
    context.fill();
  });
}

function pushLevel() {
  levels.shift();
  levels.push(recording ? peakLevel : 0);
  peakLevel = 0;
  drawMeter();
}

function updateControls() {
  const active = recording || busy;
  liveMode.disabled = active;
  stopButton.textContent = liveMode.checked ? "Stop" : "Stop & transcribe";
  transcript.placeholder = liveMode.checked
    ? "Your words will appear here as you speak."
    : "Your words will appear here after you stop recording.";
  recordButton.disabled = active;
  recordButton.hidden = recording;
  stopButton.hidden = !recording;
  stopButton.disabled = !recording || busy;
  retryButton.disabled = active || !lastRecording;
  clearButton.disabled = active || (!transcript.value && !lastRecording);
  copyButton.disabled = active || !transcript.value.trim();
  transcript.readOnly = active;
  const words = wordCount(transcript.value);
  count.textContent = `${words} ${words === 1 ? "word" : "words"}`;
  stage.classList.toggle("recording", recording);
  stage.classList.toggle("busy", busy && !recording);
}

/** @param {unknown} error */
function showError(error) {
  errorMessage.textContent =
    error instanceof Error ? error.message : "Something went wrong. Try again.";
  errorMessage.hidden = false;
}

function hideError() {
  errorMessage.hidden = true;
  errorMessage.textContent = "";
}

/** @param {number} seconds */
function updateTimer(seconds) {
  timer.textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

recordButton.addEventListener("click", async () => {
  hideError();
  if (!window.isSecureContext || !navigator.mediaDevices) {
    showError(new Error("Open this app at http://localhost:8080 to enable microphone access."));
    return;
  }
  busy = true;
  updateControls();
  status.textContent = "Waiting for microphone permission…";
  try {
    playback.pause();
    if (liveMode.checked) {
      status.textContent = "Connecting live transcription…";
      const stream = new LiveTranscriber(
        (text) => {
          transcript.value = text;
          updateControls();
        },
        (error) => {
          if (recording) {
            showError(error);
            status.textContent = "Recording continues. Stop to transcribe the complete recording.";
          }
        },
      );
      activeStream = stream;
      const url = new URL("/api/stream", window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      await stream.start(url.href);
      status.textContent = "Waiting for microphone permission…";
      await recorder.start((samples) => stream.sendSamples(samples));
      transcript.value = stream.transcript.text;
    } else {
      await recorder.start();
    }
    recording = true;
    startedAt = performance.now();
    updateTimer(0);
    if (activeStream?.failure) {
      showError(activeStream.failure);
      status.textContent = "Recording continues. Stop to transcribe the complete recording.";
    } else {
      status.textContent = activeStream
        ? "Transcribing as you speak. Text may change until you stop."
        : "Recording. Stop when you’re ready to transcribe.";
    }
    timerId = window.setInterval(() => {
      const elapsed = (performance.now() - startedAt) / 1000;
      updateTimer(Math.min(elapsed, MAX_DURATION_SECONDS));
      pushLevel();
      if (elapsed >= MAX_DURATION_SECONDS) void stopRecording();
    }, 60);
  } catch (error) {
    activeStream?.cancel();
    activeStream = null;
    if (error instanceof DOMException && error.name === "NotAllowedError") {
      showError(new Error("Allow microphone access in your browser, then choose Record again."));
    } else if (error instanceof DOMException && error.name === "NotFoundError") {
      showError(new Error("No microphone was found. Connect one and try again."));
    } else {
      showError(error);
    }
    status.textContent = "Recording hasn’t started.";
  } finally {
    busy = false;
    updateControls();
  }
});

async function stopRecording() {
  if (!recording || busy) return;
  window.clearInterval(timerId);
  recording = false;
  levels.fill(0);
  drawMeter();
  busy = true;
  updateControls();
  status.textContent = "Preparing your recording…";
  try {
    const audio = await recorder.stop();
    lastRecording = audio;
    if (playbackUrl) URL.revokeObjectURL(playbackUrl);
    playbackUrl = URL.createObjectURL(audio);
    playback.src = playbackUrl;
    playback.hidden = false;
    if (activeStream && !activeStream.failure) {
      status.textContent = "Finishing your live transcript…";
      try {
        setTranscript(await activeStream.finish());
      } catch {
        // A complete WAV is already kept, so recover a failed stream in batch mode.
        await transcribe(audio);
      }
    } else {
      await transcribe(audio);
    }
  } catch (error) {
    showError(error);
    status.textContent = lastRecording
      ? "Your recording is kept in this tab. You can retry."
      : "Try recording again.";
  } finally {
    activeStream?.cancel();
    activeStream = null;
    busy = false;
    updateControls();
  }
}

/** @param {Blob} audio */
async function transcribe(audio) {
  hideError();
  status.textContent = "Transcribing your recording…";
  const response = await fetch("/api/transcribe", {
    method: "POST",
    headers: { "Content-Type": "audio/wav" },
    body: audio,
    signal: AbortSignal.timeout(190_000),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      typeof result.detail === "string" ? result.detail : "Transcription failed. Try again.",
    );
  if (typeof result.text !== "string")
    throw new Error("An invalid transcript was returned. Try again.");
  setTranscript(result.text);
}

/** @param {string} text */
function setTranscript(text) {
  hideError();
  transcript.value = text;
  status.textContent = text.trim()
    ? "Ready. Edit your transcript or copy the text."
    : "No speech was recognized. Try another recording.";
}

stopButton.addEventListener("click", () => void stopRecording());
liveMode.addEventListener("change", updateControls);
retryButton.addEventListener("click", async () => {
  if (!lastRecording || busy || recording) return;
  busy = true;
  updateControls();
  try {
    await transcribe(lastRecording);
  } catch (error) {
    showError(error);
    status.textContent = "Your recording is kept in this tab. You can retry.";
  } finally {
    busy = false;
    updateControls();
  }
});
transcript.addEventListener("input", updateControls);
clearButton.addEventListener("click", () => {
  transcript.value = "";
  lastRecording = null;
  playback.pause();
  playback.removeAttribute("src");
  playback.load();
  playback.hidden = true;
  if (playbackUrl) URL.revokeObjectURL(playbackUrl);
  playbackUrl = null;
  hideError();
  updateTimer(0);
  status.textContent = "Tap the mic to start.";
  updateControls();
});
copyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(transcript.value);
    status.textContent = "Text copied.";
    copyButton.classList.toggle("copied", true);
    setTimeout(() => copyButton.classList.toggle("copied", false), 1500);
  } catch {
    transcript.focus();
    transcript.select();
    status.textContent = "Text selected. Press Ctrl+C to copy.";
  }
});

async function checkEngine() {
  try {
    const response = await fetch("/api/health", { signal: AbortSignal.timeout(3000) });
    const health = await response.json();
    const ready = response.ok && health.ready;
    engineStatus.textContent = ready ? "Phonon-2 ready" : "Engine starting…";
    engineStatus.classList.toggle("ready", ready);
    engineStatus.classList.toggle("offline", false);
  } catch {
    engineStatus.textContent = "App offline";
    engineStatus.title = "Check that the app is running.";
    engineStatus.classList.toggle("ready", false);
    engineStatus.classList.toggle("offline", true);
  }
}

window.addEventListener("pagehide", () => {
  window.clearInterval(timerId);
  activeStream?.cancel();
  void recorder.release();
  if (playbackUrl) URL.revokeObjectURL(playbackUrl);
});
// Space starts and stops recording unless a control or the transcript has focus.
window.addEventListener("keydown", (event) => {
  if (event.code !== "Space" || event.repeat || event.target !== document.body) return;
  event.preventDefault();
  if (recording) void stopRecording();
  else if (!recordButton.disabled) recordButton.click();
});
window.addEventListener("resize", drawMeter);
updateControls();
drawMeter();
void checkEngine();
window.setInterval(() => void checkEngine(), 5000);
