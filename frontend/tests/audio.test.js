import assert from "node:assert/strict";
import test from "node:test";
import {
  encodePcm16,
  encodeWav,
  joinSamples,
  rms,
  wordCount,
} from "../../src/diktator/static/audio.js";

test("streaming PCM matches the retained WAV sample bytes", () => {
  const samples = new Float32Array([-2, -0.5, 0, 0.5, 2]);
  assert.deepEqual(new Uint8Array(encodePcm16(samples)), new Uint8Array(encodeWav(samples), 44));
});

test("WAV header declares the exact PCM format accepted by the engine", () => {
  const samples = new Float32Array([0, 0.5, -0.5]);
  const buffer = encodeWav(samples);
  const view = new DataView(buffer);
  const text = (start, end) => String.fromCharCode(...new Uint8Array(buffer, start, end - start));
  assert.equal(text(0, 4), "RIFF");
  assert.equal(text(8, 12), "WAVE");
  assert.equal(text(36, 40), "data");
  assert.equal(view.getUint32(4, true), buffer.byteLength - 8);
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16_000);
  assert.equal(view.getUint32(28, true), 32_000);
  assert.equal(view.getUint16(32, true), 2);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), samples.length * 2);
});

test("PCM samples clip at signed 16-bit limits without wrapping", () => {
  const view = new DataView(encodeWav(new Float32Array([-2, -1, 0, 1, 2])));
  const values = Array.from({ length: 5 }, (_, index) => view.getInt16(44 + index * 2, true));
  assert.deepEqual(values, [-32768, -32768, 0, 32767, 32767]);
});

test("joining chunks keeps their order and stops at the recording limit", () => {
  const samples = joinSamples([new Float32Array([1, 2]), new Float32Array([3, 4])], 3);
  assert.deepEqual([...samples], [1, 2, 3]);
});

test("empty captures do not invent samples", () => {
  assert.equal(joinSamples([], 16_000).length, 0);
  assert.equal(encodeWav(new Float32Array()).byteLength, 44);
});

test("editing a transcript updates whitespace-aware word counts", () => {
  assert.equal(wordCount(""), 0);
  assert.equal(wordCount(" \n\t "), 0);
  assert.equal(wordCount("Hello,\nworld!  It's working."), 4);
});

test("meter levels are the RMS amplitude of a chunk", () => {
  assert.equal(rms(new Float32Array()), 0);
  assert.equal(rms(new Float32Array([0.5, -0.5])), 0.5);
});
