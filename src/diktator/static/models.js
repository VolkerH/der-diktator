/** @typedef {{ id: string, name: string, languages: string, download_mb: number, live: boolean, installed: boolean, state: string, message: string }} ModelStatus */
/** @typedef {{ active: string | null, preferred?: string, busy: boolean, models: ModelStatus[] }} ModelsStatus */

/** A model selection is local to the tab until the user presses Use model.
 * @param {(ready: boolean, live: boolean) => void} onChange
 * @param {(error: unknown) => void} onError
 */
export function modelPicker(onChange, onError) {
  const select = /** @type {HTMLSelectElement} */ (document.getElementById("model-picker"));
  const button = /** @type {HTMLButtonElement} */ (document.getElementById("model-action"));
  const help = /** @type {HTMLElement} */ (document.getElementById("model-help"));
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
    select.disabled = locked || pending || !state;
    button.disabled = locked || pending || working || Boolean(state?.busy) || ready || !model;
    button.hidden = ready;
    button.textContent = model?.installed
      ? "Use model"
      : `Download (${model?.download_mb ?? "…"} MB)`;
    help.textContent = model
      ? `${model.languages}. ${model.live ? "Live text available." : "Transcribes after you stop recording."} ${model.message || (model.installed ? "" : "Download once to use offline.")}`
      : "The transcription service is unavailable. Check the server and retry.";
    badge.textContent = model
      ? ready
        ? `${model.name} ${state?.busy ? "busy" : "ready"}`
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
    select.replaceChildren();
    for (const model of result.models) {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = `${model.name} · ${model.languages}`;
      select.append(option);
    }
    select.value = selected;
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

  select.addEventListener("change", () => {
    if (locked || pending) {
      select.value = selected;
      return;
    }
    selected = select.value;
    render();
  });
  button.addEventListener("click", async () => {
    const model = state?.models.find((item) => item.id === selected);
    if (!model || button.disabled) return;
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
      onError(error);
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
      select.disabled = active || pending || !state;
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
