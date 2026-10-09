import assert from "node:assert/strict";
import test from "node:test";
import { MicrophoneRecorder } from "../../src/diktator/static/recorder.js";

/** Supply the browser audio boundary while keeping the recorder itself real. */
function audioEnvironment(t, { failModule = false, empty = false, fallback = false } = {}) {
  const state = { trackStops: 0, contextCloses: 0, disconnects: 0, resampled: false };
  const stream = { getTracks: () => [{ stop: () => state.trackStops++ }] };
  const samples = new Float32Array([0.25, -0.25, 0.5, -0.5, 0.75, -0.75]);
  class FakeContext {
    constructor(options) {
      if (fallback && options?.sampleRate === 16_000) throw new Error("Unsupported sample rate");
      this.sampleRate = fallback ? 48_000 : 16_000;
      this.state = "running";
      this.destination = {};
      this.audioWorklet = {
        addModule: async () => {
          if (failModule) throw new Error("Could not load audio processor");
        },
      };
    }
    createMediaStreamSource() {
      return { connect: (node) => node };
    }
    createGain() {
      return { gain: { value: 1 }, connect: (node) => node };
    }
    async resume() {}
    async close() {
      this.state = "closed";
      state.contextCloses++;
    }
  }
  class FakeNode {
    constructor(_context, _name, options) {
      state.processorOptions = options.processorOptions;
      this.port = {
        onmessage: null,
        postMessage: (message) => {
          if (message.type !== "stop") return;
          if (!empty)
            this.port.onmessage({
              data: {
                type: "samples",
                pcm: new Int16Array([...samples].map((sample) => sample * 32767)),
                level: 0.5,
              },
            });
          this.port.onmessage({ data: { type: "stopped" } });
        },
      };
    }
    connect(node) {
      return node;
    }
    disconnect() {
      state.disconnects++;
    }
  }
  class FakeOfflineContext {
    constructor(_channels, length, rate) {
      assert.equal(rate, 16_000);
      assert.equal(state.trackStops, 1, "the microphone is released before resampling");
      this.length = length;
      state.resampled = true;
    }
    createBuffer(_channels, length, sourceRate) {
      assert.equal(sourceRate, 48_000);
      return { getChannelData: () => new Float32Array(length) };
    }
    createBufferSource() {
      return { connect() {}, start() {}, buffer: null };
    }
    async startRendering() {
      return { getChannelData: () => new Float32Array(this.length) };
    }
  }
  const replacements = {
    navigator: { mediaDevices: { getUserMedia: async () => stream } },
    AudioContext: FakeContext,
    AudioWorkletNode: FakeNode,
    OfflineAudioContext: FakeOfflineContext,
  };
  for (const [name, value] of Object.entries(replacements)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  return state;
}

test("stopping captures the final batch, produces WAV, and releases the device", async (t) => {
  const state = audioEnvironment(t);
  const recorder = new MicrophoneRecorder();
  await recorder.start();
  const recording = await recorder.stop();
  const header = new DataView(await recording.arrayBuffer());
  assert.equal(recording.type, "audio/wav");
  assert.equal(header.getUint32(24, true), 16_000);
  assert.equal(header.getUint32(40, true), 12);
  assert.equal(state.trackStops, 1);
  assert.equal(state.contextCloses, 1);
  assert.equal(state.disconnects, 1);
  assert.equal(recorder.context, null);
  assert.deepEqual(recorder.chunks, []);
});

test("processor startup failure releases the granted microphone", async (t) => {
  const state = audioEnvironment(t, { failModule: true });
  const recorder = new MicrophoneRecorder();
  await assert.rejects(recorder.start(), /Could not load/);
  assert.equal(state.trackStops, 1);
  assert.equal(state.contextCloses, 1);
});

test("empty captures fail without leaving the microphone open", async (t) => {
  const state = audioEnvironment(t, { empty: true });
  const recorder = new MicrophoneRecorder();
  await recorder.start();
  await assert.rejects(recorder.stop(), /No audio/);
  assert.equal(state.trackStops, 1);
  assert.equal(state.contextCloses, 1);
});

test("a 48 kHz context is resampled to the engine's 16 kHz format", async (t) => {
  const state = audioEnvironment(t, { fallback: true });
  const recorder = new MicrophoneRecorder();
  await recorder.start();
  const header = new DataView(await (await recorder.stop()).arrayBuffer());
  assert.equal(state.processorOptions.sampleRate, 48_000);
  assert.equal(header.getUint32(24, true), 16_000);
  assert.equal(header.getUint32(40, true), 12);
});

test("live callbacks receive the final PCM flush while a complete WAV is retained", async (t) => {
  audioEnvironment(t);
  const recorder = new MicrophoneRecorder();
  const chunks = [];
  await recorder.start((samples) => chunks.push(samples));
  const recording = await recorder.stop();
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].length, 6);
  assert.equal(recording.size, 44 + chunks[0].length * 2);
});

test("native-rate live capture uses the same bounded worklet conversion", async (t) => {
  const state = audioEnvironment(t, { fallback: true });
  const recorder = new MicrophoneRecorder();
  const samples = [];
  await recorder.start((chunk) => samples.push(chunk), {
    intervalSeconds: 1800,
    hardLimitSeconds: 3600,
  });
  assert.equal(state.processorOptions.sampleRate, 48_000);
  assert.equal(state.processorOptions.maxSamples, 1800 * 16000);
  assert.equal(state.processorOptions.hardMaxSamples, 3600 * 16000);
  await recorder.stop();
  assert.equal(samples.length, 1);
});
