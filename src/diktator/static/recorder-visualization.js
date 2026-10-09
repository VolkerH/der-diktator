import { stippleTheme } from "./recorder-theme.js";

const TRAVEL_MS = 800;

/** A bounded microphone-level history. New speech enters on the right. */
export class WaveHistory {
  constructor() {
    /** @type {{time: number, value: number}[]} */
    this.samples = [];
    this.envelope = 0;
    this.levelTime = 0;
  }

  /** @param {number} level @param {number} time */
  push(level, time) {
    const amplitude = Number.isFinite(level) ? Math.sqrt(Math.max(0, level - 0.002) * 8) : 0;
    const target = Math.min(1, amplitude);
    const elapsed = this.samples.length ? Math.max(0, time - this.levelTime) : 60;
    const response = target > this.envelope ? 100 : 240;
    this.envelope += (target - this.envelope) * (1 - Math.exp(-elapsed / response));
    this.levelTime = time;
    this.samples.push({
      time,
      value: Math.min(1, amplitude) * Math.sin((time / 1000) * Math.PI * 6),
    });
    while (this.samples.length > 80 || this.samples[0].time < time - TRAVEL_MS - 200) {
      this.samples.shift();
    }
  }

  /** Travelling vertical component, combined with a global breath by the renderer.
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

  /** Smooth expansion with speech, relaxing back to rest in silence.
   * @param {number} time */
  breath(time) {
    return this.envelope * Math.exp(-Math.max(0, time - this.levelTime - 80) / 240);
  }

  clear() {
    this.samples = [];
    this.envelope = 0;
    this.levelTime = 0;
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
      if (document.hidden || this.motion?.matches) this.history.clear();
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
    const expansion = moving ? this.history.breath(time) * 0.075 : 0;
    // Sample once per column instead of searching the history for every dot.
    const offsets = Array.from({ length: 129 }, (_, i) =>
      moving ? this.history.at(i / 128, time) * span * 0.025 : 0,
    );
    ctx.fillStyle = this.theme.ink;
    for (const [x, y, ink] of this.theme.points) {
      const column = Math.min(127, Math.max(0, Math.floor(x * 128)));
      const fraction = Math.min(1, Math.max(0, x * 128 - column));
      const dy = offsets[column] + (offsets[column + 1] - offsets[column]) * fraction;
      const radius = Math.max(0.48, this.theme.dotSize * (span / 520) * (0.25 + ink * 0.55) * 0.5);
      ctx.globalAlpha = 0.18 + ink * 0.72;
      ctx.beginPath();
      ctx.arc(
        ox + (x + (x - 0.5) * expansion) * span,
        oy + (y + (y - 0.5) * expansion) * span + dy,
        radius,
        0,
        Math.PI * 2,
      );
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
