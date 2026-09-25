import { readServer, sequenceRequest } from "./api.js";
import { errorMessage, query } from "./dom.js";

export function installSequences(refreshMode) {
  const panel = query("#playback-panel");
  const list = query("#sequence-list");
  const status = query("#sequence-status");
  const fileInput = query("#sequence-file");
  let busy = false;

  function message(text, state = "success") {
    status.textContent = text;
    status.dataset.state = state;
  }

  async function run(task) {
    if (busy) return;
    busy = true;
    panel.setAttribute("aria-busy", "true");
    const disableControls = () => panel.querySelectorAll("button").forEach((button) => { button.disabled = busy; });
    disableControls();
    try {
      await task();
    } catch (error) {
      message(errorMessage(error), "error");
    } finally {
      busy = false;
      panel.removeAttribute("aria-busy");
      disableControls();
    }
  }

  async function refresh() {
    const sequences = await readServer("list-sequences");
    if (!Array.isArray(sequences)) throw new Error("Server returned an invalid sequence list.");
    const rows = document.createDocumentFragment();
    for (const sequence of sequences) {
      const row = document.createElement("li");
      const info = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = sequence.name;
      const metadata = document.createElement("small");
      metadata.textContent = `${sequence.total_frames} frames · ${sequence.capture_hz} Hz · ${Number(sequence.duration_secs).toFixed(2)} s`;
      const id = document.createElement("small");
      id.className = "sequence-id";
      id.textContent = sequence.id;
      info.append(name, metadata, id);
      const actions = document.createElement("div");
      actions.className = "sequence-actions";
      for (const action of ["play", "delete"]) {
        const button = document.createElement("button");
        button.type = "button";
        button.disabled = busy;
        button.className = `sequence-button ${action === "play" ? "primary-button" : "danger-button"}`;
        button.textContent = action === "play" ? "Play" : "Delete";
        button.setAttribute("aria-label", `${button.textContent} ${sequence.name}`);
        button.addEventListener("click", () => {
          if (busy) return;
          if (action === "delete" && !window.confirm(`Delete “${sequence.name}” from the stage? This cannot be undone.`)) return;
          run(async () => {
            message(action === "play" ? "Starting playback…" : "Deleting…", "working");
            await sequenceRequest({ action, id: sequence.id });
            message(action === "play" ? `Playback requested: ${sequence.name}` : `Deleted: ${sequence.name}`);
            await refreshMode();
            if (action === "delete") await refresh();
          });
        });
        actions.append(button);
      }
      row.append(info, actions);
      rows.append(row);
    }
    if (!rows.children.length) {
      const empty = document.createElement("li");
      empty.textContent = "No sequences yet. Import a file to get started.";
      rows.append(empty);
    }
    list.replaceChildren(rows);
  }

  function load() {
    return run(async () => {
      message("Loading sequences…", "working");
      await refresh();
      message("Library refreshed.");
    });
  }
  query("#refresh-sequences").addEventListener("click", load);
  query("#import-sequence").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    fileInput.value = "";
    if (!file) return;
    run(async () => {
      if (!file.size || file.size > 64 * 1024 * 1024) throw new Error("Choose a file between 1 byte and 64 MiB.");
      message(`Importing ${file.name}…`, "working");
      await sequenceRequest(null, file);
      message(`Imported ${file.name}.`);
      await refresh();
    });
  });
  query("#manual-mode").addEventListener("click", () => run(async () => {
    message("Switching to manual…", "working");
    await sequenceRequest({ action: "manual" });
    message("Manual mode requested.");
    await refreshMode();
  }));
  return load;
}
