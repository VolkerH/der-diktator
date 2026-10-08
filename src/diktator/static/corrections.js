import { ApiRequestError } from "./errors.js";
import { request } from "./request.js";

/** @typedef {{text: string, key: number, version: number, active: boolean}} CorrectionSnapshot */
/** @typedef {{snapshot: CorrectionSnapshot, start: number, end: number}} SelectionSnapshot */
/** @typedef {{configured: boolean, model: string|null, languages: string[], default_mode: string, modes: {id: string, label: string}[], max_input_characters: number, timeout_seconds: number}} Capabilities */

/** Exact slicing deliberately adds no spaces and never interprets Markdown as HTML.
 * @param {SelectionSnapshot} selection @param {string} replacement */
export function replaceSelection(selection, replacement) {
  return (
    selection.snapshot.text.slice(0, selection.start) +
    replacement +
    selection.snapshot.text.slice(selection.end)
  );
}

/** A local edit version prevents an edit-then-undo ABA from reviving a preview.
 * @param {CorrectionSnapshot} before @param {CorrectionSnapshot} now */
export function sameDraft(before, now) {
  return (
    !now.active &&
    before.key === now.key &&
    before.version === now.version &&
    before.text === now.text
  );
}

/** Read one finite NDJSON job; deltas never authorize replacement.
 * @param {string} text @param {string} mode @param {AbortSignal} signal
 * @param {(delta: string) => void} onDelta @returns {Promise<string>} */
export async function streamCorrection(text, mode, signal, onDelta) {
  const response = await fetch("/api/corrections", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, mode }),
    signal,
  });
  if (!response.ok) {
    throw new ApiRequestError(await response.json(), "Correction could not start.");
  }
  if (!response.body) throw new Error("The correction stream was missing.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  /** @type {string | null} */
  let completed = null;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      pending += decoder.decode(chunk.value, { stream: true });
      let newline;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (!line.trim()) continue;
        if (completed !== null) throw new Error("Unexpected data after correction completion.");
        const event = JSON.parse(line);
        if (event.type === "error") {
          throw new ApiRequestError(event, "Correction failed.");
        }
        if (typeof event.text !== "string") throw new Error("Invalid correction response.");
        if (event.type === "delta") onDelta(event.text);
        else if (event.type === "done" && event.text.trim()) completed = event.text;
        else throw new Error("Invalid correction response.");
      }
      if (pending.length > 65_536) throw new Error("The correction response exceeded its limit.");
    }
    pending += decoder.decode();
    signal.throwIfAborted();
    if (pending.trim() || completed === null) {
      throw new Error("Correction ended before completion. Select less text and try again.");
    }
    return completed;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Selected-text review UI. Persistence remains in the application's conditional save flow.
 * @param {() => CorrectionSnapshot} snapshot
 * @param {(text: string, start: number, end: number) => void} apply
 * @param {(message: string) => void} announce
 */
export function correctionControls(snapshot, apply, announce) {
  /** @param {string} id */
  const button = (id) => /** @type {HTMLButtonElement} */ (document.getElementById(id));
  /** @param {string} id */
  const area = (id) => /** @type {HTMLTextAreaElement} */ (document.getElementById(id));
  const editor = area("transcript");
  const open = button("correction-open");
  const generate = button("correction-generate");
  const accept = button("correction-accept");
  const undo = button("correction-undo");
  const cancel = button("correction-cancel");
  const original = area("correction-original");
  const proposal = area("correction-proposal");
  const dialog = /** @type {HTMLDialogElement} */ (document.getElementById("correction-dialog"));
  const mode = /** @type {HTMLSelectElement} */ (document.getElementById("correction-mode"));
  const status = /** @type {HTMLElement} */ (document.getElementById("correction-status"));
  const provider = /** @type {HTMLElement} */ (document.getElementById("correction-provider"));
  /** @type {SelectionSnapshot | null} */
  let selection = null;
  /** @type {Capabilities | null} */
  let capabilities = null;
  /** Authoritative string, independent from textarea newline normalization. @type {string | null} */
  let result = null;
  /** @type {AbortController | null} */
  let controller = null;
  let generation = 0;
  /** @type {{before: SelectionSnapshot, after: CorrectionSnapshot} | null} */
  let undoEntry = null;

  function invalidate() {
    generation++;
    controller?.abort();
    controller = null;
    result = null;
    accept.disabled = true;
  }

  function update() {
    const now = snapshot();
    const selected = now.text.slice(editor.selectionStart, editor.selectionEnd);
    open.disabled = now.active || !selected.trim();
    if (selection && !sameDraft(selection.snapshot, now)) {
      invalidate();
      selection = null;
      generate.disabled = true;
      status.textContent = "The draft changed. Close this preview and select the text again.";
    }
    if (undoEntry && !sameDraft(undoEntry.after, now)) undoEntry = null;
    undo.hidden = !undoEntry;
    undo.disabled = !undoEntry;
  }

  async function openPreview() {
    update();
    if (open.disabled) return;
    invalidate();
    const token = generation;
    selection = { snapshot: snapshot(), start: editor.selectionStart, end: editor.selectionEnd };
    original.value = selection.snapshot.text.slice(selection.start, selection.end);
    proposal.value = "";
    capabilities = null;
    mode.replaceChildren();
    mode.disabled = true;
    generate.disabled = true;
    provider.textContent = "Local correction · Preview prototype";
    status.textContent = "Checking correction setup…";
    dialog.showModal();
    try {
      const response = await request("/api/corrections/capabilities");
      if (generation !== token) return;
      capabilities = /** @type {Capabilities} */ (response.body);
      for (const item of capabilities.modes) {
        const option = document.createElement("option");
        option.value = item.id;
        option.textContent = item.label;
        mode.append(option);
      }
      mode.value = capabilities.default_mode;
      mode.disabled = !capabilities.configured;
      const languages = capabilities.languages.length
        ? `Configured languages: ${capabilities.languages.join(", ")}`
        : "Languages not specified by this server";
      provider.textContent = capabilities.configured
        ? `Local model: ${capabilities.model} · ${languages}`
        : "Local correction is not configured";
      const tooLong = [...original.value].length > capabilities.max_input_characters;
      generate.disabled = !capabilities.configured || tooLong;
      status.textContent = !capabilities.configured
        ? "Set DIKTATOR_CORRECTION_URL on the server to enable previews."
        : tooLong
          ? `Select up to ${capabilities.max_input_characters} characters, then reopen this preview.`
          : "Choose an editing style, then generate a preview.";
    } catch (error) {
      if (generation === token) {
        status.textContent = error instanceof Error ? error.message : "Correction setup failed.";
      }
    }
  }

  async function run() {
    update();
    if (!selection || !capabilities?.configured || generate.disabled) return;
    invalidate();
    const token = generation;
    controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout((capabilities.timeout_seconds + 5) * 1000),
    ]);
    generate.disabled = true;
    mode.disabled = true;
    proposal.value = "";
    status.textContent = "Generating… You can cancel at any time.";
    try {
      const selected = selection.snapshot.text.slice(selection.start, selection.end);
      const completed = await streamCorrection(selected, mode.value, signal, (delta) => {
        if (generation === token) proposal.value += delta;
      });
      if (generation !== token) return;
      update();
      if (!selection || generation !== token) return;
      result = completed;
      proposal.value = completed;
      accept.disabled = false;
      status.textContent = "Preview complete. Check every change before accepting.";
    } catch (error) {
      if (generation === token) {
        result = null;
        status.textContent = error instanceof Error ? error.message : "Correction failed.";
      }
    } finally {
      if (generation === token) {
        controller = null;
        generate.disabled = !selection;
        mode.disabled = false;
      }
    }
  }

  open.addEventListener("click", openPreview);
  editor.addEventListener("contextmenu", (event) => {
    update();
    if (open.disabled) return;
    event.preventDefault();
    void openPreview();
  });
  for (const event of ["select", "keyup", "pointerup"]) editor.addEventListener(event, update);
  generate.addEventListener("click", run);
  mode.addEventListener("change", () => {
    invalidate();
    proposal.value = "";
    status.textContent = "Editing style changed. Generate a new preview.";
  });
  accept.addEventListener("click", () => {
    update();
    if (!selection || result === null || accept.disabled) return;
    const before = selection;
    const replacement = result;
    // Detach the preview before the app's apply callback updates its controls.
    selection = null;
    invalidate();
    apply(replaceSelection(before, replacement), before.start, before.start + replacement.length);
    undoEntry = { before, after: snapshot() };
    dialog.close();
    update();
    announce("Correction applied. Undo correction is available until your next edit.");
    editor.focus();
  });
  undo.addEventListener("click", () => {
    update();
    if (!undoEntry) return;
    const before = undoEntry.before;
    undoEntry = null;
    apply(before.snapshot.text, before.start, before.end);
    update();
    announce("Correction undone.");
    editor.focus();
  });
  cancel.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    invalidate();
    selection = null;
    editor.focus();
  });
  window.addEventListener("pagehide", invalidate);
  return { update };
}
