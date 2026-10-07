/** A deterministic browser socket boundary for the client and UI tests. */
export class FakeSocket {
  constructor() {
    this.readyState = 1;
    this.bufferedAmount = 0;
    this.sent = [];
    this.listeners = new Map();
    this.closeCount = 0;
  }
  addEventListener(type, callback) {
    const callbacks = this.listeners.get(type) ?? [];
    callbacks.push(callback);
    this.listeners.set(type, callbacks);
  }
  emit(type, event = {}) {
    for (const callback of this.listeners.get(type) ?? []) callback(event);
  }
  event(event) {
    this.emit("message", { data: JSON.stringify(event) });
  }
  send(message) {
    this.sent.push(message);
  }
  close() {
    this.closeCount++;
    this.readyState = 3;
    this.emit("close");
  }
}
