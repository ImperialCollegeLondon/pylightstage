import { loadConfiguration, readServer } from "./api.js";
import { camera, installCameraControls, pickFixture } from "./camera.js";
import { errorMessage, query, queryAll, setPressed } from "./dom.js";
import { installFixtureControls } from "./fixture-controls.js";
import { installSimulation } from "./simulation.js";
import { installSequences } from "./sequences.js";
import { installIBL } from "./ibl.js";
import { installWorkspace } from "./workspace.js";
import { installCapture, installCameraCapture } from "./capture.js";
import { Canvas2DRenderer } from "./renderers/canvas2d.js";
import { WebGPURenderer } from "./renderers/webgpu.js";
import { StageLabels } from "./renderers/labels.js";
import { StageScene } from "./scene.js";

const canvas = query("#stage-view");
const gridCanvas = query("#grid-view");
const canvasShell = query("#canvas-shell");
const backend = query("#renderer-backend");
const endpoint = query("#stage-endpoint");
const status = query("#service-status");
const stageMode = query("#stage-mode");
const connectionStatusDot = query(".mini-status");
const fallbackNote = query("#fallback-note");
const viewButtons = queryAll("[data-view]");
const modeButtons = queryAll(".view-mode-switch [data-mode]");
let activeMode = "3d";
const updateCameraMode = installCameraCapture();

const CONNECTIVITY_CHECK_INTERVAL_MS = 3000;

function setConnectivityStatus(state, message, detail = "") {
  status.textContent = message;
  status.dataset.state = state;
  status.title = detail;
  connectionStatusDot.dataset.state = state;
  if (state !== "ready") stageMode.hidden = true;
}

let connectivityTimer;
let connectivityPending = false;
async function checkConnectivity() {
  if (connectivityPending) return;
  connectivityPending = true;
  window.clearTimeout(connectivityTimer);
  try {
    const mode = await readServer("get-mode");
    updateCameraMode(mode);
    setConnectivityStatus("ready", "Ready", "LightStage server is reachable.");
    stageMode.textContent = mode ? `Mode: ${mode}` : "Mode: idle";
    stageMode.hidden = false;
  } catch (error) {
    updateCameraMode(null);
    setConnectivityStatus("error", "Unavailable", errorMessage(error));
  } finally {
    connectivityPending = false;
    connectivityTimer = window.setTimeout(checkConnectivity, CONNECTIVITY_CHECK_INTERVAL_MS);
  }
}

async function createRenderers() {
  const renderers = { grid: new Canvas2DRenderer(gridCanvas), webgpu: null };
  if (!navigator.gpu) return renderers;
  try {
    renderers.webgpu = await WebGPURenderer.create(canvas);
  } catch (error) {
    console.warn("WebGPU initialization failed; using the 2D grid", error);
  }
  return renderers;
}

function setMode(mode, renderers) {
  if (mode === "3d" && !renderers.webgpu) return;
  activeMode = mode;
  canvas.hidden = mode !== "3d";
  gridCanvas.hidden = mode !== "2d";
  canvasShell.dataset.mode = mode;
  query("#interaction-hint-3d").hidden = mode !== "3d";
  query("#interaction-hint-2d").hidden = mode !== "2d";
  query("#camera-controls").hidden = mode !== "3d";
  query("#view-kind").textContent = mode.toUpperCase();
  backend.textContent = mode === "3d" ? "WebGPU" : "Canvas 2D";
  setPressed(modeButtons, "mode", mode);
}

function installModeControls(renderers) {
  const threeDimensional = modeButtons.find((button) => button.dataset.mode === "3d");
  threeDimensional.disabled = !renderers.webgpu;
  threeDimensional.title = renderers.webgpu
    ? "Show the 3D stage"
    : "WebGPU is unavailable";
  modeButtons.forEach((button) => {
    button.addEventListener("click", () => setMode(button.dataset.mode, renderers));
  });
  if (renderers.webgpu) {
    setMode("3d", renderers);
  } else {
    fallbackNote.hidden = false;
    fallbackNote.textContent = "WebGPU is unavailable, so the 2D grid is the only view in this session.";
    setMode("2d", renderers);
  }
}

function installInspector() {
  const form = query("#server-inspector");
  const result = query("#inspect-result");
  const button = query("button", form);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    button.disabled = true;
    result.hidden = false;
    result.textContent = "Reading…";
    result.dataset.state = "working";
    try {
      result.textContent = JSON.stringify(await readServer(form.elements.action.value), null, 2);
      result.dataset.state = "success";
    } catch (error) {
      result.textContent = errorMessage(error);
      result.dataset.state = "error";
    } finally {
      button.disabled = false;
    }
  });
}

function installSceneControls(scene, gridRenderer, selectFixture) {
  query("#show-rgb").addEventListener("change", (event) => {
    scene.setLayerVisibility("rgb", event.currentTarget.checked);
  });
  query("#show-white").addEventListener("change", (event) => {
    scene.setLayerVisibility("white", event.currentTarget.checked);
  });
  installCameraControls(canvas, scene, viewButtons, selectFixture);
  gridCanvas.addEventListener("click", (event) => {
    const logicalIndex = gridRenderer.pick(event.clientX, event.clientY);
    if (logicalIndex !== null) {
      selectFixture(logicalIndex, {
        additive: event.shiftKey,
        toggle: event.ctrlKey || event.metaKey,
      });
    }
  });
}

function startRendering(appliedScene, renderers, renderScene = () => appliedScene) {
  const labels = new StageLabels(query("#stage-labels"));
  const showLabels = query("#show-labels");
  function useFallback(error) {
    console.warn("WebGPU renderer stopped; using the 2D grid", error);
    renderers.webgpu?.destroy();
    renderers.webgpu = null;

    const button = modeButtons.find((item) => item.dataset.mode === "3d");
    button.disabled = true;
    button.title = "WebGPU is unavailable";
    fallbackNote.hidden = false;
    fallbackNote.textContent = "The 3D renderer stopped. The 2D grid remains available.";
    setMode("2d", renderers);
  }
  renderers.webgpu?.device.lost.then((info) => {
    if (renderers.webgpu) useFallback(info.message);
  });
  let pointer = null;
  for (const view of [canvas, gridCanvas]) {
    view.addEventListener("pointermove", (event) => {
      pointer = event.pointerType === "touch" || event.buttons
        ? null
        : { view, x: event.clientX, y: event.clientY };
    });
    for (const eventName of ["pointerleave", "pointercancel", "pointerdown"]) {
      view.addEventListener(eventName, () => { pointer = null; });
    }
  }
  const frame = () => {
    const scene = renderScene();
    const activeCanvas = activeMode === "3d" ? canvas : gridCanvas;
    if (pointer?.view !== activeCanvas) pointer = null;
    scene.hoverFixture(pointer
      ? activeMode === "3d"
        ? pickFixture(canvas, scene, pointer.x, pointer.y)
        : renderers.grid.pick(pointer.x, pointer.y)
      : null);

    if (activeMode === "3d") {
      try {
        const matrix = renderers.webgpu.render(scene, camera);
        labels.render(scene, matrix, showLabels.checked);
      } catch (error) {
        useFallback(error);
      }
    }
    else renderers.grid.render(scene);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

async function start() {
  try {
    const config = await loadConfiguration();
    endpoint.textContent = config.lightstage_uri;
    endpoint.title = config.lightstage_uri;
    setConnectivityStatus("checking", "Checking", `Checking ${config.lightstage_uri}…`);
    checkConnectivity();

    const renderers = await createRenderers();
    const scene = new StageScene();
    const selectFixture = installFixtureControls(
      scene,
      config.features?.fixture_control === true,
    );
    installInspector();
    const loadSequences = installSequences(checkConnectivity);
    const ibl = installIBL(scene, checkConnectivity);
    const simulation = installSimulation(scene);
    installWorkspace(loadSequences, checkConnectivity, (mode) => {
      simulation.stop();
      ibl.setWorkspace(mode);
    });
    installCapture(checkConnectivity);
    installSceneControls(scene, renderers.grid, selectFixture);
    installModeControls(renderers);
    startRendering(scene, renderers, () => simulation.renderScene(ibl.renderScene()));
  } catch (error) {
    const detail = errorMessage(error);
    setConnectivityStatus("error", "Unavailable", detail);
    fallbackNote.hidden = false;
    fallbackNote.textContent = detail;
  }
}

start();
