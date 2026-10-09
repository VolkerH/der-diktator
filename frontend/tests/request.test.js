import assert from "node:assert/strict";
import test from "node:test";
import { request } from "../../src/diktator/static/request.js";

for (const phase of ["fetch", "body"])
  test(`the shared request deadline rejects a stalled ${phase}`, async (t) => {
    const deadline = new AbortController();
    t.mock.method(AbortSignal, "timeout", (ms) => {
      assert.equal(ms, 190_000);
      return deadline.signal;
    });
    t.mock.method(globalThis, "fetch", async (_url, { signal }) => {
      const wait = () =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      return phase === "fetch" ? wait() : { status: 200, ok: true, json: wait };
    });
    const pending = request("/test", { signal: new AbortController().signal });
    await Promise.resolve();
    const reason = new DOMException("Timed out", "TimeoutError");
    deadline.abort(reason);
    await assert.rejects(pending, (error) => error === reason);
  });

test("caller cancellation survives the shared deadline", async (t) => {
  const caller = new AbortController();
  caller.abort(new DOMException("Cancelled", "AbortError"));
  t.mock.method(globalThis, "fetch", async (_url, { signal }) => signal.throwIfAborted());
  await assert.rejects(request("/test", { signal: caller.signal }), { name: "AbortError" });
});

test("an explicit recording deadline replaces the generic request wait", async (t) => {
  t.mock.method(AbortSignal, "timeout", (ms) => {
    assert.equal(ms, 450_000);
    return new AbortController().signal;
  });
  t.mock.method(globalThis, "fetch", async () => Response.json({ text: "complete" }));
  assert.equal(
    (await request("/api/transcribe", { method: "POST" }, 450_000)).body.text,
    "complete",
  );
});
