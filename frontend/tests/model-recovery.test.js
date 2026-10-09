import assert from "node:assert/strict";
import test from "node:test";
import { waitForModelReady } from "../../src/diktator/static/models.js";

const state = {
  active: "phonon-2",
  busy: true,
  models: [{ id: "phonon-2", state: "loading", message: "" }],
};

test("readiness expiry retains recovery instructions without inference or activation requests", async (t) => {
  let clock = 0;
  const requests = [];
  t.mock.method(performance, "now", () => clock);
  t.mock.method(globalThis, "setTimeout", (callback, milliseconds) => {
    clock += milliseconds;
    callback();
  });
  t.mock.method(globalThis, "fetch", async (url) => {
    requests.push(url);
    return Response.json(state);
  });
  await assert.rejects(
    waitForModelReady("phonon-2", 500),
    /recovery is still pending.*Keep the clip/u,
  );
  assert.deepEqual(requests, ["/api/models", "/api/models"]);
});

test("model discovery failure is reported without retrying inference or activation", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    requests.push(url);
    return Response.json(
      { detail: "Engine is unavailable.", code: "engine_unavailable" },
      { status: 503 },
    );
  });
  await assert.rejects(waitForModelReady("phonon-2", 1000), /Engine is unavailable/);
  assert.deepEqual(requests, ["/api/models"]);
});
