import { requestMode } from "./api.js";
import { errorMessage, query, queryAll, setPressed } from "./dom.js";

export function installCapture(refreshMode) {
  const panel = query("#capture-panel");
  const form = query("#capture-form");
  const rate = query("#capture-hz");
  const status = query("#capture-status");
  const tabs = queryAll("[data-workspace]");
  let busy = false;

  tabs.forEach((tab) => tab.addEventListener("click", () => {
    const capture = tab.dataset.workspace === "capture";
    panel.hidden = !capture;
    queryAll("[data-scene-controls]").forEach((section) => { section.hidden = capture; });
    setPressed(tabs, "workspace", tab.dataset.workspace);
  }));

  function validateRate() {
    rate.setCustomValidity(Number.isFinite(rate.valueAsNumber) && rate.valueAsNumber > 0
      ? "" : "Enter a positive, finite capture rate.");
  }
  rate.addEventListener("input", validateRate);

  async function changeMode(mode) {
    if (busy) return;
    if (mode === "olat") {
      validateRate();
      if (!form.reportValidity()) return;
    }
    busy = true;
    form.setAttribute("aria-busy", "true");
    form.querySelectorAll("button, input").forEach((control) => { control.disabled = true; });
    status.textContent = mode === "olat" ? "Requesting OLAT…" : "Requesting manual mode…";
    status.dataset.state = "working";
    try {
      await requestMode(mode === "olat" ? { mode, capture_hz: rate.valueAsNumber } : { mode });
      status.textContent = mode === "olat" ? "OLAT requested." : "Manual mode requested.";
      status.dataset.state = "success";
    } catch (error) {
      status.textContent = `${errorMessage(error)} Check the current stage mode before retrying.`;
      status.dataset.state = "error";
    } finally {
      busy = false;
      form.removeAttribute("aria-busy");
      form.querySelectorAll("button, input").forEach((control) => { control.disabled = false; });
      await refreshMode();
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    changeMode("olat");
  });
  query("#capture-manual").addEventListener("click", () => changeMode("manual"));
}
