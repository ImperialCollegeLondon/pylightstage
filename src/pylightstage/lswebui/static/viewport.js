import { camera, installCameraControls, pickFixture } from "./camera.js";
import { query, queryAll, setPressed } from "./dom.js";
import { Canvas2DRenderer } from "./renderers/canvas2d.js";
import { WebGPURenderer } from "./renderers/webgpu.js";
import { StageLabels } from "./renderers/labels.js";

/** Own renderer selection, camera interaction, picking and WebGPU fallback. */
export async function createViewport() {
  const canvas = query("#stage-view");
  const gridCanvas = query("#grid-view");
  const canvasShell = query("#canvas-shell");
  const backend = query("#renderer-backend");
  const fallbackNote = query("#fallback-note");
  const viewButtons = queryAll("[data-view]");
  const modeButtons = queryAll(".view-mode-switch [data-mode]");
  let activeMode = "3d";

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

  const renderers = await createRenderers();
  installModeControls(renderers);
  return {
    installControls(scene, selectFixture) {
      installSceneControls(scene, renderers.grid, selectFixture);
    },
    start(scene, renderScene) {
      startRendering(scene, renderers, renderScene);
    },
  };
}
