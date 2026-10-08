import assert from "node:assert/strict";
import test from "node:test";
import {
  replaceSelection,
  sameDraft,
  streamCorrection,
} from "../../src/diktator/static/corrections.js";

const draft = { text: "Before 🙂\n  wrong. \tAfter 🪶", key: 2, version: 3, active: false };

test("correction replacement preserves Unicode and exact text outside selection", () => {
  const start = draft.text.indexOf("  wrong.");
  const end = draft.text.indexOf("After");
  const text = replaceSelection({ snapshot: draft, start, end }, "  Correct. \t");
  assert.equal(text, "Before 🙂\n  Correct. \tAfter 🪶");
});

test("editor versions reject edit-then-undo, navigation, recording and text changes", () => {
  assert.equal(sameDraft(draft, { ...draft }), true);
  for (const changed of [{ version: 4 }, { key: 3 }, { active: true }, { text: "Other" }]) {
    assert.equal(sameDraft(draft, { ...draft, ...changed }), false);
  }
});

/** Split transport bytes at arbitrary boundaries, including inside UTF-8 codepoints. */
function response(lines) {
  const bytes = new TextEncoder().encode(lines);
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let index = 0; index < bytes.length; index += 3)
          controller.enqueue(bytes.slice(index, index + 3));
        controller.close();
      },
    }),
  );
}

const line = (type, text) => JSON.stringify({ type, text }) + "\n";

test("only authoritative done text is returned after chunked streaming", async (t) => {
  const deltas = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "/api/corrections");
    assert.deepEqual(JSON.parse(options.body), { text: "selected only", mode: "paragraphs" });
    return response(line("delta", "Early 🙂") + line("done", "  Final 🙂\n"));
  });
  const result = await streamCorrection(
    "selected only",
    "paragraphs",
    new AbortController().signal,
    (text) => deltas.push(text),
  );
  assert.deepEqual(deltas, ["Early 🙂"]);
  assert.equal(result, "  Final 🙂\n");
});

for (const [name, body] of [
  ["missing done", line("delta", "Partial")],
  ["empty done", line("done", " ")],
  ["unterminated done", JSON.stringify({ type: "done", text: "Incomplete" })],
  ["extra data after done", line("done", "Finished") + line("delta", "Unexpected")],
  [
    "provider error",
    JSON.stringify({ type: "error", code: "correction_incomplete", detail: "Incomplete" }) + "\n",
  ],
]) {
  test(`${name} never produces an acceptable result`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => response(body));
    await assert.rejects(
      streamCorrection("Original", "paragraphs", new AbortController().signal, () => {}),
    );
  });
}

test("cancellation wins over a late completed stream", async (t) => {
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async () => {
    controller.abort();
    return response(line("done", "Too late"));
  });
  await assert.rejects(
    streamCorrection("Original", "paragraphs", controller.signal, () => {}),
    { name: "AbortError" },
  );
});
