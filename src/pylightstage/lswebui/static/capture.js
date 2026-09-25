import { requestMode, triggerCamera } from "./api.js";
import { errorMessage, query } from "./dom.js";

export function installCapture(refreshMode) {
  const form = query("#capture-form");
  const rate = query("#capture-hz");
  const status = query("#capture-status");
  let busy = false;

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

export function installCameraCapture() {
  const form = query("#camera-interval-form");
  const interval = query("#camera-interval");
  const trigger = query("#camera-trigger");
  const start = query("#camera-start");
  const stop = query("#camera-stop");
  const status = query("#camera-status");
  let running = false;
  let busy = false;
  let timer;
  let generation = 0;

  function updateControls() {
    trigger.disabled = busy || running;
    start.disabled = busy || running;
    interval.disabled = running;
    stop.disabled = !running;
  }

  function stopCaptures(message = "Automatic capture stopped.") {
    running = false;
    generation += 1;
    window.clearTimeout(timer);
    status.textContent = message;
    status.dataset.state = "";
    updateControls();
  }

  async function capture() {
    if (busy) return;
    busy = true;
    const startedGeneration = generation;
    updateControls();
    status.textContent = "Capturing…";
    status.dataset.state = "working";
    try {
      await triggerCamera();
      if (startedGeneration !== generation) return;
      status.textContent = running
        ? `Capture triggered. Next capture in ${interval.valueAsNumber} seconds.`
        : "Capture triggered.";
      status.dataset.state = "success";
      if (running) timer = window.setTimeout(capture, interval.valueAsNumber * 1000);
    } catch (error) {
      stopCaptures(`${errorMessage(error)} Automatic capture is stopped. Check that the stage is in Manual mode before retrying.`);
      status.dataset.state = "error";
    } finally {
      busy = false;
      updateControls();
    }
  }

  function validateInterval() {
    const value = interval.valueAsNumber;
    interval.setCustomValidity(Number.isFinite(value) && value >= 0.1 && value <= 86400
      ? "" : "Enter an interval between 0.1 and 86400 seconds.");
  }
  interval.addEventListener("input", validateInterval);
  trigger.addEventListener("click", capture);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    validateInterval();
    if (busy || running || !form.reportValidity()) return;
    running = true;
    capture();
  });
  stop.addEventListener("click", () => stopCaptures());
  window.addEventListener("pagehide", () => stopCaptures());
  return (mode) => {
    if (running && mode !== "Manual") stopCaptures("Automatic capture stopped: Manual mode is unavailable.");
  };
}
