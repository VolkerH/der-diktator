/** Batch microphone frames to reduce traffic to the browser's main thread. */
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(2048);
    this.offset = 0;
    this.active = true;
    this.port.onmessage = (event) => {
      if (event.data.type === "stop") {
        this.flush();
        this.active = false;
        this.port.postMessage({ type: "stopped" });
      }
    };
  }

  flush() {
    if (this.offset === 0) return;
    const samples = this.buffer.slice(0, this.offset);
    this.port.postMessage({ type: "samples", samples }, [samples.buffer]);
    this.offset = 0;
  }

  /** @param {Float32Array[][]} inputs @returns {boolean} */
  process(inputs) {
    if (!this.active) return false;
    const channels = inputs[0];
    if (!channels || channels.length === 0) return true;
    for (let frame = 0; frame < channels[0].length; frame++) {
      let mono = 0;
      for (const channel of channels) mono += channel[frame] / channels.length;
      this.buffer[this.offset++] = mono;
      if (this.offset === this.buffer.length) this.flush();
    }
    return true;
  }
}

registerProcessor("phonon-recorder", RecorderProcessor);
