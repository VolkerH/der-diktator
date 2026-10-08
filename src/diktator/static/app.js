import { exportControls } from "./exports.js";
import { ApiRequestError } from "./errors.js";
import { MAX_DURATION_SECONDS, wordCount } from "./audio.js";
import { chatApi, spliceText } from "./chats.js";
import { groupApi } from "./groups.js";
import { GroupSidebar } from "./group-sidebar.js";
import { modelPicker } from "./models.js";
import { LiveTranscriber } from "./live.js";
import { MicrophoneRecorder } from "./recorder.js";

/** @typedef {import("./chats.js").Chat} Chat */
/** @typedef {import("./chats.js").ChatSummary} ChatSummary */
/** @typedef {import("./chats.js").ChatTitle} ChatTitle */
/** @typedef {import("./chats.js").Recording} Recording */
/** @typedef {import("./groups.js").Group} Group */

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
const searchInput = /** @type {HTMLInputElement} */ (document.getElementById("chat-filter-input"));
const searchClear = /** @type {HTMLButtonElement} */ (document.getElementById("chat-filter-clear"));
const searchRetry = /** @type {HTMLButtonElement} */ (document.getElementById("chat-filter-retry"));
const searchState = /** @type {HTMLElement} */ (document.getElementById("chat-filter-state"));
let searchQuery = "";
let listGeneration = 0;
/** @type {string | null} */
let shownQuery = null;
let listRetryable = true;
let startupPending = true;
let startupGeneration = 0;
const STARTUP_ERROR = "Saved chats could not be loaded. Use Retry chat search in the chat list.";
let listLoading = false;
/** @type {string | null} */
let listError = null;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let searchTimer;
const chatList = /** @type {HTMLElement} */ (document.getElementById("chat-list"));
const draftUnsorted = /** @type {HTMLButtonElement} */ (document.getElementById("draft-unsorted"));
const chatTitle = /** @type {HTMLButtonElement} */ (document.getElementById("chat-title"));
const chatTitleEdit = /** @type {HTMLButtonElement} */ (document.getElementById("chat-title-edit"));
const chatTitleArea = /** @type {HTMLElement} */ (document.getElementById("chat-title-area"));
let titleLoadGeneration = 0;
/** @typedef {{ generation: number, chatId: string | null, source: "heading" | "sidebar", summary: ChatSummary | null, trigger: HTMLElement, title: string, customTitle: string | null, titleEtag: string | null, initialValue: string, value: string, dirty: boolean, needsExplicitRetry: boolean, error: string | null, loading: boolean, saving: boolean, input: HTMLInputElement | null, savePromise: Promise<boolean> | null }} TitleEdit */
/** @type {TitleEdit | null} */
let titleEdit = null;
let replacingTitleEditor = false;
const CHAT_OPEN_CLICK_DELAY_MS = 260;
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
/** @type {Group[]} */
let groups = [];
/** @type {string | null} */
let groupListError = null;
/** The selected placement of an unsaved draft. @type {string | null} */
let pendingGroupId = null;
let missingDraftGroup = false;
const groupSidebar = new GroupSidebar(chatList, {
  newChat,
  create: (id, name) => changeGroup(() => groupApi.create(id, name), id),
  rename: (group, name) => changeGroup(() => groupApi.rename(group, name)),
  remove: (group) => changeGroup(() => groupApi.remove(group)),
  move: moveChat,
  render: renderChats,
});
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

const exports = exportControls(
  () => ({ text: transcript.value, key: navigationGeneration, active: recording || busy }),
  (message) => {
    status.textContent = message;
  },
);

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
  recordButton.disabled = active || Boolean(titleEdit) || !modelReady;
  recordButton.hidden = recording;
  stopButton.hidden = !recording;
  stopButton.disabled = !recording || busy;
  copyButton.disabled = active || !transcript.value.trim();
  exports.update();
  newChatButton.disabled = active;
  groupSidebar.lock(active);
  for (const control of chatList.querySelectorAll(".chat-rename"))
    /** @type {HTMLButtonElement} */ (control).disabled = active;
  for (const control of chatList.querySelectorAll(".chat-delete"))
    /** @type {HTMLButtonElement} */ (control).disabled = active;
  draftUnsorted.disabled = active;
  transcript.readOnly = active;
  const words = wordCount(transcript.value);
  count.textContent = `${words} ${words === 1 ? "word" : "words"}`;
  renderTitleHeading();
  if (titleEdit?.input) titleEdit.input.disabled = active || titleEdit.loading || titleEdit.saving;
  chatTitle.disabled = active;
  chatTitleEdit.disabled = active;
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

/** Build the shared inline editor at the heading or in a sidebar row.
 * @param {TitleEdit} editing @param {boolean} heading */
function titleEditor(editing, heading) {
  const wrapper = element("div", `inline-title-editor${heading ? " heading-title-editor" : ""}`);
  wrapper.setAttribute("id", "title-editor");
  const form = /** @type {HTMLFormElement} */ (element("form", "inline-title-form"));
  form.setAttribute("id", "title-form");
  const input = /** @type {HTMLInputElement} */ (element("input", "inline-title-input"));
  input.setAttribute("id", "title-input");
  input.type = "text";
  input.autocomplete = "off";
  input.value = editing.value;
  input.disabled = recording || busy || editing.loading || editing.saving;
  input.setAttribute("aria-label", "Chat name");
  input.setAttribute("aria-describedby", "title-error");
  editing.input = input;

  const actions = element("div", "inline-title-actions");
  const automatic = /** @type {HTMLButtonElement} */ (
    element("button", "inline-title-auto", "Use automatic name")
  );
  automatic.type = "button";
  automatic.setAttribute("id", "title-reset");
  automatic.setAttribute("aria-label", "Use automatic name");
  automatic.title = "Use automatic name";
  automatic.disabled = recording || busy || editing.loading || editing.saving;
  const cancel = /** @type {HTMLButtonElement} */ (element("button", "inline-title-cancel", "×"));
  cancel.type = "button";
  cancel.setAttribute("id", "title-cancel");
  cancel.setAttribute("aria-label", "Cancel rename");
  cancel.title = "Cancel rename";
  cancel.disabled = editing.saving;
  const save = /** @type {HTMLButtonElement} */ (element("button", "inline-title-save", "✓"));
  save.type = "submit";
  save.setAttribute("id", "title-save");
  save.setAttribute("aria-label", "Save chat name");
  save.title = "Save chat name";
  save.disabled = recording || busy || editing.loading || editing.saving;
  actions.append(cancel, save);

  const error = element("p", "inline-title-error", editing.error ?? "");
  error.setAttribute("id", "title-error");
  error.setAttribute("role", "alert");
  error.hidden = editing.error === null;
  form.append(input, actions, automatic, error);
  wrapper.append(form);

  input.addEventListener("input", () => {
    editing.value = input.value;
    editing.dirty = editing.value !== editing.initialValue;
    if (editing.error !== null) {
      editing.error = null;
      error.textContent = "";
      error.hidden = true;
    }
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      cancelTitleEdit(editing);
    } else if (event.key === "Enter" && (event.isComposing || event.keyCode === 229)) {
      event.preventDefault();
    }
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    editing.value = input.value;
    editing.dirty = editing.value !== editing.initialValue;
    void saveTitleEdit(editing, input.value, true, true);
  });
  form.addEventListener("focusout", (event) => {
    if (
      replacingTitleEditor ||
      editing.saving ||
      form.contains(/** @type {Node | null} */ (event.relatedTarget))
    )
      return;
    queueMicrotask(() => {
      if (titleEdit === editing && !form.contains(document.activeElement))
        void saveTitleEdit(editing, editing.value, false);
    });
  });
  automatic.addEventListener("click", () => void saveTitleEdit(editing, null, true, true));
  cancel.addEventListener("click", () => cancelTitleEdit(editing));
  return wrapper;
}

/** @param {string | null} id */
function chatRenameButton(id) {
  return /** @type {HTMLElement | null} */ (
    id ? chatList.querySelector(`[data-chat-id="${id}"] .chat-rename`) : chatTitleEdit
  );
}

/** @param {string | null} id @param {string} title @param {string} meta @param {ChatSummary | null} [summary] */
function chatItem(id, title, meta, summary = null) {
  const item = element("li", "chat-item");
  item.classList.toggle("active", id === (chat?.id ?? null));
  const open = /** @type {HTMLButtonElement} */ (element("button", "chat-open"));
  open.type = "button";
  open.append(element("span", "chat-name", title), element("span", "chat-meta", meta));
  if (id && summary) {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let openTimer;
    let pointerType = "";
    open.addEventListener("pointerdown", (event) => {
      pointerType = event.pointerType ?? "";
    });
    open.addEventListener("click", (event) => {
      if (event.detail >= 2) {
        clearTimeout(openTimer);
        return;
      }
      if (event.detail === 1 && pointerType === "mouse") {
        clearTimeout(openTimer);
        // Give the browser's second click a chance to deliver its native dblclick.
        openTimer = setTimeout(() => void openChat(id), CHAT_OPEN_CLICK_DELAY_MS);
      } else void openChat(id);
    });
    open.addEventListener("dblclick", (event) => {
      event.preventDefault();
      clearTimeout(openTimer);
      void beginTitleEdit(id, summary, "sidebar", open);
    });
  } else {
    open.addEventListener("click", () => void dismissDrawer());
  }
  if (id && summary) item.setAttribute("data-chat-id", id);
  const editing =
    id && titleEdit?.source === "sidebar" && titleEdit.chatId === id ? titleEdit : null;
  if (editing) {
    item.append(titleEditor(editing, false));
    return item;
  }
  item.append(open);
  if (id && summary) {
    const rename = /** @type {HTMLButtonElement} */ (element("button", "chat-rename"));
    rename.type = "button";
    rename.setAttribute("aria-label", `Rename “${title}”`);
    rename.title = "Rename chat";
    rename.addEventListener("click", (event) => {
      event.stopPropagation?.();
      void beginTitleEdit(id, summary, "sidebar", rename);
    });
    const move = groupSidebar.button(
      "Move",
      () => void runAfterTitleSave(() => groupSidebar.editMove(summary)),
      "chat-move",
    );
    move.setAttribute("aria-label", `Move “${title}” to group`);
    move.setAttribute("aria-haspopup", "dialog");
    move.setAttribute("aria-controls", "group-move");
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
      if (recording || busy) return;
      if (remove.classList.contains("confirm")) void runAfterTitleSave(() => deleteChat(id));
      else setConfirming(true);
    });
    remove.addEventListener("blur", () => setConfirming(false));
    item.append(rename, move, remove);
  }
  return item;
}

function renderChats() {
  const editing = titleEdit?.source === "sidebar" ? titleEdit : null;
  const input = editing?.input;
  const hadFocus = Boolean(input && document.activeElement === input);
  const selection = hadFocus && input ? [input.selectionStart, input.selectionEnd] : null;
  const visibleChats = [...chats];
  if (editing?.summary && !visibleChats.some((summary) => summary.id === editing.chatId))
    visibleChats.unshift(editing.summary);
  const editingSummary = editing
    ? (visibleChats.find((summary) => summary.id === editing.chatId) ?? editing.summary)
    : null;
  replacingTitleEditor = true;
  groupSidebar.render(
    groups,
    visibleChats,
    pendingGroupId,
    !chat,
    Boolean(searchQuery.trim()),
    (summary) =>
      summary
        ? chatItem(
            summary.id,
            summary.id === chat?.id ? chat.title : summary.title,
            `${formatWhen(summary.updated)} · ${summary.recording_count} ${summary.recording_count === 1 ? "clip" : "clips"}`,
            summary,
          )
        : chatItem(null, "New chat", "Not saved yet"),
    editing ? (editingSummary?.group_id ?? null) : undefined,
  );
  replacingTitleEditor = false;
  if (hadFocus && editing?.input?.isConnected && selection) {
    editing.input.focus();
    editing.input.setSelectionRange(selection[0], selection[1]);
  }
  chatList.hidden = shownQuery !== searchQuery && !editing;
  chatList.setAttribute("aria-busy", String(listLoading));
  searchClear.disabled = !searchQuery;
  searchRetry.hidden = listError === null || !listRetryable;
  searchState.textContent =
    listError ??
    (listLoading
      ? "Loading chats…"
      : searchQuery.trim() && !chats.length
        ? "No matching chats."
        : "");
  searchState.hidden = !searchState.textContent;
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

/** Reuse the pending chat ID after an uncertain create response. */
async function ensureChat() {
  if (chat) return chat;
  if (missingDraftGroup)
    throw new Error("This draft's group no longer exists. Save it in Unsorted to continue.");
  const generation = navigationGeneration;
  const input = { id: pendingChatId, groupId: pendingGroupId };
  creating ??= (async () => {
    let created;
    try {
      created = await chatApi.create(input.id, input.groupId);
    } catch (error) {
      if (!(error instanceof ApiRequestError) || error.code !== "group_not_found") throw error;
      if (generation === navigationGeneration) {
        missingDraftGroup = true;
        draftUnsorted.hidden = false;
        await refreshChats(true);
      }
      throw new Error(
        "This draft's group no longer exists. Your text and recording are kept. Save this draft in Unsorted to continue.",
      );
    }
    if (generation === navigationGeneration) {
      chat = created;
      draftUnsorted.hidden = true;
      if (!searchQuery.trim())
        chats = [
          {
            id: created.id,
            title: created.title,
            custom_title: created.custom_title,
            updated: created.updated,
            recording_count: created.recordings.length,
            etag: created.etag ?? "",
            group_id: input.groupId,
            placement_etag: "",
          },
          ...chats.filter((item) => item.id !== created.id),
        ];
      else void refreshChats();
      renderChats();
    }
    return created;
  })().finally(() => {
    if (generation === navigationGeneration) creating = null;
  });
  return await creating;
}

/** Update private metadata without replacing the editor or acknowledging shared validators.
 * @param {() => Promise<unknown>} operation @param {string} [createdId] */
async function changeGroup(operation, createdId) {
  if (recording || busy) throw new Error("Wait for the current operation to finish.");
  busy = true;
  updateControls();
  try {
    await operation();
    await refreshChats(true);
    if (listError || groupListError)
      throw new Error(listError || groupListError || "Groups could not be loaded.");
  } catch (error) {
    await refreshChats(true);
    // A chosen-ID create can be acknowledged by its own ID after a lost response.
    if (createdId && !groupListError && groups.some((group) => group.id === createdId)) return;
    showError(error);
    if (error instanceof ApiRequestError && error.code === "revision_conflict")
      throw new Error("This group changed elsewhere. Review the current groups and try again.");
    throw error;
  } finally {
    busy = false;
    updateControls();
  }
}

/** Moves use only placement validators and preserve drafts, shared state and recency.
 * @param {ChatSummary} summary @param {string | null} groupId */
async function moveChat(summary, groupId) {
  if (recording || busy) throw new Error("Wait for the current operation to finish.");
  busy = true;
  updateControls();
  let moveDispatched = false;
  try {
    if (!summary.placement_etag)
      throw new Error("The group version could not be loaded. Refresh the chat list.");
    moveDispatched = true;
    const saved = await groupApi.move(summary.id, groupId, summary.placement_etag);
    summary.group_id = saved.group_id;
    summary.placement_etag = saved.etag;
    await refreshChats();
  } catch (error) {
    // Reconcile ambiguous writes and stale placements. A retry remains explicit.
    try {
      const current = await groupApi.placement(summary.id);
      summary.group_id = current.group_id;
      summary.placement_etag = current.etag;
      if (moveDispatched && current.group_id === groupId && !(error instanceof ApiRequestError)) {
        await refreshChats();
        return;
      }
    } catch {
      /* Retain the last acknowledged placement when reconciliation fails. */
    }
    await refreshChats(error instanceof ApiRequestError && error.code === "group_not_found");
    showError(error);
    if (error instanceof ApiRequestError && error.code === "revision_conflict")
      throw new Error(
        "This chat's group changed elsewhere. Review its current group and move again to use your selection.",
      );
    if (error instanceof ApiRequestError && error.code === "group_not_found")
      throw new Error(
        "That group no longer exists. Your draft is kept. Close this dialog and choose another group or Unsorted.",
      );
    throw error;
  } finally {
    busy = false;
    updateControls();
  }
}

draftUnsorted.addEventListener("click", () => {
  if (!missingDraftGroup || recording || busy || chat) return;
  pendingChatId = newId();
  pendingGroupId = null;
  missingDraftGroup = false;
  draftUnsorted.hidden = true;
  hideError();
  renderChats();
  void saveText();
});

/** Search only affects the list; editor, selection and recording stay untouched. */
async function refreshChats(refreshGroupList = false) {
  clearTimeout(searchTimer);
  const generation = navigationGeneration;
  const requestGeneration = ++listGeneration;
  const query = searchQuery;
  listLoading = shownQuery !== query;
  listError = null;
  listRetryable = true;
  renderChats();
  try {
    const [chatResult, groupResult] = await Promise.allSettled([
      chatApi.list(query),
      refreshGroupList ? groupApi.list() : Promise.resolve(null),
    ]);
    if (generation !== navigationGeneration || requestGeneration !== listGeneration) return;
    if (groupResult.status === "fulfilled") {
      if (groupResult.value !== null) {
        groups = groupResult.value;
        groupListError = null;
      }
    } else {
      groupListError = "Groups could not be loaded. Refresh to try again.";
      showError(new Error(groupListError));
    }
    if (chatResult.status === "rejected") throw chatResult.reason;
    chats = chatResult.value;
    shownQuery = query;
    if (errorMessage.textContent === STARTUP_ERROR) hideError();
  } catch (error) {
    if (generation !== navigationGeneration || requestGeneration !== listGeneration) return;
    listError = error instanceof Error ? error.message : "Saved chats could not be loaded.";
    listRetryable = !(error instanceof ApiRequestError && error.code === "invalid_search_query");
  }
  if (generation !== navigationGeneration || requestGeneration !== listGeneration) return;
  listLoading = false;
  renderChats();
}

/** @param {string} query @param {boolean} [immediate] */
function changeSearch(query, immediate = false) {
  searchQuery = query;
  // Invalidate old responses when the user types, before the debounce fires.
  listGeneration++;
  clearTimeout(searchTimer);
  listLoading = true;
  listError = null;
  renderChats();
  if (immediate) void refreshChats(false);
  else searchTimer = setTimeout(() => void refreshChats(false), 200);
}

searchInput.addEventListener("input", () => changeSearch(searchInput.value));
searchClear.addEventListener("click", () => {
  searchInput.value = "";
  changeSearch("", true);
  searchInput.focus();
});
searchRetry.addEventListener("click", async () => {
  await refreshChats(true);
  await finishStartup();
});

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
    if (saved.revision >= target.titleChatRevision) target.updated = saved.updated;
    target.textEtag = saved.textEtag;
    target.text_revision = saved.text_revision;
    // The response is a complete Chat: show recordings added elsewhere before taking up
    // the whole-chat validator that covers them.
    addRecordings(target, saved.recordings);
    acknowledgeTitleMetadata(target, saved);
    if (saved.revision >= target.revision) {
      target.etag = saved.etag;
      target.revision = saved.revision;
    }
    renderClips();
    updateControls();
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

/** @param {Chat | null} next @param {string | null} [draftGroup] */
function setChat(next, draftGroup = null) {
  const refreshPending = listLoading;
  listGeneration++;
  titleLoadGeneration++;
  navigationGeneration++;
  if (titleEdit) cancelTitleEdit(titleEdit, false);
  creating = null;
  pendingChatId = newId();
  pendingGroupId = draftGroup;
  missingDraftGroup = false;
  draftUnsorted.hidden = true;
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
  if (refreshPending) void refreshChats();
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

/** Finish an inline rename before an action can navigate or cover its editor.
 * A pending read has no proposed value yet, so navigation can discard it safely. */
async function prepareTitleEditorToLeave() {
  const editing = titleEdit;
  if (!editing) return true;
  if (editing.loading) {
    cancelTitleEdit(editing, false);
    return true;
  }
  if (editing.needsExplicitRetry) return false;
  return await saveTitleEdit(editing, editing.value, false);
}

/** @param {() => void | Promise<void>} action */
async function runAfterTitleSave(action) {
  if (recording || busy || !(await prepareTitleEditorToLeave())) return;
  if (recording || busy) return;
  await action();
}

/** @param {string} id */
async function openChat(id) {
  if (recording || busy || id === chat?.id) return;
  if (!(await prepareTitleEditorToLeave()) || recording || busy) return;
  closeDrawer();
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

/** @param {string | null} [groupId] */
async function newChat(groupId = null) {
  if (recording || busy) return;
  if (!(await prepareTitleEditorToLeave()) || recording || busy) return;
  closeDrawer();
  busy = true;
  updateControls();
  try {
    if (!(await prepareToLeave())) return;
    setChat(null, groupId);
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
  if (!chat || recording || busy) return;
  const target = chat.id;
  if (!(await prepareTitleEditorToLeave()) || recording || busy || chat?.id !== target) return;
  if (!window.confirm("Discard your unsaved changes?")) return;
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

/** @param {TitleEdit} editing @param {boolean} [restoreFocus] */
function closeTitleEdit(editing, restoreFocus = true) {
  if (titleEdit !== editing) return;
  titleEdit = null;
  titleLoadGeneration++;
  if (editing.source === "heading") renderTitleHeading();
  else renderChats();
  updateControls();
  if (restoreFocus) restoreTitleFocus(editing);
}

/** @param {TitleEdit} editing */
function cancelTitleEdit(editing, restoreFocus = true) {
  if (titleEdit !== editing || editing.saving) return;
  closeTitleEdit(editing, restoreFocus);
}

/** @param {TitleEdit} editing */
function restoreTitleFocus(editing) {
  const target = editing.source === "heading" ? editing.trigger : chatRenameButton(editing.chatId);
  const fallback = editing.chatId ? chatRenameButton(editing.chatId) : chatTitleEdit;
  const focusTarget = target?.isConnected ? target : fallback?.isConnected ? fallback : chatTitle;
  focusTarget?.focus();
}

/** Keep the header's ordinary controls stable while an edit is elsewhere. */
function renderTitleHeading() {
  const editing =
    titleEdit?.source === "heading" && titleEdit.chatId === (chat?.id ?? null) ? titleEdit : null;
  if (editing) {
    if (!chatTitleArea.querySelector(".inline-title-editor"))
      chatTitleArea.replaceChildren(titleEditor(editing, true));
    return;
  }
  if (chatTitleArea.children[0] !== chatTitle)
    chatTitleArea.replaceChildren(chatTitle, chatTitleEdit);
  chatTitle.textContent = chat?.title ?? "New chat";
}

/** @param {TitleEdit} editing @param {boolean} [focus] */
function rerenderTitleEdit(editing, focus = false) {
  const selection = editing.input
    ? [editing.input.selectionStart, editing.input.selectionEnd]
    : null;
  if (editing.source === "heading") {
    replacingTitleEditor = true;
    chatTitleArea.replaceChildren(titleEditor(editing, true));
    replacingTitleEditor = false;
  } else renderChats();
  if (focus && editing.input?.isConnected) {
    editing.input.focus();
    if (selection) editing.input.setSelectionRange(selection[0], selection[1]);
  }
  updateControls();
}

/** @param {string} id @param {Chat} observed */
function updateSummaryTitle(id, observed) {
  const summary = chats.find((item) => item.id === id);
  if (!summary) return;
  summary.title = observed.title;
  summary.custom_title = observed.custom_title;
  summary.updated = observed.updated;
  summary.etag = observed.etag ?? summary.etag;
}

/** Read a canonical full Chat before an edit, without accepting its transcript or
 * whole-chat validator into the active editor. */
/** @param {string | null} id @param {ChatSummary | null} summary @param {"heading" | "sidebar"} source @param {HTMLElement} trigger */
async function beginTitleEdit(id, summary, source, trigger) {
  if (recording || busy) return;
  if (titleEdit) {
    if (titleEdit.chatId === id && titleEdit.source === source) {
      titleEdit.input?.focus();
      return;
    }
    if (!(await prepareTitleEditorToLeave()) || recording || busy) return;
  }
  const generation = navigationGeneration;
  const loadGeneration = ++titleLoadGeneration;
  const current = id && chat?.id === id ? chat : null;
  const initialTitle = summary?.title ?? current?.title ?? "New chat";
  const initialCustom = summary?.custom_title ?? current?.custom_title ?? null;
  /** @type {TitleEdit} */
  const editing = {
    generation,
    chatId: id,
    source,
    summary: summary ? { ...summary } : null,
    trigger,
    title: initialTitle,
    customTitle: initialCustom,
    titleEtag: current?.titleEtag ?? null,
    initialValue: initialCustom ?? initialTitle,
    value: initialCustom ?? initialTitle,
    dirty: false,
    needsExplicitRetry: false,
    error: null,
    loading: Boolean(id),
    saving: false,
    input: null,
    savePromise: null,
  };
  titleEdit = editing;
  if (source === "heading") renderTitleHeading();
  else renderChats();
  updateControls();
  if (editing.input?.isConnected && !editing.loading) {
    editing.input.focus();
    editing.input.select();
  }
  if (!id) return;
  try {
    const observed = await chatApi.get(id);
    if (
      titleEdit !== editing ||
      generation !== navigationGeneration ||
      loadGeneration !== titleLoadGeneration
    )
      return;
    editing.title = observed.title;
    editing.customTitle = observed.custom_title;
    editing.titleEtag = observed.titleEtag;
    editing.initialValue = observed.custom_title ?? observed.title;
    editing.value = editing.initialValue;
    editing.loading = false;
    if (chat?.id === id) acknowledgeTitleMetadata(chat, observed);
    updateSummaryTitle(id, observed);
    rerenderTitleEdit(editing, true);
    if (editing.input?.isConnected) editing.input.select();
  } catch (error) {
    if (titleEdit !== editing || generation !== navigationGeneration) return;
    editing.loading = false;
    editing.error =
      error instanceof Error ? error.message : "The current name could not be loaded.";
    editing.needsExplicitRetry = true;
    rerenderTitleEdit(editing, true);
  }
}

chatTitle.addEventListener(
  "click",
  () => void beginTitleEdit(chat?.id ?? null, null, "heading", chatTitle),
);
chatTitleEdit.addEventListener(
  "click",
  () => void beginTitleEdit(chat?.id ?? null, null, "heading", chatTitleEdit),
);

/** Title freshness is separate from the complete chat version acknowledged for deletion.
 * A newer title response can contain text this tab has not acknowledged yet.
 * @param {Chat} target
 * @param {ChatTitle} saved */
function acknowledgeTitleMetadata(target, saved) {
  if (saved.titleChatRevision < target.titleChatRevision) return;
  target.title = saved.title;
  target.custom_title = saved.custom_title;
  target.title_revision = saved.title_revision;
  target.titleEtag = saved.titleEtag;
  target.titleChatRevision = saved.titleChatRevision;
}

/** Apply a title response without acknowledging unseen text or replacing the editor draft.
 * @param {Chat} target @param {Chat} saved */
function acknowledgeTitle(target, saved) {
  if (saved.revision < target.revision) return;
  if (saved.revision >= target.titleChatRevision) target.updated = saved.updated;
  acknowledgeTitleMetadata(target, saved);
  addRecordings(target, saved.recordings);
  if (saved.text_revision === target.text_revision && saved.revision >= target.revision) {
    target.revision = saved.revision;
    target.etag = saved.etag;
  }
  renderClips();
  renderChats();
  updateControls();
}

/** @param {TitleEdit} editing @param {string | null} customTitle @param {boolean} restoreFocus */
function performTitleSave(editing, customTitle, restoreFocus) {
  return (async () => {
    if (titleEdit !== editing || recording || busy) return false;
    if (editing.generation !== navigationGeneration) return false;
    if (
      customTitle === editing.customTitle ||
      (customTitle !== null && customTitle === editing.initialValue && !editing.dirty)
    ) {
      closeTitleEdit(editing, restoreFocus);
      return true;
    }
    if (customTitle !== null && !customTitle.trim() && !editing.chatId) {
      editing.error = "Enter a chat name.";
      editing.needsExplicitRetry = true;
      rerenderTitleEdit(editing, true);
      return false;
    }
    if (customTitle === null && !editing.chatId) {
      closeTitleEdit(editing, restoreFocus);
      return true;
    }

    editing.saving = true;
    editing.error = null;
    updateControls();
    try {
      let targetId = editing.chatId;
      let target = targetId && chat?.id === targetId ? chat : null;
      if (!targetId) {
        await saveText();
        if (titleEdit !== editing || editing.generation !== navigationGeneration) return false;
        target = await ensureChat();
        targetId = target.id;
        editing.chatId = target.id;
        editing.titleEtag = target.titleEtag;
      } else if (target) {
        // A reset must derive from the latest acknowledged transcript. This also
        // preserves the old ordering when an autosave was already in flight.
        await saveText();
        if (titleEdit !== editing || editing.generation !== navigationGeneration) return false;
        target = chat?.id === targetId ? chat : null;
        if (target) editing.titleEtag = target.titleEtag;
      }
      if (titleEdit !== editing || editing.generation !== navigationGeneration) return false;
      if (!editing.titleEtag) {
        const latest = await chatApi.get(targetId);
        if (titleEdit !== editing || editing.generation !== navigationGeneration) return false;
        editing.title = latest.title;
        editing.customTitle = latest.custom_title;
        editing.titleEtag = latest.titleEtag;
        if (targetId === chat?.id) acknowledgeTitleMetadata(chat, latest);
      }
      if (!editing.titleEtag)
        throw new Error("The title version could not be loaded. Retry the save.");
      const saved = await chatApi.saveTitle(targetId, customTitle, editing.titleEtag);
      if (titleEdit !== editing || editing.generation !== navigationGeneration) return false;
      if (chat?.id === targetId) acknowledgeTitle(chat, saved);
      updateSummaryTitle(targetId, saved);
      editing.saving = false;
      closeTitleEdit(editing, false);
      await refreshChats();
      if (restoreFocus) restoreTitleFocus(editing);
      return true;
    } catch (error) {
      if (titleEdit !== editing || editing.generation !== navigationGeneration) return false;
      editing.error = error instanceof Error ? error.message : "The name could not be saved.";
      editing.needsExplicitRetry = true;
      if (
        error instanceof ApiRequestError &&
        error.code === "revision_conflict" &&
        editing.chatId
      ) {
        editing.titleEtag = null;
        try {
          const latest = await chatApi.get(editing.chatId);
          if (titleEdit !== editing || editing.generation !== navigationGeneration) return false;
          editing.title = latest.title;
          editing.customTitle = latest.custom_title;
          editing.titleEtag = latest.titleEtag;
          if (chat?.id === editing.chatId) acknowledgeTitleMetadata(chat, latest);
          updateSummaryTitle(editing.chatId, latest);
          editing.error =
            customTitle === null
              ? `The current name is “${latest.title}”. Choose Auto again to use the automatic name.`
              : `The current name is “${latest.title}”. Save again to use your name.`;
          await refreshChats();
        } catch {
          if (titleEdit === editing)
            editing.error = "The name changed elsewhere. Retry to load its current version.";
        }
      }
      return false;
    } finally {
      if (titleEdit === editing) {
        editing.saving = false;
        rerenderTitleEdit(editing, true);
      }
    }
  })();
}

/** @param {TitleEdit} editing @param {string | null} [customTitle] @param {boolean} [restoreFocus] @param {boolean} [explicit] */
function saveTitleEdit(
  editing,
  customTitle = editing.value,
  restoreFocus = false,
  explicit = false,
) {
  if (titleEdit !== editing) return Promise.resolve(false);
  if (editing.savePromise) return editing.savePromise;
  if (editing.loading || recording || busy) return Promise.resolve(false);
  if (editing.needsExplicitRetry && !explicit) return Promise.resolve(false);
  if (explicit) editing.needsExplicitRetry = false;
  /** @type {Promise<boolean>} */
  const tracked = performTitleSave(editing, customTitle, restoreFocus).finally(() => {
    if (editing.savePromise === tracked) editing.savePromise = null;
  });
  editing.savePromise = tracked;
  return tracked;
}

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

/** Keep a failed inline edit visible when the phone drawer is dismissed. */
async function dismissDrawer() {
  if (titleEdit && !(await prepareTitleEditorToLeave())) return;
  closeDrawer();
}

stopButton.addEventListener("click", () => void stopRecording());
liveMode.addEventListener("change", () => {
  livePreference = liveMode.checked;
  updateControls();
});
newChatButton.addEventListener("click", () => void newChat());
menuButton.addEventListener("click", () => {
  const open = !sidebar.classList.contains("open");
  if (open) {
    sidebar.classList.toggle("open", true);
    scrim.hidden = false;
    menuButton.setAttribute("aria-expanded", "true");
  } else void dismissDrawer();
});
scrim.addEventListener("click", () => void dismissDrawer());
modelSettingsButton.addEventListener("click", () => modelDialog.showModal());
modelSettingsClose.addEventListener("click", () => modelDialog.close());
transcript.addEventListener("input", () => {
  startupPending = false;
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

/** Retry startup navigation only while the initial blank editor is untouched. */
async function finishStartup() {
  if (!startupPending) return;
  if (
    navigationGeneration !== startupGeneration ||
    chat ||
    textDirty ||
    transcript.value ||
    recording
  ) {
    startupPending = false;
    return;
  }
  if (listError) {
    showError(new Error(STARTUP_ERROR));
    return;
  }
  if (shownQuery !== "" || searchQuery !== "") return;
  startupPending = false;
  hideError();
  const latest = chats[0];
  if (latest) await openChat(latest.id);
}

/** Reopen the most recently used chat, or start a new one. */
async function loadChats() {
  startupGeneration = navigationGeneration;
  busy = true;
  updateControls();
  await refreshChats(true);
  busy = false;
  updateControls();
  await finishStartup();
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
