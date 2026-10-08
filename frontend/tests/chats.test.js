import assert from "node:assert/strict";
import test from "node:test";
import { ApiRequestError } from "../../src/diktator/static/errors.js";
import { chatApi, spliceText } from "../../src/diktator/static/chats.js";

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

for (const [name, payload, message, code] of [
  [
    "coded",
    { detail: "Wait for the model.", code: "model_loading" },
    "Wait for the model.",
    "model_loading",
  ],
  ["legacy", { detail: "Try again." }, "Try again.", undefined],
  ["validation array", { detail: [{ msg: "bad" }] }, "The request failed. Try again.", undefined],
  ["invalid code", { detail: "Try again.", code: 42 }, "Try again.", undefined],
  ["non-JSON", null, "The request failed. Try again.", undefined],
]) {
  test(`chat API keeps a useful message and optional code for ${name} errors`, async (t) => {
    t.mock.method(globalThis, "fetch", async () =>
      payload === null
        ? new Response("gateway", { status: 502 })
        : Response.json(payload, { status: 409 }),
    );
    await assert.rejects(chatApi.list(), (error) => {
      assert.ok(error instanceof ApiRequestError);
      assert.equal(error.message, message);
      assert.equal(error.code, code);
      return true;
    });
  });
}

test("chat validators stay opaque and quoted through save, delete and keepalive", async (t) => {
  const calls = [];
  const chat = { id: "a".repeat(32), text: "", recordings: [], revision: 900, text_revision: 800 };
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push([url, options]);
    return options?.method === "DELETE"
      ? new Response(null, { status: 204 })
      : Response.json(chat, {
          headers: { ETag: '"opaque-chat-token"', "Text-ETag": '"opaque-text-token"' },
        });
  });
  const read = await chatApi.get(chat.id);
  assert.equal(read.etag, '"opaque-chat-token"');
  assert.equal(read.textEtag, '"opaque-text-token"');
  const saved = await chatApi.saveText(chat.id, "Draft", read.textEtag, true);
  assert.equal(calls[1][1].headers["If-Match"], '"opaque-text-token"');
  assert.equal(calls[1][1].keepalive, true);
  await chatApi.remove(chat.id, saved.etag);
  assert.equal(calls[2][1].headers["If-Match"], '"opaque-chat-token"');
});

test("recording upload reads the explicit parent validator without treating the body as a Chat", async (t) => {
  const recording = { id: "b".repeat(32), created: "2026-10-08T10:00:00Z", duration_seconds: 1 };
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(recording, {
      headers: { "Chat-ETag": '"opaque-parent"', "Chat-Revision": "3", ETag: '"recording-only"' },
    }),
  );
  const uploaded = await chatApi.addRecording("a".repeat(32), new Blob(), recording.id);
  assert.deepEqual(uploaded, { recording, chatEtag: '"opaque-parent"', chatRevision: 3 });
  assert.equal(uploaded.recording.etag, undefined);
});

test("title API uses only the server's canonical name and preserves scoped validators", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push([url, options]);
    return Response.json(
      { title: "Server label", custom_title: "Server label", title_revision: 2 },
      {
        headers: { ETag: '"title-read"', "Title-ETag": '"title-write"', "Chat-Revision": "7" },
      },
    );
  });
  const current = await chatApi.getTitle("a".repeat(32));
  assert.equal(current.custom_title, "Server label");
  assert.equal(current.titleEtag, '"title-read"');
  const saved = await chatApi.saveTitle("a".repeat(32), null, current.titleEtag);
  assert.equal(calls[1][1].headers["If-Match"], '"title-read"');
  assert.equal(calls[1][1].body, '{"custom_title":null}');
  assert.equal(saved.titleEtag, '"title-write"');
});

test("search requests encode the query and clearing issues the ordinary list request", async (t) => {
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    urls.push(url);
    return Response.json([]);
  });
  await chatApi.list("Straße & café?");
  await chatApi.list("");
  await chatApi.list();
  assert.deepEqual(urls, [
    "/api/chats?q=Stra%C3%9Fe%20%26%20caf%C3%A9%3F",
    "/api/chats",
    "/api/chats",
  ]);
});
