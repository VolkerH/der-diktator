import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { PcmCapture } from "../../src/diktator/static/pcm-capture.js";

function processor(config = {}) {
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
    PcmCapture,
    Number,
    Math,
  });
  const source = readFileSync(
    new URL("../../src/diktator/static/recorder-worklet.js", import.meta.url),
    "utf8",
  )
    .replace(/^import .*\n/u, "")
    .replace("export class", "class");
  vm.runInContext(source, context);
  return { instance: new Processor({ processorOptions: config }), messages };
}

test("stop flushes the permitted tail exactly once", () => {
  const { instance, messages } = processor();
  instance.process([[new Float32Array([0.5, -0.5, 1])]]);
  instance.port.onmessage({ data: { type: "stop" } });
  instance.port.onmessage({ data: { type: "stop" } });
  assert.deepEqual([...messages[0].pcm], [16383, -16384, 32767]);
  assert.equal(messages[1].type, "stopped");
  assert.equal(messages.length, 2);
  assert.equal(instance.process([]), false);
});
test("channel mixing and conversion remain continuous across irregular blocks", () => {
  for (const rate of [16000, 44100, 48000]) {
    const captured = [];
    const pcm = new PcmCapture(rate, 16000, (batch) => captured.push(...batch));
    for (let offset = 0; offset < rate; offset += 127) {
      const n = Math.min(127, rate - offset);
      pcm.push([new Float32Array(n).fill(1), new Float32Array(n).fill(0)]);
    }
    pcm.flush();
    assert.equal(captured.length, 16000);
    assert.ok(captured.slice(32).every((sample) => Math.abs(sample - 16383) <= 1));
  }
});
test("sample cap stops inside a quantum and late extensions cannot restart it", () => {
  const { instance, messages } = processor({ maxSamples: 3, hardMaxSamples: 6 });
  instance.process([[new Float32Array(128).fill(0.5)]]);
  instance.port.onmessage({ data: { type: "extend", maxSamples: 6 } });
  assert.equal(messages[0].pcm.length, 3);
  assert.equal(messages[1].reason, "deadline");
  assert.equal(messages[2].accepted, false);
});
test("an acknowledged extension permits its full interval and never exceeds the hard cap", () => {
  const { instance, messages } = processor({ maxSamples: 128, hardMaxSamples: 256 });
  instance.process([[new Float32Array(64)]]);
  instance.port.onmessage({ data: { type: "extend", maxSamples: 256 } });
  assert.equal(messages[0].accepted, true);
  instance.port.onmessage({ data: { type: "extend", maxSamples: 257 } });
  assert.equal(messages[1].accepted, false);
  instance.process([[new Float32Array(256)]]);
  assert.equal(messages[2].pcm.length, 256);
  assert.equal(messages[3].sampleCount, 256);
});
test("a throttled main thread has a bounded queue and receives an explicit stop", () => {
  const { instance, messages } = processor({ maxSamples: 3600 * 16000 });
  for (let i = 0; i < 3000; i++) if (!instance.process([[new Float32Array(128)]])) break;
  assert.equal(messages.filter((message) => message.type === "samples").length, 128);
  assert.equal(messages.at(-1).reason, "capture_queue_overflow");
  assert.equal(messages.at(-1).sampleCount, 128 * 2048);
});

test("native-rate FIR preserves speech-band tones and suppresses aliased high frequencies", () => {
  for (const rate of [44100, 48000]) {
    function amplitude(frequency) {
      const output = [];
      const capture = new PcmCapture(rate, 16000, (pcm) => output.push(...pcm));
      for (let start = 0; start < rate; start += 128) {
        const chunk = new Float32Array(Math.min(128, rate - start));
        for (let i = 0; i < chunk.length; i++)
          chunk[i] = 0.5 * Math.sin((2 * Math.PI * frequency * (start + i)) / rate);
        capture.push([chunk]);
      }
      capture.flush();
      return Math.sqrt(
        output.slice(100).reduce((sum, value) => sum + (value / 32768) ** 2, 0) /
          (output.length - 100),
      );
    }
    assert.ok(Math.abs(amplitude(1000) - 0.5 / Math.sqrt(2)) < 0.005);
    assert.ok(Math.abs(amplitude(4000) - 0.5 / Math.sqrt(2)) < 0.01);
    assert.ok(amplitude(12000) < 0.003, "12 kHz must not alias into speech");
  }
});

test("a two-second main-thread stall continues once queued batches are acknowledged", () => {
  const { instance, messages } = processor({ maxSamples: 3600 * 16000 });
  for (let i = 0; i < 250; i++) assert.equal(instance.process([[new Float32Array(128)]]), true);
  assert.equal(
    messages.some((message) => message.type === "stopped"),
    false,
  );
  const queued = messages.filter((message) => message.type === "samples").length;
  for (let i = 0; i < queued; i++) instance.port.onmessage({ data: { type: "ack" } });
  assert.equal(instance.pending, 0);
  assert.equal(instance.process([[new Float32Array(128)]]), true);
  instance.port.onmessage({ data: { type: "stop" } });
  assert.equal(messages.at(-1).reason, "manual");
  assert.equal(messages.at(-1).sampleCount, 32_128);
});
