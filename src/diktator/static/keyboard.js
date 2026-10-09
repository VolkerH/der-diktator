import { ApiRequestError } from "./errors.js";
import { request } from "./request.js";

/** @typedef {{id: string, label: string, default_binding: string | null}} KeyboardAction */
/** @typedef {{keyboard_bindings: Record<string, string | null>, default_keyboard_bindings: Record<string, string | null>, keyboard_actions: KeyboardAction[], keyboard_bindings_is_default: boolean, keyboard_binding_pattern: string}} KeyboardPreferences */

/** Normalize physical digits (Shift changes their printed character) and letter keys.
 * Control stays Control on every platform; AltGr/composition are ignored.
 * @param {KeyboardEvent} event
 * @returns {string | null}
 */
export function eventBinding(event) {
  if (event.repeat || event.isComposing || event.altKey || event.getModifierState?.("AltGraph"))
    return null;
  if (!event.shiftKey || !event.ctrlKey || event.metaKey) return null;
  const key = /^Digit[0-9]$/.test(event.code)
    ? event.code.slice(-1)
    : event.key.length === 1
      ? event.key.toUpperCase()
      : event.key;
  return `Ctrl+Shift+${key}`;
}

/** Preserve a keyboard user's logical control when lists are rebuilt.
 * @param {HTMLElement} container @returns {() => void}
 */
export function preserveFocus(container) {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !container.contains(active)) return () => {};
  const controls = [...container.querySelectorAll("button, summary, input, select, textarea")];
  const index = controls.indexOf(active);
  const chat = active.closest("[data-chat-id]")?.getAttribute("data-chat-id");
  const group = active.closest(".chat-group")?.querySelector(".group-chats")?.id;
  const className = active.className;
  const control = active.getAttribute("aria-controls");
  return () => {
    if (active.isConnected) return;
    const next = [...container.querySelectorAll("button, summary, input, select, textarea")];
    const matching = next.find((node) =>
      chat
        ? node.closest("[data-chat-id]")?.getAttribute("data-chat-id") === chat &&
          node.className === className
        : control
          ? node.getAttribute("aria-controls") === control
          : group
            ? node.closest(".chat-group")?.querySelector(".group-chats")?.id === group &&
              node.className === className
            : node.className === className &&
              node.getAttribute("aria-label") === active.getAttribute("aria-label"),
    );
    const target = matching ?? next[Math.min(index, next.length - 1)];
    if (target instanceof HTMLElement && !target.closest("[hidden]")) target.focus();
  };
}

/** Shared preference contract, client-owned event dispatch and settings presentation.
 * @param {Record<string, () => void>} actions
 */
export function keyboardControls(actions) {
  const dialog = /** @type {HTMLDialogElement} */ (document.getElementById("keyboard-dialog"));
  const rows = /** @type {HTMLElement} */ (document.getElementById("keyboard-bindings"));
  const message = /** @type {HTMLElement} */ (document.getElementById("keyboard-status"));
  const save = /** @type {HTMLButtonElement} */ (document.getElementById("keyboard-save"));
  const reset = /** @type {HTMLButtonElement} */ (document.getElementById("keyboard-reset"));
  const reload = /** @type {HTMLButtonElement} */ (document.getElementById("keyboard-reload"));
  /** @type {KeyboardPreferences | null} */
  let preferences = null;
  /** @type {string | null} */
  let etag = null;
  /** @type {Map<string, HTMLInputElement>} */
  const inputs = new Map();
  let pending = false;
  let writing = false;
  let conflicted = false;
  let followDefault = false;
  let generation = 0;

  function controls() {
    save.disabled = pending || !etag || conflicted;
    reset.disabled = pending || !etag;
    reload.hidden = !conflicted;
    reload.disabled = pending;
    for (const input of inputs.values()) input.disabled = pending;
  }

  function render() {
    if (!preferences) return;
    inputs.clear();
    rows.replaceChildren();
    for (const action of preferences.keyboard_actions) {
      const label = document.createElement("label");
      label.className = "keyboard-row";
      const name = document.createElement("span");
      name.textContent = action.label;
      const input = document.createElement("input");
      input.id = `keyboard-${action.id}`;
      input.type = "text";
      input.autocomplete = "off";
      input.spellcheck = false;
      input.maxLength = 32;
      input.value = preferences.keyboard_bindings[action.id] ?? "";
      input.placeholder = "Disabled";
      input.setAttribute("aria-describedby", "keyboard-format");
      input.addEventListener("input", () => {
        followDefault = false;
      });
      label.append(name, input);
      rows.append(label);
      inputs.set(action.id, input);
    }
    controls();
  }

  /** @param {boolean} show */
  async function load(show = false) {
    // A save owns its draft, ETag and pending controls until it settles. A focus
    // refresh or reopen must not read a pre-save representation over its result.
    if (writing) return;
    const ownGeneration = ++generation;
    pending = true;
    if (show) message.textContent = "Loading saved bindings…";
    controls();
    try {
      const response = await request("/api/preferences");
      if (ownGeneration !== generation) return;
      preferences = response.body;
      etag = response.headers.get("ETag");
      conflicted = false;
      followDefault = false;
      if (show) {
        render();
        message.textContent = "Saved on this server for all your devices.";
      }
    } catch (error) {
      if (ownGeneration !== generation) return;
      conflicted = true;
      message.textContent =
        (error instanceof Error ? error.message : "Bindings unavailable.") +
        " Use Load latest to retry.";
    } finally {
      if (ownGeneration === generation) {
        pending = false;
        controls();
      }
    }
  }

  function open() {
    if (!dialog.open) dialog.showModal();
    void load(true);
  }
  document.getElementById("keyboard-open")?.addEventListener("click", open);
  document.getElementById("keyboard-close")?.addEventListener("click", () => dialog.close());
  reload.addEventListener("click", () => void load(true));
  reset.addEventListener("click", () => {
    if (!preferences) return;
    for (const [id, input] of inputs) input.value = preferences.default_keyboard_bindings[id] ?? "";
    followDefault = true;
    message.textContent = "Defaults selected. Save to follow this server's defaults.";
  });
  save.addEventListener("click", async () => {
    if (pending || !etag || conflicted) return;
    const bindings = Object.fromEntries(
      [...inputs].map(([id, input]) => [id, input.value.trim() || null]),
    );
    writing = true;
    ++generation;
    pending = true;
    controls();
    message.textContent = "Saving…";
    try {
      const response = await request("/api/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "If-Match": etag },
        body: JSON.stringify(
          followDefault ? { reset: ["keyboard_bindings"] } : { keyboard_bindings: bindings },
        ),
      });
      preferences = response.body;
      etag = response.headers.get("ETag");
      message.textContent = "Keyboard shortcuts saved.";
      followDefault = false;
    } catch (error) {
      // Retain the complete draft, including on stale ETags or uncertain writes.
      const code = /** @type {{code?: string}} */ (error).code;
      conflicted = code === "revision_conflict" || code === "persistence_failed" || !code;
      const detail =
        error instanceof ApiRequestError && error.validationMessages.length
          ? error.validationMessages.join(" ")
          : error instanceof Error
            ? error.message
            : "Save failed.";
      message.textContent =
        detail +
        (conflicted
          ? " Your changes are kept. Load latest before retrying."
          : " Your changes are kept.");
    } finally {
      writing = false;
      pending = false;
      controls();
    }
  });

  window.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || document.querySelector("dialog[open]")) return;
    const binding = eventBinding(event);
    if (!binding || !preferences) return;
    // Control+Shift+arrows belong to native text selection inside editors.
    if (
      binding.includes("Arrow") &&
      event.target instanceof HTMLElement &&
      event.target.closest("input, textarea, [contenteditable]")
    )
      return;
    const id = Object.keys(preferences.keyboard_bindings).find(
      (id) => preferences?.keyboard_bindings[id] === binding,
    );
    if (!id) return;
    const action = id === "keyboard_help" ? open : actions[id];
    if (!action) return;
    event.preventDefault();
    action();
  });
  // Re-read after other clients/settings have changed preferences. No draft is
  // replaced while this editor is open; it retains its original ETag for conflicts.
  window.addEventListener("focus", () => {
    if (!dialog.open) void load();
  });
  void load();
  return { open };
}
