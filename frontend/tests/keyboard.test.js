import assert from "node:assert/strict";
import test from "node:test";
import { eventBinding } from "../../src/diktator/static/keyboard.js";

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
