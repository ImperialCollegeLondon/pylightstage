import { readServer } from "./api.js";
import { errorMessage, query } from "./dom.js";

const CHECK_INTERVAL_MS = 3000;

/** Serialize polls and expose the same refresh function to command controls. */
export function installConnectivity(updateCameraMode) {
  const status = query("#service-status");
  const stageMode = query("#stage-mode");
  const dot = query(".mini-status");
  let timer;
  let pending = null;
  let stopped = false;
  let disposed = false;

  function setStatus(state, message, detail = "") {
    status.textContent = message;
    status.dataset.state = state;
    status.title = detail;
    dot.dataset.state = state;
    if (state !== "ready") stageMode.hidden = true;
  }

  async function poll() {
    try {
      const mode = await readServer("get-mode");
      if (stopped) return;
      updateCameraMode(mode);
      setStatus("ready", "Ready", "LightStage server is reachable.");
      stageMode.textContent = mode ? `Mode: ${mode}` : "Mode: idle";
      stageMode.hidden = false;
    } catch (error) {
      if (stopped) return;
      updateCameraMode(null);
      setStatus("error", "Unavailable", errorMessage(error));
    } finally {
      pending = null;
      if (!stopped) timer = window.setTimeout(refresh, CHECK_INTERVAL_MS);
    }
  }

  function refresh() {
    if (stopped) return Promise.resolve();
    if (!pending) {
      window.clearTimeout(timer);
      pending = poll();
    }
    return pending;
  }

  function stop() {
    disposed = true;
    suspend();
  }

  function suspend() {
    stopped = true;
    window.clearTimeout(timer);
  }
  window.addEventListener("pagehide", suspend);
  window.addEventListener("pageshow", () => {
    if (disposed || !stopped) return;
    stopped = false;
    refresh();
  });
  return { refresh, setStatus, stop };
}
