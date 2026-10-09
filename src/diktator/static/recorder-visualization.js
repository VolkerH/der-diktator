import { stippleTheme } from "./recorder-theme.js";

const TRAVEL_MS = 2400;

/** A bounded microphone-level history. New speech enters on the right. */
export class WaveHistory {
  constructor() {
    /** @type {{time: number, value: number}[]} */
    this.samples = [];
  }

  /** @param {number} level @param {number} time */
  push(level, time) {
    const amplitude = Number.isFinite(level) ? Math.sqrt(Math.max(0, level - 0.002) * 8) : 0;
    this.samples.push({
      time,
      value: Math.min(1, amplitude) * Math.sin((time / 1000) * Math.PI * 6),
    });
    while (this.samples.length > 80 || this.samples[0].time < time - TRAVEL_MS - 200) {
      this.samples.shift();
    }
  }

  /** Vertical displacement only; the cloud's horizontal positions never change.
   * @param {number} x normalized horizontal coordinate
   * @param {number} time monotonic milliseconds
   */
  at(x, time) {
    const target = time - (1 - x) * TRAVEL_MS;
    const samples = this.samples;
    if (!samples.length || target < samples[0].time) return 0;
    for (let i = 1; i < samples.length; i++) {
      const before = samples[i - 1];
      const after = samples[i];
      if (target <= after.time) {
        const fraction = (target - before.time) / Math.max(1, after.time - before.time);
        return before.value + (after.value - before.value) * fraction;
      }
    }
    const last = samples[samples.length - 1];
    return last.value * Math.max(0, 1 - (target - last.time) / 120);
  }

  clear() {
    this.samples = [];
  }
}

/** Decorative renderer; it owns no microphone or application preferences. */
export class RecorderVisualization {
  /** @param {HTMLCanvasElement} canvas
   * @param {import("./recorder-theme.js").RecorderTheme} [theme] */
  constructor(canvas, theme = stippleTheme) {
    this.canvas = canvas;
    this.theme = theme;
    this.context = canvas.getContext("2d");
    this.history = new WaveHistory();
    this.recording = false;
    this.frame = 0;
    this.lastDraw = 0;
    // A missing canvas context leaves the recording controls fully usable.
    if (!this.context) return;
    this.motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.refresh = () => {
      if (this.frame) cancelAnimationFrame(this.frame);
      this.frame = 0;
      if (document.hidden) this.history.clear();
      this.draw(performance.now());
      if (this.recording && !this.motion?.matches && !document.hidden) {
        this.frame = requestAnimationFrame((time) => this.animate?.(time));
      }
    };
    this.animate = (/** @type {number} */ time) => {
      if (time - this.lastDraw >= 1000 / 30) {
        this.draw(time);
        this.lastDraw = time;
      }
      this.frame = requestAnimationFrame((time) => this.animate?.(time));
    };
    this.resize = new ResizeObserver(this.refresh);
    this.resize.observe(canvas);
    this.motion.addEventListener("change", this.refresh);
    document.addEventListener("visibilitychange", this.refresh);
    this.refresh();
  }

  /** @param {number} level */
  push(level) {
    if (this.recording && !document.hidden && !this.motion?.matches) {
      this.history.push(level, performance.now());
    }
  }

  /** @param {boolean} recording */
  setRecording(recording) {
    if (recording === this.recording) return;
    this.recording = recording;
    this.history.clear();
    this.refresh?.();
  }

  /** @param {number} time */
  draw(time) {
    const ctx = this.context;
    if (!ctx || document.hidden) return;
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const pixelsWide = Math.round(width * ratio);
    const pixelsHigh = Math.round(height * ratio);
    if (this.canvas.width !== pixelsWide || this.canvas.height !== pixelsHigh) {
      this.canvas.width = pixelsWide;
      this.canvas.height = pixelsHigh;
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const span = Math.min(width * 0.94, height * 0.94, 520);
    const ox = (width - span) / 2;
    const oy = (height - span) / 2;
    const moving = this.recording && !this.motion?.matches;
    // Sample once per column instead of searching the history for every dot.
    const offsets = Array.from({ length: 129 }, (_, i) =>
      moving ? this.history.at(i / 128, time) * span * 0.055 : 0,
    );
    ctx.fillStyle = this.theme.ink;
    for (const [x, y, ink] of this.theme.points) {
      const column = Math.min(127, Math.max(0, Math.floor(x * 128)));
      const fraction = Math.min(1, Math.max(0, x * 128 - column));
      const dy = offsets[column] + (offsets[column + 1] - offsets[column]) * fraction;
      const radius = Math.max(0.48, this.theme.dotSize * (span / 520) * (0.25 + ink * 0.55) * 0.5);
      ctx.globalAlpha = 0.18 + ink * 0.72;
      ctx.beginPath();
      ctx.arc(ox + x * span, oy + y * span + dy, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  destroy() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.resize?.disconnect();
    if (this.refresh) {
      this.motion?.removeEventListener("change", this.refresh);
      document.removeEventListener("visibilitychange", this.refresh);
    }
    this.history.clear();
  }
}
