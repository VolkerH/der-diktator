import { ApiRequestError } from "./errors.js";

/** @typedef {import("./groups.js").Group} Group */
/** @typedef {import("./chats.js").ChatSummary} ChatSummary */
/** @typedef {{newChat: (groupId: string | null) => Promise<void>, rename: (group: Group, name: string) => Promise<void>, create: (id: string, name: string) => Promise<void>, remove: (group: Group) => Promise<void>, move: (chat: ChatSummary, groupId: string | null) => Promise<void>, render: () => void}} Actions */

/** @param {string} tag @param {string} className @param {string} [text] */
function node(tag, className, text = "") {
  const result = document.createElement(tag);
  result.className = className;
  result.textContent = text;
  return result;
}

/** Presentation only: private placement and group validation come from the API. */
export class GroupSidebar {
  /** @param {HTMLElement} list @param {Actions} actions */
  constructor(list, actions) {
    this.list = list;
    this.actions = actions;
    /** @type {Group[]} */
    this.groups = [];
    /** @type {Set<string>} */
    this.folds = new Set();
    try {
      const saved = JSON.parse(localStorage.getItem("diktator.group-folds") ?? "[]");
      if (Array.isArray(saved)) this.folds = new Set(saved.filter((id) => typeof id === "string"));
    } catch {
      /* Folding works even when storage is unavailable or malformed. */
    }
    /** @type {HTMLButtonElement[]} */
    this.buttons = [];
    this.locked = false;
    this.saving = false;
    /** @type {Group | null} */
    this.nameTarget = null;
    /** @type {{id: string, name: string} | null} */
    this.creation = null;
    /** @type {ChatSummary | null} */
    this.moveTarget = null;
    this.newGroup = /** @type {HTMLButtonElement} */ (document.getElementById("new-group"));
    this.nameDialog = /** @type {HTMLDialogElement} */ (document.getElementById("group-editor"));
    this.nameHeading = /** @type {HTMLElement} */ (document.getElementById("group-editor-heading"));
    this.nameInput = /** @type {HTMLInputElement} */ (document.getElementById("group-name-input"));
    this.nameError = /** @type {HTMLElement} */ (document.getElementById("group-name-error"));
    this.nameSave = /** @type {HTMLButtonElement} */ (document.getElementById("group-name-save"));
    this.nameCancel = /** @type {HTMLButtonElement} */ (
      document.getElementById("group-name-cancel")
    );
    this.moveDialog = /** @type {HTMLDialogElement} */ (document.getElementById("group-move"));
    this.moveSelect = /** @type {HTMLSelectElement} */ (
      document.getElementById("group-move-select")
    );
    this.moveError = /** @type {HTMLElement} */ (document.getElementById("group-move-error"));
    this.moveSave = /** @type {HTMLButtonElement} */ (document.getElementById("group-move-save"));
    this.moveCancel = /** @type {HTMLButtonElement} */ (
      document.getElementById("group-move-cancel")
    );
    this.newGroup.addEventListener("click", () => this.editName(null));
    document.getElementById("group-name-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.saveName();
    });
    document.getElementById("group-move-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.saveMove();
    });
    this.nameCancel.addEventListener("click", () => this.nameDialog.close());
    this.moveCancel.addEventListener("click", () => this.moveDialog.close());
    for (const dialog of [this.nameDialog, this.moveDialog]) {
      dialog.addEventListener("cancel", (event) => {
        if (this.saving) event.preventDefault();
      });
    }
  }

  /** @param {boolean} active */
  lock(active) {
    this.locked = active;
    this.newGroup.disabled = active;
    for (const button of this.buttons) button.disabled = active;
  }

  /** @param {string} label @param {() => void} action @param {string} [className] */
  button(label, action, className = "group-action") {
    const button = /** @type {HTMLButtonElement} */ (node("button", className, label));
    button.type = "button";
    button.disabled = this.locked;
    button.addEventListener("click", () => {
      if (!this.locked) action();
    });
    this.buttons.push(button);
    return button;
  }

  /** @param {Group[]} groups @param {ChatSummary[]} chats @param {string | null} draftGroup @param {boolean} draft @param {boolean} searching @param {(summary: ChatSummary | null) => HTMLElement} item */
  render(groups, chats, draftGroup, draft, searching, item) {
    this.groups = groups;
    this.buttons = [];
    const visibleGroups = [...groups];
    // Group and chat lists are independent snapshots. Keep chats visible when a
    // newer placement refers to a group absent from the group-list observation.
    const observedIds = new Set(groups.map((group) => group.id));
    const unknownIds = new Set(chats.map((chat) => chat.group_id));
    if (draft) unknownIds.add(draftGroup);
    for (const id of unknownIds)
      if (id && !observedIds.has(id))
        visibleGroups.push({ id, name: "Unavailable group", created: "", revision: 0, etag: "" });
    const sections = [null, ...visibleGroups]
      .map((group) => {
        const groupId = group?.id ?? null;
        const members = chats.filter((chat) => chat.group_id === groupId);
        const hasDraft = draft && draftGroup === groupId && !searching;
        if (searching && !members.length) return null;
        const name = group?.name ?? "Unsorted";
        const key = groupId ?? "unsorted";
        const section = node("li", "chat-group");
        const header = node("div", "group-header");
        const content = node("ul", "group-chats");
        content.id = `group-chats-${key}`;
        content.setAttribute("aria-label", `${name} chats`);
        const expanded = searching || !this.folds.has(key);
        content.hidden = !expanded;
        const fold = /** @type {HTMLButtonElement} */ (node("button", "group-fold", name));
        fold.type = "button";
        fold.setAttribute("aria-label", `${expanded ? "Collapse" : "Expand"} ${name}`);
        fold.setAttribute("aria-expanded", String(expanded));
        fold.setAttribute("aria-controls", content.id);
        // Search expansions never overwrite the user's regular folds.
        fold.disabled = searching;
        fold.addEventListener("click", () => {
          if (searching) return;
          if (this.folds.has(key)) this.folds.delete(key);
          else this.folds.add(key);
          try {
            localStorage.setItem("diktator.group-folds", JSON.stringify([...this.folds]));
          } catch {
            /* Local presentation remains usable. */
          }
          this.actions.render();
        });
        const add = this.button("+", () => void this.actions.newChat(groupId), "group-add");
        add.setAttribute("aria-label", `New chat in ${name}`);
        header.append(fold);
        if (!group || groups.includes(group)) header.append(add);
        if (group && groups.includes(group)) {
          const menu = node("details", "group-menu");
          const toggle = node("summary", "group-menu-toggle", "⋯");
          toggle.setAttribute("aria-label", `Actions for ${name}`);
          const choices = node("div", "group-menu-actions");
          choices.append(
            this.button("Rename", () => this.editName(group)),
            this.button("Delete", () => void this.remove(group)),
          );
          menu.append(toggle, choices);
          header.append(menu);
        }
        if (hasDraft) content.append(item(null));
        content.append(...members.map(item));
        section.append(header, content);
        return section;
      })
      .filter((section) => section !== null);
    this.list.replaceChildren(...sections);
  }

  /** @param {Group | null} group */
  editName(group) {
    if (this.locked) return;
    this.nameTarget = group ? { ...group } : null;
    this.creation = null;
    this.nameHeading.textContent = group ? "Rename group" : "New group";
    this.nameInput.value = group?.name ?? "";
    this.nameInput.readOnly = false;
    this.nameError.hidden = true;
    this.nameDialog.showModal();
    this.nameInput.focus();
    this.nameInput.select();
  }

  async saveName() {
    if (this.saving || this.locked) return;
    this.saving = true;
    this.nameSave.disabled = this.nameCancel.disabled = true;
    this.nameError.hidden = true;
    try {
      if (this.nameTarget) await this.actions.rename(this.nameTarget, this.nameInput.value);
      else {
        this.creation ??= {
          id: crypto.randomUUID().replaceAll("-", ""),
          name: this.nameInput.value,
        };
        await this.actions.create(this.creation.id, this.creation.name);
      }
      this.nameDialog.close();
    } catch (error) {
      this.nameError.textContent =
        error instanceof Error ? error.message : "The group could not be saved.";
      this.nameError.hidden = false;
      if (this.nameTarget) {
        const current = this.groups.find((group) => group.id === this.nameTarget?.id);
        if (current) this.nameTarget = { ...current };
      } else {
        if (
          error instanceof ApiRequestError &&
          ["invalid_group_name", "invalid_request"].includes(error.code ?? "")
        )
          this.creation = null;
        this.nameInput.readOnly = this.creation !== null;
        if (this.creation)
          this.nameError.textContent +=
            " Retry to create the original name, or cancel and review the groups.";
      }
    } finally {
      this.saving = false;
      this.nameSave.disabled = this.nameCancel.disabled = false;
    }
  }

  /** @param {Group} group */
  async remove(group) {
    if (
      this.locked ||
      !window.confirm(
        `Delete “${group.name}”? Its chats will move to Unsorted. Chats and recordings will be kept.`,
      )
    )
      return;
    try {
      await this.actions.remove(group);
    } catch {
      /* The application displays the operation error. */
    }
  }

  /** @param {ChatSummary} chat */
  editMove(chat) {
    if (this.locked) return;
    this.moveTarget = { ...chat };
    const options = [null, ...this.groups].map((group) => {
      const option = node("option", "", group?.name ?? "Unsorted");
      option.setAttribute("value", group?.id ?? "");
      return option;
    });
    this.moveSelect.replaceChildren(...options);
    this.moveSelect.value = chat.group_id ?? "";
    this.moveError.hidden = true;
    this.moveDialog.showModal();
    this.moveSelect.focus();
  }

  async saveMove() {
    if (this.saving || this.locked || !this.moveTarget) return;
    this.saving = true;
    this.moveSave.disabled = this.moveCancel.disabled = this.moveSelect.disabled = true;
    this.moveError.hidden = true;
    try {
      await this.actions.move(this.moveTarget, this.moveSelect.value || null);
      this.moveDialog.close();
    } catch (error) {
      this.moveError.textContent =
        error instanceof Error ? error.message : "The chat could not be moved.";
      this.moveError.hidden = false;
      // Keep the dialog's chosen target. A refreshed validator permits an explicit retry.
    } finally {
      this.saving = false;
      this.moveSave.disabled = this.moveCancel.disabled = this.moveSelect.disabled = false;
    }
  }
}
