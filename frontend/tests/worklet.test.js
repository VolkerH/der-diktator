import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

function processor() {
  const messages = [];
  let Processor;
  class FakeAudioWorkletProcessor {
    constructor() {
      this.port = { postMessage: (message) => messages.push(message), onmessage: null };
    }
  }
  const context = vm.createContext({
    AudioWorkletProcessor: FakeAudioWorkletProcessor,
    registerProcessor: (_name, implementation) => {
      Processor = implementation;
    },
    Float32Array,
  });
  const source = readFileSync(
    new URL("../../src/phonon_web/static/recorder-worklet.js", import.meta.url),
    "utf8",
  );
  vm.runInContext(source, context);
  return { instance: new Processor(), messages };
}

test("stop flushes audio below the batch size before reporting completion", () => {
  const { instance, messages } = processor();
  instance.process([[new Float32Array([0.5, -0.5, 1])]]);
  assert.equal(messages.length, 0);
  instance.port.onmessage({ data: { type: "stop" } });
  assert.equal(messages[0].type, "samples");
  assert.deepEqual([...messages[0].samples], [0.5, -0.5, 1]);
  assert.equal(messages[1].type, "stopped");
  assert.equal(instance.process([]), false);
});

test("channel mixing averages stereo audio before sending it to the main thread", () => {
  const { instance, messages } = processor();
  instance.process([[new Float32Array([1, 0]), new Float32Array([0, -1])]]);
  instance.port.onmessage({ data: { type: "stop" } });
  assert.deepEqual([...messages[0].samples], [0.5, -0.5]);
});

test("full batches are sent during capture and the tail is sent at stop", () => {
  const { instance, messages } = processor();
  instance.process([[new Float32Array(2050).fill(0.25)]]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].samples.length, 2048);
  instance.port.onmessage({ data: { type: "stop" } });
  assert.equal(messages[1].samples.length, 2);
  assert.equal(messages[2].type, "stopped");
});
