import { requestMode } from "./api.js";
import { errorMessage, query, queryAll, setStatus } from "./dom.js";

export function installWorkspace(loadSequences, refreshMode, onWorkspaceChange = () => {}) {
  const tabs = queryAll("[role=tab][data-workspace]");
  function activate(tab) {
    const mode = tab.dataset.workspace;
    query(".dashboard").dataset.workspace = mode;
    for (const item of tabs) {
      const selected = item === tab;
      item.classList.toggle("active", selected);
      item.setAttribute("aria-selected", String(selected));
      item.tabIndex = selected ? 0 : -1;
      query(`#${item.getAttribute("aria-controls")}`).hidden = !selected;
    }
    queryAll("[data-manual-controls]").forEach((element) => { element.hidden = mode !== "manual"; });
    query("#ibl-inspector").hidden = mode !== "ibl";
    const ibl = mode === "ibl";
    const layers = query("#fixture-layers");
    const viewSettings = query("#ibl-view-settings");
    layers.hidden = ibl;
    viewSettings.hidden = !ibl;
    (ibl ? viewSettings : layers).append(query("#labels-control"));
    const sequenceWorkspace = mode === "playback" || mode === "olat";
    query("#sequence-inspector").hidden = !sequenceWorkspace;
    const simulationPanel = query("#simulation-panel");
    if (sequenceWorkspace) query("#sequence-inspector").append(simulationPanel);
    else if (mode === "ibl") query("#ibl-inspector").append(simulationPanel);
    else query(".toolbar-left").insertBefore(simulationPanel, query(".camera-control"));
    queryAll("[data-workspace-controls]").forEach((element) => {
      element.hidden = element.dataset.workspaceControls !== mode;
    });
    onWorkspaceChange(mode);
    if (mode === "playback") loadSequences();
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => activate(tab));
    tab.addEventListener("keydown", (event) => {
      let next;
      if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
      if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = tabs.length - 1;
      if (next === undefined) return;
      event.preventDefault();
      tabs[next].focus();
      activate(tabs[next]);
    });
  });
  const button = query("#start-manual");
  const status = query("#manual-status");
  button.addEventListener("click", async () => {
    if (button.disabled) return;
    button.disabled = true;
    setStatus(status, "Requesting manual mode…", "working");
    try {
      await requestMode({ mode: "manual" });
      setStatus(status, "Manual mode requested.", "success");
    } catch (error) {
      setStatus(status, errorMessage(error), "error");
    } finally {
      button.disabled = false;
      await refreshMode();
    }
  });
}
