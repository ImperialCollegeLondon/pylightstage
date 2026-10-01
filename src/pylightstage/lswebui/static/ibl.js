import { applyIBL } from "./api.js";
import { errorMessage, query, setStatus } from "./dom.js";
import { decodeEnvironmentImage } from "./environment-image.js";
import { StageScene } from "./scene.js";

const LIVE_UPDATE_INTERVAL_MS = 100;

export function installIBL(appliedScene, refreshMode) {
  const preview = new StageScene(appliedScene.arcs, appliedScene.lightsPerArc);
  preview.rgbOnly = true;
  preview.setLayerVisibility("white", false);
  const file = query("#ibl-file");
  const colourSpace = query("#ibl-colour-space");
  const thumbnail = query("#ibl-thumbnail");
  const remove = query("#ibl-remove");
  const form = query("#ibl-form");
  const fieldset = query("fieldset", form);
  const intensity = query("#ibl-intensity");
  const rotation = query("#ibl-rotation");
  const liveSync = query("#ibl-live-sync");
  const applyButton = query("button[type=submit]", form);
  const status = query("#ibl-status");
  const importStatus = query("#ibl-import-status");
  const label = query("#ibl-preview-label");
  let environment = null;
  let importedSource = null;
  let importedColourSpace = "auto";
  let intensities = null;
  let workspace = "manual";
  let generation = 0;
  let importing = false;
  let busy = false;
  let liveRequest = false;
  let pendingLive = null;
  let liveTimer = null;
  let lastSent = -Infinity;
  let lastApplied = null;
  let appliedVersion = -1;

  function paint(scene, values) {
    scene.fixtures.forEach(({ arc, light }, index) => {
      scene.setFixtureIntensity(arc, light, "rgb", values[index]);
      scene.setFixtureIntensity(arc, light, "white", [0, 0, 0]);
    });
  }

  function updateControls() {
    const locked = busy && !liveRequest;
    fieldset.disabled = !environment || locked;
    file.disabled = locked;
    colourSpace.disabled = locked;
    remove.disabled = !environment || locked;
    applyButton.disabled = busy;
    applyButton.hidden = liveSync.checked;
  }

  function stopLive() {
    liveSync.checked = false;
    clearTimeout(liveTimer);
    liveTimer = pendingLive = null;
    updateControls();
  }

  function scheduleLive() {
    if (!pendingLive || busy || liveTimer !== null || !liveSync.checked || workspace !== "ibl") return;
    // Send during a drag, serializing requests and retaining only the newest draft.
    liveTimer = setTimeout(() => {
      liveTimer = null;
      const submitted = pendingLive;
      pendingLive = null;
      if (liveSync.checked && workspace === "ibl" && submitted) sendLighting(submitted, true);
    }, Math.max(0, LIVE_UPDATE_INTERVAL_MS - (performance.now() - lastSent)));
  }

  function showPreviewStatus() {
    if (!environment) return;
    const applied = lastApplied === intensities;
    status.textContent = liveSync.checked
      ? "Live sync pending. Preview shows calculated fixture output."
      : applied ? "Lighting applied. Stage is in Manual mode."
        : "Unapplied changes. Preview shows calculated fixture output.";
    if (applied && !liveSync.checked) status.dataset.state = "success";
    else delete status.dataset.state;
    label.textContent = applied && !liveSync.checked ? "IBL · last applied" : "IBL preview · unapplied";
  }

  function updatePreview() {
    if (!environment) return;
    intensities = environment.sample(preview.arcs, Number(rotation.value), Number(intensity.value) / 100);
    paint(preview, intensities);
    query("#ibl-intensity-value").textContent = `${intensity.value}%`;
    query("#ibl-rotation-value").textContent = `${rotation.value}°`;
    showPreviewStatus();
    label.hidden = workspace !== "ibl";
    if (liveSync.checked && workspace === "ibl") {
      pendingLive = intensities;
      scheduleLive();
    }
  }

  async function loadImage(source, resetControls = true) {
    if (!source || (busy && !liveRequest)) return;
    const current = ++generation;
    importing = true;
    const sourceColourSpace = colourSpace.value;
    importStatus.textContent = "Reading image…";
    delete importStatus.dataset.state;
    try {
      const decoded = await decodeEnvironmentImage(source, preview.lightsPerArc, sourceColourSpace);
      if (current !== generation) return;
      thumbnail.getContext("2d").putImageData(decoded.thumbnail, 0, 0);
      environment = decoded.environment;
      importedSource = source;
      importedColourSpace = sourceColourSpace;
      thumbnail.hidden = false;
      query("#ibl-filename").textContent = source.name;
      if (resetControls) {
        intensity.value = "100";
        rotation.value = "0";
      }
      updateControls();
      updatePreview();
      importStatus.textContent = "Image ready.";
    } catch (error) {
      if (current !== generation) return;
      if (source === importedSource) colourSpace.value = importedColourSpace;
      setStatus(importStatus, errorMessage(error), "error");
    } finally {
      if (current === generation) {
        importing = false;
        file.value = "";
      }
    }
  }
  file.addEventListener("change", () => loadImage(file.files[0]));
  colourSpace.addEventListener("change", () => loadImage(importedSource, false));

  remove.addEventListener("click", () => {
    generation += 1;
    importing = false;
    environment = intensities = null;
    importedSource = null;
    stopLive();
    appliedVersion = -1;
    thumbnail.hidden = true;
    label.hidden = true;
    fieldset.disabled = remove.disabled = true;
    query("#ibl-filename").textContent = "";
    importStatus.textContent = "";
    status.textContent = "Import an image to preview its lighting.";
    delete status.dataset.state;
  });
  intensity.addEventListener("input", updatePreview);
  rotation.addEventListener("input", updatePreview);
  liveSync.addEventListener("change", () => {
    if (liveSync.checked && environment && workspace === "ibl") {
      pendingLive = intensities;
      updateControls();
      scheduleLive();
    } else stopLive();
    showPreviewStatus();
  });

  async function sendLighting(submitted, live) {
    busy = true;
    liveRequest = live;
    lastSent = performance.now();
    // A manual Apply locks the draft; live sync permits importing a replacement.
    if (!live) {
      generation += 1;
      colourSpace.value = importedColourSpace;
      if (importing) {
        importing = false;
        file.value = "";
        importStatus.textContent = "Pending import cancelled. Current image retained.";
        delete importStatus.dataset.state;
      }
    }
    updateControls();
    setStatus(status, live ? "Syncing lighting to stage…" : "Applying lighting…", "working");
    try {
      await applyIBL(submitted);
      paint(appliedScene, submitted);
      lastApplied = submitted;
      if (intensities === submitted) {
        status.textContent = liveSync.checked
          ? "Live sync on. Stage matches the preview in Manual mode."
          : "Lighting applied. Stage is in Manual mode.";
        status.dataset.state = "success";
        label.textContent = liveSync.checked ? "IBL · live synced" : "IBL · last applied";
      }
    } catch (error) {
      if (live) stopLive();
      if (environment) {
        setStatus(status, `${live ? "Live sync stopped. " : ""}${errorMessage(error)} Stage state may have changed; preview remains unapplied.`, "error");
        label.textContent = "IBL preview · unapplied";
      }
    } finally {
      busy = liveRequest = false;
      updateControls();
      scheduleLive();
      if (!pendingLive) refreshMode();
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!intensities || busy || liveSync.checked) return;
    sendLighting(intensities, false);
  });

  return {
    setWorkspace(mode) {
      workspace = mode;
      if (mode !== "ibl") {
        stopLive();
        showPreviewStatus();
      }
      label.hidden = mode !== "ibl" || !environment;
    },
    renderScene() {
      if (workspace !== "ibl") return appliedScene;
      // The empty-image view also shows RGB only, without changing manual layers.
      if (!environment && appliedVersion !== appliedScene.version) {
        paint(preview, appliedScene.fixtures.map(({ intensity }) => intensity.rgb));
        appliedVersion = appliedScene.version;
      }
      return preview;
    },
  };
}
