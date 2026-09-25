import { requestMode } from "./api.js";
import { errorMessage, query, queryAll } from "./dom.js";

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
    button.disabled = true;
    status.textContent = "Requesting manual mode…";
    status.dataset.state = "working";
    try {
      await requestMode({ mode: "manual" });
      status.textContent = "Manual mode requested.";
      status.dataset.state = "success";
    } catch (error) {
      status.textContent = errorMessage(error);
      status.dataset.state = "error";
    } finally {
      button.disabled = false;
      await refreshMode();
    }
  });
}
