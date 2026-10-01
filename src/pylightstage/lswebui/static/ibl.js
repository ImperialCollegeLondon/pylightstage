import { applyIBL } from "./api.js";
import { errorMessage, query } from "./dom.js";
import { EnvironmentMap } from "./environment-map.js";
import { StageScene } from "./scene.js";

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
  const status = query("#ibl-status");
  const importStatus = query("#ibl-import-status");
  const label = query("#ibl-preview-label");
  let environment = null;
  let intensities = null;
  let workspace = "manual";
  let generation = 0;
  let busy = false;
  let appliedVersion = -1;

  function paint(scene, values) {
    scene.fixtures.forEach(({ arc, light }, index) => {
      scene.setFixtureIntensity(arc, light, "rgb", values[index]);
      scene.setFixtureIntensity(arc, light, "white", [0, 0, 0]);
    });
  }

  function updatePreview() {
    if (!environment) return;
    intensities = environment.sample(preview.arcs, Number(rotation.value), Number(intensity.value) / 100);
    paint(preview, intensities);
    query("#ibl-intensity-value").textContent = `${intensity.value}%`;
    query("#ibl-rotation-value").textContent = `${rotation.value}°`;
    status.textContent = "Unapplied changes. Preview shows calculated fixture output.";
    delete status.dataset.state;
    label.textContent = "IBL preview · unapplied";
    label.hidden = workspace !== "ibl";
  }

  file.addEventListener("change", async () => {
    const source = file.files[0];
    if (!source || busy) return;
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
      fieldset.disabled = false;
      remove.disabled = false;
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
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!intensities || busy) return;
    const submitted = intensities;
    busy = true;
    generation += 1; // Ignore an image decode that was pending when Apply was pressed.
    fieldset.disabled = file.disabled = remove.disabled = true;
    status.textContent = "Applying lighting…";
    status.dataset.state = "working";
    try {
      await applyIBL(submitted);
      paint(appliedScene, submitted);
      status.textContent = "Lighting applied. Stage is in Manual mode.";
      status.dataset.state = "success";
      label.textContent = "IBL · last applied";
    } catch (error) {
      status.textContent = `${errorMessage(error)} Stage state may have changed; preview remains unapplied.`;
      status.dataset.state = "error";
      label.textContent = "IBL preview · unapplied";
    } finally {
      busy = false;
      fieldset.disabled = file.disabled = remove.disabled = false;
      refreshMode();
    }
  });

  return {
    setWorkspace(mode) {
      workspace = mode;
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
