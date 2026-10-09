/** Public request failure; legacy and intermediary bodies may have no code. */
export class ApiRequestError extends Error {
  /** @param {unknown} payload @param {string} fallback */
  constructor(payload, fallback) {
    const result =
      /** @type {{ detail?: unknown, code?: unknown, context?: {errors?: {msg?: unknown}[]} } | null} */ (
        payload
      );
    super(typeof result?.detail === "string" ? result.detail : fallback);
    this.name = "ApiRequestError";
    /** Safe server validation diagnostics; never the submitted values. */
    const errors = result?.context?.errors;
    this.validationMessages = Array.isArray(errors)
      ? errors.map((error) => error?.msg).filter((message) => typeof message === "string")
      : [];
    /** @type {string | undefined} */
    this.code = typeof result?.code === "string" ? result.code : undefined;
  }
}
