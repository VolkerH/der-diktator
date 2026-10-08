import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { encodeWav } from "../../src/diktator/static/audio.js";
import { MicrophoneRecorder } from "../../src/diktator/static/recorder.js";
import { FakeSocket } from "./fake-socket.js";

class Element {
  constructor(tag = "div") {
    this.tag = tag;
    this.value = "";
    this.textContent = "";
    this.className = "";
    this.checked = true;
    this.disabled = false;
    this.hidden = true;
    this.readOnly = false;
    this.paused = true;
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    const classes = new Set();
    this.classList = {
      toggle: (name, force = !classes.has(name)) => {
        if (force) classes.add(name);
        else classes.delete(name);
        return force;
      },
      contains: (name) => classes.has(name),
    };
  }
  addEventListener(type, callback) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]);
  }
  async emit(type) {
    for (const callback of this.listeners.get(type) ?? []) await callback();
  }
  append(...children) {
    this.children.push(...children);
  }
  replaceChildren(...children) {
    this.children = children;
  }
  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
  setSelectionRange(start, end) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
  getContext() {
    return null;
  }
  async play() {
    this.paused = false;
  }
  pause() {
    this.paused = true;
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
    void this.emit("close");
  }
  load() {}
  removeAttribute() {}
  focus() {}
  select() {}
}

const id = (number) => String(number).padStart(32, "0");

/** An in-memory stand-in for the chat API, with switches for failure paths. */
function chatServer() {
  const server = {
    chats: new Map(),
    nextId: 1,
    failRecordings: false,
    failTranscription: false,
    batchPosts: [],
    storedTranscriptions: 0,
    modelRequests: [],
    requestedModels: [],
    models: {
      active: "phonon-2",
      busy: false,
      models: [
        {
          id: "phonon-2",
          name: "Phonon-2",
          languages: "English",
          language_labels: ["English"],
          live: true,
          download_mb: 164,
          installed: true,
          state: "ready",
          message: "",
        },
        {
          id: "parakeet-v3",
          name: "Parakeet v3",
          languages: "German, English",
          language_labels: ["German", "English", "+23 languages"],
          live: false,
          download_mb: 671,
          installed: false,
          state: "missing",
          message: "",
        },
        {
          id: "whisper-large-v3-turbo",
          name: "Whisper large-v3-turbo",
          languages: "German, English and many other languages",
          language_labels: ["German", "English", "Multilingual"],
          live: false,
          download_mb: 1622,
          installed: false,
          state: "missing",
          message: "",
        },
      ],
    },
    failModelAction: false,
  };
  server.add = (text, recordings = []) => {
    const chat = {
      id: id(server.nextId++),
      created: "2026-10-07T10:00:00Z",
      updated: "2026-10-07T10:00:00Z",
      text,
      recordings,
    };
    server.chats.set(chat.id, chat);
    return chat;
  };
  server.fetch = async (url, options = {}) => {
    const parsed = new URL(url, "http://localhost");
    url = parsed.pathname;
    if (parsed.searchParams.has("model"))
      server.requestedModels.push(parsed.searchParams.get("model"));
    const method = options.method ?? "GET";
    const json = (body, status = 200) => Response.json(body, { status });
    if (url === "/api/models") return json(server.models);
    if (url.startsWith("/api/models/")) {
      server.modelRequests.push(url);
      if (server.failModelAction) return json({ detail: "Download failed. Retry." }, 503);
      const [, modelId, action] = url.match(/^\/api\/models\/([^/]+)\/(.*)$/);
      const model = server.models.models.find((item) => item.id === modelId);
      if (action === "download") {
        model.installed = true;
        model.state = "installed";
      } else if (action === "delete") {
        model.installed = false;
        model.state = "missing";
        if (server.models.active === modelId) server.models.active = null;
      } else {
        for (const item of server.models.models)
          if (item.state === "ready") item.state = "installed";
        server.models.active = modelId;
        model.state = "ready";
      }
      return json(server.models, 202);
    }
    if (url === "/api/health") return json({ ready: true });
    if (url === "/api/transcribe") {
      server.batchPosts.push(options.body);
      return server.failTranscription
        ? json({ detail: "Engine unavailable. Retry." }, 503)
        : json({ text: "Complete recording." });
    }
    if (url === "/api/chats" && method === "GET") {
      return json(
        [...server.chats.values()].map((chat) => ({
          id: chat.id,
          title: chat.text || "New chat",
          updated: chat.updated,
          recording_count: chat.recordings.length,
        })),
      );
    }
    if (url === "/api/chats" && method === "POST") return json(server.add(""), 201);
    const [, chatId, rest] = url.match(/^\/api\/chats\/(\w+)(.*)$/) ?? [];
    const chat = server.chats.get(chatId);
    if (!chat) return json({ detail: "This chat no longer exists." }, 404);
    if (!rest && method === "GET") return json(chat);
    if (!rest && method === "DELETE") {
      server.chats.delete(chatId);
      return new Response(null, { status: 204 });
    }
    if (rest === "/text") {
      chat.text = JSON.parse(options.body).text;
      return json(chat);
    }
    if (rest === "/recordings") {
      if (server.failRecordings) return json({ detail: "The disk is full." }, 500);
      const recording = { id: id(server.nextId++), created: chat.updated, duration_seconds: 2 };
      chat.recordings.push(recording);
      return json(recording, 201);
    }
    if (rest.endsWith("/transcribe")) {
      server.storedTranscriptions++;
      return server.failTranscription
        ? json({ detail: "Engine unavailable. Retry." }, 503)
        : json({ text: "Stored recording." });
    }
    assert.fail(`Unexpected request ${method} ${url}`);
  };
  return server;
}

/** Run the real app module against browser boundaries, with no DOM package or server. */
async function appEnvironment(t, setup = () => {}, waitReady = true) {
  const elements = new Map();
  const element = (name) => {
    if (!elements.has(name)) elements.set(name, new Element());
    return elements.get(name);
  };
  const server = chatServer();
  setup(server);
  const sockets = [];
  const copied = [];
  const windowListeners = new Map();
  const state = { starts: 0, stops: 0, onSamples: null };
  const intervals = [];
  const samples = new Float32Array([0.5, -0.5]);
  const wav = new Blob([encodeWav(samples)], { type: "audio/wav" });
  t.mock.method(MicrophoneRecorder.prototype, "start", async (onSamples = null) => {
    state.starts++;
    state.onSamples = onSamples;
  });
  t.mock.method(MicrophoneRecorder.prototype, "stop", async () => {
    state.stops++;
    state.onSamples?.(samples);
    return wav;
  });
  t.mock.method(MicrophoneRecorder.prototype, "release", async () => {});
  const replacements = {
    document: { getElementById: element, createElement: (tag) => new Element(tag) },
    window: {
      isSecureContext: true,
      location: { href: "http://localhost:8080/" },
      setInterval: (callback, milliseconds) => {
        if (milliseconds === 2000) intervals.push(callback);
        return 1;
      },
      clearInterval() {},
      confirm: () => true,
      addEventListener: (type, callback) => windowListeners.set(type, callback),
    },
    navigator: {
      mediaDevices: {},
      clipboard: { writeText: async (text) => copied.push(text) },
    },
    WebSocket: class extends FakeSocket {
      constructor(url) {
        super();
        assert.equal(url, "ws://localhost:8080/api/stream?model=phonon-2");
        sockets.push(this);
      }
    },
    fetch: server.fetch,
  };
  const originals = new Map();
  for (const [name, value] of Object.entries(replacements)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    originals.set(name, original);
    Object.defineProperty(globalThis, name, { value, configurable: true });
  }
  t.after(() => {
    windowListeners.get("pagehide")?.();
    for (const [name, original] of originals) {
      if (original) Object.defineProperty(globalThis, name, original);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  // Each test gets fresh application state; the audio, stream, and chat modules stay real.
  await import(`../../src/diktator/static/app.js?case=${encodeURIComponent(t.name)}`);
  const app = { element, server, sockets, copied, state, wav, intervals };
  if (waitReady) await waitForIdle(app);
  else for (let i = 0; i < 5; i++) await setImmediate();
  return app;
}

async function startLive(app) {
  const starting = app.element("record").emit("click");
  const socket = app.sockets.at(-1);
  socket.event({ type: "ready" });
  await starting;
  return socket;
}

async function waitForEnd(socket) {
  for (let attempt = 0; attempt < 10; attempt++) {
    if (socket.sent.includes('{"type":"end"}')) return;
    await Promise.resolve();
  }
  assert.fail("The app did not finish its stream");
}

async function waitForIdle(app) {
  for (let attempt = 0; attempt < 50; attempt++) {
    await setImmediate();
    if (!app.element("record").disabled && !app.element("stage").classList.contains("busy")) return;
  }
  assert.fail("The app did not finish its work");
}

/** The sidebar's rendered rows as [title, active] pairs. */
function chatRows(app) {
  return app
    .element("chat-list")
    .children.map((item) => [
      item.children[0].children[0].textContent,
      item.classList.contains("active"),
    ]);
}

/** Place the cursor as if the user clicked into the transcript. */
function setCursor(app, start, end = start) {
  app.element("transcript").setSelectionRange(start, end);
}

test("live text is inserted at the cursor and the chat is stored with its audio", async (t) => {
  const app = await appEnvironment(t);
  assert.deepEqual(chatRows(app), [["New chat", true]]);
  const transcript = app.element("transcript");
  transcript.value = "Start end.";
  setCursor(app, 6);
  const socket = await startLive(app);
  assert.equal(app.element("live-mode").disabled, true);
  socket.event({ type: "partial", text: "Hello" });
  assert.equal(transcript.value, "Start Hello end.");
  socket.event({ type: "partial", text: "Hello world" });
  assert.equal(transcript.value, "Start Hello world end.");
  await app.element("stop").emit("click");
  await waitForEnd(socket);
  assert.ok(socket.sent[0] instanceof ArrayBuffer, "the final microphone chunk is sent first");
  socket.event({ type: "final", text: "Hello world.", segment: 1 });
  socket.event({ type: "done", text: "Hello world." });
  await waitForIdle(app);

  assert.equal(transcript.value, "Start Hello world. end.");
  assert.equal(transcript.selectionStart, "Start Hello world.".length);
  assert.equal(transcript.readOnly, false);
  const [stored] = app.server.chats.values();
  assert.equal(stored.text, "Start Hello world. end.");
  assert.equal(stored.recordings.length, 1);
  assert.equal(app.server.storedTranscriptions, 0, "live text needs no batch transcription");
  assert.deepEqual(app.server.batchPosts, []);
  assert.equal(app.element("clips").children.length, 1);
  assert.deepEqual(chatRows(app), [["Start Hello world. end.", true]]);
  await app.element("copy").emit("click");
  assert.deepEqual(app.copied, ["Start Hello world. end."]);
});

test("a failed live connection keeps recording and transcribes the stored WAV", async (t) => {
  const app = await appEnvironment(t);
  const socket = await startLive(app);
  socket.close();
  assert.match(app.element("status").textContent, /Recording continues/);
  assert.equal(app.state.stops, 0);
  await app.element("stop").emit("click");
  await waitForIdle(app);
  assert.equal(app.server.storedTranscriptions, 1);
  assert.equal(app.element("transcript").value, "Stored recording.");
  assert.equal(app.element("error").hidden, true);
});

test("the latest chat reopens, recording extends it, and clips can be transcribed again", async (t) => {
  const app = await appEnvironment(t, (server) => {
    server.add("Earlier words.", [
      { id: id(99), created: "2026-10-07T10:00:00Z", duration_seconds: 3 },
    ]);
  });
  const transcript = app.element("transcript");
  assert.equal(transcript.value, "Earlier words.");
  assert.equal(transcript.selectionStart, transcript.value.length);
  assert.equal(app.element("clips").children.length, 1);
  app.element("live-mode").checked = false;
  await app.element("live-mode").emit("change");
  assert.equal(app.element("stop").textContent, "Stop & transcribe");
  await app.element("record").emit("click");
  await app.element("stop").emit("click");
  await waitForIdle(app);
  assert.equal(transcript.value, "Earlier words. Stored recording.");
  assert.equal(app.server.chats.size, 1, "recording again extends the open chat");
  assert.equal([...app.server.chats.values()][0].recordings.length, 2);

  setCursor(app, 0);
  await app.element("clips").children[0].children[1].emit("click");
  await waitForIdle(app);
  assert.equal(transcript.value, "Stored recording. Earlier words. Stored recording.");
});

test("audio that cannot be stored is still transcribed and kept for a retry", async (t) => {
  const app = await appEnvironment(t);
  app.server.failRecordings = true;
  app.element("live-mode").checked = false;
  await app.element("record").emit("click");
  await app.element("stop").emit("click");
  await waitForIdle(app);
  assert.equal(app.element("transcript").value, "Complete recording.");
  assert.equal(app.server.batchPosts[0], app.wav);
  assert.match(app.element("error").textContent, /could not be saved: The disk is full/);
  const [clip] = app.element("clips").children;
  assert.ok(clip.classList.contains("unsaved"));

  app.server.failRecordings = false;
  await clip.children[1].emit("click");
  await waitForIdle(app);
  const [stored] = app.server.chats.values();
  assert.equal(stored.recordings.length, 1);
  assert.equal(stored.text, "Complete recording. Stored recording.");
  assert.equal(app.element("clips").children[0].classList.contains("unsaved"), false);
});

test("failed transcription restores the text and leaves the stored clip for a retry", async (t) => {
  const app = await appEnvironment(t, (server) => server.add("Keep me."));
  app.server.failTranscription = true;
  app.element("live-mode").checked = false;
  await app.element("record").emit("click");
  await app.element("stop").emit("click");
  await waitForIdle(app);
  assert.equal(app.element("transcript").value, "Keep me.");
  assert.equal(app.element("error").hidden, false);
  assert.equal(app.element("clips").children.length, 1);
});

test("chats can be switched, started anew, and deleted after confirming", async (t) => {
  const app = await appEnvironment(t, (server) => {
    server.add("First chat.");
    server.add("Second chat.");
  });
  assert.deepEqual(chatRows(app), [
    ["First chat.", true],
    ["Second chat.", false],
  ]);
  await app.element("chat-list").children[1].children[0].emit("click");
  await waitForIdle(app);
  assert.equal(app.element("transcript").value, "Second chat.");

  await app.element("new-chat").emit("click");
  await waitForIdle(app);
  assert.equal(app.element("transcript").value, "");
  assert.deepEqual(chatRows(app)[0], ["New chat", true]);
  assert.equal(app.server.chats.size, 2, "an empty new chat is not stored");

  const remove = app.element("chat-list").children[1].children[1];
  await remove.emit("click");
  assert.equal(app.server.chats.size, 2, "the first click only asks for confirmation");
  assert.equal(remove.textContent, "Delete");
  await remove.emit("click");
  await waitForIdle(app);
  assert.deepEqual(
    [...app.server.chats.values()].map((chat) => chat.text),
    ["Second chat."],
  );
});

test("connection failure preserves existing text", async (t) => {
  const app = await appEnvironment(t, (server) => server.add("My existing edits."));
  const starting = app.element("record").emit("click");
  app.sockets[0].emit("error");
  await starting;
  assert.equal(app.state.starts, 0);
  assert.equal(app.element("transcript").value, "My existing edits.");
  assert.equal(app.element("record").disabled, false);
});

test("Parakeet download is explicit, activation disables live text, and requests retain its identity", async (t) => {
  const app = await appEnvironment(t);
  const picker = app.element("model-picker");
  await selectModel(app, "parakeet-v3");
  assert.equal(app.element("record").disabled, true);
  assert.equal(downloadButton(app, "parakeet-v3").textContent, "Download");
  assert.deepEqual(app.server.modelRequests, []);
  await downloadButton(app, "parakeet-v3").emit("click");
  assert.equal(app.element("model-action").textContent, "Use model");
  assert.equal(app.server.models.active, "phonon-2");
  await app.element("model-action").emit("click");
  await waitForIdle(app);
  assert.equal(app.element("live-mode").checked, false);
  assert.equal(app.element("live-mode").disabled, true);
  await app.element("record").emit("click");
  assert.equal(picker.disabled, true);
  assert.equal(app.sockets.length, 0);
  await app.element("stop").emit("click");
  await waitForIdle(app);
  assert.deepEqual(app.server.requestedModels, ["parakeet-v3"]);
  await selectModel(app, "phonon-2");
  await app.element("model-action").emit("click");
  await waitForIdle(app);
  assert.equal(app.element("live-mode").checked, true);
  assert.equal(app.element("live-mode").disabled, false);
});

test("model action failures are visible and can be retried without losing text", async (t) => {
  const app = await appEnvironment(t, (server) => server.add("Keep these words."));
  await selectModel(app, "parakeet-v3");
  app.server.failModelAction = true;
  await downloadButton(app, "parakeet-v3").emit("click");
  assert.match(app.element("model-error").textContent, /Download failed/);
  assert.equal(app.element("transcript").value, "Keep these words.");
  assert.equal(downloadButton(app, "parakeet-v3").disabled, false);
  app.server.failModelAction = false;
  await downloadButton(app, "parakeet-v3").emit("click");
  assert.equal(app.element("model-action").textContent, "Use model");
});

test("startup selects persisted Parakeet while loading and becomes ready without another click", async (t) => {
  const app = await appEnvironment(
    t,
    (server) => {
      server.models.active = null;
      server.models.preferred = "parakeet-v3";
      server.models.models[0].state = "installed";
      Object.assign(server.models.models[1], { installed: true, state: "loading" });
    },
    false,
  );
  assert.equal(selectedModel(app), "parakeet-v3");
  assert.equal(app.element("record").disabled, true);
  app.server.models.active = "parakeet-v3";
  app.server.models.models[1].state = "ready";
  app.intervals[0]();
  await waitForIdle(app);
  assert.equal(selectedModel(app), "parakeet-v3");
  assert.equal(app.element("live-mode").checked, false);
});

test("a different tab switching models cannot change the model of a recorded fallback", async (t) => {
  const app = await appEnvironment(t);
  const stream = await startLive(app);
  app.server.models.active = "parakeet-v3";
  app.server.models.models[0].state = "installed";
  app.server.models.models[1].state = "ready";
  app.intervals[0]();
  for (let i = 0; i < 3; i++) await setImmediate();
  stream.close();
  await app.element("stop").emit("click");
  for (let i = 0; i < 10; i++) await setImmediate();
  assert.deepEqual(app.server.requestedModels, ["phonon-2"]);
  assert.equal(app.element("record").disabled, true);
});

function modelRadios(app) {
  return app.element("model-options").children.map((option) => option.children[0].children[0]);
}

async function selectModel(app, id) {
  const radio = modelRadios(app).find((radio) => radio.value === id);
  assert.ok(radio, `Missing model option ${id}`);
  radio.checked = true;
  await radio.emit("change");
}

function selectedModel(app) {
  return modelRadios(app).find((radio) => radio.checked)?.value;
}

test("Whisper pills explain capabilities in the picker and sidebar; activation uses batch transcription", async (t) => {
  const app = await appEnvironment(t);
  const option = app.element("model-options").children[2];
  const labels = option.children[0].children[1].children[1].children.map(
    (pill) => pill.textContent,
  );
  assert.deepEqual(labels, [
    "German",
    "English",
    "Multilingual",
    "After recording",
    "Download: 1.62 GB",
  ]);
  await selectModel(app, "whisper-large-v3-turbo");
  assert.deepEqual(
    app.element("model-summary-pills").children.map((pill) => pill.textContent),
    labels,
  );
  assert.equal(app.element("model-summary-name").textContent, "Whisper large-v3-turbo");
  assert.equal(downloadButton(app, "whisper-large-v3-turbo").textContent, "Download");
  assert.equal(app.element("record").disabled, true);
  assert.deepEqual(app.server.modelRequests, []);
  await downloadButton(app, "whisper-large-v3-turbo").emit("click");
  await app.element("model-action").emit("click");
  await waitForIdle(app);
  assert.equal(app.element("live-mode").disabled, true);
  assert.equal(app.element("live-mode").checked, false);
  assert.equal(app.element("model-options").children[2], option);
  await app.element("record").emit("click");
  await selectModel(app, "phonon-2");
  assert.equal(selectedModel(app), "whisper-large-v3-turbo");
  assert.equal(app.sockets.length, 0);
  await app.element("stop").emit("click");
  await waitForIdle(app);
  assert.deepEqual(app.server.requestedModels, ["whisper-large-v3-turbo"]);
});

function downloadButton(app, modelId) {
  return app
    .element("model-options")
    .children.find((option) => option.children[0].children[0].value === modelId).children[1];
}

test("download buttons reflect availability; deletion requires confirmation and preserves chat", async (t) => {
  const app = await appEnvironment(t, (server) => server.add("Keep my transcript."));
  const remove = downloadButton(app, "phonon-2");
  assert.equal(remove.textContent, "Delete download");
  assert.equal(downloadButton(app, "parakeet-v3").textContent, "Download");
  await remove.emit("click");
  assert.equal(app.element("model-delete-dialog").open, true);
  assert.match(app.element("model-delete-description").textContent, /Phonon-2/);
  assert.deepEqual(app.server.modelRequests, []);
  await app.element("model-delete-cancel").emit("click");
  assert.equal(app.element("model-delete-dialog").open, false);
  assert.deepEqual(app.server.modelRequests, []);
  await remove.emit("click");
  await app.element("model-delete-confirm").emit("click");
  assert.equal(app.element("model-delete-dialog").open, false);
  assert.deepEqual(app.server.modelRequests, ["/api/models/phonon-2/delete"]);
  assert.equal(remove.textContent, "Download");
  assert.equal(app.server.models.active, null);
  assert.equal(app.element("record").disabled, true);
  assert.equal(app.element("transcript").value, "Keep my transcript.");
  await remove.emit("click");
  assert.equal(remove.textContent, "Delete download");
  assert.equal(app.element("model-action").hidden, false);
});

test("delete confirmation pins its target and handles failure without losing installation", async (t) => {
  const app = await appEnvironment(t);
  await downloadButton(app, "phonon-2").emit("click");
  await selectModel(app, "parakeet-v3");
  app.server.failModelAction = true;
  await app.element("model-delete-confirm").emit("click");
  assert.deepEqual(app.server.modelRequests, ["/api/models/phonon-2/delete"]);
  assert.equal(app.element("model-error").hidden, false);
  assert.equal(downloadButton(app, "phonon-2").textContent, "Delete download");
});

test("recording and server work disable deletion, including an already open confirmation", async (t) => {
  const app = await appEnvironment(t);
  const stream = await startLive(app);
  assert.equal(downloadButton(app, "phonon-2").disabled, true);
  await downloadButton(app, "phonon-2").emit("click");
  assert.notEqual(app.element("model-delete-dialog").open, true);
  const stopping = app.element("stop").emit("click");
  await waitForEnd(stream);
  stream.event({ type: "done" });
  await stopping;
  await waitForIdle(app);
  await downloadButton(app, "phonon-2").emit("click");
  app.server.models.busy = true;
  app.intervals[0]();
  for (let i = 0; i < 5; i++) await setImmediate();
  assert.equal(app.element("model-delete-confirm").disabled, true);
  await app.element("model-delete-confirm").emit("click");
  assert.deepEqual(app.server.modelRequests, []);
});

for (const [name, body, message] of [
  ["coded", { detail: "Wait for the model.", code: "model_busy" }, "Wait for the model."],
  ["legacy", { detail: "Try again later." }, "Try again later."],
  ["non-string detail", { detail: ["bad input"] }, "The model operation failed. Retry."],
  ["non-JSON", null, "The model operation failed. Retry."],
]) {
  test(`model actions tolerate ${name} errors and keep their message visible`, async (t) => {
    const app = await appEnvironment(t);
    const fetch = globalThis.fetch;
    t.mock.method(globalThis, "fetch", async (url, options) => {
      if (String(url).includes("/download")) {
        return body === null
          ? new Response("gateway", { status: 502 })
          : Response.json(body, { status: 409 });
      }
      return fetch(url, options);
    });
    await downloadButton(app, "parakeet-v3").emit("click");
    assert.equal(app.element("model-error").hidden, false);
    assert.equal(app.element("model-error").textContent, message);
    assert.equal(downloadButton(app, "parakeet-v3").disabled, false);
  });
}
