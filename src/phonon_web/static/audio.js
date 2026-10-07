/** The inference server's sample rate. */
export const SAMPLE_RATE = 16_000;
export const MAX_DURATION_SECONDS = 600;

/**
 * Encode mono samples as a little-endian, signed 16-bit PCM WAV file.
 * @param {Float32Array} samples
 * @param {number} [sampleRate]
 * @returns {ArrayBuffer}
 */
export function encodeWav(samples, sampleRate = SAMPLE_RATE) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  /** @param {number} offset @param {string} text */
  function writeText(offset, text) {
    for (let index = 0; index < text.length; index++) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  }
  writeText(0, "RIFF");
  view.setUint32(4, buffer.byteLength - 8, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index++) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return buffer;
}

/**
 * Join microphone chunks, enforcing a sample limit before allocating a recording.
 * @param {Float32Array[]} chunks
 * @param {number} maxSamples
 * @returns {Float32Array}
 */
export function joinSamples(chunks, maxSamples) {
  const length = Math.min(
    chunks.reduce((total, chunk) => total + chunk.length, 0),
    maxSamples,
  );
  const result = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    const count = Math.min(chunk.length, length - offset);
    result.set(chunk.subarray(0, count), offset);
    offset += count;
    if (offset === length) break;
  }
  return result;
}

/** @param {string} text @returns {number} */
export function wordCount(text) {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/u).length : 0;
}
