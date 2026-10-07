import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { encodeWav } from "../../src/phonon_web/static/audio.js";
import { MicrophoneRecorder } from "../../src/phonon_web/static/recorder.js";
import { FakeSocket } from "./fake-socket.js";

class Element {
  constructor() {
    this.value = "";
    this.textContent = "";
    this.checked = true;
    this.disabled = false;
    this.hidden = true;
    this.readOnly = false;
    this.listeners = new Map();
    this.classList = { toggle() {} };
  }
  addEventListener(type, callback) {
    this.listeners.set(type, callback);
  }
  async emit(type) {
    await this.listeners.get(type)?.();
  }
  pause() {}
  load() {}
  removeAttribute() {}
  focus() {}
  select() {}
}

/** Run the real app module against browser boundaries, with no DOM package or server. */
async function appEnvironment(t) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const sockets = [];
  const posts = [];
  const copied = [];
  const windowListeners = new Map();
  const state = { starts: 0, stops: 0, onSamples: null, failBatch: false };
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
    document: { getElementById: element },
    window: {
      isSecureContext: true,
      location: { href: "http://localhost:8080/" },
      setInterval: () => 1,
      clearInterval() {},
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
    fetch: async (url, options) => {
      if (url === "/api/health") return Response.json({ ready: true });
      assert.equal(url, "/api/transcribe");
      posts.push(options);
      return state.failBatch
        ? Response.json({ detail: "Engine unavailable. Retry." }, { status: 503 })
        : Response.json({ text: "Complete recording." });
    },
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
  // Each test gets fresh application state; the audio and stream modules stay real.
  await import(`../../src/phonon_web/static/app.js?case=${encodeURIComponent(t.name)}`);
  return { element, sockets, posts, copied, state, wav };
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
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!app.element("record").disabled) return;
    await setImmediate();
  }
  assert.fail("The app did not finish its recording flow");
}

test("live UI shows corrected text, flushes audio, finalizes, and copies without a batch request", async (t) => {
  const app = await appEnvironment(t);
  assert.equal(app.element("stop").textContent, "Stop");
  const socket = await startLive(app);
  assert.equal(app.element("live-mode").disabled, true);
  socket.event({ type: "partial", text: "Hello" });
  socket.event({ type: "partial", text: "Hello world" });
  assert.equal(app.element("transcript").value, "Hello world");
  assert.equal(app.element("word-count").textContent, "2 words");
  await app.element("stop").emit("click");
  await waitForEnd(socket);
  assert.ok(socket.sent[0] instanceof ArrayBuffer, "the final microphone chunk is sent first");
  socket.event({ type: "final", text: "Hello world.", segment: 1 });
  socket.event({ type: "done", text: "Hello world." });
  await waitForIdle(app);
  assert.equal(app.element("transcript").value, "Hello world.");
  assert.equal(app.element("transcript").readOnly, false);
  assert.equal(app.element("playback").hidden, false);
  assert.equal(app.element("retry").disabled, false);
  assert.equal(app.element("live-mode").disabled, false);
  assert.deepEqual(app.posts, []);
  await app.element("copy").emit("click");
  assert.deepEqual(app.copied, ["Hello world."]);
});

test("a failed live connection keeps recording and transcribes the complete WAV at stop", async (t) => {
  const app = await appEnvironment(t);
  const socket = await startLive(app);
  socket.close();
  assert.match(app.element("status").textContent, /Recording continues/);
  assert.equal(app.state.stops, 0);
  await app.element("stop").emit("click");
  await waitForIdle(app);
  assert.equal(app.posts.length, 1);
  assert.equal(app.posts[0].body, app.wav);
  assert.equal(app.element("transcript").value, "Complete recording.");
  assert.equal(app.element("error").hidden, true);
});

test("failed stream finalization and failed batch recovery keep a recording for retry", async (t) => {
  const app = await appEnvironment(t);
  const socket = await startLive(app);
  app.state.failBatch = true;
  await app.element("stop").emit("click");
  await waitForEnd(socket);
  socket.close();
  await waitForIdle(app);
  assert.equal(app.element("error").hidden, false);
  assert.equal(app.element("retry").disabled, false);
  assert.equal(app.element("playback").hidden, false);
  app.state.failBatch = false;
  await app.element("retry").emit("click");
  assert.equal(app.posts.length, 2);
  assert.equal(app.posts[1].body, app.wav);
  assert.equal(app.element("transcript").value, "Complete recording.");
});

test("connection failure preserves existing text and the live switch selects the batch flow", async (t) => {
  const app = await appEnvironment(t);
  app.element("transcript").value = "My existing edits.";
  const starting = app.element("record").emit("click");
  app.sockets[0].emit("error");
  await starting;
  assert.equal(app.state.starts, 0);
  assert.equal(app.element("transcript").value, "My existing edits.");
  assert.equal(app.element("record").disabled, false);
  app.element("live-mode").checked = false;
  await app.element("live-mode").emit("change");
  assert.equal(app.element("stop").textContent, "Stop & transcribe");
  await app.element("record").emit("click");
  await app.element("stop").emit("click");
  await waitForIdle(app);
  assert.equal(app.sockets.length, 1);
  assert.equal(app.posts.length, 1);
  assert.equal(app.element("transcript").value, "Complete recording.");
});
