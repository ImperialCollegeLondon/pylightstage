import { loadConfiguration } from "./api.js";
import { installCapture, installCameraCapture } from "./capture.js";
import { installConnectivity } from "./connectivity.js";
import { errorMessage, query } from "./dom.js";
import { installFixtureControls } from "./fixture-controls.js";
import { installIBL } from "./ibl.js";
import { installInspector } from "./inspector.js";
import { StageScene } from "./scene.js";
import { installSequences } from "./sequences.js";
import { installSimulation } from "./simulation.js";
import { createViewport } from "./viewport.js";
import { installWorkspace } from "./workspace.js";

const endpoint = query("#stage-endpoint");
const fallbackNote = query("#fallback-note");
const connectivity = installConnectivity(installCameraCapture());

async function start() {
  try {
    const config = await loadConfiguration();
    endpoint.textContent = config.lightstage_uri;
    endpoint.title = config.lightstage_uri;
    connectivity.setStatus("checking", "Checking", `Checking ${config.lightstage_uri}…`);
    connectivity.refresh();

    const viewport = await createViewport();
    const scene = new StageScene();
    const selectFixture = installFixtureControls(
      scene,
      config.features?.fixture_control === true,
    );
    installInspector();
    const loadSequences = installSequences(connectivity.refresh);
    const ibl = installIBL(scene, connectivity.refresh);
    const simulation = installSimulation(scene);
    installWorkspace(loadSequences, connectivity.refresh, (mode) => {
      simulation.stop();
      ibl.setWorkspace(mode);
    });
    installCapture(connectivity.refresh);
    viewport.installControls(scene, selectFixture);
    viewport.start(scene, () => simulation.renderScene(ibl.renderScene()));
  } catch (error) {
    connectivity.stop();
    const detail = errorMessage(error);
    connectivity.setStatus("error", "Unavailable", detail);
    fallbackNote.hidden = false;
    fallbackNote.textContent = detail;
  }
}

start();
