import { PcmCapture } from "./pcm-capture.js";

/** Bound audio in the audio thread, including messages awaiting main-thread delivery. */
export class RecorderProcessor extends AudioWorkletProcessor {
  /** @param {{processorOptions?: {sampleRate?: number, maxSamples?: number, hardMaxSamples?: number}}} [options] */
  constructor(options = {}) {
    super();
    const config = options.processorOptions ?? {};
    this.hardMaxSamples = config.hardMaxSamples ?? 600 * 16000;
    this.active = true;
    this.pending = 0;
    this.pcm = new PcmCapture(
      config.sampleRate ?? 16000,
      config.maxSamples ?? this.hardMaxSamples,
      (pcm, level) => {
        this.pending++;
        this.port.postMessage({ type: "samples", pcm, level }, [pcm.buffer]);
      },
    );
    this.port.onmessage = (event) => {
      if (event.data.type === "ack") this.pending = Math.max(0, this.pending - 1);
      else if (event.data.type === "stop") this.stop("manual");
      else if (event.data.type === "extend") {
        const limit = event.data.maxSamples;
        const accepted =
          this.active &&
          Number.isInteger(limit) &&
          limit > this.pcm.limit &&
          limit <= this.hardMaxSamples;
        if (accepted) this.pcm.limit = limit;
        this.port.postMessage({
          type: "extended",
          requestId: event.data.requestId,
          accepted,
          maxSamples: this.pcm.limit,
        });
      }
    };
  }
  /** @param {string} reason */
  stop(reason) {
    if (!this.active) return;
    this.active = false;
    this.pcm.flush();
    this.port.postMessage({ type: "stopped", reason, sampleCount: this.pcm.count });
  }
  /** @param {Float32Array[][]} inputs @returns {boolean} */
  process(inputs) {
    if (!this.active) return false;
    // 128 batches tolerate ~16.384 s of main-thread stalls. Including the
    // partial batch, transport retains at most 516 KiB PCM16 regardless of duration.
    if (this.pending >= 128) {
      this.stop("capture_queue_overflow");
      return false;
    }
    this.pcm.push(inputs[0] ?? []);
    if (this.pcm.count >= this.pcm.limit) this.stop("deadline");
    return this.active;
  }
}
registerProcessor("diktator-recorder", RecorderProcessor);
