import { ApiRequestError } from "./errors.js";

/** Share error decoding and a deadline covering both fetch and response-body reads.
 * @param {string} path @param {RequestInit} [options] */
export async function request(path, options = {}) {
  const deadline = AbortSignal.timeout(190_000);
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
