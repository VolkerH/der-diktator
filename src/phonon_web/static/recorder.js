import { encodeWav, joinSamples, MAX_DURATION_SECONDS, SAMPLE_RATE } from "./audio.js";

/** Capture microphone PCM and release all microphone resources on every exit path. */
export class MicrophoneRecorder {
  constructor() {
    /** @type {MediaStream | null} */
    this.stream = null;
    /** @type {AudioContext | null} */
    this.context = null;
    /** @type {AudioWorkletNode | null} */
    this.node = null;
    /** @type {Float32Array[]} */
    this.chunks = [];
    this.sampleCount = 0;
    /** @type {(() => void) | null} */
    this.onStopped = null;
  }

  /** Live callbacks receive mono 16 kHz chunks, including the final worklet flush.
   * @param {((samples: Float32Array) => void) | null} [onSamples]
   */
  async start(onSamples = null) {
    this.chunks = [];
    this.sampleCount = 0;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      try {
        this.context = new AudioContext({ sampleRate: SAMPLE_RATE });
      } catch {
        this.context = new AudioContext();
      }
      if (onSamples && this.context.sampleRate !== SAMPLE_RATE) {
        throw new Error(
          "This browser cannot capture at 16 kHz for live transcription. Turn off Live transcription and record again.",
        );
      }
      await this.context.audioWorklet.addModule("/assets/recorder-worklet.js");
      this.node = new AudioWorkletNode(this.context, "phonon-recorder");
      const maxSamples = this.context.sampleRate * MAX_DURATION_SECONDS;
      this.node.port.onmessage = (event) => {
        if (event.data.type === "samples") {
          const samples = /** @type {Float32Array} */ (event.data.samples);
          const remaining = maxSamples - this.sampleCount;
          if (remaining > 0) {
            const chunk = samples.subarray(0, remaining);
            this.chunks.push(chunk);
            this.sampleCount += chunk.length;
            onSamples?.(chunk);
          }
        } else if (event.data.type === "stopped") {
          this.onStopped?.();
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

  /** @returns {Promise<Blob>} */
  async stop() {
    const context = this.context;
    const node = this.node;
    if (!context || !node) throw new Error("No recording is active.");
    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Microphone capture did not stop.")),
          2000,
        );
        this.onStopped = () => {
          clearTimeout(timeout);
          resolve(undefined);
        };
        node.port.postMessage({ type: "stop" });
      });
      const samples = joinSamples(this.chunks, context.sampleRate * MAX_DURATION_SECONDS);
      if (samples.length === 0) throw new Error("No audio was captured. Check your microphone.");
      // Release the device before resampling a potentially long recording.
      for (const track of this.stream?.getTracks() ?? []) track.stop();
      this.stream = null;
      const resampled = await resample(samples, context.sampleRate);
      return new Blob([encodeWav(resampled)], { type: "audio/wav" });
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
    if (this.context && this.context.state !== "closed") await this.context.close();
    this.context = null;
  }
}

/** Use the browser's audio resampler when the microphone context has another rate.
 * @param {Float32Array} samples
 * @param {number} sourceRate
 * @returns {Promise<Float32Array>}
 */
async function resample(samples, sourceRate) {
  if (sourceRate === SAMPLE_RATE) return samples;
  const length = Math.max(1, Math.round((samples.length * SAMPLE_RATE) / sourceRate));
  const context = new OfflineAudioContext(1, length, SAMPLE_RATE);
  const buffer = context.createBuffer(1, samples.length, sourceRate);
  buffer.getChannelData(0).set(samples);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  source.start();
  const result = await context.startRendering();
  return result.getChannelData(0);
}
