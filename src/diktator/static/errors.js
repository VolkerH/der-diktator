/** Public request failure; legacy and intermediary bodies may have no code. */
export class ApiRequestError extends Error {
  /** @param {unknown} payload @param {string} fallback */
  constructor(payload, fallback) {
    const result = /** @type {{ detail?: unknown, code?: unknown } | null} */ (payload);
    super(typeof result?.detail === "string" ? result.detail : fallback);
    this.name = "ApiRequestError";
    /** @type {string | undefined} */
    this.code = typeof result?.code === "string" ? result.code : undefined;
  }
}
