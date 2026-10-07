/** @typedef {{ id: string, created: string, duration_seconds: number }} Recording */
/** @typedef {{ id: string, created: string, updated: string, text: string, recordings: Recording[] }} Chat */
/** @typedef {{ id: string, title: string, updated: string, recording_count: number }} ChatSummary */

/** @param {string} path @param {RequestInit} [options] */
async function request(path, options = {}) {
  const response = await fetch(path, { signal: AbortSignal.timeout(190_000), ...options });
  if (response.status === 204) return null;
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      typeof result?.detail === "string" ? result.detail : "The request failed. Try again.",
    );
  }
  return result;
}

/** @param {unknown} result @returns {string} */
function transcriptText(result) {
  const text = /** @type {{ text?: unknown } | null} */ (result)?.text;
  if (typeof text !== "string") throw new Error("An invalid transcript was returned. Try again.");
  return text;
}

/** The server's chat storage and transcription endpoints. */
export const chatApi = {
  /** @returns {Promise<ChatSummary[]>} */
  list: () => request("/api/chats"),
  /** @returns {Promise<Chat>} */
  create: () => request("/api/chats", { method: "POST" }),
  /** @param {string} id @returns {Promise<Chat>} */
  get: (id) => request(`/api/chats/${id}`),
  /** @param {string} id */
  remove: (id) => request(`/api/chats/${id}`, { method: "DELETE" }),
  /** Keepalive lets a save started while the page closes still reach the server.
   * @param {string} id @param {string} text @param {boolean} [keepalive]
   * @returns {Promise<Chat>} */
  saveText: (id, text, keepalive = false) =>
    request(`/api/chats/${id}/text`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      keepalive,
    }),
  /** @param {string} id @param {Blob} audio @returns {Promise<Recording>} */
  addRecording: (id, audio) =>
    request(`/api/chats/${id}/recordings`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: audio,
    }),
  /** @param {string} id @param {string} recordingId */
  recordingUrl: (id, recordingId) => `/api/chats/${id}/recordings/${recordingId}`,
  /** @param {string} id @param {string} recordingId @returns {Promise<string>} */
  transcribeRecording: async (id, recordingId) =>
    transcriptText(
      await request(`/api/chats/${id}/recordings/${recordingId}/transcribe`, { method: "POST" }),
    ),
  /** Transcribe audio that could not be stored. @param {Blob} audio @returns {Promise<string>} */
  transcribe: async (audio) =>
    transcriptText(
      await request("/api/transcribe", {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        body: audio,
      }),
    ),
};

/**
 * Insert words in place of a selection, adding a space where they would touch other words.
 * Nothing recognized leaves the text unchanged.
 * @param {string} text @param {number} start @param {number} end @param {string} insertion
 * @returns {{ text: string, caret: number }}
 */
export function spliceText(text, start, end, insertion) {
  const words = insertion.trim();
  if (!words) return { text, caret: end };
  const before = text.slice(0, start);
  const after = text.slice(end);
  const lead = before && !/\s$/u.test(before) ? " " : "";
  const trail = after && !/^\s/u.test(after) ? " " : "";
  return {
    text: before + lead + words + trail + after,
    caret: before.length + lead.length + words.length,
  };
}

/** Matches the server's chat titles. @param {string} text */
export function titleFor(text) {
  const words = text.split(/\s+/u).filter(Boolean).join(" ");
  if (!words) return "New chat";
  if (words.length <= 48) return words;
  return words.slice(0, 48).replace(/\s+\S*$/u, "") + "…";
}
