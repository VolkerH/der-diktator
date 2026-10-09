import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { eventBinding, keyboardControls } from "../../src/diktator/static/keyboard.js";

const key = {
  key: "@",
  code: "Digit2",
  ctrlKey: true,
  metaKey: false,
  shiftKey: true,
  altKey: false,
  repeat: false,
  isComposing: false,
  getModifierState: () => false,
};

test("portable keyboard bindings use physical digits and logical letters", () => {
  assert.equal(eventBinding(key), "Ctrl+Shift+2");
  assert.equal(eventBinding({ ...key, ctrlKey: false, metaKey: true }), null);
  assert.equal(eventBinding({ ...key, code: "KeyK", key: "k" }), "Ctrl+Shift+K");
  assert.equal(
    eventBinding({ ...key, code: "ArrowDown", key: "ArrowDown" }),
    "Ctrl+Shift+ArrowDown",
  );
});

test("typing, browser editing chords, repeats, IME and AltGr never become shortcuts", () => {
  for (const changes of [
    { ctrlKey: false },
    { shiftKey: false },
    { metaKey: true },
    { altKey: true },
    { repeat: true },
    { isComposing: true },
    { getModifierState: () => true },
  ])
    assert.equal(eventBinding({ ...key, ...changes }), null);
  assert.equal(eventBinding({ ...key, ctrlKey: false, metaKey: true }), null);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Small DOM stand-in for settings state; native Enter/Tab is checked in Chromium. */
function settings(t) {
  const previous = Object.fromEntries(
    ["document", "window", "HTMLElement", "fetch"].map((name) => [name, globalThis[name]]),
  );
  t.after(() => Object.assign(globalThis, previous));
  class Element {
    constructor(id = "") {
      this.id = id;
      this.children = [];
      this.listeners = new Map();
      this.open = false;
      this.value = "";
      this.disabled = false;
    }
    addEventListener(type, listener) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    async emit(type, event = {}) {
      for (const listener of this.listeners.get(type) ?? []) await listener(event);
    }
    append(...children) {
      this.children.push(...children);
    }
    replaceChildren() {
      this.children = [];
    }
    setAttribute() {}
    contains(element) {
      return this === element || this.children.some((child) => child.contains(element));
    }
    focus() {
      if (!this.disabled) globalThis.document.activeElement = this;
    }
    showModal() {
      this.open = true;
    }
    close() {
      this.open = false;
    }
  }
  const elements = new Map(
    ["dialog", "bindings", "status", "save", "reset", "reload", "open", "close"].map((name) => [
      `keyboard-${name}`,
      new Element(`keyboard-${name}`),
    ]),
  );
  const element = (name) => elements.get(`keyboard-${name}`);
  element("dialog").append(...["close", "bindings", "save", "reset", "reload"].map(element));
  globalThis.HTMLElement = Element;
  globalThis.document = {
    activeElement: new Element("outside"),
    getElementById: (id) => elements.get(id),
    createElement: () => new Element(),
    querySelector: () => (element("dialog").open ? element("dialog") : null),
  };
  globalThis.window = new Element();
  const requests = [];
  globalThis.fetch = (url, options) => {
    const result = deferred();
    requests.push({ url, ...options, ...result });
    return result.promise;
  };
  let searches = 0;
  const controls = keyboardControls({ search_chats: () => searches++ });
  const preferences = {
    keyboard_actions: [{ id: "search_chats", label: "Search chats" }],
    keyboard_bindings: { search_chats: "Ctrl+Shift+2" },
    default_keyboard_bindings: { search_chats: "Ctrl+Shift+2" },
  };
  const reply = async (index, body = preferences, etag = '"initial"', status = 200) => {
    requests[index].resolve(Response.json(body, { status, headers: { ETag: etag } }));
    await setImmediate();
  };
  const input = () => element("bindings").children[0].children[1];
  const open = async () => {
    controls.open();
    await reply(requests.length - 1);
  };
  const shortcut = () =>
    globalThis.window.emit("keydown", {
      ...key,
      preventDefault() {},
      target: globalThis.document.activeElement,
    });
  return { element, requests, reply, open, input, preferences, shortcut, searches: () => searches };
}

test("window refreshes and reopening cannot read over an outstanding settings write", async (t) => {
  const app = settings(t);
  await app.reply(0);
  await app.open();
  app.input().value = "";
  const saving = app.element("save").emit("click");
  assert.equal(app.requests[2].method, "PATCH");
  app.element("dialog").close();
  await globalThis.window.emit("focus");
  assert.equal(app.requests.length, 3, "focus must not start a pre-save GET");
  await app.element("open").emit("click");
  assert.equal(app.requests.length, 3, "reopening must not start a pre-save GET");
  assert.equal(app.input().value, "", "the outstanding save owns its draft");
  assert.equal(app.element("save").disabled, true);
  await app.element("save").emit("click");
  assert.equal(app.requests.length, 3, "the write remains locked");
  await app.reply(2, { ...app.preferences, keyboard_bindings: { search_chats: null } }, '"saved"');
  await saving;
  const secondSave = app.element("save").emit("click");
  assert.equal(app.requests[3].headers["If-Match"], '"saved"');
  await app.reply(3, { ...app.preferences, keyboard_bindings: { search_chats: null } }, '"saved"');
  await secondSave;
  app.element("dialog").close();
  await app.shortcut();
  assert.equal(app.searches(), 0, "a successfully disabled shortcut stays disabled");
});

test("superseded GET completion cannot unlock or replace the current settings read", async (t) => {
  const app = settings(t);
  await app.element("open").emit("click");
  await app.reply(0, app.preferences, '"older"');
  assert.equal(app.element("save").disabled, true);
  await app.reply(1, { ...app.preferences, keyboard_bindings: { search_chats: null } }, '"newer"');
  assert.equal(app.input().value, "");
  const saving = app.element("save").emit("click");
  assert.equal(app.requests[2].headers["If-Match"], '"newer"');
  await app.reply(2);
  await saving;
});

test("a rejected pending save keeps its reopened draft and requires explicit reload", async (t) => {
  const app = settings(t);
  await app.reply(0);
  await app.open();
  app.input().value = "Ctrl+Shift+9";
  const saving = app.element("save").emit("click");
  app.element("dialog").close();
  await globalThis.window.emit("focus");
  await app.element("open").emit("click");
  assert.equal(app.requests.length, 3);
  await app.reply(2, { code: "revision_conflict", detail: "Changed elsewhere." }, '"other"', 412);
  await saving;
  assert.equal(app.input().value, "Ctrl+Shift+9");
  assert.equal(app.element("save").disabled, true);
  assert.equal(app.element("reload").hidden, false);
  await app.element("save").emit("click");
  assert.equal(app.requests.length, 3);
  await app.element("reload").emit("click");
  await app.reply(3, app.preferences, '"latest"');
  assert.equal(app.input().value, "Ctrl+Shift+2");
  const retry = app.element("save").emit("click");
  assert.equal(app.requests[4].headers["If-Match"], '"latest"');
  await app.reply(4);
  await retry;
});
