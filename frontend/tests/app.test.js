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
  async emit(type, event = {}) {
    for (const callback of this.listeners.get(type) ?? []) await callback(event);
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
  click() {
    void this.emit("click");
  }
  load() {}
  removeAttribute() {}
  focus() {
    if (!this.disabled) globalThis.document.activeElement = this;
  }
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
      revision: 1,
      text_revision: 1,
      title_revision: 1,
      title: text || "New chat",
      custom_title: null,
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
    const titleEtag = (chat) => `"title-${chat.id}-${chat.title_revision}"`;
    const json = (body, status = 200) =>
      Response.json(body, {
        status,
        headers: body?.recordings
          ? {
              ETag: `"chat-${body.id}-${body.revision}"`,
              "Text-ETag": `"text-${body.id}-${body.text_revision}"`,
              "Title-ETag": titleEtag(body),
            }
          : undefined,
      });
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
          title: chat.title,
          custom_title: chat.custom_title,
          updated: chat.updated,
          recording_count: chat.recordings.length,
          etag: `"chat-${chat.id}-${chat.revision}"`,
        })),
      );
    }
    if (url === "/api/chats" && method === "POST") return json(server.add(""), 201);
    const [, chatId, rest] = url.match(/^\/api\/chats\/(\w+)(.*)$/) ?? [];
    if (!rest && method === "PUT") {
      let existing = server.chats.get(chatId);
      if (existing) return json(existing);
      existing = server.add("");
      server.chats.delete(existing.id);
      existing.id = chatId;
      server.chats.set(chatId, existing);
      return json(existing, 201);
    }
    const chat = server.chats.get(chatId);
    if (!chat) return json({ detail: "This chat no longer exists." }, 404);
    if (!rest && method === "GET") return json(chat);
    if (!rest && method === "DELETE") {
      if (options.headers?.["If-Match"] !== `"chat-${chat.id}-${chat.revision}"`)
        return json({ detail: "This chat changed elsewhere.", code: "revision_conflict" }, 412);
      server.chats.delete(chatId);
      return new Response(null, { status: 204 });
    }
    if (rest === "/title") {
      if (method === "GET")
        return Response.json(
          {
            title: chat.title,
            custom_title: chat.custom_title,
            title_revision: chat.title_revision,
          },
          { headers: { ETag: titleEtag(chat), "Chat-Revision": String(chat.revision) } },
        );
      if (options.headers?.["If-Match"] !== titleEtag(chat))
        return json({ detail: "This chat changed elsewhere.", code: "revision_conflict" }, 412);
      const value = JSON.parse(options.body).custom_title;
      chat.custom_title = value === null ? null : value.trim();
      chat.title = chat.custom_title ?? (chat.text || "New chat");
      chat.title_revision++;
      chat.revision++;
      return json(chat);
    }
    if (rest === "/text") {
      if (options.headers?.["If-Match"] !== `"text-${chat.id}-${chat.text_revision}"`)
        return json({ detail: "This chat changed elsewhere.", code: "revision_conflict" }, 412);
      chat.text = JSON.parse(options.body).text;
      chat.title = chat.custom_title ?? (chat.text || "New chat");
      chat.revision++;
      chat.text_revision++;
      return json(chat);
    }
    if (rest === "/recordings" || /^\/recordings\/\w+$/u.test(rest)) {
      if (server.failRecordings) return json({ detail: "The disk is full." }, 500);
      const recordingId = rest.split("/")[2] ?? id(server.nextId++);
      const existing = chat.recordings.find((clip) => clip.id === recordingId);
      if (existing) {
        return Response.json(existing, {
          headers: {
            "Chat-ETag": `"chat-${chat.id}-${chat.revision}"`,
            "Chat-Revision": String(chat.revision),
          },
        });
      }
      const recording = { id: recordingId, created: chat.updated, duration_seconds: 2 };
      chat.revision++;
      chat.recordings.push(recording);
      return Response.json(recording, {
        status: 201,
        headers: {
          "Chat-ETag": `"chat-${chat.id}-${chat.revision}"`,
          "Chat-Revision": String(chat.revision),
        },
      });
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
  const app = { element, server, sockets, copied, state, wav, intervals, windowListeners };
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

async function settle() {
  for (let attempt = 0; attempt < 15; attempt++) await setImmediate();
}

async function editAndSave(t, app, text) {
  app.element("transcript").value = text;
  await app.element("transcript").emit("input");
  t.mock.timers.tick(700);
  await settle();
}

test("a conflict keeps the draft, drops queued saves, and confirms before switching", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const app = await appEnvironment(t, (server) => {
    server.add("First");
    server.add("Second");
  });
  const fetch = globalThis.fetch;
  let resolveConflict;
  let saves = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url).endsWith("/text")) {
      saves++;
      return await new Promise((resolve) => {
        resolveConflict = resolve;
      });
    }
    return fetch(url, options);
  });
  await editAndSave(t, app, "My first draft");
  await editAndSave(t, app, "My latest draft");
  assert.equal(saves, 1);
  resolveConflict(
    Response.json({ detail: "Changed elsewhere", code: "revision_conflict" }, { status: 412 }),
  );
  await settle();
  assert.equal(saves, 1, "the queued save is dropped after the conflict");
  assert.equal(app.element("transcript").value, "My latest draft");
  assert.equal(app.element("text-conflict").hidden, false);
  assert.equal(app.element("save-state").textContent, "This chat changed elsewhere");
  const confirmations = [];
  t.mock.method(globalThis.window, "confirm", (message) => {
    confirmations.push(message);
    return false;
  });
  await app.element("chat-list").children[1].children[0].emit("click");
  await settle();
  assert.equal(app.element("transcript").value, "My latest draft");
  assert.deepEqual(confirmations, ["Discard your unsaved changes?"]);
  t.mock.method(globalThis.window, "confirm", () => true);
  await app.element("chat-list").children[1].children[0].emit("click");
  await waitForIdle(app);
  assert.equal(app.element("transcript").value, "Second");
  assert.equal(app.element("text-conflict").hidden, true);
  assert.equal(saves, 1);
});

for (const destination of ["switch", "new"]) {
  test(`a network save failure requires confirmation before ${destination}`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const app = await appEnvironment(t, (server) => {
      server.add("First");
      server.add("Second");
    });
    const fetch = globalThis.fetch;
    t.mock.method(globalThis, "fetch", async (url, options) => {
      if (String(url).endsWith("/text")) throw new TypeError("Network unavailable");
      return fetch(url, options);
    });
    await editAndSave(t, app, "Keep this draft");
    assert.equal(app.element("save-state").textContent, "Not saved");
    t.mock.method(globalThis.window, "confirm", () => false);
    const navigate = async () => {
      if (destination === "switch")
        await app.element("chat-list").children[1].children[0].emit("click");
      if (destination === "new") await app.element("new-chat").emit("click");
      await settle();
    };
    await navigate();
    assert.equal(app.element("transcript").value, "Keep this draft");
    assert.equal(app.server.chats.size, 2);
    t.mock.method(globalThis.window, "confirm", () => true);
    await navigate();
    assert.equal(app.element("transcript").value, destination === "switch" ? "Second" : "");
    assert.equal(app.server.chats.size, 2);
  });
}

for (const destination of ["new"]) {
  test(`a conflicted draft confirms before ${destination}`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const app = await appEnvironment(t, (server) => {
      server.add("First");
      server.add("Second");
    });
    [...app.server.chats.values()][0].text_revision++;
    await editAndSave(t, app, "Conflicted draft");
    t.mock.method(globalThis.window, "confirm", () => false);
    const navigate = async () => {
      await app.element("new-chat").emit("click");
      await settle();
    };
    await navigate();
    assert.equal(app.element("transcript").value, "Conflicted draft");
    assert.equal(app.server.chats.size, 2);
    t.mock.method(globalThis.window, "confirm", () => true);
    await navigate();
    assert.equal(app.element("transcript").value, "");
    assert.equal(app.server.chats.size, 2);
  });
}

test("Load latest confirms draft discard and Copy my version keeps it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const app = await appEnvironment(t, (server) => server.add("Original"));
  const stored = [...app.server.chats.values()][0];
  stored.text = "Remote version";
  stored.text_revision++;
  await editAndSave(t, app, "Local version");
  await app.element("copy-version").emit("click");
  await settle();
  assert.deepEqual(app.copied, ["Local version"]);
  t.mock.method(globalThis.window, "confirm", () => false);
  await app.element("load-latest").emit("click");
  assert.equal(app.element("transcript").value, "Local version");
  t.mock.method(globalThis.window, "confirm", () => true);
  await app.element("load-latest").emit("click");
  assert.equal(app.element("transcript").value, "Remote version");
  assert.equal(app.element("text-conflict").hidden, true);
  await editAndSave(t, app, "An acknowledged edit");
  assert.equal(stored.text, "An acknowledged edit");
});

test("pagehide keeps the quoted text validator and skips conflicted text", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const app = await appEnvironment(t, (server) => server.add("Original"));
  const fetch = globalThis.fetch;
  const saves = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url).endsWith("/text")) saves.push(options);
    return fetch(url, options);
  });
  app.element("transcript").value = "Leaving draft";
  await app.element("transcript").emit("input");
  app.windowListeners.get("pagehide")();
  await settle();
  assert.equal(saves.length, 1);
  assert.equal(saves[0].keepalive, true);
  assert.equal(saves[0].headers["If-Match"], `"text-${id(1)}-1"`);
  // The closing request has no acknowledgement; a later save conflicts safely.
  await editAndSave(t, app, "Conflicted draft");
  assert.equal(app.element("text-conflict").hidden, false);
  const beforeClose = saves.length;
  app.windowListeners.get("pagehide")();
  await settle();
  assert.equal(saves.length, beforeClose);
});

test("creation and recording retries reuse their chosen IDs after lost responses", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const app = await appEnvironment(t);
  const fetch = globalThis.fetch;
  const creates = [],
    uploads = [];
  let loseCreate = true,
    loseUpload = true;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const response = await fetch(url, options);
    if (options?.method === "PUT" && /^\/api\/chats\/[a-f0-9]{32}$/u.test(String(url))) {
      creates.push(url);
      if (loseCreate) {
        loseCreate = false;
        throw new TypeError("Response lost");
      }
    }
    if (options?.method === "PUT" && String(url).includes("/recordings/")) {
      uploads.push(url);
      if (loseUpload) {
        loseUpload = false;
        throw new TypeError("Response lost");
      }
    }
    return response;
  });
  await editAndSave(t, app, "Draft");
  await editAndSave(t, app, "Draft retry");
  assert.equal(creates.length, 2);
  assert.equal(creates[0], creates[1]);
  assert.equal(app.server.chats.size, 1);
  app.element("live-mode").checked = false;
  await app.element("record").emit("click");
  await app.element("stop").emit("click");
  await waitForIdle(app);
  await app.element("clips").children.at(-1).children[1].emit("click");
  await waitForIdle(app);
  assert.equal(uploads.length, 2);
  assert.equal(uploads[0], uploads[1]);
  assert.equal([...app.server.chats.values()][0].recordings.length, 1);
});

test("edits made during a save remain dirty until their own snapshot is acknowledged", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const app = await appEnvironment(t, (server) => server.add("Original"));
  const fetch = globalThis.fetch;
  let release;
  let pending = true;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const response = await fetch(url, options);
    if (String(url).endsWith("/text") && pending) {
      pending = false;
      await new Promise((resolve) => {
        release = resolve;
      });
    }
    return response;
  });
  await editAndSave(t, app, "First edit");
  app.element("transcript").value = "Later edit";
  await app.element("transcript").emit("input");
  release();
  await settle();
  assert.equal(app.element("transcript").value, "Later edit");
  assert.equal(app.element("save-state").textContent, "Editing…");
  t.mock.timers.tick(700);
  await settle();
  assert.equal([...app.server.chats.values()][0].text, "Later edit");
  assert.equal(app.element("save-state").textContent, "Saved");
});

test("a late list response is ignored after navigating away and back to the same chat", async (t) => {
  const app = await appEnvironment(t, (server) => {
    server.add("First");
    server.add("Second");
  });
  const fetch = globalThis.fetch;
  let release;
  let deferList = true;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const response = await fetch(url, options);
    if (url === "/api/chats" && deferList) {
      deferList = false;
      const stale = await response.json();
      stale[1].title = "Obsolete title from another navigation";
      return await new Promise((resolve) => {
        release = () => resolve(Response.json(stale));
      });
    }
    return response;
  });
  app.element("live-mode").checked = false;
  await app.element("record").emit("click");
  await app.element("stop").emit("click");
  await waitForIdle(app);
  assert.equal(typeof release, "function");
  const firstDraft = app.element("transcript").value;
  await app.element("chat-list").children[1].children[0].emit("click");
  await waitForIdle(app);
  await app.element("chat-list").children[0].children[0].emit("click");
  await waitForIdle(app);
  assert.equal(app.element("transcript").value, firstDraft);
  const beforeResponse = chatRows(app);
  release();
  await settle();
  assert.deepEqual(chatRows(app), beforeResponse);
  assert.equal(app.element("transcript").value, firstDraft);
});

async function deleteRow(app, index) {
  const remove = app.element("chat-list").children[index].children[1];
  await remove.emit("click");
  await remove.emit("click");
  await settle();
}

for (const failure of ["network", "conflict"]) {
  test(`sidebar deletion preserves a ${failure} draft and retained audio without prompts or saves`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const app = await appEnvironment(t, (server) => {
      server.add("First");
      server.add("Second");
      server.failRecordings = true;
    });
    app.element("live-mode").checked = false;
    await app.element("record").emit("click");
    await app.element("stop").emit("click");
    await waitForIdle(app);
    const fetch = globalThis.fetch;
    const calls = [];
    t.mock.method(globalThis, "fetch", async (url, options) => {
      calls.push([url, options]);
      if (String(url).endsWith("/text")) {
        if (failure === "network") throw new TypeError("Network unavailable");
        return Response.json(
          { detail: "Changed elsewhere", code: "revision_conflict" },
          { status: 412 },
        );
      }
      return fetch(url, options);
    });
    await editAndSave(t, app, "My retained draft");
    const clipsBefore = app.element("clips").children.length;
    calls.length = 0;
    t.mock.method(globalThis.window, "confirm", () =>
      assert.fail("Deleting another chat cannot discard this chat"),
    );
    await deleteRow(app, 1);
    assert.equal(app.server.chats.size, 1);
    assert.equal(app.element("transcript").value, "My retained draft");
    assert.equal(app.element("clips").children.length, clipsBefore);
    assert.deepEqual(
      calls.map(([url]) => url),
      [`/api/chats/${id(2)}`, "/api/chats"],
    );
    assert.equal(calls[0][1].headers["If-Match"], `"chat-${id(2)}-1"`);
  });
}

test("sidebar deletion rejects an entry changed since its list was read, then retries its current version", async (t) => {
  const app = await appEnvironment(t, (server) => {
    server.add("First");
    server.add("Second");
  });
  app.server.chats.get(id(2)).revision++;
  await deleteRow(app, 1);
  assert.equal(app.server.chats.size, 2);
  assert.match(app.element("error").textContent, /changed elsewhere/);
  assert.equal(app.element("transcript").value, "First");
  await deleteRow(app, 1);
  assert.equal(app.server.chats.size, 1, "the refreshed entry can be deleted on retry");
});

for (const changed of [false, true]) {
  test(`current deletion ${changed ? "preserves failed draft and audio" : "discards on success"} without saving text`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const app = await appEnvironment(t, (server) => {
      server.add("Original");
      server.failRecordings = true;
    });
    app.element("live-mode").checked = false;
    await app.element("record").emit("click");
    await app.element("stop").emit("click");
    await waitForIdle(app);
    app.element("transcript").value = "Unsaved draft";
    await app.element("transcript").emit("input");
    const clipsBefore = app.element("clips").children.length;
    if (changed) app.server.chats.get(id(1)).revision++;
    const fetch = globalThis.fetch;
    let saves = 0;
    t.mock.method(globalThis, "fetch", async (url, options) => {
      if (String(url).endsWith("/text")) saves++;
      return fetch(url, options);
    });
    t.mock.method(globalThis.window, "confirm", () =>
      assert.fail("Deletion already has its own confirmation"),
    );
    await deleteRow(app, 0);
    t.mock.timers.tick(700);
    await settle();
    assert.equal(saves, 0);
    assert.equal(app.server.chats.size, changed ? 1 : 0);
    assert.equal(app.element("transcript").value, changed ? "Unsaved draft" : "");
    assert.equal(app.element("clips").children.length, changed ? clipsBefore : 0);
    if (changed) assert.match(app.element("error").textContent, /changed elsewhere/);
  });
}

test("current deletion waits for the submitted save and drops queued and closing-page saves", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const app = await appEnvironment(t, (server) => server.add("Original"));
  const fetch = globalThis.fetch;
  let release;
  let saves = 0;
  let deletes = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const response = await fetch(url, options);
    if (String(url).endsWith("/text")) {
      saves++;
      await new Promise((resolve) => {
        release = resolve;
      });
    }
    if (options?.method === "DELETE") {
      deletes++;
      assert.equal(options.headers["If-Match"], `"chat-${id(1)}-2"`);
    }
    return response;
  });
  await editAndSave(t, app, "Submitted draft");
  await editAndSave(t, app, "Queued draft");
  await deleteRow(app, 0);
  app.windowListeners.get("pagehide")();
  await settle();
  assert.equal(deletes, 0);
  assert.equal(saves, 1);
  assert.equal(app.element("transcript").value, "Queued draft");
  release();
  await waitForIdle(app);
  assert.equal(deletes, 1);
  assert.equal(saves, 1);
  assert.equal(app.server.chats.size, 0);
});

test("successful upload requires no chat GET and cannot freshen a stale text validator", async (t) => {
  const app = await appEnvironment(t, (server) => server.add("Original"));
  const stored = app.server.chats.get(id(1));
  stored.text = "Remote edit";
  stored.text_revision++;
  stored.revision++;
  const fetch = globalThis.fetch;
  let gets = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url === `/api/chats/${id(1)}` && (!options?.method || options.method === "GET")) {
      gets++;
      throw new TypeError("Reading the chat failed");
    }
    return fetch(url, options);
  });
  app.element("live-mode").checked = false;
  await app.element("record").emit("click");
  await app.element("stop").emit("click");
  await waitForIdle(app);
  assert.equal(gets, 0);
  assert.equal(stored.recordings.length, 1);
  assert.equal(
    app.element("clips").children.length,
    1,
    "no duplicate unsaved clip after successful upload",
  );
  assert.equal(stored.text, "Remote edit");
  assert.equal(app.element("transcript").value, "Original Stored recording.");
  assert.equal(app.element("text-conflict").hidden, false);
});

/** A recording another tab stored, unseen by this one. */
function addRemoteRecording(stored) {
  stored.recordings.push({ id: "f".repeat(32), created: stored.updated, duration_seconds: 3 });
  stored.revision++;
}

test("an upload after a change elsewhere keeps the old chat validator for deletion", async (t) => {
  const app = await appEnvironment(t, (server) => server.add("Original"));
  const stored = app.server.chats.get(id(1));
  addRemoteRecording(stored);
  // A failed text save keeps the upload as this tab's only acknowledgement.
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url).endsWith("/text")) throw new TypeError("Saving the text failed");
    return fetch(url, options);
  });
  app.element("live-mode").checked = false;
  await app.element("record").emit("click");
  await app.element("stop").emit("click");
  await waitForIdle(app);
  assert.equal(stored.recordings.length, 2);
  assert.equal(app.element("clips").children.length, 1);
  await deleteRow(app, 0);
  assert.equal(app.server.chats.size, 1, "the unseen recording is not deleted");
  assert.match(app.element("error").textContent, /changed elsewhere/);
});

test("a text save shows recordings added elsewhere before taking up their validator", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const app = await appEnvironment(t, (server) => server.add("Original"));
  addRemoteRecording(app.server.chats.get(id(1)));
  await editAndSave(t, app, "Edited here");
  assert.equal(app.element("clips").children.length, 1);
  await deleteRow(app, 0);
  assert.equal(app.server.chats.size, 0);
});

test("a late refresh cannot replace the sidebar while navigation GET is pending", async (t) => {
  const app = await appEnvironment(t, (server) => {
    server.add("First");
    server.add("Second");
  });
  const fetch = globalThis.fetch;
  let releaseList;
  let releaseChat;
  let deferList = true;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const response = await fetch(url, options);
    if (url === "/api/chats" && deferList) {
      deferList = false;
      const stale = await response.json();
      stale[1].title = "Stale title arriving during navigation";
      return await new Promise((resolve) => {
        releaseList = () => resolve(Response.json(stale));
      });
    }
    if (url === `/api/chats/${id(2)}` && (!options?.method || options.method === "GET")) {
      return await new Promise((resolve) => {
        releaseChat = () => resolve(response);
      });
    }
    return response;
  });
  app.element("live-mode").checked = false;
  await app.element("record").emit("click");
  await app.element("stop").emit("click");
  await waitForIdle(app);
  const before = chatRows(app);
  await app.element("chat-list").children[1].children[0].emit("click");
  await settle();
  assert.equal(typeof releaseChat, "function");
  releaseList();
  await settle();
  assert.deepEqual(chatRows(app), before);
  releaseChat();
  await waitForIdle(app);
  assert.equal(app.element("transcript").value, "Second");
});

async function submitTitle(app, value) {
  app.element("title-input").value = value;
  await app.element("title-form").emit("submit", { preventDefault() {} });
  await settle();
}

test("title editor cancellation keeps a new chat lazy; submitted literal labels are canonical", async (t) => {
  const app = await appEnvironment(t);
  await app.element("chat-title").emit("click");
  assert.equal(app.element("title-editor").open, true);
  await app.element("title-cancel").emit("click");
  assert.equal(app.server.chats.size, 0);
  await app.element("chat-title").emit("click");
  await submitTitle(app, "");
  assert.equal(app.server.chats.size, 0);
  assert.equal(app.element("title-error").hidden, false);
  await submitTitle(app, " <b>Notes</b> ");
  assert.equal(app.server.chats.size, 1);
  assert.equal(app.element("chat-title").textContent, "<b>Notes</b>");
  assert.deepEqual(chatRows(app), [["<b>Notes</b>", true]]);
  assert.equal(app.element("title-editor").open, false);
  await app.element("chat-title").emit("click");
  await app.element("title-reset").emit("click");
  await settle();
  assert.equal(app.element("chat-title").textContent, "New chat");
});

test("unsaved transcript uses its acknowledged server title until autosave completes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const app = await appEnvironment(t, (server) => {
    const chat = server.add("Transcript text");
    chat.title = "A canonical server name";
  });
  app.element("transcript").value = "New draft";
  await app.element("transcript").emit("input");
  assert.equal(app.element("chat-title").textContent, "A canonical server name");
  assert.deepEqual(chatRows(app), [["A canonical server name", true]]);
  t.mock.timers.tick(700);
  await settle();
  assert.equal(app.element("chat-title").textContent, "New draft");
});

test("rename waits for pending text saves and keeps newer editor drafts", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const app = await appEnvironment(t, (server) => server.add("Original"));
  const fetch = globalThis.fetch;
  let releaseText;
  let releaseTitle;
  let deferText = true;
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const response = await fetch(url, options);
    if (String(url).endsWith("/text")) {
      calls.push("text");
      if (deferText) {
        deferText = false;
        await new Promise((resolve) => {
          releaseText = resolve;
        });
      }
    }
    if (String(url).endsWith("/title") && options?.method === "PUT") {
      calls.push("title");
      await new Promise((resolve) => {
        releaseTitle = resolve;
      });
    }
    return response;
  });
  await editAndSave(t, app, "Submitted text");
  await app.element("chat-title").emit("click");
  await submitTitle(app, "Manual title");
  assert.deepEqual(calls, ["text"]);
  releaseText();
  await settle();
  assert.deepEqual(calls, ["text", "title"]);
  app.element("transcript").value = "Newer draft";
  await app.element("transcript").emit("input");
  releaseTitle();
  await settle();
  assert.equal(app.element("transcript").value, "Newer draft");
  assert.equal(app.element("chat-title").textContent, "Manual title");
  t.mock.timers.tick(700);
  await settle();
  assert.equal(app.server.chats.get(id(1)).text, "Newer draft");
  assert.equal(app.element("chat-title").textContent, "Manual title");
});

test("rename conflicts preserve input, read current metadata and retry explicitly", async (t) => {
  const app = await appEnvironment(t, (server) => server.add("Original"));
  await app.element("chat-title").emit("click");
  const stored = app.server.chats.get(id(1));
  stored.custom_title = "Remote name";
  stored.title = "Remote name";
  stored.title_revision++;
  stored.revision++;
  await submitTitle(app, "My name");
  assert.equal(app.element("title-editor").open, true);
  assert.equal(app.element("title-input").value, "My name");
  assert.equal(app.element("chat-title").textContent, "Remote name");
  assert.match(app.element("title-error").textContent, /Remote name/);
  assert.equal(stored.title, "Remote name");
  await submitTitle(app, "My name");
  assert.equal(stored.title, "My name");
  assert.equal(app.element("title-editor").open, false);
});

test("title network failure keeps the confirmed label and input", async (t) => {
  const app = await appEnvironment(t, (server) => server.add("Original"));
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url).endsWith("/title")) throw new TypeError("Network unavailable");
    return fetch(url, options);
  });
  await app.element("chat-title").emit("click");
  await submitTitle(app, "Keep this input");
  assert.equal(app.element("chat-title").textContent, "Original");
  assert.equal(app.element("title-input").value, "Keep this input");
  assert.equal(app.element("title-editor").open, true);
  assert.match(app.element("title-error").textContent, /Network unavailable/);
});

test("title responses with remote text never freshen the old text validator", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const app = await appEnvironment(t, (server) => server.add("Original"));
  const stored = app.server.chats.get(id(1));
  stored.custom_title = "Manual";
  stored.title = "Manual";
  // Fetch the manual title first, as a real reload would.
  await app.element("new-chat").emit("click");
  await waitForIdle(app);
  await app.element("chat-list").children[1].children[0].emit("click");
  await waitForIdle(app);
  stored.text = "Remote text";
  stored.text_revision++;
  stored.revision++;
  await app.element("chat-title").emit("click");
  await submitTitle(app, "Renamed");
  assert.equal(app.element("transcript").value, "Original");
  await editAndSave(t, app, "My draft");
  assert.equal(app.element("text-conflict").hidden, false);
  assert.equal(stored.text, "Remote text");
});

test("late title responses are ignored after navigating to another chat", async (t) => {
  const app = await appEnvironment(t, (server) => {
    server.add("First");
    server.add("Second");
  });
  const fetch = globalThis.fetch;
  let release;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const response = await fetch(url, options);
    if (String(url).endsWith("/title") && options?.method === "PUT")
      await new Promise((resolve) => {
        release = resolve;
      });
    return response;
  });
  await app.element("chat-title").emit("click");
  await submitTitle(app, "Renamed first");
  await app.element("title-cancel").emit("click");
  await app.element("chat-list").children[1].children[0].emit("click");
  await waitForIdle(app);
  release();
  await settle();
  assert.equal(app.element("chat-title").textContent, "Second");
  assert.equal(app.element("transcript").value, "Second");
});

test("a delayed reset response cannot replace a newer title from autosave", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const app = await appEnvironment(t, (server) => {
    const chat = server.add("Original");
    chat.title = chat.custom_title = "Manual";
  });
  const fetch = globalThis.fetch;
  let release;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const response = await fetch(url, options);
    if (String(url).endsWith("/title") && options?.method === "PUT")
      await new Promise((resolve) => {
        release = resolve;
      });
    return response;
  });
  await app.element("chat-title").emit("click");
  await app.element("title-reset").emit("click");
  await settle();
  await editAndSave(t, app, "New automatic name");
  assert.equal(app.element("chat-title").textContent, "New automatic name");
  release();
  await settle();
  assert.equal(app.element("chat-title").textContent, "New automatic name");
  assert.equal(app.element("transcript").value, "New automatic name");
});

test("an older text response cannot undo an acknowledged rename", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const app = await appEnvironment(t, (server) => {
    const chat = server.add("Original");
    chat.title = chat.custom_title = "Manual";
  });
  const fetch = globalThis.fetch;
  let releaseTitleRequest;
  let releaseTextResponse;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url).endsWith("/title") && options?.method === "PUT") {
      await new Promise((resolve) => {
        releaseTitleRequest = resolve;
      });
    }
    const response = await fetch(url, options);
    if (String(url).endsWith("/text")) {
      await new Promise((resolve) => {
        releaseTextResponse = resolve;
      });
    }
    return response;
  });
  await app.element("chat-title").emit("click");
  await submitTitle(app, "Renamed");
  await app.element("title-cancel").emit("click");
  await editAndSave(t, app, "New text");
  releaseTitleRequest();
  await settle();
  assert.equal(app.element("chat-title").textContent, "Renamed");
  releaseTextResponse();
  await settle();
  assert.equal(app.server.chats.get(id(1)).title, "Renamed");
  assert.equal(app.element("chat-title").textContent, "Renamed");
});

test("an older autosave cannot replace newer title metadata read after a conflict", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const app = await appEnvironment(t, (server) => {
    const chat = server.add("Original");
    chat.title = chat.custom_title = "Manual";
  });
  const fetch = globalThis.fetch;
  let releaseTitleRequest;
  let releaseTextResponse;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url).endsWith("/title") && options?.method === "PUT") {
      await new Promise((resolve) => {
        releaseTitleRequest = resolve;
      });
    }
    const response = await fetch(url, options);
    if (String(url).endsWith("/text")) {
      await new Promise((resolve) => {
        releaseTextResponse = resolve;
      });
    }
    return response;
  });
  await app.element("chat-title").emit("click");
  await submitTitle(app, "My name");
  await app.element("title-cancel").emit("click");
  await editAndSave(t, app, "New text");
  const stored = app.server.chats.get(id(1));
  stored.title = stored.custom_title = "Remote name";
  stored.title_revision++;
  stored.revision++;
  releaseTitleRequest();
  await settle();
  assert.equal(app.element("chat-title").textContent, "Remote name");
  releaseTextResponse();
  await settle();
  assert.equal(app.element("chat-title").textContent, "Remote name");
  assert.equal(app.element("transcript").value, "New text");
  await deleteRow(app, 0);
  assert.equal(app.server.chats.size, 1, "metadata-only reads do not acknowledge deletion");
});

test("successful title save restores focus after a delayed sidebar refresh", async (t) => {
  const app = await appEnvironment(t, (server) => server.add("Original"));
  const fetch = globalThis.fetch;
  let finishRefresh;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url === "/api/chats") {
      await new Promise((resolve) => {
        finishRefresh = resolve;
      });
    }
    return fetch(url, options);
  });
  await app.element("chat-title").emit("click");
  await submitTitle(app, "Renamed");
  assert.equal(app.element("title-editor").open, false);
  assert.equal(app.element("chat-title").disabled, true);
  finishRefresh();
  await settle();
  assert.equal(app.element("chat-title").disabled, false);
  assert.equal(globalThis.document.activeElement, app.element("chat-title"));
});

test("a failed rename after cancellation reports its error outside the closed dialog", async (t) => {
  const app = await appEnvironment(t, (server) => server.add("Original"));
  const fetch = globalThis.fetch;
  let fail;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url).endsWith("/title") && options?.method === "PUT") {
      return new Promise((resolve, reject) => {
        fail = reject;
      });
    }
    return fetch(url, options);
  });
  await app.element("chat-title").emit("click");
  await submitTitle(app, "Attempted name");
  await app.element("title-cancel").emit("click");
  fail(new TypeError("Network unavailable"));
  await settle();
  assert.equal(app.element("title-editor").open, false);
  assert.match(app.element("error").textContent, /Network unavailable/);
  assert.equal(app.element("error").hidden, false);
  assert.equal(app.element("chat-title").textContent, "Original");
});
