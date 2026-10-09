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
    this.open = false;
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.isConnected = true;
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
      contains: (name) => classes.has(name) || String(this.className).split(/\s+/u).includes(name),
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
    for (const child of children) child.setConnected(this.isConnected);
  }
  replaceChildren(...children) {
    for (const child of this.children) child.setConnected(false);
    this.children = children;
    for (const child of children) child.setConnected(this.isConnected);
  }
  setConnected(connected) {
    this.isConnected = connected;
    for (const child of this.children) child.setConnected(connected);
  }
  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  querySelectorAll(selector) {
    const [ancestorSelector, descendantSelector] = selector.trim().split(/\s+/u);
    const matches = (element, part) => {
      const attribute = part.match(/^\[data-chat-id="([^"]+)"\]$/u);
      if (attribute) return element.getAttribute("data-chat-id") === attribute[1];
      if (part.startsWith(".")) return element.classList.contains(part.slice(1));
      return false;
    };
    const descendants = (root) => root.children.flatMap((child) => [child, ...descendants(child)]);
    if (!descendantSelector)
      return descendants(this).filter((item) => matches(item, ancestorSelector));
    return descendants(this)
      .filter((item) => matches(item, ancestorSelector))
      .flatMap((item) => descendants(item).filter((child) => matches(child, descendantSelector)));
  }
  contains(candidate) {
    return candidate === this || this.children.some((child) => child.contains(candidate));
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
    if (!this.disabled && this.isConnected) {
      globalThis.document.activeElement = this;
      this.focused = true;
    }
  }
  select() {
    this.selectionStart = 0;
    this.selectionEnd = this.value.length;
  }
}

const id = (number) => String(number).padStart(32, "0");

/** An in-memory stand-in for the chat API, with switches for failure paths. */
function chatServer() {
  const server = {
    chats: new Map(),
    groups: new Map(),
    createInputs: [],
    groupWrites: [],
    placementWrites: [],
    foldStorage: new Map(),
    storageUnavailable: false,
    searchResults: new Map(),
    listQueries: [],
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
      group_id: null,
      placement_revision: 1,
    };
    server.chats.set(chat.id, chat);
    return chat;
  };
  server.addGroup = (name, groupId = id(100 + server.groups.size)) => {
    const group = {
      id: groupId,
      name,
      created: "2026-10-08T10:00:00Z",
      revision: 1,
    };
    server.groups.set(group.id, group);
    return group;
  };
  server.deleteGroup = (groupId) => {
    server.groups.delete(groupId);
    for (const chat of server.chats.values())
      if (chat.group_id === groupId) {
        chat.group_id = null;
        chat.placement_revision++;
      }
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
    const groupEtag = (group) => `"group-${group.id}-${group.revision}"`;
    const groupJson = (group, status = 200) =>
      Response.json(
        { ...group, etag: groupEtag(group) },
        { status, headers: { ETag: groupEtag(group) } },
      );
    const placementEtag = (chat) => `"placement-${chat.id}-${chat.placement_revision}"`;
    const placementJson = (chat) =>
      Response.json(
        {
          chat_id: chat.id,
          group_id: chat.group_id,
          placement_revision: chat.placement_revision,
          etag: placementEtag(chat),
        },
        { headers: { ETag: placementEtag(chat) } },
      );
    if (url === "/api/groups")
      return json(
        [...server.groups.values()].map((group) => ({ ...group, etag: groupEtag(group) })),
      );
    if (url.startsWith("/api/groups/")) {
      const [, groupId, namePath] = url.match(/^\/api\/groups\/(\w+)(.*)$/);
      const group = server.groups.get(groupId);
      server.groupWrites.push({
        groupId,
        method,
        body: options.body,
        etag: options.headers?.["If-Match"],
      });
      if (!namePath && method === "PUT") {
        const name = JSON.parse(options.body).name.trim();
        if (!name) return json({ detail: "Enter a group name.", code: "invalid_group_name" }, 422);
        if (group) return groupJson(group);
        return groupJson(server.addGroup(name, groupId), 201);
      }
      if (!group)
        return json({ detail: "This group no longer exists.", code: "group_not_found" }, 404);
      if (options.headers?.["If-Match"] !== groupEtag(group))
        return json({ detail: "This group changed elsewhere.", code: "revision_conflict" }, 412);
      if (method === "DELETE") {
        server.deleteGroup(groupId);
        return new Response(null, { status: 204 });
      }
      group.name = JSON.parse(options.body).name.trim();
      group.revision++;
      return groupJson(group);
    }
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
      const query = parsed.searchParams.get("q") ?? "";
      server.listQueries.push(query);
      // Fixtures select matching IDs; the client must never implement matching.
      const matches = query ? (server.searchResults.get(query) ?? []) : [...server.chats.keys()];
      return json(
        [...server.chats.values()]
          .filter((chat) => matches.includes(chat.id))
          .map((chat) => ({
            id: chat.id,
            title: chat.title,
            custom_title: chat.custom_title,
            updated: chat.updated,
            recording_count: chat.recordings.length,
            etag: `"chat-${chat.id}-${chat.revision}"`,
            group_id: chat.group_id,
            placement_etag: placementEtag(chat),
          })),
      );
    }
    if (url === "/api/chats" && method === "POST") return json(server.add(""), 201);
    const [, chatId, rest] = url.match(/^\/api\/chats\/(\w+)(.*)$/) ?? [];
    if (!rest && method === "PUT") {
      const groupId = options.body ? JSON.parse(options.body).group_id : null;
      server.createInputs.push({ id: chatId, group_id: groupId });
      let existing = server.chats.get(chatId);
      if (existing) return json(existing);
      if (groupId && !server.groups.has(groupId))
        return json({ detail: "This group no longer exists.", code: "group_not_found" }, 404);
      existing = server.add("");
      server.chats.delete(existing.id);
      existing.id = chatId;
      existing.group_id = groupId;
      server.chats.set(chatId, existing);
      return json(existing, 201);
    }
    const chat = server.chats.get(chatId);
    if (!chat) return json({ detail: "This chat no longer exists.", code: "chat_not_found" }, 404);
    if (!rest && method === "GET") return json(chat);
    if (!rest && method === "DELETE") {
      if (options.headers?.["If-Match"] !== `"chat-${chat.id}-${chat.revision}"`)
        return json({ detail: "This chat changed elsewhere.", code: "revision_conflict" }, 412);
      server.chats.delete(chatId);
      return new Response(null, { status: 204 });
    }
    if (rest === "/group") {
      if (method === "GET") return placementJson(chat);
      const groupId = JSON.parse(options.body).group_id;
      server.placementWrites.push({
        id: chatId,
        group_id: groupId,
        etag: options.headers?.["If-Match"],
      });
      if (options.headers?.["If-Match"] !== placementEtag(chat))
        return json(
          { detail: "This chat's group changed elsewhere.", code: "revision_conflict" },
          412,
        );
      if (groupId && !server.groups.has(groupId))
        return json({ detail: "This group no longer exists.", code: "group_not_found" }, 404);
      if (chat.group_id !== groupId) {
        chat.group_id = groupId;
        chat.placement_revision++;
      }
      return placementJson(chat);
    }
    if (rest === "/title") {
      if (method === "GET")
        return Response.json(
          {
            custom_title: chat.custom_title,
            title_revision: chat.title_revision,
          },
          { headers: { ETag: titleEtag(chat), "Chat-Revision": String(chat.revision) } },
        );
      if (options.headers?.["If-Match"] !== titleEtag(chat))
        return json({ detail: "This chat changed elsewhere.", code: "revision_conflict" }, 412);
      const value = JSON.parse(options.body).custom_title;
      if (value !== null && (!value.trim() || [...value.trim()].length > 120))
        return json(
          { detail: "A title must contain 1 to 120 characters.", code: "invalid_title" },
          422,
        );
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
    if (!elements.has(name)) {
      const connected = [...elements.values()].flatMap((root) => {
        const descendants = (node) => [node, ...node.children.flatMap(descendants)];
        return descendants(root).filter(
          (node) => node.isConnected && node.getAttribute("id") === name,
        );
      })[0];
      if (connected) return connected;
      elements.set(name, new Element());
    }
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
    localStorage: {
      getItem: (key) => {
        if (server.storageUnavailable) throw new Error("Storage blocked");
        return server.foldStorage.get(key) ?? null;
      },
      setItem: (key, value) => {
        if (server.storageUnavailable) throw new Error("Storage blocked");
        server.foldStorage.set(key, value);
      },
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

/** The sidebar's visible chat rows, across the grouped sections. */
function chatItems(app) {
  return app
    .element("chat-list")
    .children.flatMap((section) =>
      section.children[1].hidden ? [] : section.children[1].children,
    );
}

function inlineTitleEditor(app) {
  return (
    app.element("chat-title-area").querySelector(".inline-title-editor") ??
    app.element("chat-list").querySelector(".inline-title-editor")
  );
}

/** The sidebar's rendered rows as [title, active] pairs. */
function chatRows(app) {
  return chatItems(app).map((item) => {
    const label = findByClass(item, "chat-open");
    const input = findByClass(item, "inline-title-input");
    return [input?.value ?? label?.children[0].textContent, item.classList.contains("active")];
  });
}

function findByClass(root, name) {
  if (root.classList.contains(name)) return root;
  for (const child of root.children) {
    const found = findByClass(child, name);
    if (found) return found;
  }
  return null;
}

function chatAction(row, label) {
  const className = { Rename: "chat-rename", Move: "chat-move", Delete: "chat-delete" }[label];
  return findByClass(row, className);
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
  await chatItems(app)[1].children[0].emit("click");
  await waitForIdle(app);
  assert.equal(app.element("transcript").value, "Second chat.");

  await app.element("new-chat").emit("click");
  await waitForIdle(app);
  assert.equal(app.element("transcript").value, "");
  assert.deepEqual(chatRows(app)[0], ["New chat", true]);
  assert.equal(app.server.chats.size, 2, "an empty new chat is not stored");

  const remove = chatAction(chatItems(app)[1], "Delete");
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
    server.add("Third");
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
  await chatItems(app)[1].children[0].emit("click");
  await settle();
  assert.equal(app.element("transcript").value, "My latest draft");
  assert.deepEqual(confirmations, ["Discard your unsaved changes?"]);
  t.mock.method(globalThis.window, "confirm", () => true);
  await chatItems(app)[1].children[0].emit("click");
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
      if (destination === "switch") await chatItems(app)[1].children[0].emit("click");
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
  await chatItems(app)[1].children[0].emit("click");
  await waitForIdle(app);
  await chatItems(app)[0].children[0].emit("click");
  await waitForIdle(app);
  assert.equal(app.element("transcript").value, firstDraft);
  const beforeResponse = chatRows(app);
  release();
  await settle();
  assert.deepEqual(chatRows(app), beforeResponse);
  assert.equal(app.element("transcript").value, firstDraft);
});

async function deleteRow(app, index) {
  const remove = chatAction(chatItems(app)[index], "Delete");
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
  await chatItems(app)[1].children[0].emit("click");
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
  const input = app.element("title-input");
  input.value = value;
  await input.emit("input");
  await app.element("title-form").emit("submit", { preventDefault() {} });
  await settle();
}

async function openHeadingRename(app, entry = "chat-title-edit") {
  await app.element(entry).emit("click");
  await settle();
  return app.element("title-input");
}

async function openSidebarRename(app, index) {
  const row = chatItems(app)[index];
  const trigger = chatAction(row, "Rename");
  await trigger.emit("click", { stopPropagation() {} });
  await settle();
  return { row, trigger, input: app.element("title-input") };
}

test("heading rename edits in place, validates empty text, and explicitly restores the automatic name", async (t) => {
  const app = await appEnvironment(t, (server) => server.add("Transcript words"));
  const original = app.server.chats.get(id(1));
  await openHeadingRename(app, "chat-title");
  assert.ok(inlineTitleEditor(app));
  assert.equal(app.element("title-input").value, "Transcript words");
  assert.equal(app.element("record").disabled, true, "recording waits until the inline edit ends");

  await submitTitle(app, "");
  assert.equal(original.title, "Transcript words");
  assert.equal(original.custom_title, null, "empty text does not mean automatic naming");
  assert.match(app.element("title-error").textContent, /visible|1 to 120/i);
  assert.ok(inlineTitleEditor(app));

  await submitTitle(app, "  Notes  ");
  assert.equal(original.title, "Notes");
  assert.equal(original.custom_title, "Notes");
  assert.equal(app.element("chat-title").textContent, "Notes");
  assert.equal(inlineTitleEditor(app), null);

  await openHeadingRename(app);
  await app.element("title-reset").emit("click");
  await settle();
  assert.equal(original.custom_title, null);
  assert.equal(original.title, "Transcript words");
  assert.equal(app.element("chat-title").textContent, "Transcript words");
});

test("sidebar pencil reads the canonical chat and preserves the active transcript draft", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const app = await appEnvironment(t, (server) => {
    server.add("First");
    server.add("Second");
  });
  const requests = [];
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push([String(url), options?.method ?? "GET"]);
    return fetch(url, options);
  });
  app.element("transcript").value = "Unsubmitted active draft";
  await app.element("transcript").emit("input");

  await openSidebarRename(app, 1);
  assert.equal(app.element("title-input").value, "Second");
  assert.ok(requests.some(([url, method]) => url === `/api/chats/${id(2)}` && method === "GET"));
  assert.ok(!requests.some(([url]) => url === `/api/chats/${id(2)}/title`));
  await submitTitle(app, "Renamed second");

  assert.equal(app.server.chats.get(id(2)).title, "Renamed second");
  assert.equal(app.server.chats.get(id(1)).text, "First");
  assert.equal(app.element("transcript").value, "Unsubmitted active draft");
  assert.equal(app.element("chat-title").textContent, "First");
  assert.ok(!requests.some(([url]) => url.endsWith("/text")));
  assert.equal(
    globalThis.document.activeElement,
    chatAction(chatItems(app)[1], "Rename"),
    "a saved sidebar edit returns focus to its pencil",
  );
});

test("failed title writes keep the inline proposal and allow an explicit retry", async (t) => {
  const app = await appEnvironment(t, (server) => server.add("Original"));
  const fetch = globalThis.fetch;
  let failOnce = true;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url).endsWith("/title") && options?.method === "PUT" && failOnce) {
      failOnce = false;
      throw new TypeError("Network unavailable");
    }
    return fetch(url, options);
  });
  await openHeadingRename(app);
  await submitTitle(app, "Keep this input");
  assert.equal(app.element("chat-title").textContent, "Original");
  assert.equal(app.element("title-input").value, "Keep this input");
  assert.match(app.element("title-error").textContent, /Network unavailable/);
  assert.ok(inlineTitleEditor(app));

  await submitTitle(app, "Keep this input");
  assert.equal(app.server.chats.get(id(1)).title, "Keep this input");
  assert.equal(inlineTitleEditor(app), null);
});

test("title conflicts refresh the validator, keep the proposal, and require explicit retry", async (t) => {
  const app = await appEnvironment(t, (server) => {
    server.add("First");
    server.add("Second");
    server.add("Third");
  });
  const target = app.server.chats.get(id(2));
  let titleWrites = 0;
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url).endsWith("/title") && options?.method === "PUT") titleWrites++;
    return fetch(url, options);
  });
  await openSidebarRename(app, 1);
  app.element("title-input").value = "My name";
  await app.element("title-input").emit("input");
  target.custom_title = "Remote name";
  target.title = "Remote name";
  target.title_revision++;
  target.revision++;
  await app.element("title-form").emit("submit", { preventDefault() {} });
  await settle();
  assert.equal(app.element("title-input").value, "My name");
  assert.match(app.element("title-error").textContent, /Remote name/);
  assert.equal(titleWrites, 1);

  const thirdLabel = findByClass(chatItems(app)[2], "chat-open");
  thirdLabel.focus();
  await app.element("title-form").emit("focusout", { relatedTarget: thirdLabel });
  await settle();
  await thirdLabel.emit("click", { detail: 0 });
  await settle();
  assert.equal(
    app.element("transcript").value,
    "First",
    "failed navigation leaves the active chat alone",
  );
  assert.equal(app.element("title-input").value, "My name");
  assert.equal(titleWrites, 1, "blur and navigation do not retry a conflict implicitly");

  await submitTitle(app, "My name");
  assert.equal(target.title, "My name");
  assert.equal(titleWrites, 2);
});

test("automatic-name conflict asks for Auto again and keeps that explicit reset intent", async (t) => {
  const app = await appEnvironment(t, (server) => {
    const chat = server.add("Transcript words");
    chat.title = chat.custom_title = "Manual name";
  });
  const target = app.server.chats.get(id(1));
  await openHeadingRename(app);
  target.title = target.custom_title = "Remote name";
  target.title_revision++;
  target.revision++;
  await app.element("title-reset").emit("click");
  await settle();
  assert.equal(target.title, "Remote name");
  assert.match(app.element("title-error").textContent, /Use automatic name.*again/);
  await app.element("title-reset").emit("click");
  await settle();
  assert.equal(target.custom_title, null);
  assert.equal(target.title, "Transcript words");
});

test("sidebar refresh and search preserve the active editor, value, and caret", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const app = await appEnvironment(t, (server) => {
    server.add("First");
    server.add("Second");
  });
  await openSidebarRename(app, 1);
  let input = app.element("title-input");
  input.value = "Second title draft";
  await input.emit("input");
  input.focus();
  input.setSelectionRange(7, 12);

  await app.element("chat-filter-retry").emit("click");
  await settle();
  input = app.element("title-input");
  assert.equal(input.value, "Second title draft");
  assert.equal(globalThis.document.activeElement, input);
  assert.deepEqual([input.selectionStart, input.selectionEnd], [7, 12]);

  await filterChats(t, app, "no matching chat");
  input = app.element("title-input");
  assert.equal(app.element("chat-list").hidden, false);
  assert.equal(input.value, "Second title draft");
  assert.equal(
    findByClass(
      chatItems(app).find((row) => row.getAttribute("data-chat-id") === id(2)),
      "inline-title-input",
    ),
    input,
  );
  assert.equal(globalThis.document.activeElement, input);
  await app.element("title-cancel").emit("click");
});

test("a refreshed group placement keeps the active editor in its newly folded group", async (t) => {
  const app = await appEnvironment(t, (server) => {
    server.addGroup("Before");
    server.addGroup("After");
    const chat = server.add("Moving title");
    chat.group_id = id(100);
    server.foldStorage.set("diktator.group-folds", JSON.stringify([id(101)]));
  });
  await openSidebarRename(app, 0);
  const moved = app.server.chats.get(id(1));
  moved.group_id = id(101);
  moved.placement_revision++;
  await app.element("chat-filter-retry").emit("click");
  await settle();

  const after = groupSection(app, id(101));
  assert.equal(after.children[1].hidden, false);
  assert.ok(findByClass(after.children[1].children[0], "inline-title-input"));
  assert.equal(app.element("title-input").value, "Moving title");
  await app.element("title-cancel").emit("click");
});

test("a rename waits for an in-flight text save and retains newer transcript edits", async (t) => {
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
  await openHeadingRename(app);
  await submitTitle(app, "Manual title");
  assert.deepEqual(calls, ["text"]);
  releaseText();
  for (let attempt = 0; attempt < 20 && !releaseTitle; attempt++) await setImmediate();
  assert.deepEqual(calls, ["text", "title"]);
  app.element("transcript").value = "Newer draft";
  await app.element("transcript").emit("input");
  releaseTitle();
  await settle();
  assert.equal(app.element("chat-title").textContent, "Manual title");
  assert.equal(app.element("transcript").value, "Newer draft");
  t.mock.timers.tick(700);
  await settle();
  assert.equal(app.server.chats.get(id(1)).text, "Newer draft");
  assert.equal(app.element("chat-title").textContent, "Manual title");
});

test("a title response with remote text does not freshen the text validator", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const app = await appEnvironment(t, (server) => {
    const stored = server.add("Original");
    stored.custom_title = "Manual";
    stored.title = "Manual";
  });
  await openHeadingRename(app);
  const stored = app.server.chats.get(id(1));
  stored.text = "Remote text";
  stored.text_revision++;
  stored.revision++;
  await submitTitle(app, "Renamed");
  assert.equal(app.element("transcript").value, "Original");
  await editAndSave(t, app, "My draft");
  assert.equal(app.element("text-conflict").hidden, false);
  assert.equal(stored.text, "Remote text");
});

test("a delayed automatic-name response cannot replace a newer autosave", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const app = await appEnvironment(t, (server) => {
    const stored = server.add("Original");
    stored.title = stored.custom_title = "Manual";
  });
  const fetch = globalThis.fetch;
  let releaseTitle;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const response = await fetch(url, options);
    if (String(url).endsWith("/title") && options?.method === "PUT")
      await new Promise((resolve) => {
        releaseTitle = resolve;
      });
    return response;
  });
  await openHeadingRename(app);
  await app.element("title-reset").emit("click");
  for (let attempt = 0; attempt < 20 && !releaseTitle; attempt++) await setImmediate();
  assert.equal(typeof releaseTitle, "function");
  await editAndSave(t, app, "New automatic name");
  releaseTitle();
  await settle();
  assert.equal(app.element("chat-title").textContent, "New automatic name");
  assert.equal(app.element("transcript").value, "New automatic name");
});

test("an older autosave response cannot replace title metadata read after a conflict", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const app = await appEnvironment(t, (server) => {
    const stored = server.add("Original");
    stored.title = stored.custom_title = "Manual";
  });
  const fetch = globalThis.fetch;
  let releaseText;
  let deferText = true;
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const response = await fetch(url, options);
    if (String(url).endsWith("/text") && deferText) {
      deferText = false;
      calls.push("text response held");
      await new Promise((resolve) => {
        releaseText = resolve;
      });
    }
    if (String(url).endsWith("/title") && options?.method === "PUT") calls.push("title write");
    if (String(url) === `/api/chats/${id(1)}` && !options?.method) calls.push("full chat read");
    return response;
  });
  await openHeadingRename(app);
  calls.length = 0;
  app.element("transcript").value = "Pending transcript";
  await app.element("transcript").emit("input");
  t.mock.timers.tick(700);
  for (let attempt = 0; attempt < 20 && !releaseText; attempt++) await setImmediate();
  assert.equal(typeof releaseText, "function");

  const stored = app.server.chats.get(id(1));
  stored.title = stored.custom_title = "Remote name";
  stored.title_revision++;
  stored.revision++;
  await submitTitle(app, "My name");
  assert.deepEqual(calls, ["text response held"]);
  releaseText();
  for (let attempt = 0; attempt < 30 && calls.length < 3; attempt++) await setImmediate();
  assert.deepEqual(calls.slice(0, 3), ["text response held", "title write", "full chat read"]);
  assert.equal(app.element("title-input").value, "My name");
  assert.match(app.element("title-error").textContent, /Remote name/);
  await app.element("title-cancel").emit("click");
  assert.equal(app.element("chat-title").textContent, "Remote name");
  assert.equal(stored.text, "Pending transcript");
});

test("a pending sidebar title read is discarded by navigation; a failed read stays retryable", async (t) => {
  const app = await appEnvironment(t, (server) => {
    server.add("First");
    server.add("Second");
    server.add("Third");
  });
  const fetch = globalThis.fetch;
  let releaseRead;
  let blockRead = true;
  let failRead = false;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url) === `/api/chats/${id(2)}` && !options?.method && blockRead) {
      blockRead = false;
      await new Promise((resolve) => {
        releaseRead = resolve;
      });
    }
    if (String(url) === `/api/chats/${id(2)}` && !options?.method && failRead) {
      failRead = false;
      return Response.json({ detail: "Title read unavailable." }, { status: 503 });
    }
    return fetch(url, options);
  });
  await chatAction(chatItems(app)[1], "Rename").emit("click", { stopPropagation() {} });
  await settle();
  const thirdLabel = findByClass(chatItems(app)[2], "chat-open");
  await thirdLabel.emit("click", { detail: 0 });
  await waitForIdle(app);
  assert.equal(app.element("transcript").value, "Third");
  releaseRead();
  await settle();
  assert.equal(inlineTitleEditor(app), null);

  failRead = true;
  await openSidebarRename(app, 1);
  assert.match(app.element("title-error").textContent, /Title read unavailable/);
  await submitTitle(app, "Recovered name");
  assert.equal(app.server.chats.get(id(2)).title, "Recovered name");
});

test("native double-click enters edit while touch and keyboard single clicks open immediately", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const app = await appEnvironment(t, (server) => {
    server.add("First");
    server.add("Second");
  });
  const secondRow = chatItems(app)[1];
  const label = findByClass(secondRow, "chat-open");
  await label.emit("pointerdown", { pointerType: "mouse", isPrimary: true });
  await label.emit("click", { detail: 1 });
  assert.equal(app.element("transcript").value, "First", "the first mouse click waits briefly");
  await label.emit("pointerdown", { pointerType: "mouse", isPrimary: true });
  await label.emit("click", { detail: 2 });
  await label.emit("dblclick", { preventDefault() {} });
  await settle();
  assert.equal(app.element("title-input").value, "Second");
  assert.equal(app.element("transcript").value, "First");
  await app.element("title-cancel").emit("click");

  const firstRow = chatItems(app)[0];
  const firstLabel = findByClass(firstRow, "chat-open");
  await firstLabel.emit("pointerdown", { pointerType: "touch", isPrimary: true });
  await firstLabel.emit("click", { detail: 1 });
  await waitForIdle(app);
  assert.equal(app.element("transcript").value, "First");
});

test("inline editing handles IME Enter, Tab to internal controls, Escape, and focus restoration", async (t) => {
  const app = await appEnvironment(t, (server) => server.add("Original"));
  await openHeadingRename(app);
  const input = app.element("title-input");
  const event = { key: "Enter", isComposing: true, keyCode: 229, preventDefault() {} };
  await input.emit("keydown", event);
  assert.equal(app.server.chats.get(id(1)).title, "Original");
  const cancel = app.element("title-cancel");
  cancel.focus();
  await app.element("title-form").emit("focusout", { relatedTarget: cancel });
  await settle();
  assert.equal(
    app.server.chats.get(id(1)).title,
    "Original",
    "Tab to a child control does not save",
  );
  assert.ok(inlineTitleEditor(app));
  input.focus();
  await input.emit("keydown", { key: "Escape", preventDefault() {} });
  assert.equal(inlineTitleEditor(app), null);
  assert.equal(globalThis.document.activeElement, app.element("chat-title-edit"));
});

test("Move and Delete keep their row icons and confirmation behavior", async (t) => {
  const app = await appEnvironment(t, (server) => {
    server.add("Original");
    server.addGroup("Project");
  });
  const row = chatItems(app)[0];
  assert.ok(chatAction(row, "Rename"));
  assert.ok(chatAction(row, "Move"));
  assert.ok(chatAction(row, "Delete"));
  assert.match(chatAction(row, "Move").getAttribute("aria-label"), /Move/);
  await chatAction(row, "Move").emit("click");
  assert.equal(app.element("group-move").open, true);
  await app.element("group-move-cancel").emit("click");
  await chatAction(chatItems(app)[0], "Delete").emit("click");
  assert.equal(chatAction(chatItems(app)[0], "Delete").classList.contains("confirm"), true);
  await chatAction(chatItems(app)[0], "Delete").emit("click");
  await waitForIdle(app);
  assert.equal(app.server.chats.size, 0);
});

test("a title edit rejects rename actions while recording", async (t) => {
  const app = await appEnvironment(t, (server) => server.add("Original"));
  const requests = [];
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push([String(url), options?.method ?? "GET"]);
    return fetch(url, options);
  });
  const socket = await startLive(app);
  await chatAction(chatItems(app)[0], "Rename").emit("click", { stopPropagation() {} });
  await settle();
  assert.equal(inlineTitleEditor(app), null);
  assert.ok(!requests.some(([url]) => url.endsWith("/title")));
  await app.element("stop").emit("click");
  await waitForEnd(socket);
  socket.event({ type: "done", text: "" });
  await waitForIdle(app);
});

async function filterChats(t, app, query) {
  app.element("chat-filter-input").value = query;
  await app.element("chat-filter-input").emit("input");
  t.mock.timers.tick(200);
  await settle();
}

test("search debounces server requests and preserves the editor and selection", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const app = await appEnvironment(t, (server) => {
    server.add("First transcript");
    server.add("Second transcript");
    server.searchResults.set("server query", [id(2)]);
  });
  const transcript = app.element("transcript");
  transcript.value = "Unsaved draft";
  setCursor(app, 3, 6);
  await transcript.emit("input");
  const initialQueries = app.server.listQueries.length;
  app.element("chat-filter-input").value = "server";
  await app.element("chat-filter-input").emit("input");
  t.mock.timers.tick(100);
  app.element("chat-filter-input").value = "server query";
  await app.element("chat-filter-input").emit("input");
  t.mock.timers.tick(199);
  assert.equal(app.server.listQueries.length, initialQueries);
  assert.equal(app.element("chat-list").hidden, true);
  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(app.server.listQueries.slice(initialQueries), ["server query"]);
  assert.deepEqual(chatRows(app), [["Second transcript", false]]);
  assert.equal(app.element("chat-list").hidden, false);
  assert.equal(transcript.value, "Unsaved draft");
  assert.deepEqual([transcript.selectionStart, transcript.selectionEnd], [3, 6]);
  assert.equal(
    app.server.chats.get(id(1)).text,
    "First transcript",
    "search does not save the draft",
  );
});

test("Clear requests the complete archive again and supersedes an old search response", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const app = await appEnvironment(t, (server) => {
    server.add("First");
    server.add("Second");
    server.searchResults.set("slow", [id(2)]);
  });
  const fetch = globalThis.fetch;
  let release;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const response = await fetch(url, options);
    if (url === "/api/chats?q=slow")
      await new Promise((resolve) => {
        release = resolve;
      });
    return response;
  });
  await filterChats(t, app, "slow");
  app.server.add("Added elsewhere");
  await app.element("chat-filter-clear").emit("click");
  await settle();
  assert.deepEqual(chatRows(app), [
    ["First", true],
    ["Second", false],
    ["Added elsewhere", false],
  ]);
  assert.equal(app.server.listQueries.at(-1), "");
  release();
  await settle();
  assert.equal(chatItems(app).length, 3);
  assert.equal(app.element("chat-filter-input").value, "");
  assert.equal(app.element("transcript").value, "First");
});

test("typing invalidates an old response before the next debounce fires", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const app = await appEnvironment(t, (server) => {
    server.add("First");
    server.add("Second");
    server.searchResults.set("old", [id(1)]);
    server.searchResults.set("new", [id(2)]);
  });
  const fetch = globalThis.fetch;
  let release;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const response = await fetch(url, options);
    if (url === "/api/chats?q=old")
      await new Promise((resolve) => {
        release = resolve;
      });
    return response;
  });
  await filterChats(t, app, "old");
  app.element("chat-filter-input").value = "new";
  await app.element("chat-filter-input").emit("input");
  release();
  await settle();
  assert.equal(
    app.element("chat-list").hidden,
    true,
    "obsolete results stay hidden while the new query waits",
  );
  t.mock.timers.tick(200);
  await settle();
  assert.deepEqual(chatRows(app), [["Second", false]]);
});

test("search errors hide stale matches and retry retains the query and editor", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const app = await appEnvironment(t, (server) => {
    server.add("First");
    server.searchResults.set("query", [id(1)]);
  });
  const fetch = globalThis.fetch;
  let fail = true;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url).includes("?q=") && fail)
      return Response.json(
        { detail: "Storage unavailable", code: "storage_error" },
        { status: 500 },
      );
    return fetch(url, options);
  });
  await filterChats(t, app, "query");
  assert.equal(app.element("chat-list").hidden, true);
  assert.equal(app.element("chat-filter-state").textContent, "Storage unavailable");
  assert.equal(app.element("chat-filter-retry").hidden, false);
  fail = false;
  await app.element("chat-filter-retry").emit("click");
  await settle();
  assert.equal(app.element("chat-list").hidden, false);
  assert.equal(app.element("chat-filter-state").hidden, true);
  assert.equal(app.element("chat-filter-input").value, "query");
  assert.equal(app.element("transcript").value, "First");
});

test("no matches are distinct and an unmatched new chat is not injected", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const app = await appEnvironment(t);
  await filterChats(t, app, "unmatched");
  assert.deepEqual(chatRows(app), []);
  assert.equal(app.element("chat-filter-state").textContent, "No matching chats.");
  await app.element("new-chat").emit("click");
  await waitForIdle(app);
  assert.deepEqual(chatRows(app), []);
  assert.equal(app.element("chat-filter-input").value, "unmatched");
  assert.equal(app.server.chats.size, 0);
  await app.element("chat-filter-clear").emit("click");
  await settle();
  assert.deepEqual(chatRows(app), [["New chat", true]]);
});

test("filter changes and clearing leave a live recording running", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const app = await appEnvironment(t, (server) => server.add("Original"));
  const socket = await startLive(app);
  socket.event({ type: "partial", text: "Spoken words" });
  const draft = app.element("transcript").value;
  await filterChats(t, app, "unmatched");
  assert.equal(app.state.stops, 0);
  assert.equal(socket.closeCount, 0);
  assert.equal(app.element("stop").hidden, false);
  assert.equal(app.element("transcript").value, draft);
  await app.element("chat-filter-clear").emit("click");
  await settle();
  assert.equal(app.state.stops, 0);
  assert.equal(app.element("transcript").value, draft);
});

test("mutation refreshes retain the active filter across save, rename and deletion", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const app = await appEnvironment(t, (server) => {
    server.add("Original");
    server.searchResults.set("topic", []);
  });
  await filterChats(t, app, "topic");
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const response = await fetch(url, options);
    if (String(url).endsWith("/text")) app.server.searchResults.set("topic", [id(1)]);
    return response;
  });
  await editAndSave(t, app, "Saved topic");
  assert.deepEqual(chatRows(app), [["Saved topic", true]]);
  await openHeadingRename(app);
  assert.equal(app.element("title-input").value, "Saved topic");
  await submitTitle(app, "Custom topic");
  assert.equal(app.server.chats.get(id(1)).title, "Custom topic");
  assert.deepEqual(chatRows(app), [["Custom topic", true]]);
  await deleteRow(app, 0);
  assert.deepEqual(chatRows(app), []);
  assert.equal(app.element("chat-filter-input").value, "topic");
  assert.equal(app.element("chat-filter-state").textContent, "No matching chats.");
  assert.equal(app.server.listQueries.at(-1), "topic");
});

function groupSection(app, groupId = null) {
  return app
    .element("chat-list")
    .children.find((section) => section.children[1].id === `group-chats-${groupId ?? "unsorted"}`);
}

async function submitGroupName(app, name) {
  app.element("group-name-input").value = name;
  await app.element("group-name-form").emit("submit", { preventDefault() {} });
  await settle();
}

async function startGroupedDraft(app, groupId) {
  await groupSection(app, groupId).children[0].children[1].emit("click");
  await waitForIdle(app);
}

async function openMoveDialog(app, index = 0) {
  await chatAction(chatItems(app)[index], "Move").emit("click");
}

async function submitMove(app, groupId) {
  app.element("group-move-select").value = groupId ?? "";
  await app.element("group-move-form").emit("submit", { preventDefault() {} });
  await settle();
}

test("groups retain server order, include empty groups and fold with accessible controls", async (t) => {
  const app = await appEnvironment(t, (server) => {
    const group = server.addGroup("Project");
    server.addGroup("Email");
    server.add("Unsorted text");
    server.add("Project text").group_id = group.id;
  });
  assert.deepEqual(
    app.element("chat-list").children.map((section) => section.children[0].children[0].textContent),
    ["Unsorted", "Project", "Email"],
  );
  const fold = groupSection(app, id(100)).children[0].children[0];
  assert.equal(fold.attributes.get("aria-expanded"), "true");
  assert.equal(fold.attributes.get("aria-controls"), `group-chats-${id(100)}`);
  await fold.emit("click");
  assert.equal(groupSection(app, id(100)).children[1].hidden, true);
  assert.deepEqual(JSON.parse(app.server.foldStorage.get("diktator.group-folds")), [id(100)]);
  assert.deepEqual(chatRows(app), [["Unsorted text", true]]);
  assert.equal(app.element("transcript").value, "Unsorted text");
});

test("folds work when storage is blocked and restore from valid saved state", async (t) => {
  const app = await appEnvironment(t, (server) => {
    server.addGroup("Project");
    server.foldStorage.set("diktator.group-folds", JSON.stringify([id(100), 123]));
  });
  assert.equal(groupSection(app, id(100)).children[1].hidden, true);
  app.server.storageUnavailable = true;
  await groupSection(app, id(100)).children[0].children[0].emit("click");
  assert.equal(groupSection(app, id(100)).children[1].hidden, false);
});

test("search temporarily reveals matching folded groups and clearing restores folds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const app = await appEnvironment(t, (server) => {
    const group = server.addGroup("Project");
    server.add("Original");
    server.add("Matching text").group_id = group.id;
    server.searchResults.set("match", [id(2)]);
    server.foldStorage.set("diktator.group-folds", JSON.stringify([group.id]));
  });
  setCursor(app, 2, 4);
  await filterChats(t, app, "match");
  assert.deepEqual(chatRows(app), [["Matching text", false]]);
  assert.equal(groupSection(app, id(100)).children[1].hidden, false);
  assert.equal(groupSection(app, id(100)).children[0].children[0].disabled, true);
  assert.equal(groupSection(app), undefined);
  assert.equal(app.element("transcript").value, "Original");
  assert.deepEqual(
    [app.element("transcript").selectionStart, app.element("transcript").selectionEnd],
    [2, 4],
  );
  await app.element("chat-filter-clear").emit("click");
  await settle();
  assert.equal(groupSection(app, id(100)).children[1].hidden, true);
  assert.deepEqual(chatRows(app), [["Original", true]]);
});

test("New chat in a group stays lazy and creation carries its initial private placement", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const app = await appEnvironment(t, (server) => server.addGroup("Project"));
  await startGroupedDraft(app, id(100));
  assert.equal(app.server.chats.size, 0);
  assert.equal(
    groupSection(app, id(100)).children[1].children[0].children[0].children[0].textContent,
    "New chat",
  );
  await editAndSave(t, app, "Project draft");
  const [stored] = app.server.chats.values();
  assert.equal(stored.group_id, id(100));
  assert.deepEqual(app.server.createInputs, [{ id: stored.id, group_id: id(100) }]);
  await app.element("new-chat").emit("click");
  await waitForIdle(app);
  assert.equal(
    groupSection(app).children[1].children[0].children[0].children[0].textContent,
    "New chat",
  );
});

test("a create retry reuses its chosen ID after an ambiguous commit and group deletion", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const app = await appEnvironment(t, (server) => server.addGroup("Project"));
  await startGroupedDraft(app, id(100));
  const fetch = globalThis.fetch;
  let fail = true;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const response = await fetch(url, options);
    if (/^\/api\/chats\/\w+$/u.test(String(url)) && options?.method === "PUT" && fail) {
      fail = false;
      app.server.deleteGroup(id(100));
      throw new Error("Connection interrupted");
    }
    return response;
  });
  await editAndSave(t, app, "Keep my draft");
  assert.equal(app.element("transcript").value, "Keep my draft");
  await editAndSave(t, app, "Keep my draft and retry");
  assert.equal(app.server.chats.size, 1);
  assert.equal(app.server.createInputs.length, 2);
  assert.deepEqual(app.server.createInputs[0], app.server.createInputs[1]);
  assert.equal(app.server.createInputs[1].group_id, id(100));
  assert.equal([...app.server.chats.values()][0].group_id, null);
  assert.equal([...app.server.chats.values()][0].text, "Keep my draft and retry");
});

test("a missing draft group offers fresh Unsorted creation while preserving the draft", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const app = await appEnvironment(t, (server) => server.addGroup("Project"));
  await startGroupedDraft(app, id(100));
  app.server.deleteGroup(id(100));
  await editAndSave(t, app, "Keep this text");
  const first = app.server.createInputs[0];
  assert.equal(app.server.chats.size, 0);
  assert.equal(app.element("draft-unsorted").hidden, false);
  assert.match(app.element("error").textContent, /text and recording are kept/);
  assert.equal(app.element("transcript").value, "Keep this text");
  assert.equal(groupSection(app, id(100)).children[0].children[0].textContent, "Unavailable group");
  await app.element("draft-unsorted").emit("click");
  await settle();
  assert.equal(app.server.chats.size, 1);
  assert.notEqual(app.server.createInputs[1].id, first.id);
  assert.equal(app.server.createInputs[1].group_id, null);
  assert.equal([...app.server.chats.values()][0].text, "Keep this text");
});

test("create and rename group use chosen IDs and independent conditional validators", async (t) => {
  const app = await appEnvironment(t);
  await app.element("new-group").emit("click");
  await submitGroupName(app, "Project");
  const [group] = app.server.groups.values();
  assert.equal(app.server.chats.size, 0);
  assert.equal(app.server.groupWrites[0].method, "PUT");
  await groupSection(app, group.id).children[0].children[2].children[1].children[0].emit("click");
  await submitGroupName(app, "Renamed project");
  assert.equal(group.name, "Renamed project");
  assert.equal(app.server.groupWrites[1].etag, `"group-${group.id}-1"`);
  assert.equal(app.element("transcript").value, "");
});

test("invalid group names remain editable and ambiguous creates reconcile by chosen ID", async (t) => {
  const app = await appEnvironment(t);
  await app.element("new-group").emit("click");
  await submitGroupName(app, "");
  assert.equal(app.element("group-name-input").readOnly, false);
  const fetch = globalThis.fetch;
  let fail = true;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const response = await fetch(url, options);
    if (String(url).startsWith("/api/groups/") && fail) {
      fail = false;
      throw new Error("Connection interrupted");
    }
    return response;
  });
  await submitGroupName(app, "Recovered group");
  assert.equal(app.server.groups.size, 1);
  assert.equal(app.element("group-editor").open, false);
  assert.equal([...app.server.groups.values()][0].name, "Recovered group");
});

test("group deletion keeps chats, text, recordings and editor selection", async (t) => {
  const app = await appEnvironment(t, (server) => {
    const group = server.addGroup("Project");
    server.add("Keep text", [
      { id: id(99), created: "2026-10-07T10:00:00Z", duration_seconds: 2 },
    ]).group_id = group.id;
  });
  const stored = app.server.chats.get(id(1));
  const before = { revision: stored.revision, updated: stored.updated };
  setCursor(app, 2, 5);
  await groupSection(app, id(100)).children[0].children[2].children[1].children[1].emit("click");
  await waitForIdle(app);
  assert.equal(app.server.groups.size, 0);
  assert.equal(stored.group_id, null);
  assert.deepEqual({ revision: stored.revision, updated: stored.updated }, before);
  assert.equal(stored.recordings.length, 1);
  assert.equal(app.element("transcript").value, "Keep text");
  assert.deepEqual(
    [app.element("transcript").selectionStart, app.element("transcript").selectionEnd],
    [2, 5],
  );
  assert.deepEqual(chatRows(app), [["Keep text", true]]);
});

test("moving a current chat preserves its unsaved draft and selection", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const app = await appEnvironment(t, (server) => {
    server.add("Original");
    server.addGroup("Project");
  });
  app.element("transcript").value = "Updated draft";
  setCursor(app, 2, 5);
  await app.element("transcript").emit("input");
  await openMoveDialog(app);
  await submitMove(app, id(100));
  const stored = app.server.chats.get(id(1));
  assert.equal(stored.text, "Original");
  assert.equal(app.element("transcript").value, "Updated draft");
  assert.equal(stored.group_id, id(100));
  assert.equal(stored.revision, 1, "moving never saves shared text");
  assert.equal(app.server.placementWrites[0].etag, `"placement-${id(1)}-1"`);
  assert.deepEqual(
    [app.element("transcript").selectionStart, app.element("transcript").selectionEnd],
    [2, 5],
  );
  await deleteRow(app, 0);
  assert.equal(app.server.chats.size, 0, "move does not replace the shared deletion validator");
});

test("stale move retains the draft and requires explicit retry with reconciled placement", async (t) => {
  const app = await appEnvironment(t, (server) => {
    server.add("Original");
    server.addGroup("Project");
    server.addGroup("Email");
  });
  await openMoveDialog(app);
  const stored = app.server.chats.get(id(1));
  stored.group_id = id(101);
  stored.placement_revision++;
  await submitMove(app, id(100));
  assert.equal(stored.group_id, id(101));
  assert.equal(app.element("group-move").open, true);
  assert.match(app.element("group-move-error").textContent, /changed elsewhere/);
  assert.equal(app.element("transcript").value, "Original");
  await submitMove(app, id(100));
  assert.equal(stored.group_id, id(100));
  assert.equal(app.server.placementWrites[1].etag, `"placement-${id(1)}-2"`);
  assert.equal(app.element("group-move").open, false);
});

test("a lost move response reconciles privately and a missing group retains the editor", async (t) => {
  const app = await appEnvironment(t, (server) => {
    server.add("Original");
    server.addGroup("Project");
  });
  const fetch = globalThis.fetch;
  let fail = true;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const response = await fetch(url, options);
    if (String(url).endsWith("/group") && options?.method === "PUT" && fail) {
      fail = false;
      throw new Error("Connection interrupted");
    }
    return response;
  });
  await openMoveDialog(app);
  await submitMove(app, id(100));
  assert.equal(app.element("group-move").open, false);
  assert.equal(app.server.chats.get(id(1)).group_id, id(100));
  await openMoveDialog(app);
  app.server.deleteGroup(id(100));
  await submitMove(app, id(100));
  // Deletion changed the validator, so conflict reconciliation happens first.
  assert.match(app.element("group-move-error").textContent, /changed elsewhere/);
  await submitMove(app, id(100));
  assert.match(app.element("group-move-error").textContent, /no longer exists/);
  assert.equal(app.element("transcript").value, "Original");
  await submitMove(app, null);
  assert.equal(app.element("group-move").open, false);
});

test("group actions respect recording guards while search keeps the recording active", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const app = await appEnvironment(t, (server) => {
    server.add("Original");
    server.addGroup("Project");
  });
  const socket = await startLive(app);
  assert.equal(app.element("new-group").disabled, true);
  assert.equal(groupSection(app, id(100)).children[0].children[1].disabled, true);
  assert.equal(chatAction(chatItems(app)[0], "Rename").disabled, true);
  assert.equal(chatAction(chatItems(app)[0], "Move").disabled, true);
  await app.element("new-group").emit("click");
  await chatAction(chatItems(app)[0], "Rename").emit("click");
  await chatAction(chatItems(app)[0], "Move").emit("click");
  assert.equal(app.element("group-editor").open, false);
  assert.equal(app.element("group-move").open, false);
  await filterChats(t, app, "unmatched");
  assert.equal(app.state.stops, 0);
  await app.element("stop").emit("click");
  await waitForEnd(socket);
  socket.event({ type: "done", text: "" });
  await waitForIdle(app);
});

test("a missing draft group retains captured audio through fresh Unsorted creation", async (t) => {
  const app = await appEnvironment(t, (server) => server.addGroup("Project"));
  await startGroupedDraft(app, id(100));
  app.server.deleteGroup(id(100));
  app.element("live-mode").checked = false;
  await app.element("record").emit("click");
  await app.element("stop").emit("click");
  await waitForIdle(app);
  assert.equal(app.element("draft-unsorted").hidden, false);
  assert.equal(app.element("clips").children.length, 1);
  assert.equal(app.server.batchPosts[0], app.wav);
  assert.equal(app.element("transcript").value, "Complete recording.");
  await app.element("draft-unsorted").emit("click");
  await settle();
  assert.equal(
    app.element("clips").children.length,
    1,
    "the captured WAV remains available for retry",
  );
  await app.element("clips").children[0].children[1].emit("click");
  await waitForIdle(app);
  const [stored] = app.server.chats.values();
  assert.equal(stored.group_id, null);
  assert.equal(stored.recordings.length, 1);
  assert.equal(stored.text, "Complete recording. Stored recording.");
});

test("a delayed move acknowledgement keeps newer editor text and selection", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const app = await appEnvironment(t, (server) => {
    server.add("Original");
    server.addGroup("Project");
  });
  const fetch = globalThis.fetch;
  let release;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const response = await fetch(url, options);
    if (String(url).endsWith("/group") && options?.method === "PUT")
      await new Promise((resolve) => {
        release = resolve;
      });
    return response;
  });
  await openMoveDialog(app);
  await submitMove(app, id(100));
  app.element("transcript").value = "Newer local draft";
  setCursor(app, 2, 7);
  await app.element("transcript").emit("input");
  await app.element("new-chat").emit("click");
  release();
  await waitForIdle(app);
  assert.equal(app.element("transcript").value, "Newer local draft");
  assert.deepEqual(
    [app.element("transcript").selectionStart, app.element("transcript").selectionEnd],
    [2, 7],
  );
  assert.equal(app.server.chats.get(id(1)).text, "Original");
  assert.equal(app.server.chats.get(id(1)).group_id, id(100));
});

test("independent group/chat snapshots keep unknown placements visible without rewriting them", async (t) => {
  const app = await appEnvironment(t, (server) => {
    server.add("Visible in Unsorted");
    server.add("Placed in a newer group").group_id = id(100);
  });
  assert.deepEqual(chatRows(app), [
    ["Visible in Unsorted", true],
    ["Placed in a newer group", false],
  ]);
  assert.equal(groupSection(app, id(100)).children[0].children[0].textContent, "Unavailable group");
  assert.deepEqual(app.server.placementWrites, []);
  assert.equal(app.server.chats.get(id(2)).group_id, id(100));
  app.server.addGroup("Project");
  await app.element("chat-filter-retry").emit("click");
  await settle();
  assert.equal(groupSection(app, id(100)).children[0].children[0].textContent, "Project");
  assert.deepEqual(app.server.placementWrites, []);
});

test("unavailable text saves do not block an independent placement move", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const app = await appEnvironment(t, (server) => server.add("Original"));
  await openMoveDialog(app);
  app.element("transcript").value = "Retained draft";
  await app.element("transcript").emit("input");
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url).endsWith("/text")) throw new Error("Save unavailable");
    return fetch(url, options);
  });
  await submitMove(app, null);
  assert.equal(app.element("group-move").open, false);
  assert.equal(app.server.placementWrites.length, 1);
  assert.equal(app.element("transcript").value, "Retained draft");
});

test("private placement reads cannot block opening or saving a chat", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const app = await appEnvironment(t, (server) => server.add("Original"));
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url).endsWith("/group") && !options?.method)
      throw new Error("Private placement unavailable");
    return fetch(url, options);
  });
  await app.element("new-chat").emit("click");
  await settle();
  await editAndSave(t, app, "New draft");
  assert.equal(
    [...app.server.chats.values()].find((chat) => chat.text === "New draft")?.text,
    "New draft",
  );
  await app.element("new-chat").emit("click");
  await settle();
  const original = chatItems(app).find(
    (row) => row.children[0].children[0].textContent === "Original",
  );
  await original.children[0].emit("click");
  await settle();
  assert.equal(app.element("transcript").value, "Original");
});

test("group registry failures preserve chats and search reuses known groups", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const app = await appEnvironment(t, (server) => server.add("Original"));
  const fetch = globalThis.fetch;
  let groupReads = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url) === "/api/groups") {
      groupReads++;
      throw new Error("Registry unavailable");
    }
    return fetch(url, options);
  });
  await app.element("chat-filter-retry").emit("click");
  await settle();
  assert.equal(groupReads, 1);
  assert.deepEqual(chatRows(app), [["Original", true]]);
  app.server.searchResults.set("Original", [id(1)]);
  app.element("chat-filter-input").value = "Original";
  await app.element("chat-filter-input").emit("input");
  t.mock.timers.tick(201);
  await settle();
  assert.equal(groupReads, 1);
  assert.deepEqual(chatRows(app), [["Original", true]]);
});

test("successful title save closes its inline editor before a delayed sidebar refresh", async (t) => {
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
  await openHeadingRename(app);
  await submitTitle(app, "Renamed");
  for (let attempt = 0; attempt < 20 && !finishRefresh; attempt++) await setImmediate();
  assert.equal(typeof finishRefresh, "function", "the title save reached its list refresh");
  assert.equal(inlineTitleEditor(app), null);
  assert.equal(app.element("chat-title").disabled, false);
  finishRefresh();
  await settle();
  assert.equal(app.element("chat-title").disabled, false);
  assert.equal(app.element("chat-title").textContent, "Renamed");
});

test("an older title refresh cannot blur a newly opened sidebar editor", async (t) => {
  const app = await appEnvironment(t, (server) => {
    server.add("First");
    server.add("Second");
  });
  const fetch = globalThis.fetch;
  let finishRefresh;
  let titleWrites = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url).endsWith("/title") && options?.method === "PUT") titleWrites++;
    if (url === "/api/chats")
      await new Promise((resolve) => {
        finishRefresh = resolve;
      });
    return fetch(url, options);
  });
  await openSidebarRename(app, 1);
  await submitTitle(app, "Saved name");
  for (let attempt = 0; attempt < 20 && !finishRefresh; attempt++) await setImmediate();
  assert.equal(typeof finishRefresh, "function");
  assert.equal(inlineTitleEditor(app), null);
  assert.equal(titleWrites, 1);

  const targetRow = () => chatItems(app).find((row) => row.getAttribute("data-chat-id") === id(2));
  await chatAction(targetRow(), "Rename").emit("click", { stopPropagation() {} });
  await settle();
  const input = app.element("title-input");
  assert.ok(inlineTitleEditor(app));
  input.value = "A newer proposal";
  await input.emit("input");
  input.setSelectionRange(3, 9);
  assert.equal(globalThis.document.activeElement, input);

  finishRefresh();
  await settle();
  assert.ok(inlineTitleEditor(app));
  assert.equal(app.element("title-input").value, "A newer proposal");
  assert.deepEqual(
    [app.element("title-input").selectionStart, app.element("title-input").selectionEnd],
    [3, 9],
  );
  assert.equal(titleWrites, 1, "the refresh does not implicitly submit the newer proposal");
  assert.equal(globalThis.document.activeElement, app.element("title-input"));
});

test("a delayed title refresh does not steal focus after a transcript click", async (t) => {
  const app = await appEnvironment(t, (server) => server.add("Original"));
  const fetch = globalThis.fetch;
  let finishRefresh;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url === "/api/chats")
      await new Promise((resolve) => {
        finishRefresh = resolve;
      });
    return fetch(url, options);
  });
  await openHeadingRename(app);
  await submitTitle(app, "Renamed");
  for (let attempt = 0; attempt < 20 && !finishRefresh; attempt++) await setImmediate();
  assert.equal(typeof finishRefresh, "function");
  const transcript = app.element("transcript");
  transcript.focus();
  finishRefresh();
  await settle();
  assert.equal(globalThis.document.activeElement, transcript);
});

test("a title refresh started before navigation cannot restore its old row focus", async (t) => {
  const app = await appEnvironment(t, (server) => {
    server.add("First");
    server.add("Second");
  });
  const secondLabel = findByClass(
    chatItems(app).find((row) => row.getAttribute("data-chat-id") === id(2)),
    "chat-open",
  );
  await secondLabel.emit("click", { detail: 0 });
  await waitForIdle(app);
  assert.equal(app.element("chat-title").textContent, "Second");
  const fetch = globalThis.fetch;
  let finishRefresh;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url === "/api/chats")
      await new Promise((resolve) => {
        finishRefresh = resolve;
      });
    return fetch(url, options);
  });
  await openSidebarRename(app, 1);
  await submitTitle(app, "Renamed second");
  for (let attempt = 0; attempt < 20 && !finishRefresh; attempt++) await setImmediate();
  assert.equal(typeof finishRefresh, "function");
  const firstLabel = findByClass(
    chatItems(app).find((row) => row.getAttribute("data-chat-id") === id(1)),
    "chat-open",
  );
  await firstLabel.emit("click", { detail: 0 });
  await waitForIdle(app);
  assert.equal(app.element("chat-title").textContent, "First");
  finishRefresh();
  await settle();
  assert.equal(app.element("chat-title").textContent, "First");
  const secondRow = chatItems(app).find((row) => row.getAttribute("data-chat-id") === id(2));
  assert.notEqual(globalThis.document.activeElement, chatAction(secondRow, "Rename"));
});

test("the phone drawer stays open when an inline title save has failed", async (t) => {
  const app = await appEnvironment(t, (server) => {
    server.add("First");
    server.add("Second");
  });
  const fetch = globalThis.fetch;
  let failOnce = true;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url).endsWith("/title") && options?.method === "PUT" && failOnce) {
      failOnce = false;
      throw new TypeError("Network unavailable");
    }
    return fetch(url, options);
  });
  await app.element("menu").emit("click");
  await openSidebarRename(app, 1);
  await submitTitle(app, "Recoverable name");
  assert.match(app.element("title-error").textContent, /Network unavailable/);
  await app.element("scrim").emit("click");
  await settle();
  assert.equal(app.element("sidebar").classList.contains("open"), true);
  assert.equal(app.element("scrim").hidden, false);
  assert.equal(app.element("title-input").value, "Recoverable name");
  await submitTitle(app, "Recoverable name");
  await app.element("scrim").emit("click");
  await settle();
  assert.equal(app.element("sidebar").classList.contains("open"), false);
});

test("autosave keeps same-query rows visible during refresh and after a failure", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const app = await appEnvironment(t, (server) => {
    server.add("First");
    server.add("Second");
  });
  const fetch = globalThis.fetch;
  let failRefresh;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url === "/api/chats")
      await new Promise((resolve, reject) => {
        failRefresh = reject;
      });
    return fetch(url, options);
  });
  await editAndSave(t, app, "Edited first");
  assert.equal(app.element("chat-list").hidden, false);
  assert.equal(chatRows(app).length, 2);
  failRefresh(new TypeError("Offline"));
  await settle();
  assert.equal(app.element("chat-list").hidden, false);
  assert.equal(chatRows(app).length, 2);
  assert.equal(app.element("chat-filter-state").textContent, "Offline");
  assert.equal(app.element("chat-filter-retry").hidden, false);
});

for (const edit of [false, true]) {
  test(`startup failure shows a banner and retry ${edit ? "preserves edits" : "opens the latest chat"}`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let fail = true;
    const app = await appEnvironment(t, (server) => {
      server.add("Latest saved transcript");
      const fetch = server.fetch;
      server.fetch = async (url, options) => {
        if (url === "/api/chats" && fail) throw new TypeError("Offline");
        return fetch(url, options);
      };
    });
    assert.equal(app.element("error").hidden, false);
    assert.match(app.element("error").textContent, /Saved chats could not be loaded/);
    if (edit) {
      app.element("transcript").value = "My draft";
      await app.element("transcript").emit("input");
      setCursor(app, 2, 4);
    }
    fail = false;
    await app.element("chat-filter-retry").emit("click");
    await settle();
    assert.equal(app.element("transcript").value, edit ? "My draft" : "Latest saved transcript");
    assert.equal(app.element("error").hidden, true);
    if (edit)
      assert.deepEqual(
        [app.element("transcript").selectionStart, app.element("transcript").selectionEnd],
        [2, 4],
      );
  });
}

test("invalid search queries show validation feedback without an ineffective retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const app = await appEnvironment(t);
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url, options) =>
    String(url).includes("?q=")
      ? Response.json(
          { code: "invalid_search_query", detail: "Search accepts up to 16 different words." },
          { status: 422 },
        )
      : fetch(url, options),
  );
  await filterChats(t, app, Array.from({ length: 17 }, (_, i) => `word${i}`).join(" "));
  assert.match(app.element("chat-filter-state").textContent, /16 different words/);
  assert.equal(app.element("chat-filter-retry").hidden, true);
  await app.element("chat-filter-clear").emit("click");
  await settle();
  assert.equal(app.element("chat-list").hidden, false);
});

for (const recovery of ["search and clear", "autosave"]) {
  test(`startup warning clears when ${recovery} recovers the chat list`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let fail = true;
    const app = await appEnvironment(t, (server) => {
      server.add("Saved transcript");
      const fetch = server.fetch;
      server.fetch = async (url, options) => {
        if (url === "/api/chats" && fail) throw new TypeError("Offline");
        return fetch(url, options);
      };
    });
    assert.equal(app.element("error").hidden, false);
    fail = false;
    if (recovery === "autosave") await editAndSave(t, app, "Local draft");
    else {
      await filterChats(t, app, "Saved");
      assert.equal(app.element("error").hidden, true);
      await app.element("chat-filter-clear").emit("click");
      await settle();
    }
    assert.equal(app.element("error").hidden, true);
    assert.equal(app.element("chat-filter-retry").hidden, true);
    assert.equal(app.element("transcript").value, recovery === "autosave" ? "Local draft" : "");
  });
}

test("autosaves and uploads reuse the group registry without surfacing unrelated read failures", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const app = await appEnvironment(t, (server) => server.add("Original"));
  const fetch = globalThis.fetch;
  let groupReads = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url) === "/api/groups") {
      groupReads++;
      throw new Error("Registry unavailable");
    }
    return fetch(url, options);
  });
  await editAndSave(t, app, "First edit");
  await editAndSave(t, app, "Second edit");
  assert.equal(groupReads, 0);
  assert.equal(app.element("error").hidden, true);
  assert.equal(app.server.chats.get(id(1)).text, "Second edit");
  app.element("live-mode").checked = false;
  await app.element("record").emit("click");
  await app.element("stop").emit("click");
  await waitForIdle(app);
  assert.equal(app.server.chats.get(id(1)).recordings.length, 1);
  assert.equal(groupReads, 0);
  assert.equal(app.element("error").hidden, true);
  await app.element("chat-filter-retry").emit("click");
  await settle();
  assert.equal(groupReads, 1);
  assert.equal(app.element("error").hidden, false);
});

/** Install the preferences/export API without duplicating the backend formatter in tests. */
function exportServer(t) {
  const underlying = globalThis.fetch;
  const server = {
    requests: [],
    preamble: "Server preamble",
    sharePreamble: false,
    get exportRequests() {
      return this.requests.filter(([url]) => url === "/api/exports");
    },
    etag: '"preference-1"',
    exportText: "Exact backend output 🌻\n````text\nDraft\n````",
    failSave: null,
  };
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    if (!String(url).startsWith("/api/preferences") && !String(url).startsWith("/api/exports"))
      return underlying(url, options);
    server.requests.push([url, options]);
    if (url === "/api/exports" || url === "/api/exports/preview")
      return Response.json({ text: server.exportText, media_type: "text/markdown" });
    if (options.method === "PATCH") {
      if (server.failSave === "network") throw new TypeError("Network unavailable");
      if (server.failSave)
        return Response.json(
          { detail: "Preferences changed elsewhere", code: "revision_conflict" },
          { status: 412 },
        );
      const body = JSON.parse(options.body);
      if (body.reset?.includes("copy_preamble")) server.preamble = "Default preamble";
      else if (body.copy_preamble !== undefined) server.preamble = body.copy_preamble;
      if (body.share_include_preamble !== undefined)
        server.sharePreamble = body.share_include_preamble;
      server.etag = '"preference-2"';
    }
    return Response.json(
      {
        copy_preamble: server.preamble,
        share_include_preamble: server.sharePreamble,
        default_copy_preamble: "Default preamble",
        max_copy_preamble_characters: 4000,
        revision: 1,
      },
      { headers: { ETag: server.etag } },
    );
  });
  return server;
}

test("sharing uses saved preamble choice and copies exact unsaved text on a fresh gesture", async (t) => {
  const app = await appEnvironment(t, (server) => server.add("Saved words"));
  const exports = exportServer(t);
  exports.sharePreamble = true;
  const transcript = app.element("transcript");
  transcript.value = "  Unsaved draft 🌻\n````  ";
  transcript.setSelectionRange(2, 7);
  await transcript.emit("input");
  await app.element("share").emit("click");
  assert.equal(app.element("prepared-dialog").open, true);
  assert.equal(app.element("prepared-text").value, exports.exportText);
  assert.equal(app.element("share-preamble").checked, true);
  assert.equal(app.copied.length, 0);
  assert.deepEqual(JSON.parse(exports.exportRequests[0][1].body), {
    text: transcript.value,
    format: "with_preamble",
  });
  await app.element("prepared-copy").emit("click");
  assert.deepEqual(app.copied, [exports.exportText]);
  assert.equal(transcript.value, "  Unsaved draft 🌻\n````  ");
  assert.equal(transcript.selectionStart, 2);
  assert.equal(transcript.selectionEnd, 7);
  assert.equal(app.element("save-state").textContent, "Editing…");
  assert.equal(exports.exportRequests.length, 1);
});

test("clipboard failure selects backend-prepared output and retries the same payload", async (t) => {
  const app = await appEnvironment(t, (server) => server.add("Saved words"));
  const exports = exportServer(t);
  t.mock.method(navigator.clipboard, "writeText", async () => {
    throw new Error("Denied");
  });
  await app.element("share").emit("click");
  await app.element("prepared-copy").emit("click");
  assert.match(app.element("prepared-status").textContent, /Text selected/);
  assert.equal(app.element("prepared-text").focused, true);
  assert.equal(app.element("prepared-text").selectionEnd, exports.exportText.length);
  assert.equal(app.element("prepared-text").value, exports.exportText);
  assert.equal(app.element("transcript").value, "Saved words");
  t.mock.method(navigator.clipboard, "writeText", async (text) => app.copied.push(text));
  exports.exportText = "New result must not be used";
  await app.element("prepared-copy").emit("click");
  assert.deepEqual(app.copied, [app.element("prepared-text").value]);
  assert.equal(exports.exportRequests.length, 1);
});

test("preamble preference editing previews on the server, cancels and saves with its validator", async (t) => {
  const app = await appEnvironment(t);
  const exports = exportServer(t);
  await app.element("preferences-open").emit("click");
  await settle();
  const input = app.element("copy-preamble-input");
  assert.equal(input.value, "Server preamble");
  input.value = "Unsaved preference";
  await app.element("preferences-preview-button").emit("click");
  assert.equal(app.element("preferences-preview").value, exports.exportText);
  assert.equal(exports.preamble, "Server preamble");
  await app.element("preferences-cancel").emit("click");
  await app.element("preferences-open").emit("click");
  await settle();
  assert.equal(input.value, "Server preamble");
  input.value = "Saved preference";
  await app.element("preferences-save").emit("click");
  assert.equal(exports.preamble, "Saved preference");
  const [, save] = exports.requests.find(([, options]) => options.method === "PATCH");
  assert.equal(save.headers["If-Match"], '"preference-1"');
  assert.equal(app.element("preferences-dialog").open, false);
  await app.element("preferences-open").emit("click");
  await settle();
  await app.element("preferences-reset").emit("click");
  assert.equal(input.value, "Default preamble");
  await app.element("preferences-save").emit("click");
  assert.deepEqual(JSON.parse(exports.requests.at(-1)[1].body), { reset: ["copy_preamble"] });
});

for (const failure of ["conflict", "network"])
  test(`a ${failure} preference save keeps the draft until explicit confirmed reload`, async (t) => {
    const app = await appEnvironment(t);
    const exports = exportServer(t);
    await app.element("preferences-open").emit("click");
    await settle();
    app.element("copy-preamble-input").value = "My preference draft";
    exports.failSave = failure;
    await app.element("preferences-save").emit("click");
    assert.equal(app.element("copy-preamble-input").value, "My preference draft");
    assert.equal(app.element("preferences-dialog").open, true);
    assert.equal(app.element("preferences-save").disabled, true);
    assert.equal(app.element("preferences-reload").hidden, false);
    t.mock.method(globalThis.window, "confirm", () => false);
    await app.element("preferences-reload").emit("click");
    assert.equal(app.element("copy-preamble-input").value, "My preference draft");
    t.mock.method(globalThis.window, "confirm", () => true);
    await app.element("preferences-reload").emit("click");
    await settle();
    assert.equal(app.element("copy-preamble-input").value, "Server preamble");
    assert.equal(app.element("preferences-save").disabled, false);
  });

test("closing preferences ignores its pending response after reopening", async (t) => {
  const app = await appEnvironment(t);
  exportServer(t);
  const fetch = globalThis.fetch;
  let release;
  let delay = true;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const response = await fetch(url, options);
    if (url === "/api/preferences" && delay) {
      delay = false;
      await new Promise((resolve) => {
        release = resolve;
      });
      return Response.json({ copy_preamble: "Stale response" }, { headers: { ETag: '"stale"' } });
    }
    return response;
  });
  await app.element("preferences-open").emit("click");
  await settle();
  await app.element("preferences-cancel").emit("click");
  await app.element("preferences-open").emit("click");
  await settle();
  app.element("copy-preamble-input").value = "New draft";
  release();
  await settle();
  assert.equal(app.element("copy-preamble-input").value, "New draft");
});

test("clipboard retries keep exact backend CRLF despite textarea normalization", async (t) => {
  const app = await appEnvironment(t, (server) => server.add("Draft"));
  const exports = exportServer(t);
  exports.exportText = "Preamble\r\nSecond line\n\n```text\nDraft\n```";
  const exact = exports.exportText;
  const output = app.element("prepared-text");
  let displayed = "";
  // Model the browser's actual textarea normalization for this regression.
  Object.defineProperty(output, "value", {
    get: () => displayed,
    set: (text) => {
      displayed = text.replace(/\r\n?/gu, "\n");
    },
  });
  await app.element("share").emit("click");
  assert.notEqual(output.value, exact);
  await app.element("prepared-copy").emit("click");
  assert.deepEqual(app.copied, [exact]);
  t.mock.method(navigator.clipboard, "writeText", async () => {
    throw new Error("Denied");
  });
  await app.element("prepared-copy").emit("click");
  assert.match(app.element("prepared-status").textContent, /Text selected/);
  t.mock.method(navigator.clipboard, "writeText", async (text) => app.copied.push(text));
  exports.exportText = "A later response must not replace the prepared string";
  await app.element("prepared-copy").emit("click");
  assert.deepEqual(app.copied, [exact, exact]);
  assert.equal(exports.exportRequests.length, 1);
});

test("native sharing prepares the exact unsaved draft and waits for a fresh share gesture", async (t) => {
  const app = await appEnvironment(t, (server) => server.add("Saved words"));
  const exports = exportServer(t);
  exports.exportText = "Backend text\r\nwith exact line endings 🌻";
  const shares = [];
  Object.defineProperty(navigator, "share", {
    configurable: true,
    value: async (data) => shares.push(data),
  });
  app.element("transcript").value = "Unsaved edited draft";
  app.element("transcript").setSelectionRange(3, 9);
  await app.element("transcript").emit("input");
  await app.element("share").emit("click");
  assert.equal(app.element("prepared-dialog").open, true);
  assert.equal(app.element("share-preamble").checked, false);
  assert.deepEqual(JSON.parse(exports.exportRequests[0][1].body), {
    text: "Unsaved edited draft",
    format: "plain",
  });
  assert.equal(shares.length, 0);
  await app.element("prepared-share").emit("click");
  assert.deepEqual(shares, [{ text: exports.exportText }]);
  assert.match(app.element("prepared-status").textContent, /Handed off.*delivery.*unconfirmed/);
  assert.equal(app.element("transcript").value, "Unsaved edited draft");
  assert.equal(app.element("transcript").selectionStart, 3);
  assert.equal(app.element("transcript").selectionEnd, 9);
  assert.equal(app.server.chats.get(id(1)).text, "Saved words");
  app.element("share-preamble").checked = true;
  await app.element("share-preamble").emit("change");
  assert.equal(JSON.parse(exports.exportRequests.at(-1)[1].body).format, "with_preamble");
  await app.element("prepared-share").emit("click");
  assert.equal(shares.length, 2);
  assert.equal(exports.exportRequests.length, 2);
});

for (const capability of ["missing", "denied by canShare", "insecure"])
  test(`sharing ${capability} retains prepared text and offers fallbacks`, async (t) => {
    const app = await appEnvironment(t, (server) => server.add("Draft"));
    const exports = exportServer(t);
    if (capability !== "missing")
      Object.defineProperty(navigator, "share", {
        configurable: true,
        value: async () => assert.fail("No native handoff"),
      });
    if (capability === "denied by canShare")
      Object.defineProperty(navigator, "canShare", { configurable: true, value: () => false });
    if (capability === "insecure") globalThis.window.isSecureContext = false;
    await app.element("share").emit("click");
    assert.equal(app.element("prepared-share").disabled, true);
    assert.equal(app.element("prepared-share").hidden, capability === "missing");
    assert.equal(app.element("prepared-copy").disabled, false);
    assert.equal(app.element("prepared-download").disabled, false);
    assert.match(
      app.element("prepared-status").textContent,
      capability === "missing" ? /This browser cannot open a share window/ : /unavailable/,
    );
    assert.equal(app.element("share-help").hidden, capability === "missing");
    assert.equal(
      app.element("prepared-copy").classList.contains("accent"),
      capability === "missing",
    );
    await app.element("prepared-copy").emit("click");
    assert.deepEqual(app.copied, [exports.exportText]);
  });

for (const [name, message] of [
  ["AbortError", /cancelled, or no destination/],
  ["NotAllowedError", /not allowed/],
  ["InvalidStateError", /Another share window is already open/],
  ["TypeError", /cannot share/],
  ["DataError", /outcome is unknown.*Check the destination/],
])
  test(`native ${name} keeps the exact payload without automatically retrying`, async (t) => {
    const app = await appEnvironment(t, (server) => server.add("Draft"));
    const exports = exportServer(t);
    let calls = 0;
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async () => {
        calls++;
        throw new DOMException("Sensitive platform detail", name);
      },
    });
    await app.element("share").emit("click");
    await app.element("prepared-share").emit("click");
    assert.match(app.element("prepared-status").textContent, message);
    assert.doesNotMatch(app.element("prepared-status").textContent, /Sensitive/);
    assert.equal(app.element("prepared-text").value, exports.exportText);
    assert.equal(calls, 1);
    assert.equal(exports.exportRequests.length, 1);
    await app.element("prepared-copy").emit("click");
    assert.deepEqual(app.copied, [exports.exportText]);
    assert.equal(calls, 1);
  });

test("closing preparation ignores its late result after a newer dialog opens", async (t) => {
  const app = await appEnvironment(t, (server) => server.add("Draft"));
  const exports = exportServer(t);
  const fetch = globalThis.fetch;
  let release;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const response = await fetch(url, options);
    if (url === "/api/exports" && exports.exportRequests.length === 1)
      await new Promise((resolve) => {
        release = resolve;
      });
    return response;
  });
  const pending = app.element("share").emit("click");
  await settle();
  await app.element("prepared-close").emit("click");
  exports.exportText = "New prepared result";
  await app.element("share").emit("click");
  release();
  await pending;
  assert.equal(app.element("prepared-text").value, "New prepared result");
  assert.equal(app.element("share-preamble").checked, false);
});

test("a pending share belongs to its dialog and cannot unlock a newer handoff", async (t) => {
  const app = await appEnvironment(t, (server) => server.add("Draft"));
  exportServer(t);
  const releases = [];
  Object.defineProperty(navigator, "share", {
    configurable: true,
    value: () =>
      new Promise((resolve) => {
        releases.push(resolve);
      }),
  });
  await app.element("share").emit("click");
  const oldShare = app.element("prepared-share").emit("click");
  await app.element("prepared-share").emit("click");
  assert.equal(releases.length, 1);
  await app.element("prepared-close").emit("click");
  await app.element("share").emit("click");
  assert.equal(app.element("prepared-share").disabled, false);
  assert.equal(app.element("share-preamble").disabled, false);
  const newShare = app.element("prepared-share").emit("click");
  const message = app.element("prepared-status").textContent;
  releases[0]();
  await oldShare;
  assert.equal(app.element("prepared-share").disabled, true);
  assert.equal(app.element("prepared-status").textContent, message);
  releases[1]();
  await newShare;
  assert.equal(app.element("prepared-share").disabled, false);
  assert.match(app.element("prepared-status").textContent, /Handed off/);
});

test("download fallback preserves exact UTF-8 prepared bytes and backend media type", async (t) => {
  const app = await appEnvironment(t, (server) => server.add("Draft"));
  const exports = exportServer(t);
  exports.exportText = "Literal text 🌻\r\nSecond line\n";
  let blob;
  let link;
  let requested = 0;
  const revoked = [];
  t.mock.method(URL, "createObjectURL", (value) => {
    blob = value;
    return "blob:prepared-export";
  });
  t.mock.method(URL, "revokeObjectURL", (url) => revoked.push(url));
  const createElement = globalThis.document.createElement;
  t.mock.method(globalThis.document, "createElement", (tag) => {
    const element = createElement(tag);
    if (tag === "a") {
      link = element;
      link.addEventListener("click", () => {
        requested++;
      });
    }
    return element;
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await app.element("share").emit("click");
  await app.element("prepared-download").emit("click");
  assert.equal(requested, 1);
  assert.equal(await blob.text(), exports.exportText);
  assert.equal(blob.type, "text/markdown;charset=utf-8");
  assert.equal(link.href, "blob:prepared-export");
  assert.equal(link.download, "dictation.md");
  assert.equal(exports.exportRequests.length, 1);
  assert.match(app.element("prepared-status").textContent, /Download requested/);
  // Closing the dialog does not invalidate or mutate the already-created download Blob.
  await app.element("prepared-close").emit("click");
  assert.equal(await blob.text(), exports.exportText);
  assert.deepEqual(revoked, []);
  t.mock.timers.tick(1000);
  assert.deepEqual(revoked, ["blob:prepared-export"]);
});

test("typing text equal to the default saves custom text; Use default is explicit", async (t) => {
  const app = await appEnvironment(t);
  const server = exportServer(t);
  await app.element("preferences-open").emit("click");
  await settle();
  await app.element("preferences-reset").emit("click");
  await app.element("copy-preamble-input").emit("input");
  await app.element("preferences-save").emit("click");
  assert.deepEqual(JSON.parse(server.requests.at(-1)[1].body), {
    copy_preamble: "Default preamble",
  });
});

test("a successful preview clears an earlier preview error", async (t) => {
  const app = await appEnvironment(t);
  exportServer(t);
  const originalFetch = globalThis.fetch;
  let failing = true;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url === "/api/exports/preview" && failing)
      return Response.json(
        { detail: "Invalid preamble", code: "validation_error" },
        { status: 422 },
      );
    return originalFetch(url, options);
  });
  await app.element("preferences-open").emit("click");
  await settle();
  await app.element("preferences-preview-button").emit("click");
  assert.equal(app.element("preferences-error").hidden, false);
  failing = false;
  await app.element("preferences-preview-button").emit("click");
  assert.equal(app.element("preferences-error").hidden, true);
});

test("export timeout reports the error and enables preparation again", async (t) => {
  const app = await appEnvironment(t, (server) => server.add("Saved words"));
  exportServer(t);
  const deadline = new AbortController();
  t.mock.method(AbortSignal, "timeout", () => deadline.signal);
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url === "/api/exports")
      return new Promise((_, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), {
          once: true,
        });
      });
    return originalFetch(url, options);
  });
  const pending = app.element("share").emit("click");
  await settle();
  assert.equal(app.element("share").disabled, true);
  deadline.abort(new DOMException("Request timed out", "TimeoutError"));
  await pending;
  assert.equal(app.element("share").disabled, false);
  assert.equal(app.element("prepared-dialog").open, true);
  assert.match(app.element("prepared-status").textContent, /timed out/);
  assert.equal(app.element("share-preamble").disabled, false);
});

test("preamble mode stays visible when typing, undoing and restoring the default", async (t) => {
  const app = await appEnvironment(t);
  exportServer(t);
  await app.element("preferences-open").emit("click");
  await settle();
  const mode = app.element("preferences-mode");
  assert.match(mode.textContent, /Using a custom preamble/);
  await app.element("preferences-reset").emit("click");
  assert.match(mode.textContent, /Using the default preamble/);
  app.element("copy-preamble-input").value = "Edited";
  await app.element("copy-preamble-input").emit("input");
  assert.match(mode.textContent, /Using a custom preamble/);
  app.element("copy-preamble-input").value = "Default preamble";
  await app.element("copy-preamble-input").emit("input");
  assert.match(mode.textContent, /Using a custom preamble/);
  await app.element("preferences-reset").emit("click");
  assert.match(mode.textContent, /Future updates apply automatically/);
});

test("share preamble changes persist conditionally and initialize the next dialog", async (t) => {
  const app = await appEnvironment(t, (server) => server.add("Draft"));
  const server = exportServer(t);
  await app.element("share").emit("click");
  assert.equal(app.element("share-preamble").checked, false);
  app.element("share-preamble").checked = true;
  await app.element("share-preamble").emit("change");
  const patch = server.requests.find(([, options]) => options.method === "PATCH")[1];
  assert.deepEqual(JSON.parse(patch.body), { share_include_preamble: true });
  assert.equal(patch.headers["If-Match"], '"preference-1"');
  assert.equal(JSON.parse(server.exportRequests.at(-1)[1].body).format, "with_preamble");
  await app.element("prepared-close").emit("click");
  await app.element("share").emit("click");
  assert.equal(app.element("share-preamble").checked, true);
  assert.equal(server.sharePreamble, true);
  assert.equal(server.preamble, "Server preamble");
});

test("failed sharing preference load does not invent a checkbox default or prepare text", async (t) => {
  const app = await appEnvironment(t, (server) => server.add("Draft"));
  const server = exportServer(t);
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (url, options) =>
    url === "/api/preferences" ? Promise.reject(new TypeError("Offline")) : fetch(url, options),
  );
  await app.element("share").emit("click");
  assert.equal(app.element("share-preamble").indeterminate, true);
  assert.equal(app.element("share-preamble").disabled, true);
  assert.equal(app.element("prepared-copy").disabled, true);
  assert.equal(app.element("prepared-download").disabled, true);
  assert.equal(server.exportRequests.length, 0);
  assert.match(app.element("prepared-status").textContent, /Offline.*Close and reopen/);
  assert.equal(app.element("transcript").value, "Draft");
});

for (const failure of ["conflict", "network"])
  test(`sharing preference ${failure} keeps prepared text and requires a fresh read`, async (t) => {
    const app = await appEnvironment(t, (server) => server.add("Draft"));
    const server = exportServer(t);
    await app.element("share").emit("click");
    const text = app.element("prepared-text").value;
    server.failSave = failure;
    app.element("share-preamble").checked = true;
    await app.element("share-preamble").emit("change");
    assert.match(app.element("prepared-status").textContent, /Could not save.*Close and reopen/);
    assert.equal(app.element("share-preamble").checked, false);
    assert.equal(app.element("share-preamble").disabled, true);
    assert.equal(app.element("prepared-text").value, text);
    assert.equal(app.element("transcript").value, "Draft");
    assert.equal(server.exportRequests.length, 1);
    await app.element("prepared-copy").emit("click");
    assert.deepEqual(app.copied, [text]);
    server.failSave = null;
    server.sharePreamble = true;
    await app.element("prepared-close").emit("click");
    await app.element("share").emit("click");
    assert.equal(app.element("share-preamble").checked, true);
    assert.equal(app.element("share-preamble").disabled, false);
  });
