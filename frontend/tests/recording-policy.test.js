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
  max_audio_bytes: 20000044,
  max_pcm_bytes: 19200000,
  max_stream_frame_bytes: 65536,
  upload_timeout_seconds: 300,
  batch_timeout_seconds: 400,
  live_finalization_timeout_seconds: 500,
  client_timeout_margin_seconds: 10,
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
])
  test(`unusable capture discovery fails closed: ${JSON.stringify(broken)}`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => Response.json(broken));
    await assert.rejects(recordingPolicy(), /policy is unavailable/);
  });

test("upload waiting reads web-only settings and never needs engine discovery", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    calls.push(url);
    return Response.json({ upload_timeout_seconds: 300, client_timeout_margin_seconds: 10 });
  });
  assert.equal(await uploadTimeoutMs(), 310_000);
  assert.deepEqual(calls, ["/api/settings"]);
});
