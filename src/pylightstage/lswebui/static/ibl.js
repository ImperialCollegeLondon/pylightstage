import { applyIBL } from "./api.js";
import { errorMessage, query } from "./dom.js";
import { EnvironmentMap } from "./environment-map.js";
import { StageScene } from "./scene.js";

const LIVE_UPDATE_INTERVAL_MS = 100;

export function installIBL(appliedScene, refreshMode) {
  const preview = new StageScene(appliedScene.arcs, appliedScene.lightsPerArc);
  preview.rgbOnly = true;
  preview.setLayerVisibility("white", false);
  const file = query("#ibl-file");
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
  let intensities = null;
  let workspace = "manual";
  let generation = 0;
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

  file.addEventListener("change", async () => {
    const source = file.files[0];
    if (!source || (busy && !liveRequest)) return;
    const current = ++generation;
    importStatus.textContent = "Reading image…";
    delete importStatus.dataset.state;
    let bitmap;
    try {
      if (!/\.(png|jpe?g|webp)$/i.test(source.name) || source.size > 16 * 1024 * 1024) {
        throw new Error("Choose a PNG, JPEG or WebP panorama up to 16 MiB.");
      }
      bitmap = await createImageBitmap(source);
      if (current !== generation) return;
      if (Math.abs(bitmap.width / bitmap.height - 2) > 0.02) {
        throw new Error("Use a 2:1 equirectangular panorama (for example, 2048 × 1024).");
      }
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const nextEnvironment = new EnvironmentMap(
        context.getImageData(0, 0, canvas.width, canvas.height), preview.lightsPerArc,
      );
      thumbnail.getContext("2d").drawImage(bitmap, 0, 0, thumbnail.width, thumbnail.height);
      environment = nextEnvironment;
      thumbnail.hidden = false;
      query("#ibl-filename").textContent = source.name;
      intensity.value = "100";
      rotation.value = "0";
      updateControls();
      updatePreview();
      importStatus.textContent = "Image ready.";
    } catch (error) {
      if (current !== generation) return;
      importStatus.textContent = errorMessage(error);
      importStatus.dataset.state = "error";
    } finally {
      bitmap?.close();
      if (current === generation) file.value = "";
    }
  });

  remove.addEventListener("click", () => {
    generation += 1;
    environment = intensities = null;
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
    if (!live) generation += 1;
    updateControls();
    status.textContent = live ? "Syncing lighting to stage…" : "Applying lighting…";
    status.dataset.state = "working";
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
        status.textContent = `${live ? "Live sync stopped. " : ""}${errorMessage(error)} Stage state may have changed; preview remains unapplied.`;
        status.dataset.state = "error";
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
