import assert from "node:assert/strict";
import test from "node:test";
import { spliceText, titleFor } from "../../src/diktator/static/chats.js";

test("transcripts are inserted at the cursor with spaces only where words would touch", () => {
  assert.deepEqual(spliceText("", 0, 0, " Hello. "), { text: "Hello.", caret: 6 });
  assert.deepEqual(spliceText("Start end.", 6, 6, "middle"), {
    text: "Start middle end.",
    caret: 12,
  });
  assert.deepEqual(spliceText("One.", 4, 4, "Two."), { text: "One. Two.", caret: 9 });
  assert.deepEqual(spliceText("Line\n", 5, 5, "Next"), { text: "Line\nNext", caret: 9 });
});

test("a selection is replaced, and empty speech changes nothing", () => {
  assert.deepEqual(spliceText("Keep old keep", 5, 8, "new"), {
    text: "Keep new keep",
    caret: 8,
  });
  assert.deepEqual(spliceText("Keep old keep", 5, 8, "  "), { text: "Keep old keep", caret: 8 });
});

test("chat titles match the server's", () => {
  assert.equal(titleFor(" \n "), "New chat");
  assert.equal(titleFor("Hello  there\nfriend"), "Hello there friend");
  assert.equal(titleFor("word ".repeat(20)), Array(9).fill("word").join(" ") + "…");
});
