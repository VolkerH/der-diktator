import { request } from "./request.js";

/** @typedef {{ protocol_version: number, policy_revision: string, hard_limit_seconds: number, max_audio_bytes: number, max_pcm_bytes: number, max_stream_frame_bytes: number, upload_timeout_seconds: number, batch_timeout_seconds: number, live_finalization_timeout_seconds: number, client_timeout_margin_seconds: number, client_deadlines_ms: {upload: number, batch: number, live: number}, preference_etag: string, recording_interval_seconds: number }} RecordingPolicy */

/** Discovery does not reserve a model. The server checks agreement again at admission.
 * @returns {Promise<Readonly<RecordingPolicy>>} */
export async function recordingPolicy() {
  const { body } = await request("/api/recording-policy");
  if (
    body?.protocol_version !== 1 ||
    typeof body.policy_revision !== "string" ||
    !Number.isInteger(body.hard_limit_seconds) ||
    body.hard_limit_seconds < 60 ||
    body.hard_limit_seconds % 60 !== 0 ||
    ![
      "upload_timeout_seconds",
      "batch_timeout_seconds",
      "live_finalization_timeout_seconds",
      "client_timeout_margin_seconds",
    ].every((name) => Number.isFinite(body[name]) && body[name] > 0) ||
    !["upload", "batch", "live"].every((name) => validDeadline(body?.client_deadlines_ms?.[name]))
  )
    throw new Error("The recording policy is unavailable. Restart both services and retry.");
  Object.freeze(body.client_deadlines_ms);
  return Object.freeze(body);
}

/** @param {RecordingPolicy} policy @param {"upload" | "batch" | "live"} operation */
export function recordingTimeoutMs(policy, operation) {
  return policy.client_deadlines_ms[operation];
}

/** @param {unknown} value */
function validDeadline(value) {
  return (
    typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 2_147_483_647
  );
}

/** Saving captured or attached audio remains available without an inference engine.
 * @returns {Promise<number>} */
export async function uploadTimeoutMs() {
  try {
    const { body } = await request("/api/settings", {}, 5000);
    if (validDeadline(body?.client_upload_timeout_ms)) return body.client_upload_timeout_ms;
  } catch {
    // Discovery is advisory for saving: the server still enforces upload limits.
  }
  return 190_000;
}
