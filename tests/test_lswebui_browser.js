const originalFetch = window.fetch.bind(window);
const failures = [];
let passed = 0;
function assert(value, message = "Assertion failed") {
  if (!value) throw new Error(message);
}
function equal(actual, expected) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
}
function throws(task) {
  try { task(); } catch { return; }
  throw new Error("Expected rejection");
}
async function test(name, task) {
  try { await task(); passed++; }
  catch (error) { failures.push(`${name}: ${error.message}\n${error.stack}`); }
  finally { window.fetch = originalFetch; }
}

try {
  const { StageScene, polarizedChannel } = await import("/assets/scene.js");
  const { installFixtureControls } = await import("/assets/fixture-controls.js");
  const { installCameraControls } = await import("/assets/camera.js");
  const { Canvas2DRenderer } = await import("/assets/renderers/canvas2d.js");
  const { installCameraCapture } = await import("/assets/capture.js");
  const { installSequences } = await import("/assets/sequences.js");
  const api = await import("/assets/api.js");
  const page = new DOMParser().parseFromString(await (await originalFetch("/index.html")).text(), "text/html");
  document.body.replaceChildren(...page.body.children);

  const { LightingSimulation, olatSequence, installSimulation } = await import("/assets/simulation.js");
  await test("simulation clock, pause, seek, held channels and isolation", () => {
    const applied = new StageScene(2, 2);
    applied.setFixtureIntensity(0, 0, "white", [20, 30, 40]);
    const sim = new LightingSimulation(applied);
    const sequence = olatSequence(applied, 10, "rgb");
    sequence.frames[1].white_fixtures = [];
    sequence.frames[2].white_fixtures = [];
    sim.start(sequence, 1000);
    equal(sim.scene.fixtures[0].intensity.rgb, [255, 255, 255]);
    sim.tick(1250);
    equal(sim.frame, 2);
    equal(sim.scene.fixtures[0].intensity.white, [0, 0, 0]);
    equal(sim.scene.fixtures[2].intensity.rgb, [255, 255, 255]);
    sim.toggle(1250);
    sim.tick(2000);
    equal(sim.frame, 2);
    sim.seek(0, 2000);
    sim.toggle(2000);
    sim.tick(2101);
    equal(sim.frame, 1);
    sim.tick(2500);
    equal(sim.frame, 3);
    assert(!sim.playing);
    equal(applied.fixtures[0].intensity.white, [20, 30, 40]);
    equal(applied.fixtures[0].intensity.rgb, [0, 0, 0]);
    sim.stop();
    assert(!sim.active);
    sim.start({ capture_hz: 1, frames: [{}] }, 0);
    equal(sim.scene.fixtures[0].intensity.white, [20, 30, 40]);
    throws(() => sim.start({ capture_hz: 0, frames: [{}] }));
  });

  await test("simulation controls render locally and restore the applied scene", () => {
    window.fetch = () => { throw new Error("OLAT preview must not use the network"); };
    const applied = new StageScene();
    const preview = installSimulation(applied);
    document.querySelector("#simulate-olat").click();
    assert(!document.querySelector("#simulation-controls").hidden);
    document.querySelector("#simulation-pause").click();
    const slider = document.querySelector("#simulation-frame");
    slider.value = "12";
    slider.dispatchEvent(new Event("input"));
    const scene = preview.renderScene(applied);
    assert(scene !== applied);
    equal(scene.fixtures[12].intensity.rgb, [255, 255, 255]);
    equal(applied.fixtures[12].intensity.rgb, [0, 0, 0]);
    applied.setLayerVisibility("rgb", false);
    equal(preview.renderScene(applied).visibility.rgb, false);
    document.querySelector("#simulation-stop").click();
    assert(preview.renderScene(applied) === applied);
    assert(document.querySelector("#simulation-label").hidden);
  });

  await test("layout is finite and paired", () => {
    const scene = new StageScene();
    equal(scene.fixtures.length, 168);
    assert([...scene.instanceData].every(Number.isFinite));
    equal(scene.count, 336);
    throws(() => new StageScene(12, 1));
  });
  await test("polarization routes all orientations", () => {
    for (let arc = 0; arc < 12; arc++) for (let light = 0; light < 14; light++) {
      equal(polarizedChannel(arc, light, "up"), "rgbw");
      assert(polarizedChannel(arc, light, "pp") !== polarizedChannel(arc, light, "cp"));
    }
    throws(() => polarizedChannel(0, 0, "invalid"));
  });
  await test("invalid intensity leaves scene unchanged", () => {
    const scene = new StageScene();
    const before = [...scene.instanceData];
    for (const intensity of [[NaN, 0, 0], [256, 0, 0], [1, 2], [true, 0, 0]]) {
      throws(() => scene.setFixtureIntensity(0, 0, "rgb", intensity));
    }
    throws(() => scene.setFixtureIntensity(0, 0, "invalid", [1, 2, 3]));
    throws(() => scene.setFixtureIntensity(0.5, 0, "rgb", [1, 2, 3]));
    equal([...scene.instanceData], before);
    equal(scene.fixtures[0].intensity.rgb, [0, 0, 0]);
  });
  await test("selection, hover, visibility preserve each other", () => {
    const scene = new StageScene();
    scene.selectFixture(0);
    scene.hoverFixture(1);
    equal(scene.instanceData[15], 2);
    equal(scene.instanceData[47], 1.5);
    scene.setLayerVisibility("rgb", false);
    equal(scene.instanceData[15], 0);
    scene.selectFixture(null);
    scene.setLayerVisibility("rgb", true);
    equal(scene.instanceData[15], 1);
    equal(scene.instanceData[47], 1.5);
    throws(() => scene.hoverFixture(NaN));
    throws(() => scene.setLayerVisibility("toString", true));
  });
  await test("API encodes requests and propagates server errors", async () => {
    window.fetch = async (path, options) => {
      equal(path, "/api/fixture");
      equal(JSON.parse(options.body), { action: "clear" });
      return new Response(JSON.stringify({ error: "stage unavailable" }), { status: 502 });
    };
    let message;
    try { await api.controlFixture({ action: "clear" }); } catch (error) { message = error.message; }
    equal(message, "stage unavailable");
  });
  for (const body of ["null", "[]", "<html>unavailable</html>"]) {
    await test(`API rejects malformed response: ${body}`, async () => {
      window.fetch = async () => new Response(body);
      let failed = false;
      try { await api.triggerCamera(); } catch { failed = true; }
      assert(failed);
    });
  }
  await test("pending fixture command uses submitted selection and white channel", async () => {
    const scene = new StageScene();
    const select = installFixtureControls(scene, true);
    select(0);
    const colour = document.querySelector("#fixture-color");
    colour.value = "w";
    colour.dispatchEvent(new Event("change"));
    [10, 20, 30].forEach((value, index) => {
      document.querySelector(`#intensity-${index}`).value = value;
    });
    let finish;
    let calls = 0;
    window.fetch = () => { calls++; return new Promise((resolve) => { finish = resolve; }); };
    const form = document.querySelector("#fixture-control");
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    select(1);
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    equal(calls, 1);
    finish(new Response('{"status":"ok"}'));
    for (let attempt = 0; form.hasAttribute("aria-busy") && attempt < 50; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert(!form.hasAttribute("aria-busy"));
    equal(scene.fixtures[0].intensity.white, [10, 20, 30]);
    equal(scene.fixtures[1].intensity.white, [0, 0, 0]);
    equal(scene.fixtures[0].intensity.rgb, [0, 0, 0]);
  });
  await test("cancelled pointer does not select", () => {
    const canvas = document.querySelector("#stage-view");
    canvas.setPointerCapture = () => {};
    let calls = 0;
    installCameraControls(canvas, new StageScene(), [], () => { calls++; });
    canvas.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, button: 0 }));
    canvas.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1 }));
    canvas.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));
    equal(calls, 0);
  });
  await test("grid picking matches rendered cells and tiny layouts stay nonnegative", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 800; canvas.height = 600;
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 });
    const renderer = new Canvas2DRenderer(canvas);
    renderer.layout(new StageScene());
    for (const cell of renderer.cells) equal(renderer.pick(cell.x, cell.y), cell.logicalIndex);
    canvas.width = 1; canvas.height = 1;
    renderer.layout(new StageScene());
    assert(renderer.cells.every((cell) => cell.radius >= 0));
  });
  await test("stopping a pending capture prevents subsequent automatic triggers", async () => {
    let finish;
    let calls = 0;
    window.fetch = () => { calls++; return new Promise((resolve) => { finish = resolve; }); };
    const updateMode = installCameraCapture();
    const form = document.querySelector("#camera-interval-form");
    document.querySelector("#camera-interval").value = "0.1";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    equal(calls, 1);
    updateMode("OLAT");
    finish(new Response('{"result":null}'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    equal(calls, 1);
    assert(document.querySelector("#camera-stop").disabled);
    assert(document.querySelector("#camera-status").textContent.includes("Manual mode is unavailable"));
  });
  await test("malformed sequence response preserves existing library", async () => {
    const list = document.querySelector("#sequence-list");
    list.innerHTML = "<li>Existing sequence</li>";
    window.fetch = async () => new Response('{"result":{}}');
    const load = installSequences(async () => {});
    await load();
    equal(list.textContent, "Existing sequence");
    equal(document.querySelector("#sequence-status").dataset.state, "error");
    assert(!document.querySelector("#playback-panel").hasAttribute("aria-busy"));
  });
  await test("environment sampling preserves energy, exposure and orientation", async () => {
    const { sampleEnvironment } = await import("/assets/environment-map.js");
    const pixels = new ImageData(120, 60);
    for (let i = 0; i < pixels.data.length; i += 4) {
      pixels.data.set([128, 0, 0, 255], i);
    }
    const values = sampleEnvironment(pixels, 12, 14);
    assert(values.every(([r, g, b]) => Math.abs(r - 55.0444) < 0.01 && g === 0 && b === 0));
    const brighter = sampleEnvironment(pixels, 12, 14, 0, 1);
    assert(Math.abs(brighter[0][0] - 2 * values[0][0]) < 0.001);
    pixels.data.fill(0);
    for (let y = 0; y < 60; y++) for (let x = 55; x < 65; x++) {
      pixels.data.set([255, 0, 0, 255], (y * 120 + x) * 4);
    }
    const first = sampleEnvironment(pixels, 12, 14);
    const rotated = sampleEnvironment(pixels, 12, 14, 90);
    assert(first[7][0] > 200);
    assert(first[3 * 14 + 7][0] === 0);
    assert(Math.abs(rotated[3 * 14 + 7][0] - first[7][0]) < 0.001);
    const wrapped = sampleEnvironment(pixels, 12, 14, 360);
    equal(wrapped, first);
  });
  await test("IBL imports locally, isolates preview, applies once and retains state on failure", async () => {
    const { installIBL } = await import("/assets/ibl.js");
    const scene = new StageScene();
    const ibl = installIBL(scene, () => {});
    ibl.setWorkspace("ibl");
    const canvas = document.createElement("canvas");
    canvas.width = 32; canvas.height = 16;
    const context = canvas.getContext("2d");
    context.fillStyle = "red";
    context.fillRect(0, 0, 32, 16);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve));
    const input = document.querySelector("#ibl-file");
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], "test.png", { type: "image/png" }));
    input.files = transfer.files;
    let calls = 0;
    window.fetch = () => { calls++; throw new Error("Unexpected request"); };
    input.dispatchEvent(new Event("change"));
    for (let i = 0; document.querySelector("#ibl-form fieldset").disabled && i < 100; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert(!document.querySelector("#ibl-form fieldset").disabled);
    equal(calls, 0);
    // A failed replacement preserves the previous valid preview.
    const invalid = new DataTransfer();
    invalid.items.add(new File(["not an image"], "broken.png", { type: "image/png" }));
    input.files = invalid.files;
    input.dispatchEvent(new Event("change"));
    for (let i = 0; document.querySelector("#ibl-import-status").dataset.state !== "error" && i < 100; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    equal(document.querySelector("#ibl-import-status").dataset.state, "error");
    equal(document.querySelector("#ibl-filename").textContent, "test.png");
    equal(scene.fixtures[0].intensity.rgb, [0, 0, 0]);
    assert(ibl.renderScene().fixtures[0].intensity.rgb[0] > 254);
    ibl.setWorkspace("manual");
    assert(ibl.renderScene() === scene);
    ibl.setWorkspace("ibl");
    let finish;
    window.fetch = (path, options) => {
      calls++;
      equal(path, "/api/ibl");
      equal(JSON.parse(options.body).intensities.length, 168);
      return new Promise((resolve) => { finish = resolve; });
    };
    const form = document.querySelector("#ibl-form");
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    equal(calls, 1);
    equal(scene.fixtures[0].intensity.rgb, [0, 0, 0]);
    finish(new Response('{"result":null}'));
    for (let i = 0; input.disabled && i < 100; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert(scene.fixtures[0].intensity.rgb[0] > 254);
    const exposure = document.querySelector("#ibl-exposure");
    exposure.value = "-1";
    exposure.dispatchEvent(new Event("input"));
    assert(ibl.renderScene().fixtures[0].intensity.rgb[0] < 128);
    window.fetch = async () => new Response('{"error":"offline"}', { status: 502 });
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    for (let i = 0; input.disabled && i < 100; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert(scene.fixtures[0].intensity.rgb[0] > 254);
    equal(document.querySelector("#ibl-status").dataset.state, "error");
    document.querySelector("#ibl-remove").click();
    assert(ibl.renderScene() === scene);
  });
  await test("application starts with the canvas fallback", async () => {
    // Use fresh DOM nodes to avoid carrying controller listeners between tests.
    document.body.replaceChildren(...new DOMParser().parseFromString(
      await (await originalFetch("/index.html")).text(), "text/html",
    ).body.children);
    Object.defineProperty(navigator, "gpu", { configurable: true, value: undefined });
    window.fetch = async (path) => new Response(JSON.stringify(path === "/api/config"
      ? { lightstage_uri: "ws://test/ws", features: { fixture_control: true } }
      : { result: "Manual" }));
    await import("/assets/app.js");
    for (let attempt = 0; (document.querySelector("#renderer-backend").textContent !== "Canvas 2D" || document.querySelector("#service-status").dataset.state !== "ready") && attempt < 50; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    equal(document.querySelector("#renderer-backend").textContent, "Canvas 2D");
    equal(document.querySelector("#service-status").dataset.state, "ready");
    assert(document.querySelector('[data-mode="3d"]').disabled);
    document.querySelector("#ibl-tab").click();
    equal(document.querySelector(".dashboard").dataset.workspace, "ibl");
    assert(!document.querySelector("#ibl-panel").hidden);
    assert(!document.querySelector("#ibl-inspector").hidden);
    assert(document.querySelector("[data-manual-controls]").hidden);
    document.querySelector("#manual-tab").click();
    assert(document.querySelector("#ibl-inspector").hidden);
  });

} catch (error) { failures.push(`Setup: ${error.stack}`); }
await originalFetch("/results", { method: "POST", body: JSON.stringify({ passed, failures }) });
