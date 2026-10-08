/** @typedef {{ id: string, name: string, languages: string, language_labels?: string[], download_mb: number, live: boolean, installed: boolean, state: string, message: string }} ModelStatus */
/** @typedef {{ active: string | null, preferred?: string, busy: boolean, models: ModelStatus[] }} ModelsStatus */

/** @param {number} megabytes */
export function downloadSize(megabytes) {
  return megabytes >= 1000 ? `${(megabytes / 1000).toFixed(2)} GB` : `${megabytes} MB`;
}

/** @param {HTMLElement} container @param {ModelStatus | undefined} model */
function renderPills(container, model) {
  container.replaceChildren();
  if (!model) return;
  const labels = [
    ...(model.language_labels ?? [model.languages]),
    model.live ? "Live text" : "After recording",
    `Download: ${downloadSize(model.download_mb)}`,
  ];
  for (const label of labels) {
    const pill = document.createElement("span");
    pill.className = "model-pill";
    pill.textContent = label;
    container.append(pill);
  }
}

/** A model selection is local to the tab until the user presses Use model.
 * @param {(ready: boolean, live: boolean) => void} onChange
 */
export function modelPicker(onChange) {
  const picker = /** @type {HTMLFieldSetElement} */ (document.getElementById("model-picker"));
  const options = /** @type {HTMLElement} */ (document.getElementById("model-options"));
  const summaryName = /** @type {HTMLElement} */ (document.getElementById("model-summary-name"));
  const summaryPills = /** @type {HTMLElement} */ (document.getElementById("model-summary-pills"));
  /** @type {Map<string, HTMLInputElement>} */
  const radios = new Map();
  /** @type {Map<string, HTMLButtonElement>} */
  const downloads = new Map();
  /** @type {Map<string, HTMLElement>} */
  const operationMessages = new Map();
  let choicesSignature = "";
  const button = /** @type {HTMLButtonElement} */ (document.getElementById("model-action"));
  const help = /** @type {HTMLElement} */ (document.getElementById("model-help"));
  const errorMessage = /** @type {HTMLElement} */ (document.getElementById("model-error"));
  const badge = /** @type {HTMLElement} */ (document.getElementById("engine-status"));
  const deleteDialog = /** @type {HTMLDialogElement} */ (
    document.getElementById("model-delete-dialog")
  );
  const deleteDescription = /** @type {HTMLElement} */ (
    document.getElementById("model-delete-description")
  );
  const deleteConfirm = /** @type {HTMLButtonElement} */ (
    document.getElementById("model-delete-confirm")
  );
  const deleteCancel = /** @type {HTMLButtonElement} */ (
    document.getElementById("model-delete-cancel")
  );
  let deleteTarget = "";
  /** @type {ModelsStatus | null} */
  let state = null;
  let selected = "";
  let locked = false;
  let pending = false;
  let polling = false;
  let generation = 0;

  function operationBlocked() {
    return (
      locked ||
      pending ||
      !state ||
      state.busy ||
      state.models.some((item) => ["loading", "downloading", "deleting"].includes(item.state))
    );
  }

  function updateActions() {
    picker.disabled = locked || pending || !state;
    const blocked = operationBlocked();
    const model = state?.models.find((item) => item.id === selected);
    button.disabled = blocked || !model?.installed || model.state === "ready";
    for (const download of downloads.values()) download.disabled = blocked;
    deleteConfirm.disabled =
      blocked || !state?.models.find((item) => item.id === deleteTarget)?.installed;
  }

  function render() {
    const model = state?.models.find((item) => item.id === selected);
    const ready = model?.state === "ready" && state?.active === selected;
    updateActions();
    for (const [id, radio] of radios) radio.checked = id === selected;
    for (const [id, download] of downloads) {
      const item = state?.models.find((item) => item.id === id);
      download.textContent = !item
        ? "Unavailable"
        : item.state === "downloading"
          ? "Downloading…"
          : item?.state === "deleting"
            ? "Deleting…"
            : item?.installed
              ? "Delete download"
              : "Download";
      download.setAttribute("aria-label", `${download.textContent} ${item?.name ?? id}`);
      download.classList.toggle("danger", Boolean(item?.installed));
      const message = operationMessages.get(id);
      if (message) {
        message.hidden = item?.state !== "error";
        message.textContent = item?.state === "error" ? item.message : "";
      }
    }
    summaryName.textContent = model?.name ?? "";
    renderPills(summaryPills, model);
    button.hidden = ready || !model?.installed;
    button.textContent = "Use model";
    help.textContent = model
      ? `${model.languages}. ${model.live ? "Live text available." : "Transcribes after you stop recording."} ${model.message || (model.installed ? "" : "Download once to use offline.")}`
      : "The transcription service is unavailable. Check the server and retry.";
    badge.textContent = model
      ? ready
        ? state?.busy
          ? "Transcribing…"
          : "Ready"
        : model.state === "loading"
          ? "Loading model…"
          : model.state === "downloading"
            ? "Downloading model…"
            : model.state === "deleting"
              ? "Deleting model…"
              : model.state === "error"
                ? "Model needs attention"
                : model.installed
                  ? "Choose Use model"
                  : "Download a model"
      : "Engine unavailable";
    badge.classList.toggle("ready", ready);
    badge.classList.toggle("offline", !state);
    onChange(
      Boolean(
        ready &&
        !state?.busy &&
        !pending &&
        !state?.models.some((item) => item.state === "deleting"),
      ),
      Boolean(model?.live),
    );
  }

  /** @param {ModelsStatus} result */
  function accept(result) {
    state = result;
    if (!selected)
      selected =
        result.active ??
        result.models.find((model) => model.state === "loading")?.id ??
        result.preferred ??
        "phonon-2";
    // Keep the native radio inputs mounted across polls to preserve keyboard focus.
    const signature = JSON.stringify(
      result.models.map(({ id, name, languages, language_labels, live, download_mb }) => ({
        id,
        name,
        languages,
        language_labels,
        live,
        download_mb,
      })),
    );
    if (signature !== choicesSignature) {
      choicesSignature = signature;
      options.replaceChildren();
      radios.clear();
      downloads.clear();
      operationMessages.clear();
      for (const model of result.models) {
        const option = document.createElement("div");
        option.className = "model-option";
        const label = document.createElement("label");
        label.className = "model-choice";
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = "speech-model";
        radio.value = model.id;
        radio.addEventListener("change", () => {
          if (!picker.disabled && radio.checked) {
            selected = model.id;
            errorMessage.hidden = true;
          }
          render();
        });
        const description = document.createElement("span");
        description.className = "model-description";
        const name = document.createElement("span");
        name.className = "model-name";
        name.textContent = model.name;
        const pills = document.createElement("span");
        pills.className = "model-pills";
        renderPills(pills, model);
        description.append(name, pills);
        label.append(radio, description);
        const download = document.createElement("button");
        download.type = "button";
        download.className = "chip model-download";
        download.setAttribute("data-model", model.id);
        download.addEventListener("click", async () => {
          const current = state?.models.find((item) => item.id === model.id);
          if (!current || operationBlocked()) return;
          if (current.installed) {
            deleteTarget = current.id;
            deleteDescription.textContent = `Delete the downloaded files for ${current.name}? If this model is active, it will be unloaded. Your chats and recordings will be kept. You can download the model again later.`;
            updateActions();
            deleteDialog.showModal();
          } else {
            await perform(current.id, "download");
          }
        });
        const message = document.createElement("span");
        message.className = "model-operation-message error";
        message.setAttribute("role", "status");
        option.append(label, download, message);
        options.append(option);
        radios.set(model.id, radio);
        downloads.set(model.id, download);
        operationMessages.set(model.id, message);
      }
    }
    render();
  }

  async function refresh() {
    if (polling || pending) return;
    polling = true;
    const requestGeneration = generation;
    try {
      const response = await fetch("/api/models", { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error("Model service unavailable.");
      const result = await response.json();
      if (requestGeneration === generation) accept(result);
    } catch {
      if (requestGeneration === generation) {
        state = null;
        render();
      }
    } finally {
      polling = false;
    }
  }

  /** @param {string} modelId @param {"download" | "activate" | "delete"} action */
  async function perform(modelId, action) {
    errorMessage.hidden = true;
    pending = true;
    generation++;
    render();
    try {
      const response = await fetch(`/api/models/${encodeURIComponent(modelId)}/${action}`, {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || "The model operation failed. Retry.");
      accept(result);
    } catch (error) {
      errorMessage.textContent =
        error instanceof Error ? error.message : "The model operation failed. Retry.";
      errorMessage.hidden = false;
    } finally {
      pending = false;
      render();
      void refresh();
    }
  }

  button.addEventListener("click", async () => {
    if (!button.disabled) await perform(selected, "activate");
  });
  deleteCancel.addEventListener("click", () => deleteDialog.close());
  deleteConfirm.addEventListener("click", async () => {
    if (deleteConfirm.disabled || !deleteTarget || operationBlocked()) return;
    const modelId = deleteTarget;
    deleteDialog.close();
    await perform(modelId, "delete");
  });
  deleteDialog.addEventListener("close", () => {
    deleteTarget = "";
  });

  return {
    /** @returns {string} */
    selected: () => selected || "phonon-2",
    refresh,
    /** @param {boolean} active */
    lock: (active) => {
      locked = active;
      updateActions();
    },
  };
}
