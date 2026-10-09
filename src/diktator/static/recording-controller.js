/** @typedef {{hard_limit_seconds: number, recording_interval_seconds: number, policy_revision: string, upload_timeout_seconds: number, batch_timeout_seconds: number, live_finalization_timeout_seconds: number, client_timeout_margin_seconds: number, preference_etag: string}} RecordingSnapshot */

/** A recording freezes policy, model and its original interval until completion. */
export class RecordingController {
  /** @param {{now?: () => number, warn: () => void, automaticStop: (reason: string) => void}} callbacks */
  constructor(callbacks) {
    this.callbacks = callbacks;
    this.now = callbacks.now ?? (() => performance.now());
    this.state = "idle";
    /** @type {Readonly<RecordingSnapshot> | null} */
    this.snapshot = null;
    this.model = "";
    this.deadlineSeconds = 0;
    this.startedAt = 0;
    this.warned = false;
    this.extending = false;
  }
  /** @param {RecordingSnapshot} snapshot @param {string} model */
  prepare(snapshot, model) {
    if (this.state !== "idle") throw new Error("A recording is already active.");
    if (
      !Number.isInteger(snapshot.recording_interval_seconds) ||
      snapshot.recording_interval_seconds < 60 ||
      snapshot.recording_interval_seconds > snapshot.hard_limit_seconds
    )
      throw new Error("The recording policy returned an invalid interval.");
    this.snapshot = Object.freeze({ ...snapshot });
    this.model = model;
    this.deadlineSeconds = snapshot.recording_interval_seconds;
    this.warned = false;
    this.state = "starting";
  }
  started() {
    if (this.state !== "starting") return;
    this.startedAt = this.now();
    this.state = "recording";
    this.tick(0);
  }
  /** @param {number} samples */
  elapsed(samples) {
    return Math.max(samples / 16000, (this.now() - this.startedAt) / 1000);
  }
  /** @param {number} samples */
  tick(samples) {
    if (this.state !== "recording") return;
    const remaining = this.deadlineSeconds - this.elapsed(samples);
    if (remaining <= 60 && !this.warned) {
      this.warned = true;
      this.callbacks.warn();
    }
    if (remaining <= 0) this.automaticStop("deadline");
  }
  get canExtend() {
    return (
      this.state === "recording" &&
      !this.extending &&
      Boolean(this.snapshot) &&
      this.deadlineSeconds +
        /** @type {RecordingSnapshot} */ (this.snapshot).recording_interval_seconds <=
        /** @type {RecordingSnapshot} */ (this.snapshot).hard_limit_seconds
    );
  }
  /** @param {(seconds: number) => Promise<boolean>} apply */
  async extend(apply) {
    if (!this.canExtend || !this.snapshot) return false;
    this.extending = true;
    const next = this.deadlineSeconds + this.snapshot.recording_interval_seconds;
    try {
      if (!(await apply(next)) || this.state !== "recording") return false;
      this.deadlineSeconds = next;
      this.warned = false;
      return true;
    } finally {
      this.extending = false;
    }
  }
  /** @param {string} reason */
  automaticStop(reason) {
    if (this.state !== "recording") return;
    this.callbacks.automaticStop(reason);
  }
  stopping() {
    if (this.state !== "recording") return false;
    this.state = "stopping";
    return true;
  }
  finalizing() {
    this.state = "finalizing";
  }
  reset() {
    this.state = "idle";
    this.snapshot = null;
    this.extending = false;
  }
}

/** Audio initialization belongs to the Record gesture; visible warnings always remain. */
export class RecordingBeep {
  constructor() {
    /** @type {AudioContext | null} */ this.context = null;
  }
  async prepare() {
    try {
      this.context = new AudioContext();
      await this.context.resume();
    } catch {
      await this.release();
    }
  }
  play() {
    if (!this.context || this.context.state !== "running") return;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.frequency.value = 660;
    gain.gain.value = 0.08;
    oscillator.connect(gain).connect(this.context.destination);
    oscillator.start();
    oscillator.stop(this.context.currentTime + 0.18);
  }
  async release() {
    const context = this.context;
    this.context = null;
    if (context && context.state !== "closed") await context.close().catch(() => {});
  }
}
