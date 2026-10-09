import { ApiRequestError } from "./errors.js";
import { request } from "./request.js";

/** @typedef {{text: string, key: number, active: boolean}} DraftSnapshot */
/** @typedef {{copy_preamble: string, copy_preamble_is_default: boolean, share_include_preamble: boolean, default_copy_preamble: string, max_copy_preamble_characters: number, revision: number}} Preferences */

/** Request shared backend formatting/preferences, keeping device access in this client.
 * @param {() => DraftSnapshot} snapshot
 * @param {(message: string) => void} announce
 */
export function exportControls(snapshot, announce) {
  /** @param {string} id */
  const button = (id) => /** @type {HTMLButtonElement} */ (document.getElementById(id));
  /** @param {string} id */
  const area = (id) => /** @type {HTMLTextAreaElement} */ (document.getElementById(id));
  const share = button("share");
  const nativeShare = button("prepared-share");
  const shareHelp = /** @type {HTMLElement} */ (document.getElementById("share-help"));
  const download = button("prepared-download");
  const preparedCopy = button("prepared-copy");
  const includePreamble = /** @type {HTMLInputElement} */ (
    document.getElementById("share-preamble")
  );
  const open = button("preferences-open");
  const settingsShare = /** @type {HTMLInputElement} */ (
    document.getElementById("settings-share-preamble")
  );
  const limits = /** @type {HTMLElement} */ (document.getElementById("settings-limits"));
  for (const [link, target] of [
    ["settings-keyboard", "keyboard-open"],
    ["settings-models", "model-settings-open"],
  ]) {
    button(link).addEventListener("click", () => button(target)?.click());
    const targetDialog = document.getElementById(
      target === "keyboard-open" ? "keyboard-dialog" : "model-settings",
    );
    targetDialog?.addEventListener("close", () => {
      if (preferencesDialog.open) button(link).focus();
    });
  }
  async function loadLimits() {
    limits.textContent = "Loading limits…";
    try {
      const { body } = await request("/api/settings");
      limits.textContent =
        body.limits
          .map(
            /** @param {{label: string, value: number, unit: string}} limit */ (limit) =>
              `${limit.label}: ${limit.value.toLocaleString()} ${limit.unit}`,
          )
          .join(". ") + ".";
    } catch {
      limits.textContent = "Limits could not be loaded. Close and reopen Settings to retry.";
    }
  }
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
  let preparedMediaType = "text/plain";
  let preparationGeneration = 0;
  let sharePending = false;
  /** @type {string | null} */
  let sharePreferenceTag = null;
  /** @type {boolean | null} */
  let savedSharePreamble = null;

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

  function canSharePrepared() {
    if (!window.isSecureContext || typeof navigator.share !== "function") return false;
    try {
      return typeof navigator.canShare !== "function" || navigator.canShare({ text: preparedText });
    } catch {
      return false;
    }
  }

  function preparedControls() {
    const ready = Boolean(preparedSnapshot && current(preparedSnapshot) && !preparing);
    preparedCopy.disabled = !ready;
    download.disabled = !ready;
    includePreamble.disabled = preparing || sharePending || !sharePreferenceTag;
    nativeShare.hidden = typeof navigator.share !== "function";
    shareHelp.hidden = nativeShare.hidden;
    preparedCopy.classList.toggle("accent", nativeShare.hidden);
    nativeShare.disabled = !ready || sharePending || !canSharePrepared();
  }

  function clearPreparation() {
    preparationGeneration++;
    preparing = false;
    sharePending = false;
    sharePreferenceTag = null;
    savedSharePreamble = null;
    preparedSnapshot = null;
    preparedText = "";
    output.value = "";
  }

  function update() {
    const draft = snapshot();
    if (preparedSnapshot && !current(preparedSnapshot)) {
      clearPreparation();
      if (preparedDialog.open) preparedDialog.close();
    }
    share.disabled = preparing || draft.active || !draft.text.trim();
    preparedControls();
  }

  /** Reuse one export request and retained payload for copy, sharing and downloads.
   * @param {"plain" | "with_preamble"} format
   */
  async function prepare(format) {
    const captured = snapshot();
    const generation = ++preparationGeneration;
    preparedSnapshot = null;
    preparedText = "";
    output.value = "";
    preparing = true;
    preparedStatus.textContent = "Preparing your draft…";
    update();
    try {
      const { body } = await post("/api/exports", { text: captured.text, format });
      if (generation !== preparationGeneration || !current(captured)) return;
      preparedSnapshot = captured;
      preparedText = body.text;
      preparedMediaType = body.media_type;
      output.value = preparedText;
      preparedStatus.textContent = canSharePrepared()
        ? "Ready. Choose Share to app, Copy or Download."
        : nativeShare.hidden
          ? "Ready. This browser cannot open a share window, so copy or download the text."
          : "Native sharing is unavailable for this text. Copy or download it instead.";
    } catch (error) {
      if (generation !== preparationGeneration || !current(captured)) return;
      const message = error instanceof Error ? error.message : "Export failed.";
      preparedStatus.textContent = message + " Close and try again.";
    } finally {
      if (generation === preparationGeneration) {
        preparing = false;
        update();
      }
    }
  }

  share.addEventListener("click", async () => {
    update();
    if (share.disabled) return;
    const generation = ++preparationGeneration;
    preparing = true;
    includePreamble.indeterminate = true;
    preparedStatus.textContent = "Loading your sharing preference…";
    preparedDialog.showModal();
    update();
    try {
      const result = await request("/api/preferences");
      if (generation !== preparationGeneration) return;
      savedSharePreamble = result.body.share_include_preamble;
      sharePreferenceTag = result.headers.get("ETag");
      includePreamble.checked = Boolean(savedSharePreamble);
      includePreamble.indeterminate = false;
      await prepare(savedSharePreamble ? "with_preamble" : "plain");
    } catch (error) {
      if (generation !== preparationGeneration) return;
      preparedStatus.textContent =
        (error instanceof Error ? error.message : "Could not load your sharing preference.") +
        " Close and reopen to try again.";
    } finally {
      if (generation === preparationGeneration) {
        preparing = false;
        update();
      }
    }
  });
  includePreamble.addEventListener("change", async () => {
    if (includePreamble.disabled || !preparedDialog.open || !sharePreferenceTag) return;
    const generation = ++preparationGeneration;
    preparing = true;
    preparedStatus.textContent = "Saving your sharing preference…";
    preparedControls();
    try {
      const result = await request("/api/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "If-Match": sharePreferenceTag },
        body: JSON.stringify({ share_include_preamble: includePreamble.checked }),
      });
      if (generation !== preparationGeneration) return;
      savedSharePreamble = result.body.share_include_preamble;
      sharePreferenceTag = result.headers.get("ETag");
      await prepare(savedSharePreamble ? "with_preamble" : "plain");
    } catch (error) {
      if (generation !== preparationGeneration) return;
      // A failed response may follow a committed write. Reload before another change.
      sharePreferenceTag = null;
      includePreamble.checked = Boolean(savedSharePreamble);
      preparedStatus.textContent =
        "Could not save your sharing preference. " +
        (error instanceof Error ? error.message + " " : "") +
        "Prepared text is unchanged. Close and reopen to load the latest preference.";
    } finally {
      if (generation === preparationGeneration) {
        preparing = false;
        update();
      }
    }
  });

  preparedCopy.addEventListener("click", async () => {
    if (!preparedDialog.open || !preparedSnapshot || !current(preparedSnapshot)) return;
    const generation = preparationGeneration;
    const text = preparedText;
    try {
      await navigator.clipboard.writeText(text);
      if (generation === preparationGeneration) {
        preparedStatus.textContent = "Text copied.";
        announce("Prepared text copied.");
      }
    } catch {
      if (generation === preparationGeneration) {
        output.focus();
        output.select();
        preparedStatus.textContent =
          "Text selected. Press Ctrl+C or use your device's Copy command.";
      }
    }
  });

  nativeShare.addEventListener("click", async () => {
    if (
      !preparedDialog.open ||
      nativeShare.disabled ||
      !preparedSnapshot ||
      !current(preparedSnapshot)
    )
      return;
    const generation = preparationGeneration;
    sharePending = true;
    preparedStatus.textContent = "Waiting for the platform share window…";
    preparedControls();
    try {
      // Call immediately in this fresh gesture, before any asynchronous operation.
      await navigator.share({ text: preparedText });
      if (generation === preparationGeneration) {
        preparedStatus.textContent =
          "Handed off to the platform. Destination and delivery are unconfirmed.";
      }
    } catch (error) {
      if (generation !== preparationGeneration) return;
      /** @type {Record<string, string>} */
      const messages = {
        AbortError: "Sharing was cancelled, or no destination was available.",
        InvalidStateError: "Another share window is already open. Finish it, then try again.",
        NotAllowedError: "Platform sharing was not allowed.",
        TypeError: "This browser cannot share the prepared text.",
      };
      const name = error instanceof Error ? error.name : "";
      preparedStatus.textContent =
        (messages[name] ??
          "The share outcome is unknown. Check the destination before sharing again.") +
        " You can copy or download the text.";
    } finally {
      if (generation === preparationGeneration) {
        sharePending = false;
        preparedControls();
      }
    }
  });

  download.addEventListener("click", () => {
    if (!preparedDialog.open || !preparedSnapshot || !current(preparedSnapshot)) return;
    try {
      const file = new Blob([preparedText], { type: preparedMediaType + ";charset=utf-8" });
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = url;
      link.download = preparedMediaType === "text/markdown" ? "dictation.md" : "dictation.txt";
      try {
        link.click();
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      preparedStatus.textContent = "Download requested. Your browser handles saving the file.";
    } catch {
      preparedStatus.textContent =
        "Download could not start. Copy or select the prepared text instead.";
    }
  });
  button("prepared-close").addEventListener("click", () => preparedDialog.close());
  preparedDialog.addEventListener("close", () => {
    clearPreparation();
    update();
  });

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
    settingsShare.disabled = preferencePending || !preferences;
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
      settingsShare.checked = /** @type {Preferences} */ (preferences).share_include_preamble;
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
    void loadLimits();
  });
  button("preferences-cancel").addEventListener("click", () => preferencesDialog.close());
  preferencesDialog.addEventListener("close", () => {
    preferenceGeneration++;
    preferencePending = false;
    open.focus();
  });
  reload.addEventListener("click", () => {
    if (window.confirm("Replace your unsaved settings with the latest saved preferences?"))
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
        body: JSON.stringify({
          ...(followDefault ? { reset: ["copy_preamble"] } : { copy_preamble: input.value }),
          share_include_preamble: settingsShare.checked,
        }),
      });
      if (generation !== preferenceGeneration) return;
      announce("Settings saved for the shared local profile.");
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
