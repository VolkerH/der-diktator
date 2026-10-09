import assert from "node:assert/strict";
import test from "node:test";
import { RecordingController } from "../../src/diktator/static/recording-controller.js";

function capture(interval = 60, ceiling = 180) {
  let now = 0;
  let warnings = 0;
  let stops = 0;
  const controller = new RecordingController({
    now: () => now,
    warn: () => warnings++,
    automaticStop: () => {
      if (controller.stopping()) stops++;
    },
  });
  const snapshot = {
    recording_interval_seconds: interval,
    hard_limit_seconds: ceiling,
    warning_lead_seconds: 60,
    extension_seconds: interval,
  };
  controller.prepare(snapshot, "model-a");
  controller.started();
  return {
    controller,
    snapshot,
    advance: (seconds, samples = 0) => {
      now += seconds * 1000;
      controller.tick(samples);
    },
    counts: () => ({ warnings, stops }),
  };
}
test("one-minute warning starts immediately and an extension re-arms it", async () => {
  const c = capture();
  assert.equal(c.counts().warnings, 1);
  assert.equal(await c.controller.extend(async () => true), true);
  c.advance(61);
  assert.equal(c.counts().warnings, 2);
  c.advance(60);
  c.advance(60);
  assert.equal(c.counts().stops, 1);
});
test("snapshot and original interval remain frozen when preferences change", async () => {
  const c = capture(60, 180);
  c.snapshot.recording_interval_seconds = 120;
  await c.controller.extend(async (deadline) => {
    assert.equal(deadline, 120);
    return true;
  });
  await c.controller.extend(async (deadline) => {
    assert.equal(deadline, 180);
    return true;
  });
  assert.equal(c.controller.canExtend, false);
  assert.equal(
    await c.controller.extend(async () => {
      throw new Error("must not apply");
    }),
    false,
  );
});
test("whole intervals are refused when only a partial interval could fit", () => {
  const c = capture(120, 180);
  assert.equal(c.controller.canExtend, false);
});
test("stop wins over a pending extension and finalizes once", async () => {
  const c = capture();
  let acknowledge;
  const extending = c.controller.extend(
    () =>
      new Promise((resolve) => {
        acknowledge = resolve;
      }),
  );
  assert.equal(c.controller.stopping(), true);
  assert.equal(c.controller.stopping(), false);
  acknowledge(true);
  assert.equal(await extending, false);
  assert.equal(c.controller.deadlineSeconds, 60);
  c.controller.finalizing();
  c.controller.reset();
  assert.equal(c.controller.state, "idle");
});
test("captured samples reconcile a stalled presentation clock", () => {
  const c = capture();
  c.advance(0, 60 * 16000);
  assert.equal(c.counts().stops, 1);
});

test("warnings and extensions consume backend rules rather than deriving them from the interval", async () => {
  let now = 0;
  let warnings = 0;
  const controller = new RecordingController({
    now: () => now,
    warn: () => warnings++,
    automaticStop: () => {},
  });
  const policy = {
    recording_interval_seconds: 120,
    hard_limit_seconds: 300,
    warning_lead_seconds: 30,
    extension_seconds: 60,
  };
  controller.prepare(policy, "model-a");
  controller.started();
  policy.warning_lead_seconds = 120;
  policy.extension_seconds = 120;
  now = 89_000;
  controller.tick(0);
  assert.equal(warnings, 0);
  now = 90_000;
  controller.tick(0);
  assert.equal(warnings, 1);
  await controller.extend(async (seconds) => {
    assert.equal(seconds, 180);
    return true;
  });
  assert.equal(controller.deadlineSeconds, 180);
});
