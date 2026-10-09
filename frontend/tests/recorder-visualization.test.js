import assert from "node:assert/strict";
import test from "node:test";
import {
  WaveHistory,
  RecorderVisualization,
} from "../../src/diktator/static/recorder-visualization.js";

test("a microphone disturbance travels right to left and leaves silence behind", () => {
  const history = new WaveHistory();
  history.push(0, 0);
  history.push(0.1, 80);
  history.push(0, 160);
  const peak = history.at(1, 80);
  assert.ok(peak > 0.8);
  assert.equal(history.at(0.5, 80), 0);
  assert.equal(history.at(0.5, 1280), peak);
  assert.equal(history.at(0, 2480), peak);
  assert.equal(history.at(1, 1280), 0);
  assert.equal(history.at(0, 2700), 0);
});

test("silence is still, history is bounded, and a new take can clear old speech", () => {
  const history = new WaveHistory();
  for (let time = 0; time < 600000; time += 60) history.push(0.001, time);
  assert.ok(history.samples.length < 50);
  assert.equal(history.at(0.5, 599940), 0);
  history.push(Infinity, 600000);
  assert.equal(history.at(1, 600000), 0);
  history.push(100, 600080);
  assert.ok(Math.abs(history.at(1, 600080)) <= 1);
  history.clear();
  assert.equal(history.at(1, 600080), 0);
});

test("animation pauses for reduced motion and hidden tabs, and releases resources", (t) => {
  const media = new EventTarget();
  media.matches = false;
  const document = new EventTarget();
  document.hidden = false;
  let frameId = 0;
  const frames = new Map();
  let disconnected = false;
  for (const [name, value] of Object.entries({
    document,
    window: { matchMedia: () => media, devicePixelRatio: 3 },
    requestAnimationFrame: (callback) => {
      frames.set(++frameId, callback);
      return frameId;
    },
    cancelAnimationFrame: (id) => frames.delete(id),
    ResizeObserver: class {
      observe() {}
      disconnect() {
        disconnected = true;
      }
    },
  })) {
    const old = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    t.after(() => (old ? Object.defineProperty(globalThis, name, old) : delete globalThis[name]));
  }
  const context = { setTransform() {}, clearRect() {}, beginPath() {}, arc() {}, fill() {} };
  const canvas = { clientWidth: 400, clientHeight: 300, getContext: () => context };
  const view = new RecorderVisualization(canvas, {
    id: "test",
    points: [[0.5, 0.5, 1]],
    ink: "#000",
    dotSize: 1,
  });
  assert.equal(frames.size, 0);
  assert.equal(canvas.width, 800);
  view.setRecording(true);
  view.push(0.1);
  assert.equal(frames.size, 1);
  media.matches = true;
  media.dispatchEvent(new Event("change"));
  assert.equal(frames.size, 0);
  media.matches = false;
  media.dispatchEvent(new Event("change"));
  assert.equal(frames.size, 1);
  document.hidden = true;
  document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(frames.size, 0);
  assert.equal(view.history.samples.length, 0);
  document.hidden = false;
  document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(frames.size, 1);
  view.setRecording(false);
  assert.equal(frames.size, 0);
  view.destroy();
  assert.ok(disconnected);
});
