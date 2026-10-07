import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { encodeWav } from "../../src/phonon_web/static/audio.js";
import { MicrophoneRecorder } from "../../src/phonon_web/static/recorder.js";
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
    const method = options.method ?? "GET";
    const json = (body, status = 200) => Response.json(body, { status });
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
async function appEnvironment(t, setup = () => {}) {
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
      setInterval: () => 1,
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
        assert.equal(url, "ws://localhost:8080/api/stream");
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
  await import(`../../src/phonon_web/static/app.js?case=${encodeURIComponent(t.name)}`);
  const app = { element, server, sockets, copied, state, wav };
  await waitForIdle(app);
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
