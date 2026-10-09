import { request } from "./request.js";

/** @typedef {{ protocol_version: number, policy_revision: string, hard_limit_seconds: number, max_audio_bytes: number, max_pcm_bytes: number, max_stream_frame_bytes: number, upload_timeout_seconds: number, batch_timeout_seconds: number, live_finalization_timeout_seconds: number, client_timeout_margin_seconds: number, preference_etag: string }} RecordingPolicy */

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
    ].every((name) => Number.isFinite(body[name]) && body[name] > 0)
  )
    throw new Error("The recording policy is unavailable. Restart both services and retry.");
  return Object.freeze(body);
}

/** @param {RecordingPolicy} policy @param {"upload" | "batch" | "live"} operation */
export function recordingTimeoutMs(policy, operation) {
  const seconds =
    operation === "upload"
      ? policy.upload_timeout_seconds
      : operation === "live"
        ? policy.live_finalization_timeout_seconds + policy.client_timeout_margin_seconds
        : policy.upload_timeout_seconds +
          policy.batch_timeout_seconds +
          policy.client_timeout_margin_seconds * 2;
  return Math.ceil((seconds + policy.client_timeout_margin_seconds) * 1000);
}
