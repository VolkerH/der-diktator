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
  let choicesSignature = "";
  const button = /** @type {HTMLButtonElement} */ (document.getElementById("model-action"));
  const help = /** @type {HTMLElement} */ (document.getElementById("model-help"));
  const errorMessage = /** @type {HTMLElement} */ (document.getElementById("model-error"));
  const badge = /** @type {HTMLElement} */ (document.getElementById("engine-status"));
  /** @type {ModelsStatus | null} */
  let state = null;
  let selected = "";
  let locked = false;
  let pending = false;
  let polling = false;
  let generation = 0;

  function render() {
    const model = state?.models.find((item) => item.id === selected);
    const working = Boolean(
      state?.models.some((item) => ["loading", "downloading"].includes(item.state)),
    );
    const ready = model?.state === "ready" && state?.active === selected;
    picker.disabled = locked || pending || !state;
    for (const [id, radio] of radios) radio.checked = id === selected;
    summaryName.textContent = model?.name ?? "";
    renderPills(summaryPills, model);
    button.disabled = locked || pending || working || Boolean(state?.busy) || ready || !model;
    button.hidden = ready;
    button.textContent = model?.installed
      ? "Use model"
      : model
        ? `Download (${downloadSize(model.download_mb)})`
        : "Download model";
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
            : model.state === "error"
              ? "Model needs attention"
              : model.installed
                ? "Choose Use model"
                : "Download a model"
      : "Engine unavailable";
    badge.classList.toggle("ready", ready);
    badge.classList.toggle("offline", !state);
    onChange(Boolean(ready && !state?.busy), Boolean(model?.live));
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
      for (const model of result.models) {
        const option = document.createElement("label");
        option.className = "model-option";
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
        option.append(radio, description);
        options.append(option);
        radios.set(model.id, radio);
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

  button.addEventListener("click", async () => {
    const model = state?.models.find((item) => item.id === selected);
    if (!model || button.disabled) return;
    errorMessage.hidden = true;
    pending = true;
    generation++;
    render();
    try {
      const action = model.installed ? "activate" : "download";
      const response = await fetch(`/api/models/${encodeURIComponent(selected)}/${action}`, {
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
  });

  return {
    /** @returns {string} */
    selected: () => selected || "phonon-2",
    refresh,
    /** @param {boolean} active */
    lock: (active) => {
      locked = active;
      picker.disabled = active || pending || !state;
      const model = state?.models.find((item) => item.id === selected);
      button.disabled =
        active ||
        pending ||
        !model ||
        Boolean(state?.busy) ||
        model.state === "ready" ||
        Boolean(state?.models.some((item) => ["loading", "downloading"].includes(item.state)));
    },
  };
}
