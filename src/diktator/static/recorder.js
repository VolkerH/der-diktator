import { encodeWav, SAMPLE_RATE } from "./audio.js";

/** PCM16 retention and worklet sample budgets bound capture at every native rate. */
export class MicrophoneRecorder {
  constructor() {
    /** @type {MediaStream | null} */
    this.stream = null;
    /** @type {AudioContext | null} */
    this.context = null;
    /** @type {AudioWorkletNode | null} */
    this.node = null;
    /** @type {Int16Array[]} */
    this.chunks = [];
    this.sampleCount = 0;
    this.stopped = false;
    /** @type {(() => void) | null} */
    this.onStopped = null;
    /** @type {((reason: string) => void) | null} */
    this.onAutomaticStop = null;
    /** @type {((level: number) => void) | null} */
    this.onLevel = null;
    /** @type {((accepted: boolean) => void) | null} */
    this.onExtended = null;
    /** @type {Promise<Blob> | null} */
    this.stopping = null;
  }
  /** @param {((samples: Float32Array) => void) | null} [onSamples]
   * @param {{intervalSeconds: number, hardLimitSeconds: number}} [budget] */
  async start(onSamples = null, budget = { intervalSeconds: 600, hardLimitSeconds: 600 }) {
    this.chunks = [];
    this.sampleCount = 0;
    this.stopped = false;
    this.stopping = null;
    const hardMaxSamples = budget.hardLimitSeconds * SAMPLE_RATE;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      try {
        this.context = new AudioContext({ sampleRate: SAMPLE_RATE });
      } catch {
        this.context = new AudioContext();
      }
      await this.context.audioWorklet.addModule("/assets/recorder-worklet.js");
      this.node = new AudioWorkletNode(this.context, "diktator-recorder", {
        processorOptions: {
          sampleRate: this.context.sampleRate,
          maxSamples: budget.intervalSeconds * SAMPLE_RATE,
          hardMaxSamples,
        },
      });
      this.node.port.onmessage = (event) => {
        if (event.data.type === "samples") {
          const pcm = /** @type {Int16Array} */ (event.data.pcm);
          if (this.sampleCount + pcm.length > hardMaxSamples) return;
          this.chunks.push(pcm);
          this.sampleCount += pcm.length;
          this.node?.port.postMessage({ type: "ack" });
          if (onSamples) {
            const samples = new Float32Array(pcm.length);
            for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 32768;
            onSamples(samples);
          }
          this.onLevel?.(event.data.level);
        } else if (event.data.type === "stopped") {
          this.stopped = true;
          this.onExtended?.(false);
          this.onExtended = null;
          this.onStopped?.();
          if (event.data.reason !== "manual") this.onAutomaticStop?.(event.data.reason);
        } else if (event.data.type === "extended") {
          this.onExtended?.(Boolean(event.data.accepted));
          this.onExtended = null;
        }
      };
      const source = this.context.createMediaStreamSource(this.stream);
      const muted = this.context.createGain();
      muted.gain.value = 0;
      source.connect(this.node).connect(muted).connect(this.context.destination);
      await this.context.resume();
    } catch (error) {
      await this.release();
      throw error;
    }
  }
  /** @param {number} seconds @returns {Promise<boolean>} */
  async extend(seconds) {
    if (!this.node || this.stopped || this.stopping || this.onExtended) return false;
    return await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.onExtended = null;
        resolve(false);
      }, 2000);
      this.onExtended = (accepted) => {
        clearTimeout(timeout);
        resolve(accepted);
      };
      this.node?.port.postMessage({ type: "extend", maxSamples: seconds * SAMPLE_RATE });
    });
  }
  /** @returns {Promise<Blob>} */
  stop() {
    if (this.stopping) return this.stopping;
    this.stopping = this.finish();
    return this.stopping;
  }
  /** @returns {Promise<Blob>} */
  async finish() {
    if (!this.context || !this.node) throw new Error("No recording is active.");
    try {
      if (!this.stopped)
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("Microphone capture did not stop.")),
            2000,
          );
          this.onStopped = () => {
            clearTimeout(timeout);
            resolve(undefined);
          };
          this.node?.port.postMessage({ type: "stop" });
        });
      if (!this.sampleCount) throw new Error("No audio was captured. Check your microphone.");
      const header = encodeWav(new Float32Array());
      const view = new DataView(header);
      view.setUint32(4, 36 + this.sampleCount * 2, true);
      view.setUint32(40, this.sampleCount * 2, true);
      // Blob copies bounded PCM chunks; no full-duration join or resampling buffer.
      return new Blob(
        [header, ...this.chunks.map((chunk) => /** @type {ArrayBuffer} */ (chunk.buffer))],
        { type: "audio/wav" },
      );
    } finally {
      this.chunks = [];
      await this.release();
    }
  }
  async release() {
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.node?.disconnect();
    this.node = null;
    this.onStopped = null;
    this.onExtended?.(false);
    this.onExtended = null;
    this.chunks = [];
    if (this.context && this.context.state !== "closed") await this.context.close();
    this.context = null;
  }
}
