import { encodePcm16 } from "./audio.js";

/** Partials replace the current hypothesis; final segments are appended once. */
export class LiveTranscript {
  constructor() {
    /** @type {string[]} */
    this.finals = [];
    /** @type {Set<number>} */
    this.segments = new Set();
    this.partial = "";
    /** @type {string | null} */
    this.completed = null;
  }

  /** @param {{ type: string, text: string, segment?: number }} event */
  update(event) {
    if (event.type === "done") {
      this.completed = event.text;
      this.partial = "";
    } else if (event.type === "partial") {
      this.partial = event.text;
    } else if (event.type === "final") {
      if (!Number.isInteger(event.segment) || /** @type {number} */ (event.segment) < 1) {
        throw new Error("An invalid live transcript segment was returned.");
      }
      const segment = /** @type {number} */ (event.segment);
      if (!this.segments.has(segment)) {
        this.segments.add(segment);
        this.finals.push(event.text.trim());
        this.partial = "";
      }
    }
    return this.text;
  }

  get text() {
    return this.completed ?? [...this.finals, this.partial.trim()].filter(Boolean).join(" ");
  }
}

/** A single recording's connection. Failure leaves microphone/WAV capture running. */
export class LiveTranscriber {
  /**
   * @param {(text: string) => void} onText
   * @param {(error: Error) => void} onFailure
   * @param {{ socketFactory?: (url: string) => WebSocket, readyTimeoutMs?: number, finishTimeoutMs?: number }} [options]
   */
  constructor(onText, onFailure, options = {}) {
    this.onText = onText;
    this.onFailure = onFailure;
    this.socketFactory = options.socketFactory ?? ((url) => new WebSocket(url));
    this.readyTimeoutMs = options.readyTimeoutMs ?? 10_000;
    this.finishTimeoutMs = options.finishTimeoutMs ?? 200_000;
    this.transcript = new LiveTranscript();
    /** @type {WebSocket | null} */
    this.socket = null;
    /** @type {Error | null} */
    this.failure = null;
    this.ready = false;
    this.ending = false;
    this.completed = false;
    this.cancelled = false;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    this.readyTimer = undefined;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    this.finishTimer = undefined;
    /** @type {() => void} */
    this.resolveReady = () => {};
    /** @type {(error: Error) => void} */
    this.rejectReady = () => {};
    /** @type {(text: string) => void} */
    this.resolveDone = () => {};
    /** @type {(error: Error) => void} */
    this.rejectDone = () => {};
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = () => resolve(undefined);
      this.rejectReady = reject;
    });
    /** @type {Promise<string>} */
    this.donePromise = new Promise((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
    // A connection can fail during recording, before finish() is awaited.
    void this.readyPromise.catch(() => {});
    void this.donePromise.catch(() => {});
  }

  /** @param {string} url */
  async start(url) {
    try {
      this.socket = this.socketFactory(url);
      this.socket.addEventListener("message", (event) => this.receive(event.data));
      this.socket.addEventListener("error", () =>
        this.fail(new Error("Live transcription could not connect.")),
      );
      this.socket.addEventListener("close", () => {
        if (!this.completed && !this.cancelled) {
          this.fail(new Error("The live transcription connection closed before finishing."));
        }
      });
      this.readyTimer = setTimeout(
        () => this.fail(new Error("Live transcription did not connect in time.")),
        this.readyTimeoutMs,
      );
    } catch (error) {
      this.fail(
        error instanceof Error ? error : new Error("Live transcription could not connect."),
      );
    }
    await this.readyPromise;
  }

  /** @param {unknown} message */
  receive(message) {
    if (this.failure || this.cancelled || this.completed) return;
    try {
      if (typeof message !== "string") throw new Error("An invalid live transcript was returned.");
      const event = JSON.parse(message);
      if (!event || typeof event !== "object")
        throw new Error("An invalid live event was returned.");
      if (event.type === "ready") {
        this.ready = true;
        clearTimeout(this.readyTimer);
        this.resolveReady();
      } else if (event.type === "error") {
        throw new Error(
          typeof event.message === "string" ? event.message : "Live transcription failed.",
        );
      } else if (
        ["partial", "final", "done"].includes(event.type) &&
        typeof event.text === "string"
      ) {
        if (event.type === "done" && !this.ending) {
          throw new Error("The live transcription ended before recording stopped.");
        }
        const text = this.transcript.update(event);
        this.onText(text);
        if (event.type === "done") {
          this.completed = true;
          clearTimeout(this.finishTimer);
          this.resolveDone(text);
          this.socket?.close();
        }
      } else {
        throw new Error("An invalid live event was returned.");
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error("Live transcription failed."));
    }
  }

  /** @param {Float32Array} samples */
  sendSamples(samples) {
    if (this.failure || this.cancelled || this.ending || !this.ready) return;
    try {
      if (!this.socket || this.socket.readyState !== 1)
        throw new Error("The live connection is unavailable.");
      if (this.socket.bufferedAmount + samples.length * 2 > 1_048_576) {
        throw new Error(
          "Live transcription cannot keep up. Your recording is still being captured.",
        );
      }
      this.socket.send(encodePcm16(samples));
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error("Live audio could not be sent."));
    }
  }

  /** Send end only after the microphone's final flush, then wait for authoritative text. */
  async finish() {
    if (this.failure) throw this.failure;
    if (!this.ending) {
      this.ending = true;
      this.finishTimer = setTimeout(
        () =>
          this.fail(new Error("Live transcription did not finish in time. Retry transcription.")),
        this.finishTimeoutMs,
      );
      try {
        if (!this.socket || this.socket.readyState !== 1)
          throw new Error("The live connection is unavailable.");
        this.socket.send(JSON.stringify({ type: "end" }));
      } catch (error) {
        this.fail(
          error instanceof Error ? error : new Error("Live transcription could not finish."),
        );
      }
    }
    return await this.donePromise;
  }

  /** @param {Error} error @param {boolean} [notify] */
  fail(error, notify = true) {
    if (this.failure || this.completed) return;
    this.failure = error;
    clearTimeout(this.readyTimer);
    clearTimeout(this.finishTimer);
    this.rejectReady(error);
    this.rejectDone(error);
    this.socket?.close();
    if (notify) this.onFailure(error);
  }

  cancel() {
    this.cancelled = true;
    this.fail(new Error("Live transcription was cancelled."), false);
  }
}
