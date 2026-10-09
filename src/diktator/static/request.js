import { ApiRequestError } from "./errors.js";

/** Share error decoding and a deadline covering both fetch and response-body reads.
 * @param {string} path @param {RequestInit} [options] @param {number} [timeoutMs] */
export async function request(path, options = {}, timeoutMs = 190_000) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const response = await fetch(path, { ...options, signal });
  const result =
    response.status === 204
      ? null
      : await response.json().catch(() => {
          signal.throwIfAborted();
          return null;
        });
  if (!response.ok) {
    throw new ApiRequestError(result, "The request failed. Try again.");
  }
  return { body: result, headers: response.headers };
}
