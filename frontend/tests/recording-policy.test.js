import assert from "node:assert/strict";
import test from "node:test";
import {
  recordingPolicy,
  recordingTimeoutMs,
  uploadTimeoutMs,
} from "../../src/diktator/static/recording-policy.js";

const policy = {
  protocol_version: 1,
  policy_revision: "test",
  hard_limit_seconds: 600,
  recording_interval_seconds: 600,
  warning_lead_seconds: 60,
  extension_seconds: 600,
  max_audio_bytes: 20000044,
  max_pcm_bytes: 19200000,
  max_stream_frame_bytes: 65536,
  upload_timeout_seconds: 300,
  batch_timeout_seconds: 400,
  live_finalization_timeout_seconds: 500,
  client_timeout_margin_seconds: 10,
  client_deadlines_ms: { upload: 310000, batch: 1030000, live: 520000 },
  preference_etag: '"test"',
};

test("capture discovery freezes a snapshot and puts browser live waiting after both relays", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(url, "/api/recording-policy");
    return Response.json(policy);
  });
  const snapshot = await recordingPolicy();
  assert.ok(Object.isFrozen(snapshot));
  assert.equal(recordingTimeoutMs(snapshot, "upload"), 310_000);
  assert.equal(recordingTimeoutMs(snapshot, "live"), 520_000);
  // Direct batch permits client->web upload, web->engine upload and decoding.
  assert.equal(recordingTimeoutMs(snapshot, "batch"), 1_030_000);
});

for (const broken of [
  {},
  { ...policy, protocol_version: 0 },
  { ...policy, hard_limit_seconds: 61 },
  { ...policy, batch_timeout_seconds: Infinity },
  { ...policy, warning_lead_seconds: -1 },
  { ...policy, warning_lead_seconds: 601 },
  { ...policy, warning_lead_seconds: undefined },
  { ...policy, extension_seconds: 0 },
  { ...policy, extension_seconds: 61 },
  { ...policy, extension_seconds: 660 },
  { ...policy, extension_seconds: undefined },
])
  test(`unusable capture discovery fails closed: ${JSON.stringify(broken)}`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => Response.json(broken));
    await assert.rejects(recordingPolicy(), /policy is unavailable/);
  });

test("upload waiting reads web-only settings and never needs engine discovery", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    calls.push(url);
    return Response.json({
      upload_timeout_seconds: 300,
      client_timeout_margin_seconds: 10,
      client_upload_timeout_ms: 310000,
    });
  });
  assert.equal(await uploadTimeoutMs(), 310_000);
  assert.deepEqual(calls, ["/api/settings"]);
});

for (const deadline of [
  null,
  {},
  { upload: -1, batch: 1, live: 1 },
  { upload: 1, batch: 1, live: 2147483648 },
])
  test(`invalid published deadlines fail closed: ${JSON.stringify(deadline)}`, async (t) => {
    t.mock.method(globalThis, "fetch", async () =>
      Response.json({ ...policy, client_deadlines_ms: deadline }),
    );
    await assert.rejects(recordingPolicy(), /policy is unavailable/);
  });

test("client waits consume published deadlines without reconstructing server formulas", async (t) => {
  const published = { upload: 2001, batch: 8003, live: 4007 };
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ ...policy, client_deadlines_ms: published }),
  );
  const snapshot = await recordingPolicy();
  for (const operation of ["upload", "batch", "live"])
    assert.equal(recordingTimeoutMs(snapshot, operation), published[operation]);
});

for (const failure of ["network", "body"])
  test(`upload discovery ${failure} failure keeps the earlier generic wait`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => {
      if (failure === "network") throw new TypeError("offline");
      return Response.json({ client_upload_timeout_ms: "invalid" });
    });
    assert.equal(await uploadTimeoutMs(), 190_000);
  });
