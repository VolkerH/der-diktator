import assert from "node:assert/strict";
import test from "node:test";
import { LiveTranscript, LiveTranscriber } from "../../src/diktator/static/live.js";
import { FakeSocket } from "./fake-socket.js";

async function connected(t, options = {}) {
  const socket = new FakeSocket();
  const texts = [];
  const failures = [];
  const client = new LiveTranscriber(
    (text) => texts.push(text),
    (error) => failures.push(error),
    { socketFactory: () => socket, ...options },
  );
  t.after(() => client.cancel());
  const starting = client.start("ws://localhost/api/stream");
  socket.event({ type: "ready" });
  await starting;
  return { client, socket, texts, failures };
}

test("partial corrections replace hypotheses and finals are appended only once", () => {
  const transcript = new LiveTranscript();
  assert.equal(transcript.update({ type: "partial", text: "Good" }), "Good");
  assert.equal(transcript.update({ type: "partial", text: "Good morning" }), "Good morning");
  assert.equal(
    transcript.update({ type: "final", text: "Good morning.", segment: 1 }),
    "Good morning.",
  );
  assert.equal(transcript.update({ type: "partial", text: "How are" }), "Good morning. How are");
  assert.equal(
    transcript.update({ type: "final", text: "Good morning.", segment: 1 }),
    "Good morning. How are",
  );
  assert.equal(
    transcript.update({ type: "final", text: "How are you?", segment: 2 }),
    "Good morning. How are you?",
  );
  assert.equal(
    transcript.update({ type: "done", text: "Good morning. How are you?" }),
    "Good morning. How are you?",
  );
});

test("live PCM has no WAV header, and end waits for the authoritative done message", async (t) => {
  const { client, socket, texts, failures } = await connected(t);
  client.sendSamples(new Float32Array([-1, 0, 1]));
  assert.deepEqual([...new Uint8Array(socket.sent[0])], [0, 128, 0, 0, 255, 127]);
  socket.event({ type: "partial", text: "Hello" });
  const finishing = client.finish();
  assert.equal(socket.sent[1], '{"type":"end"}');
  assert.equal(socket.closeCount, 0);
  socket.event({ type: "final", text: "Hello world.", segment: 1 });
  socket.event({ type: "done", text: "Hello world." });
  assert.equal(await finishing, "Hello world.");
  assert.deepEqual(texts, ["Hello", "Hello world.", "Hello world."]);
  assert.equal(socket.closeCount, 1);
  assert.deepEqual(failures, []);
});

test("a closed connection reports one failure and refuses further audio", async (t) => {
  const { client, socket, failures } = await connected(t);
  socket.close();
  socket.emit("error");
  client.sendSamples(new Float32Array([1]));
  await assert.rejects(client.finish(), /closed before finishing/);
  assert.equal(failures.length, 1);
  assert.deepEqual(socket.sent, []);
});

test("backpressure stops streaming without throwing into the recorder callback", async (t) => {
  const { client, socket, failures } = await connected(t);
  socket.bufferedAmount = 1_048_576;
  assert.doesNotThrow(() => client.sendSamples(new Float32Array([1])));
  assert.equal(failures.length, 1);
  await assert.rejects(client.finish(), /cannot keep up/);
});

test("invalid JSON and engine errors are surfaced for recording fallback", async (t) => {
  const { client, socket, failures } = await connected(t);
  socket.emit("message", { data: "not JSON" });
  await assert.rejects(client.finish());
  assert.equal(failures.length, 1);
  const other = await connected(t);
  other.socket.event({ type: "error", message: "engine busy" });
  await assert.rejects(other.client.finish(), /engine busy/);
});

test("connection and finalization timeouts reject and close resources", async (t) => {
  const socket = new FakeSocket();
  const client = new LiveTranscriber(
    () => {},
    () => {},
    {
      socketFactory: () => socket,
      readyTimeoutMs: 1,
    },
  );
  await assert.rejects(client.start("ws://localhost/api/stream"), /did not connect in time/);
  assert.equal(socket.closeCount, 1);
  const other = await connected(t, { finishTimeoutMs: 1 });
  await assert.rejects(other.client.finish(), /did not finish in time/);
  assert.equal(other.socket.closeCount, 1);
});

test("cancelling a recording closes the connection without a failure notification", async (t) => {
  const { client, socket, failures } = await connected(t);
  client.cancel();
  await assert.rejects(client.finish(), /cancelled/);
  assert.equal(socket.closeCount, 1);
  assert.deepEqual(failures, []);
});
