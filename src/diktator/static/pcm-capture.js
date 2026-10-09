/** Incremental mono resampling with a bounded low-pass FIR for native-rate fallback. Only one output batch is retained here. */
export class PcmCapture {
  /** @param {number} sourceRate @param {number} limit @param {(pcm: Int16Array, level: number) => void} emit */
  constructor(sourceRate, limit, emit) {
    this.ratio = sourceRate / 16000;
    this.history = new Float32Array(64);
    this.historyIndex = 0;
    this.filter = sourceRate > 16000 ? lowPass(sourceRate) : null;
    this.limit = limit;
    this.emit = emit;
    this.count = 0;
    this.weight = 0;
    this.sum = 0;
    this.offset = 0;
    this.squares = 0;
    this.buffer = new Int16Array(2048);
  }
  /** @param {Float32Array[]} channels */
  push(channels) {
    if (!channels.length) return;
    for (let frame = 0; frame < channels[0].length && this.count < this.limit; frame++) {
      let mono = 0;
      for (const channel of channels) mono += channel[frame] / channels.length;
      this.historyIndex = (this.historyIndex + 1) & 63;
      this.history[this.historyIndex] = mono;
      let remaining = 1;
      while (remaining > 1e-9 && this.count < this.limit) {
        const taken = Math.min(remaining, this.ratio - this.weight);
        this.sum += mono * taken;
        this.weight += taken;
        remaining -= taken;
        if (this.weight >= this.ratio - 1e-9) {
          let value = this.sum / this.ratio;
          if (this.filter) {
            value = 0;
            const coefficients = this.filter[Math.min(63, Math.floor(remaining * 64))];
            for (let tap = 0; tap < 63; tap++)
              value += this.history[(this.historyIndex - tap) & 63] * coefficients[tap];
          }
          const sample = Math.max(-1, Math.min(1, value));
          this.buffer[this.offset++] = sample < 0 ? sample * 32768 : sample * 32767;
          this.squares += sample * sample;
          this.count++;
          this.weight = 0;
          this.sum = 0;
          if (this.offset === this.buffer.length) this.flush();
        }
      }
    }
  }
  flush() {
    if (!this.offset) return;
    this.emit(this.buffer.slice(0, this.offset), Math.sqrt(this.squares / this.offset));
    this.offset = 0;
    this.squares = 0;
  }
}

/** 64 fractional phases of a 63-tap Blackman-windowed sinc; causal delay is 31 native samples.
 * @param {number} rate @returns {Float64Array[]} */
function lowPass(rate) {
  const cutoff = 7200 / rate;
  return Array.from({ length: 64 }, (_, phase) => {
    const coefficients = new Float64Array(63);
    let sum = 0;
    for (let tap = 0; tap < 63; tap++) {
      const x = tap - 31 - phase / 64;
      const window =
        0.42 - 0.5 * Math.cos((2 * Math.PI * tap) / 62) + 0.08 * Math.cos((4 * Math.PI * tap) / 62);
      coefficients[tap] =
        (Math.abs(x) < 1e-9 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x)) *
        window;
      sum += coefficients[tap];
    }
    for (let tap = 0; tap < 63; tap++) coefficients[tap] /= sum;
    return coefficients;
  });
}
