import { request } from "./request.js";
import { recordingPolicy, recordingTimeoutMs } from "./recording-policy.js";

/** @typedef {{ id: string, created: string, duration_seconds: number }} Recording */
/** A title observation carries its parent ordering revision without acknowledging the whole Chat.
 * @typedef {{ title: string, custom_title: string | null, title_revision: number, titleChatRevision: number, titleEtag: string | null }} ChatTitle */
/** @typedef {ChatTitle & { id: string, created: string, updated: string, text: string, recordings: Recording[], revision: number, text_revision: number, etag: string | null, textEtag: string | null }} Chat */
/** @typedef {{ id: string, title: string, custom_title: string | null, updated: string, recording_count: number, etag: string, group_id: string | null, placement_etag: string }} ChatSummary */
/** @typedef {{ recording: Recording, chatEtag: string | null, chatRevision: number | null }} RecordingUpload */

/** Preserve opaque validators explicitly for routes returning a complete Chat.
 * @param {string} path @param {RequestInit} [options] @returns {Promise<Chat>} */
async function chatRequest(path, options = {}) {
  const { body, headers } = await request(path, options);
  return {
    ...body,
    etag: headers.get("ETag"),
    textEtag: headers.get("Text-ETag"),
    titleEtag: headers.get("Title-ETag"),
    titleChatRevision: body.revision,
  };
}

/** @param {unknown} result @returns {string} */
function transcriptText(result) {
  const text = /** @type {{ text?: unknown } | null} */ (result)?.text;
  if (typeof text !== "string") throw new Error("An invalid transcript was returned. Try again.");
  return text;
}

/** The server's chat storage and transcription endpoints. */
export const chatApi = {
  /** @param {string} [query] @returns {Promise<ChatSummary[]>} */
  list: async (query = "") =>
    (await request(query ? `/api/chats?q=${encodeURIComponent(query)}` : "/api/chats")).body,
  /** The initial group is ignored when the chosen ID already exists.
   * @param {string} id @param {string | null} [groupId] @returns {Promise<Chat>} */
  create: (id, groupId = null) =>
    chatRequest(`/api/chats/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group_id: groupId }),
    }),
  /** @param {string} id @returns {Promise<Chat>} */
  get: (id) => chatRequest(`/api/chats/${id}`),
  /** @param {string} id @returns {Promise<{ custom_title: string | null, title_revision: number, titleEtag: string | null }>} */
  getTitle: async (id) => {
    const { body, headers } = await request(`/api/chats/${id}/title`);
    return {
      ...body,
      titleEtag: headers.get("ETag"),
    };
  },
  /** @param {string} id @param {string | null} customTitle @param {string} etag @returns {Promise<Chat>} */
  saveTitle: (id, customTitle, etag) =>
    chatRequest(`/api/chats/${id}/title`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "If-Match": etag },
      body: JSON.stringify({ custom_title: customTitle }),
    }),
  /** @param {string} id @param {string} etag */
  remove: (id, etag) =>
    request(`/api/chats/${id}`, { method: "DELETE", headers: { "If-Match": etag } }),
  /** Keepalive lets a save started while the page closes still reach the server.
   * @param {string} id @param {string} text @param {string} etag @param {boolean} [keepalive]
   * @returns {Promise<Chat>} */
  saveText: (id, text, etag, keepalive = false) =>
    chatRequest(`/api/chats/${id}/text`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "If-Match": etag },
      body: JSON.stringify({ text }),
      keepalive,
    }),
  /** @param {string} id @param {Blob} audio @param {string} recordingId @returns {Promise<RecordingUpload>} */
  addRecording: async (id, audio, recordingId) => {
    const { body, headers } = await request(`/api/chats/${id}/recordings/${recordingId}`, {
      method: "PUT",
      headers: { "Content-Type": "audio/wav" },
      body: audio,
    });
    const revision = headers.get("Chat-Revision");
    return {
      recording: body,
      chatEtag: headers.get("Chat-ETag"),
      chatRevision: revision === null ? null : Number(revision),
    };
  },
  /** @param {string} id @param {string} recordingId */
  recordingUrl: (id, recordingId) => `/api/chats/${id}/recordings/${recordingId}`,
  /** @param {string} id @param {string} recordingId @param {string} [model] @returns {Promise<string>} */
  transcribeRecording: async (id, recordingId, model = "phonon-2") => {
    const policy = await recordingPolicy();
    return transcriptText(
      (
        await request(
          `/api/chats/${id}/recordings/${recordingId}/transcribe?model=${encodeURIComponent(model)}`,
          { method: "POST" },
          recordingTimeoutMs(policy, "batch"),
        )
      ).body,
    );
  },
  /** Transcribe audio that could not be stored. @param {Blob} audio @param {string} [model] @returns {Promise<string>} */
  transcribe: async (audio, model = "phonon-2") => {
    const policy = await recordingPolicy();
    return transcriptText(
      (
        await request(
          `/api/transcribe?model=${encodeURIComponent(model)}`,
          {
            method: "POST",
            headers: { "Content-Type": "audio/wav" },
            body: audio,
          },
          recordingTimeoutMs(policy, "batch"),
        )
      ).body,
    );
  },
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
