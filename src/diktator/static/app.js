import { ApiRequestError } from "./errors.js";
import { MAX_DURATION_SECONDS, wordCount } from "./audio.js";
import { chatApi, spliceText, titleFor } from "./chats.js";
import { modelPicker } from "./models.js";
import { LiveTranscriber } from "./live.js";
import { MicrophoneRecorder } from "./recorder.js";

/** @typedef {import("./chats.js").Chat} Chat */
/** @typedef {import("./chats.js").ChatSummary} ChatSummary */
/** @typedef {import("./chats.js").Recording} Recording */

const recordButton = /** @type {HTMLButtonElement} */ (document.getElementById("record"));
const stopButton = /** @type {HTMLButtonElement} */ (document.getElementById("stop"));
const copyButton = /** @type {HTMLButtonElement} */ (document.getElementById("copy"));
const newChatButton = /** @type {HTMLButtonElement} */ (document.getElementById("new-chat"));
const menuButton = /** @type {HTMLButtonElement} */ (document.getElementById("menu"));
const transcript = /** @type {HTMLTextAreaElement} */ (document.getElementById("transcript"));
const playback = /** @type {HTMLAudioElement} */ (document.getElementById("playback"));
const status = /** @type {HTMLElement} */ (document.getElementById("status"));
const errorMessage = /** @type {HTMLElement} */ (document.getElementById("error"));
const stage = /** @type {HTMLElement} */ (document.getElementById("stage"));
const meter = /** @type {HTMLCanvasElement} */ (document.getElementById("meter"));
const timer = /** @type {HTMLElement} */ (document.getElementById("timer"));
const count = /** @type {HTMLElement} */ (document.getElementById("word-count"));
const saveState = /** @type {HTMLElement} */ (document.getElementById("save-state"));
const conflictNotice = /** @type {HTMLElement} */ (document.getElementById("text-conflict"));
const loadLatestButton = /** @type {HTMLButtonElement} */ (document.getElementById("load-latest"));
const copyVersionButton = /** @type {HTMLButtonElement} */ (
  document.getElementById("copy-version")
);
const liveMode = /** @type {HTMLInputElement} */ (document.getElementById("live-mode"));
const chatList = /** @type {HTMLElement} */ (document.getElementById("chat-list"));
const chatTitle = /** @type {HTMLElement} */ (document.getElementById("chat-title"));
const clips = /** @type {HTMLElement} */ (document.getElementById("clips"));
const sidebar = /** @type {HTMLElement} */ (document.getElementById("sidebar"));
const scrim = /** @type {HTMLElement} */ (document.getElementById("scrim"));
const splash = /** @type {HTMLElement} */ (document.getElementById("splash"));
const modelDialog = /** @type {HTMLDialogElement} */ (document.getElementById("model-settings"));
const modelSettingsButton = /** @type {HTMLButtonElement} */ (
  document.getElementById("model-settings-open")
);
const modelSettingsClose = /** @type {HTMLButtonElement} */ (
  document.getElementById("model-settings-close")
);
const splashShownAt = performance.now();
const recorder = new MicrophoneRecorder();
/** @type {LiveTranscriber | null} */
let activeStream = null;
let recording = false;
let busy = false;
let modelReady = false;
let modelLive = false;
let livePreference = liveMode.checked;
let recordingModel = "phonon-2";
const models = modelPicker((ready, live) => {
  modelReady = ready;
  modelLive = live;
  if (!recording && !busy) liveMode.checked = live && livePreference;
  updateControls();
});
let startedAt = 0;
/** @type {number | undefined} */
let timerId;
/** The open chat; null is a new chat that is stored once it has text or audio.
 * @type {Chat | null} */
let chat = null;
/** @type {ChatSummary[]} */
let chats = [];
/** @type {Promise<Chat> | null} */
let creating = null;
let textDirty = false;
let textConflict = false;
/** Suspend queued/closing-page saves while deleting the open chat.
 * @type {string | null} */
let deletingChatId = null;
/** Invalidate every late result, including leaving and reopening the same chat ID. */
let navigationGeneration = 0;
/** Chosen once for this new chat and retained after a failed creation. */
let pendingChatId = newId();
/** Choose the ID before the first upload: the server may commit and lose its response.
 * @type {WeakMap<Blob, string>} */
const recordingIds = new WeakMap();
/** @type {ReturnType<typeof setTimeout> | undefined} */
let saveTimer;
/** Saves run one after another so an older text never overwrites a newer one. */
let saving = Promise.resolve();
/** Where the next transcript goes: the text and selection when it was requested. */
let insertion = { text: "", start: 0, end: 0 };
/** A recording the server could not store; it stays in this tab for a retry.
 * @type {Blob | null} */
let unsaved = null;
/** @type {string | null} */
let unsavedUrl = null;
/** Which clip the shared player has loaded, and whether it is playing. */
let playbackKey = "";
let playingKey = "";
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

function newId() {
  return crypto.randomUUID().replaceAll("-", "");
}

function pushLevel() {
  levels.shift();
  levels.push(recording ? peakLevel : 0);
  peakLevel = 0;
  drawMeter();
}

function updateControls() {
  const active = recording || busy;
  models.lock(active);
  liveMode.disabled = active || !modelLive;
  stopButton.textContent = liveMode.checked ? "Stop" : "Stop & transcribe";
  transcript.placeholder = liveMode.checked
    ? "Your words will appear here as you speak."
    : "Your words will appear here after you stop recording.";
  recordButton.disabled = active || !modelReady;
  recordButton.hidden = recording;
  stopButton.hidden = !recording;
  stopButton.disabled = !recording || busy;
  copyButton.disabled = active || !transcript.value.trim();
  newChatButton.disabled = active;
  transcript.readOnly = active;
  const words = wordCount(transcript.value);
  count.textContent = `${words} ${words === 1 ? "word" : "words"}`;
  chatTitle.textContent = titleFor(transcript.value);
  stage.classList.toggle("recording", recording);
  stage.classList.toggle("busy", busy && !recording);
  sidebar.classList.toggle("locked", active);
  clips.classList.toggle("locked", active);
}

function idleStatus() {
  status.textContent = transcript.value.trim()
    ? "Tap the mic to add more at the cursor."
    : "Tap the mic to start.";
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
function formatDuration(seconds) {
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

/** @param {number} seconds */
function updateTimer(seconds) {
  timer.textContent = formatDuration(seconds);
}

/** @param {string} iso */
function formatWhen(iso) {
  const date = new Date(iso);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString([], {
    day: "numeric",
    month: "short",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

/** @param {string} tag @param {string} className @param {string} [text] */
function element(tag, className, text = "") {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

/** @param {string | null} id @param {string} title @param {string} meta */
function chatItem(id, title, meta) {
  const item = element("li", "chat-item");
  item.classList.toggle("active", id === (chat?.id ?? null));
  const open = /** @type {HTMLButtonElement} */ (element("button", "chat-open"));
  open.type = "button";
  open.append(element("span", "chat-name", title), element("span", "chat-meta", meta));
  open.addEventListener("click", () => {
    if (id) void openChat(id);
    else closeDrawer();
  });
  item.append(open);
  if (id) {
    // Deleting takes a second click on the same button, which turns red to confirm.
    const remove = /** @type {HTMLButtonElement} */ (element("button", "chat-delete"));
    remove.type = "button";
    /** @param {boolean} confirming */
    const setConfirming = (confirming) => {
      remove.classList.toggle("confirm", confirming);
      remove.textContent = confirming ? "Delete" : "";
      remove.setAttribute(
        "aria-label",
        confirming ? `Confirm delete “${title}”` : `Delete “${title}”`,
      );
    };
    setConfirming(false);
    remove.addEventListener("click", () => {
      if (remove.classList.contains("confirm")) void deleteChat(id);
      else setConfirming(true);
    });
    remove.addEventListener("blur", () => setConfirming(false));
    item.append(remove);
  }
  return item;
}

function renderChats() {
  const items = chats.map((summary) =>
    chatItem(
      summary.id,
      summary.id === chat?.id ? titleFor(transcript.value) : summary.title,
      `${formatWhen(summary.updated)} · ${summary.recording_count} ${summary.recording_count === 1 ? "clip" : "clips"}`,
    ),
  );
  if (!chat) items.unshift(chatItem(null, titleFor(transcript.value), "Not saved yet"));
  chatList.replaceChildren(...items);
}

/**
 * @param {string} key
 * @param {string} label
 * @param {string} source
 * @param {string} actionLabel
 * @param {() => Promise<void>} action
 */
function clipItem(key, label, source, actionLabel, action) {
  const item = element("li", "clip");
  item.classList.toggle("playing", playingKey === key);
  const play = /** @type {HTMLButtonElement} */ (element("button", "clip-play", label));
  play.type = "button";
  play.setAttribute("aria-label", `${playingKey === key ? "Pause" : "Play"} recording ${label}`);
  play.addEventListener("click", () => togglePlayback(key, source));
  const insert = /** @type {HTMLButtonElement} */ (element("button", "clip-insert"));
  insert.type = "button";
  insert.title = actionLabel;
  insert.setAttribute("aria-label", actionLabel);
  insert.addEventListener("click", () => {
    if (!recording && !busy) void action();
  });
  item.append(play, insert);
  return item;
}

function renderClips() {
  const current = chat;
  const items = (current?.recordings ?? []).map((clip, index) =>
    clipItem(
      clip.id,
      `${index + 1} · ${formatDuration(clip.duration_seconds)}`,
      chatApi.recordingUrl(current?.id ?? "", clip.id),
      `Transcribe recording ${index + 1} again at the cursor`,
      () => transcribeClip(clip.id),
    ),
  );
  if (unsaved && unsavedUrl) {
    const item = clipItem(
      "unsaved",
      "Unsaved",
      unsavedUrl,
      "Save and transcribe this recording at the cursor",
      retryUnsaved,
    );
    item.classList.toggle("unsaved", true);
    items.push(item);
  }
  clips.replaceChildren(...items);
  clips.hidden = items.length === 0;
}

/** @param {string} key @param {string} source */
function togglePlayback(key, source) {
  if (playbackKey === key && !playback.paused) {
    playback.pause();
    return;
  }
  if (playbackKey !== key) {
    playback.src = source;
    playbackKey = key;
  }
  playback.play().catch(showError);
}

function stopPlayback() {
  playback.pause();
  playback.removeAttribute("src");
  playback.load();
  playbackKey = "";
  playingKey = "";
}

/** @param {Blob} audio */
function keepUnsaved(audio) {
  if (unsaved === audio) return;
  discardUnsaved();
  unsaved = audio;
  unsavedUrl = URL.createObjectURL(audio);
}

function discardUnsaved() {
  if (unsavedUrl) URL.revokeObjectURL(unsavedUrl);
  if (playbackKey === "unsaved") stopPlayback();
  unsaved = null;
  unsavedUrl = null;
}

/** @param {string} text */
function setSaveState(text) {
  saveState.textContent = text;
}

/** Add acknowledged recordings that this tab does not show yet, keeping its order.
 * @param {Chat} target @param {Recording[]} recordings */
function addRecordings(target, recordings) {
  const known = new Set(target.recordings.map((clip) => clip.id));
  target.recordings.push(...recordings.filter((clip) => !known.has(clip.id)));
}

/** A new chat is created on the server the first time it needs to store something. */
async function ensureChat() {
  if (chat) return chat;
  const generation = navigationGeneration;
  creating ??= chatApi
    .create(pendingChatId)
    .then((created) => {
      if (generation === navigationGeneration) {
        chat = created;
        chats = [
          {
            id: created.id,
            title: "New chat",
            updated: created.updated,
            recording_count: 0,
            etag: created.etag ?? "",
          },
          ...chats.filter((item) => item.id !== created.id),
        ];
        renderChats();
      }
      return created;
    })
    .finally(() => {
      if (generation === navigationGeneration) creating = null;
    });
  return await creating;
}

async function refreshChats() {
  const generation = navigationGeneration;
  try {
    const latest = await chatApi.list();
    if (generation !== navigationGeneration) return;
    chats = latest;
  } catch {
    // The list is refreshed again after the next save.
  }
  renderChats();
}

/** @param {number} generation */
async function writeText(generation) {
  if (generation !== navigationGeneration || textConflict || chat?.id === deletingChatId) {
    return;
  }
  clearTimeout(saveTimer);
  if (!textDirty) return;
  const text = transcript.value;
  if (!chat && !text) {
    textDirty = false;
    return;
  }
  setSaveState("Saving…");
  try {
    const target = await ensureChat();
    if (generation !== navigationGeneration || textConflict || chat?.id === deletingChatId) {
      return;
    }
    if (!target.textEtag) {
      throw new Error("The text version could not be loaded. Reload this chat.");
    }
    const saved = await chatApi.saveText(target.id, text, target.textEtag);
    if (generation !== navigationGeneration || chat?.id !== target.id) return;
    // Acknowledge the submitted snapshot; edits made during the request remain dirty.
    target.text = saved.text;
    target.updated = saved.updated;
    target.textEtag = saved.textEtag;
    target.text_revision = saved.text_revision;
    // The response is a complete Chat: show recordings added elsewhere before taking up
    // the whole-chat validator that covers them.
    addRecordings(target, saved.recordings);
    if (saved.revision >= target.revision) {
      target.etag = saved.etag;
      target.revision = saved.revision;
    }
    renderClips();
    textDirty = transcript.value !== text;
    setSaveState(textDirty ? "Editing…" : "Saved");
    await refreshChats();
  } catch (error) {
    if (generation !== navigationGeneration) return;
    textDirty = true;
    if (error instanceof ApiRequestError && error.code === "revision_conflict") {
      textConflict = true;
      clearTimeout(saveTimer);
      conflictNotice.hidden = false;
      setSaveState("This chat changed elsewhere");
    } else {
      setSaveState("Not saved");
      showError(error);
    }
  }
}

function saveText() {
  const generation = navigationGeneration;
  saving = saving.then(() => writeText(generation));
  return saving;
}

function scheduleSave() {
  textDirty = true;
  clearTimeout(saveTimer);
  if (textConflict) return;
  setSaveState("Editing…");
  saveTimer = setTimeout(() => void saveText(), 700);
}

/** @param {Chat | null} next */
function setChat(next) {
  navigationGeneration++;
  creating = null;
  pendingChatId = newId();
  clearTimeout(saveTimer);
  textConflict = false;
  conflictNotice.hidden = true;
  stopPlayback();
  discardUnsaved();
  hideError();
  chat = next;
  textDirty = false;
  transcript.value = next?.text ?? "";
  transcript.setSelectionRange(transcript.value.length, transcript.value.length);
  setSaveState("");
  updateTimer(0);
  idleStatus();
  renderChats();
  renderClips();
  updateControls();
}

function canLeaveChat() {
  return (
    !unsaved ||
    window.confirm("A recording in this chat could not be saved. Leave it and discard it?")
  );
}

/** Save before leaving; failed/conflicted drafts require explicit discard confirmation. */
async function prepareToLeave() {
  await saveText();
  if (textDirty && !window.confirm("Discard your unsaved changes?")) return false;
  return canLeaveChat();
}

/** @param {string} id */
async function openChat(id) {
  closeDrawer();
  if (recording || busy || id === chat?.id) return;
  busy = true;
  updateControls();
  try {
    if (!(await prepareToLeave())) return;
    // Uploads can leave refreshChats() in flight after busy clears. Invalidate that
    // old list response before this GET, so it cannot replace the sidebar mid-navigation.
    const generation = ++navigationGeneration;
    const next = await chatApi.get(id);
    if (generation === navigationGeneration) setChat(next);
  } catch (error) {
    showError(error);
    await refreshChats();
  } finally {
    busy = false;
    updateControls();
  }
}

async function newChat() {
  closeDrawer();
  if (recording || busy) return;
  busy = true;
  updateControls();
  try {
    if (!(await prepareToLeave())) return;
    setChat(null);
    transcript.focus();
  } finally {
    busy = false;
    updateControls();
  }
}

/** @param {string} id */
async function deleteChat(id) {
  if (recording || busy) return;
  busy = true;
  updateControls();
  const isCurrent = chat?.id === id;
  try {
    if (isCurrent) {
      deletingChatId = id;
      clearTimeout(saveTimer);
      // Let an already submitted save acknowledge its snapshot. Queued saves are
      // skipped, so the draft and retained audio survive a failed DELETE unchanged.
      await saving;
    }
    const target = isCurrent ? chat : chats.find((item) => item.id === id);
    if (!target?.etag) {
      throw new Error("The chat version could not be loaded. Retry deletion.");
    }
    await chatApi.remove(id, target.etag);
    if (isCurrent) setChat(null);
    await refreshChats();
  } catch (error) {
    showError(error);
    // A sidebar entry changed elsewhere: list its current version so a retry can succeed.
    if (!isCurrent && error instanceof ApiRequestError && error.code === "revision_conflict") {
      await refreshChats();
    }
  } finally {
    deletingChatId = null;
    busy = false;
    updateControls();
  }
}

loadLatestButton.addEventListener("click", async () => {
  if (!chat || recording || busy || !window.confirm("Discard your unsaved changes?")) return;
  const target = chat.id;
  const generation = navigationGeneration;
  busy = true;
  updateControls();
  try {
    const latest = await chatApi.get(target);
    if (generation === navigationGeneration && chat?.id === target) setChat(latest);
  } catch (error) {
    showError(error);
  } finally {
    busy = false;
    updateControls();
  }
});
copyVersionButton.addEventListener("click", copyTranscript);

function captureInsertion() {
  return {
    text: transcript.value,
    start: transcript.selectionStart,
    end: transcript.selectionEnd,
  };
}

/** @param {string} text */
function insertTranscript(text) {
  const result = spliceText(insertion.text, insertion.start, insertion.end, text);
  transcript.value = result.text;
  transcript.setSelectionRange(result.caret, result.caret);
  if (result.text !== insertion.text) textDirty = true;
  status.textContent = text.trim()
    ? "Added at the cursor. Edit, copy, or record more."
    : "No speech was recognized. Try another recording.";
}

/** Put back the text and selection from before a failed transcription. */
function restoreInsertion() {
  transcript.value = insertion.text;
  transcript.setSelectionRange(insertion.start, insertion.end);
}

/** Store audio with the open chat, or keep it in this tab if the server cannot.
 * @param {Blob} audio
 * @returns {Promise<{ chatId: string, recording: Recording } | Error>}
 */
async function storeRecording(audio) {
  try {
    const generation = navigationGeneration;
    const target = await ensureChat();
    let recordingId = recordingIds.get(audio);
    if (!recordingId) {
      recordingId = newId();
      recordingIds.set(audio, recordingId);
    }
    const {
      recording: stored,
      chatEtag,
      chatRevision,
    } = await chatApi.addRecording(target.id, audio, recordingId);
    if (generation !== navigationGeneration) return { chatId: target.id, recording: stored };
    // Chat-ETag also covers anything changed elsewhere since this tab's version. Take it
    // up only when this upload is the sole change, so deletion still detects unseen
    // changes. The text validator is kept, so a stale draft still conflicts on save.
    if (chatEtag && chatRevision === target.revision + 1) {
      target.etag = chatEtag;
      target.revision = chatRevision;
    }
    addRecordings(target, [stored]);
    if (unsaved === audio) discardUnsaved();
    renderClips();
    void refreshChats();
    return { chatId: target.id, recording: stored };
  } catch (error) {
    keepUnsaved(audio);
    renderClips();
    return error instanceof Error ? error : new Error("The recording could not be saved.");
  }
}

/** @param {Blob} audio @param {string | null} text */
async function storeAndInsert(audio, text) {
  status.textContent = "Saving your recording…";
  const stored = await storeRecording(audio);
  if (text === null) {
    status.textContent = "Transcribing your recording…";
    text =
      stored instanceof Error
        ? await chatApi.transcribe(audio, recordingModel)
        : await chatApi.transcribeRecording(stored.chatId, stored.recording.id, recordingModel);
  }
  // The transcript is recovered, so an earlier live-connection error no longer applies.
  hideError();
  insertTranscript(text);
  await saveText();
  if (stored instanceof Error) {
    showError(
      new Error(
        `Your recording could not be saved: ${stored.message} It stays in this tab; retry from its clip.`,
      ),
    );
  }
}

/** @param {() => Promise<void>} task @param {string} failure */
async function runBusy(task, failure) {
  busy = true;
  hideError();
  updateControls();
  try {
    await task();
  } catch (error) {
    restoreInsertion();
    showError(error);
    status.textContent = failure;
  } finally {
    busy = false;
    updateControls();
    renderChats();
  }
}

/** @param {string} recordingId */
async function transcribeClip(recordingId) {
  const target = chat;
  if (!target || !modelReady || recording || busy) return;
  const model = models.selected();
  await runBusy(async () => {
    insertion = captureInsertion();
    status.textContent = "Transcribing your recording…";
    insertTranscript(await chatApi.transcribeRecording(target.id, recordingId, model));
    await saveText();
  }, "Transcription failed. Try the clip again.");
}

async function retryUnsaved() {
  const audio = unsaved;
  if (!audio || !modelReady || recording || busy) return;
  recordingModel = models.selected();
  await runBusy(async () => {
    insertion = captureInsertion();
    await storeAndInsert(audio, null);
  }, "Your recording is kept in this tab. You can retry.");
}

recordButton.addEventListener("click", async () => {
  if (recording || busy || !modelReady) return;
  recordingModel = models.selected();
  hideError();
  if (!window.isSecureContext || !navigator.mediaDevices) {
    showError(
      new Error(
        "Browsers allow the microphone only over HTTPS or on localhost. Open this app through an HTTPS address.",
      ),
    );
    return;
  }
  busy = true;
  updateControls();
  stopPlayback();
  renderClips();
  insertion = captureInsertion();
  status.textContent = "Waiting for microphone permission…";
  try {
    if (liveMode.checked) {
      status.textContent = "Connecting live transcription…";
      const stream = new LiveTranscriber(
        (text) => {
          transcript.value = spliceText(insertion.text, insertion.start, insertion.end, text).text;
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
      url.searchParams.set("model", recordingModel);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      await stream.start(url.href);
      status.textContent = "Waiting for microphone permission…";
      await recorder.start((samples) => stream.sendSamples(samples));
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
  /** @type {Blob | null} */
  let audio = null;
  try {
    audio = await recorder.stop();
    /** @type {string | null} */
    let text = null;
    if (activeStream && !activeStream.failure) {
      status.textContent = "Finishing your live transcript…";
      // A failed stream is recovered by transcribing the complete WAV.
      text = await activeStream.finish().catch(() => null);
    }
    await storeAndInsert(audio, text);
  } catch (error) {
    restoreInsertion();
    showError(error);
    status.textContent = audio
      ? "Transcription failed. Use the clip’s button to retry at the cursor."
      : "Try recording again.";
  } finally {
    activeStream?.cancel();
    activeStream = null;
    busy = false;
    updateControls();
    renderChats();
  }
}

function closeDrawer() {
  sidebar.classList.toggle("open", false);
  scrim.hidden = true;
  menuButton.setAttribute("aria-expanded", "false");
}

stopButton.addEventListener("click", () => void stopRecording());
liveMode.addEventListener("change", () => {
  livePreference = liveMode.checked;
  updateControls();
});
newChatButton.addEventListener("click", () => void newChat());
menuButton.addEventListener("click", () => {
  const open = !sidebar.classList.contains("open");
  sidebar.classList.toggle("open", open);
  scrim.hidden = !open;
  menuButton.setAttribute("aria-expanded", String(open));
});
scrim.addEventListener("click", closeDrawer);
modelSettingsButton.addEventListener("click", () => modelDialog.showModal());
modelSettingsClose.addEventListener("click", () => modelDialog.close());
transcript.addEventListener("input", () => {
  scheduleSave();
  updateControls();
  renderChats();
});
playback.addEventListener("play", () => {
  playingKey = playbackKey;
  renderClips();
});
for (const type of ["pause", "ended"]) {
  playback.addEventListener(type, () => {
    playingKey = "";
    renderClips();
  });
}
async function copyTranscript() {
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
}
copyButton.addEventListener("click", copyTranscript);

window.addEventListener("pagehide", () => {
  window.clearInterval(timerId);
  clearTimeout(saveTimer);
  if (textDirty && chat?.textEtag && !textConflict && chat.id !== deletingChatId) {
    void chatApi.saveText(chat.id, transcript.value, chat.textEtag, true).catch(() => {});
  }
  activeStream?.cancel();
  void recorder.release();
  discardUnsaved();
});
// Space starts and stops recording unless a control or the transcript has focus.
window.addEventListener("keydown", (event) => {
  if (event.code !== "Space" || event.repeat || event.target !== document.body) return;
  event.preventDefault();
  if (recording) void stopRecording();
  else if (!recordButton.disabled) recordButton.click();
});
window.addEventListener("resize", drawMeter);

/** Reopen the most recently used chat, or start a new one. */
async function loadChats() {
  busy = true;
  updateControls();
  try {
    chats = await chatApi.list();
  } catch {
    showError(new Error("Saved chats could not be loaded. Check that the app is running."));
  } finally {
    busy = false;
  }
  const latest = chats[0];
  if (latest) await openChat(latest.id);
  else setChat(null);
  // Keep the splash up briefly so it does not flash on a fast load.
  setTimeout(
    () => splash.classList.toggle("done", true),
    Math.max(0, 1400 - (performance.now() - splashShownAt)),
  );
}

drawMeter();
setChat(null);
void loadChats();
void models.refresh();
window.setInterval(() => void models.refresh(), 2000);
