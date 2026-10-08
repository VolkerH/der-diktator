import { ApiRequestError } from "./errors.js";
import { request } from "./request.js";

/** @typedef {{text: string, key: number, active: boolean}} DraftSnapshot */
/** @typedef {{copy_preamble: string, copy_preamble_is_default: boolean, default_copy_preamble: string, max_copy_preamble_characters: number, revision: number}} Preferences */

/** Request shared backend formatting/preferences, keeping device access in this client.
 * @param {() => DraftSnapshot} snapshot
 * @param {(message: string) => void} announce
 */
export function exportControls(snapshot, announce) {
  /** @param {string} id */
  const button = (id) => /** @type {HTMLButtonElement} */ (document.getElementById(id));
  /** @param {string} id */
  const area = (id) => /** @type {HTMLTextAreaElement} */ (document.getElementById(id));
  const copy = button("copy-preamble");
  const open = button("preferences-open");
  const save = button("preferences-save");
  const reset = button("preferences-reset");
  const reload = button("preferences-reload");
  const previewButton = button("preferences-preview-button");
  const preferencesDialog = /** @type {HTMLDialogElement} */ (
    document.getElementById("preferences-dialog")
  );
  const preparedDialog = /** @type {HTMLDialogElement} */ (
    document.getElementById("prepared-dialog")
  );
  const input = area("copy-preamble-input");
  const preview = area("preferences-preview");
  const output = area("prepared-text");
  const preferenceError = /** @type {HTMLElement} */ (document.getElementById("preferences-error"));
  const preferenceStatus = /** @type {HTMLElement} */ (
    document.getElementById("preferences-status")
  );
  const preferenceMode = /** @type {HTMLElement} */ (document.getElementById("preferences-mode"));
  const preparedStatus = /** @type {HTMLElement} */ (document.getElementById("prepared-status"));
  /** @type {Preferences | null} */
  let preferences = null;
  /** @type {string | null} */
  let etag = null;
  let preferenceGeneration = 0;
  let preparing = false;
  let preferencePending = false;
  let preferenceConflict = false;
  let followDefault = false;
  /** @type {DraftSnapshot | null} */
  let preparedSnapshot = null;
  /** Keep the server string separate from textarea.value, which normalizes CRLF. */
  let preparedText = "";

  /** @param {string} path @param {unknown} body */
  const post = (path, body) =>
    request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  /** @param {DraftSnapshot} previous */
  function current(previous) {
    const next = snapshot();
    return previous.key === next.key && previous.text === next.text && !next.active;
  }

  function update() {
    const draft = snapshot();
    copy.disabled = preparing || draft.active || !draft.text.trim();
    if (preparedSnapshot && !current(preparedSnapshot)) {
      preparedSnapshot = null;
      preparedText = "";
      output.value = "";
      if (preparedDialog.open) preparedDialog.close();
    }
  }

  copy.addEventListener("click", async () => {
    update();
    if (copy.disabled) return;
    const captured = { ...snapshot() };
    preparing = true;
    announce("Preparing text with preamble…");
    update();
    try {
      const { body } = await post("/api/exports", {
        text: captured.text,
        format: "with_preamble",
      });
      if (!current(captured)) return;
      // Always use a fresh user gesture after preparation. Fetch may consume browser activation.
      preparedSnapshot = captured;
      preparedText = body.text;
      output.value = preparedText;
      preparedStatus.textContent = "";
      preparedDialog.showModal();
      button("prepared-copy").focus();
    } catch (error) {
      if (current(captured)) announce(error instanceof Error ? error.message : "Export failed.");
    } finally {
      preparing = false;
      update();
    }
  });
  button("prepared-copy").addEventListener("click", async () => {
    if (!preparedSnapshot || !current(preparedSnapshot)) return;
    const captured = preparedSnapshot;
    const text = preparedText;
    try {
      await navigator.clipboard.writeText(text);
      if (preparedDialog.open && preparedSnapshot === captured && preparedText === text) {
        preparedStatus.textContent = "Text copied.";
        announce("Text with preamble copied.");
      }
    } catch {
      if (preparedDialog.open && preparedSnapshot === captured && preparedText === text) {
        output.focus();
        output.select();
        preparedStatus.textContent =
          "Text selected. Press Ctrl+C or use your device's Copy command.";
      }
    }
  });
  button("prepared-close").addEventListener("click", () => preparedDialog.close());
  preparedDialog.addEventListener("close", () => copy.focus());

  /** @param {unknown} error */
  function showPreferenceError(error) {
    preferenceError.textContent = error instanceof Error ? error.message : "Preferences failed.";
    preferenceError.hidden = false;
  }
  function preferenceControls() {
    preferenceStatus.textContent = preferencePending ? "Working…" : "";
    preferenceMode.textContent = preferences
      ? followDefault
        ? "Using the default preamble. Future updates apply automatically."
        : "Using a custom preamble. This wording stays until you change it."
      : "";
    input.readOnly = preferencePending || !preferences;
    save.disabled = preferencePending || !preferences || !etag || preferenceConflict;
    reset.disabled = preferencePending || !preferences;
    previewButton.disabled = preferencePending || !preferences;
    reload.disabled = preferencePending;
    reload.hidden = !preferenceConflict;
  }
  async function loadPreferences() {
    const generation = ++preferenceGeneration;
    preferencePending = true;
    preferenceError.hidden = true;
    preferenceControls();
    try {
      const result = await request("/api/preferences");
      if (generation !== preferenceGeneration || !preferencesDialog.open) return;
      preferences = result.body;
      etag = result.headers.get("ETag");
      followDefault = Boolean(preferences?.copy_preamble_is_default);
      input.value = /** @type {Preferences} */ (preferences).copy_preamble;
      input.maxLength = /** @type {Preferences} */ (preferences).max_copy_preamble_characters;
      preview.value = "";
      preferenceConflict = false;
      input.focus();
    } catch (error) {
      if (generation === preferenceGeneration) showPreferenceError(error);
    } finally {
      if (generation === preferenceGeneration) {
        preferencePending = false;
        preferenceControls();
      }
    }
  }
  open.addEventListener("click", () => {
    preferences = null;
    etag = null;
    preferenceConflict = false;
    input.value = "";
    preview.value = "";
    preferencesDialog.showModal();
    void loadPreferences();
  });
  button("preferences-cancel").addEventListener("click", () => preferencesDialog.close());
  preferencesDialog.addEventListener("close", () => {
    preferenceGeneration++;
    preferencePending = false;
    open.focus();
  });
  reload.addEventListener("click", () => {
    if (window.confirm("Replace your unsaved preamble with the latest saved preference?"))
      void loadPreferences();
  });
  reset.addEventListener("click", () => {
    if (!preferences) return;
    followDefault = true;
    preferenceControls();
    input.value = preferences.default_copy_preamble;
    preview.value = "";
    input.focus();
  });
  input.addEventListener("input", () => {
    followDefault = false;
    preferenceControls();
    preview.value = "";
  });
  previewButton.addEventListener("click", async () => {
    const generation = preferenceGeneration;
    const preamble = input.value;
    preferenceError.hidden = true;
    try {
      const { body } = await post("/api/exports/preview", { copy_preamble: preamble });
      if (generation === preferenceGeneration && input.value === preamble) {
        preview.value = body.text;
        preferenceError.hidden = true;
      }
    } catch (error) {
      if (generation === preferenceGeneration && input.value === preamble)
        showPreferenceError(error);
    }
  });
  save.addEventListener("click", async () => {
    if (save.disabled || !preferences || !etag) return;
    const generation = preferenceGeneration;
    preferencePending = true;
    preferenceError.hidden = true;
    preferenceControls();
    try {
      await request("/api/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "If-Match": etag },
        body: JSON.stringify(
          followDefault ? { reset: ["copy_preamble"] } : { copy_preamble: input.value },
        ),
      });
      if (generation !== preferenceGeneration) return;
      announce("Preamble saved for this user profile.");
      preferencesDialog.close();
    } catch (error) {
      if (generation !== preferenceGeneration) return;
      // A network failure may follow a committed write. Require explicit reload/reconciliation.
      preferenceConflict =
        error instanceof ApiRequestError ? error.code !== "validation_error" : true;
      showPreferenceError(error);
    } finally {
      if (generation === preferenceGeneration) {
        preferencePending = false;
        preferenceControls();
      }
    }
  });
  return { update };
}
