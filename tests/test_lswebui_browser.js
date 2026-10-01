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
  await test("connectivity shares pending checks and ignores results after shutdown", async () => {
    const { installConnectivity } = await import("/assets/connectivity.js");
    let finish;
    let calls = 0;
    const modes = [];
    window.fetch = () => {
      calls++;
      return new Promise((resolve) => { finish = resolve; });
    };
    const connection = installConnectivity((mode) => modes.push(mode));
    try {
      const first = connection.refresh();
      assert(first === connection.refresh(), "Refresh callers await the same request");
      equal(calls, 1);
      finish(new Response('{"result":"Manual"}'));
      await first;
      equal(modes, ["Manual"]);
      equal(document.querySelector("#service-status").dataset.state, "ready");
      const pending = connection.refresh();
      connection.stop();
      connection.setStatus("error", "Stopped");
      finish(new Response('{"result":"OLAT"}'));
      await pending;
      equal(modes, ["Manual"]);
      equal(document.querySelector("#service-status").textContent, "Stopped");
      await connection.refresh();
      equal(calls, 2);
    } finally {
      connection.stop();
    }
  });

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
  await test("IBL, 2D and 3D agree on interleaved top-to-bottom fixture order", async () => {
    const { sampleEnvironment } = await import("/assets/environment-map.js");
    const { fixtureGridPosition } = await import("/assets/renderers/canvas2d.js");
    const pixels = new ImageData(120, 60);
    for (let y = 0; y < 60; y++) for (let x = 0; x < 120; x++) {
      pixels.data.set([255 - y * 4, 0, 0, 255], (y * 120 + x) * 4);
    }
    const values = sampleEnvironment(pixels, 12, 14);
    const scene = new StageScene();
    const order = [0, 7, 1, 8, 2, 9, 3, 10, 4, 11, 5, 12, 6, 13];
    for (let arc = 0; arc < 12; arc++) {
      let previousY = Infinity;
      let previousRed = Infinity;
      for (const [row, light] of order.entries()) {
        equal(fixtureGridPosition(arc, light).row, row);
        const centreY = scene.getLogicalCentre(arc * 14 + light)[1];
        const red = values[arc * 14 + light][0];
        assert(centreY < previousY, `3D row ${row} must be below the preceding row`);
        assert(red < previousRed, `IBL row ${row} must be darker than the preceding row`);
        previousY = centreY;
        previousRed = red;
      }
    }
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
    window.fetch = () => new Promise((resolve) => { finish = resolve; });
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    document.querySelector("#camera-stop").click();
    const stoppedMessage = document.querySelector("#camera-status").textContent;
    finish(new Response('{"error":"Late failure"}', { status: 502 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    equal(document.querySelector("#camera-status").textContent, stoppedMessage);
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
    window.fetch = async () => new Response(JSON.stringify({ result: [
      { name: "Sweep", id: "sweep", total_frames: 1, capture_hz: 1, duration_secs: 1 },
    ] }));
    await load();
    let finish;
    window.fetch = () => new Promise((resolve) => { finish = resolve; });
    const loading = load();
    assert([...list.querySelectorAll("button")].every((button) => button.disabled));
    finish(new Response('{"result":{}}'));
    await loading;
    assert([...list.querySelectorAll("button")].every((button) => !button.disabled));
  });
  await test("environment sampling maps the source peak and preserves intensity and orientation", async () => {
    const { sampleEnvironment } = await import("/assets/environment-map.js");
    const pixels = new ImageData(120, 60);
    for (let i = 0; i < pixels.data.length; i += 4) {
      pixels.data.set([128, 0, 0, 255], i);
    }
    const values = sampleEnvironment(pixels, 12, 14);
    assert(values.every(([r, g, b]) => Math.abs(r - 255) < 1e-10 && g === 0 && b === 0));
    const dimmer = sampleEnvironment(pixels, 12, 14, 0, 0.5);
    assert(dimmer.every(([r]) => Math.abs(r - 127.5) < 1e-10));
    equal(sampleEnvironment(pixels, 12, 14, 0, 0), Array.from({ length: 168 }, () => [0, 0, 0]));
    equal(sampleEnvironment(pixels, 12, 14, 0, 5), values);
    equal(sampleEnvironment(pixels, 12, 14, 0, -1), Array.from({ length: 168 }, () => [0, 0, 0]));
    for (const invalid of [NaN, Infinity, -Infinity, "1", true]) {
      throws(() => sampleEnvironment(pixels, 12, 14, 0, invalid));
    }
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
  await test("source peak normalization preserves RGB ratios and precedes fixture averaging", async () => {
    const { EnvironmentMap } = await import("/assets/environment-map.js");
    const linear = (value) => {
      const s = value / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    const pixels = new ImageData(24, 12);
    for (let offset = 0; offset < pixels.data.length; offset += 4) {
      pixels.data.set([64, 32, 16, 255], offset);
    }
    // One brighter pixel defines the reference even though no fixture is as bright.
    pixels.data.set([128, 64, 32, 255], (6 * 24 + 12) * 4);
    const environment = new EnvironmentMap(pixels);
    const baseline = [64, 32, 16].map((channel) => 255 * linear(channel) / linear(128));
    for (const rotation of [0, 17, -90, 180]) {
      const full = environment.sample(12, rotation);
      const half = environment.sample(12, rotation, 0.5);
      assert(full.every(([r, g, b]) => r < 255 && r > g && g > b));
      // The top fixtures stay outside the bright pixel's latitude band.
      assert(full[9 * 14].every((value, c) => Math.abs(value - baseline[c]) < 1e-10));
      assert(half.every((rgb, i) => rgb.every((value, c) => Math.abs(value - full[i][c] / 2) < 1e-10)));
    }
    const solid = new ImageData(2, 1);
    solid.data.set([128, 64, 32, 255, 128, 64, 32, 255]);
    const expected = [128, 64, 32].map((channel) => 255 * linear(channel) / linear(128));
    assert(new EnvironmentMap(solid).sample(12).every((rgb) =>
      rgb.every((value, c) => Math.abs(value - expected[c]) < 1e-10)));
  });
  await test("black and transparent panoramas stay finite and do not distort the source peak", async () => {
    const { EnvironmentMap } = await import("/assets/environment-map.js");
    const pixels = new ImageData(2, 1);
    for (const rgba of [[0, 0, 0, 255], [255, 255, 255, 0]]) {
      pixels.data.set(rgba, 0);
      pixels.data.set(rgba, 4);
      for (const intensity of [0, 0.5, 1]) {
        equal(new EnvironmentMap(pixels).sample(12, 17, intensity),
          Array.from({ length: 168 }, () => [0, 0, 0]));
      }
    }
    pixels.data.set([128, 0, 0, 128], 0);
    // Invisible white must not dim the visible source when choosing the reference.
    const values = new EnvironmentMap(pixels).sample(12);
    assert(values.some(([r]) => Math.abs(r - 255) < 1e-10));
    assert(values.every(([r, g, b]) => Number.isFinite(r) && r >= 0 && r <= 255 && g === 0 && b === 0));
  });
  await test("small panoramas cover all fixtures and preserve north/south orientation", async () => {
    const { sampleEnvironment } = await import("/assets/environment-map.js");
    const { fixtureGridPosition } = await import("/assets/renderers/canvas2d.js");
    const pixels = new ImageData(2, 1);
    pixels.data.set([128, 64, 32, 255, 128, 64, 32, 255]);
    const values = sampleEnvironment(pixels, 12, 14, 17);
    assert(values.every((rgb) => rgb.every((value) => value > 0)));
    assert(values.every((rgb) => rgb.every((value, c) => Math.abs(value - values[0][c]) < 1e-10)));
    const hemispheres = new ImageData(4, 2);
    for (let x = 0; x < 4; x++) {
      hemispheres.data.set([255, 0, 0, 255], x * 4);
      hemispheres.data.set([0, 0, 255, 255], (4 + x) * 4);
    }
    const colours = sampleEnvironment(hemispheres, 12, 14);
    for (let arc = 0; arc < 12; arc++) for (let light = 0; light < 14; light++) {
      const expected = fixtureGridPosition(arc, light).row < 7 ? [255, 0, 0] : [0, 0, 255];
      assert(colours[arc * 14 + light].every((value, c) => Math.abs(value - expected[c]) < 1e-10));
    }
  });
  await test("fractional boundaries and panorama seam conserve solid-angle radiance", async () => {
    const { EnvironmentMap } = await import("/assets/environment-map.js");
    const { fixtureGridPosition } = await import("/assets/renderers/canvas2d.js");
    const pixels = new ImageData(10, 5);
    let sourceMean = 0;
    let sourcePeak = 0;
    for (let y = 0; y < 5; y++) {
      const area = Math.sin((0.5 - y / 5) * Math.PI) - Math.sin((0.5 - (y + 1) / 5) * Math.PI);
      for (let x = 0; x < 10; x++) {
        const value = (x * 31 + y * 47) % 256;
        const alpha = (x * 73 + y * 11) % 256;
        pixels.data.set([value, 0, 0, alpha], (y * 10 + x) * 4);
        const s = value / 255;
        const linear = s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        sourceMean += linear * alpha / 255 * area / 20;
        sourcePeak = Math.max(sourcePeak, linear * alpha / 255);
      }
    }
    const environment = new EnvironmentMap(pixels);
    for (const rotation of [0, 17, -90, 180, 359, 360]) {
      const values = environment.sample(12, rotation);
      let outputMean = 0;
      for (let arc = 0; arc < 12; arc++) for (let light = 0; light < 14; light++) {
        const row = fixtureGridPosition(arc, light).row;
        const upper = row === 0 ? Math.PI / 2 : 1.08 - (row - 0.5) * 2.16 / 13;
        const lower = row === 13 ? -Math.PI / 2 : 1.08 - (row + 0.5) * 2.16 / 13;
        outputMean += values[arc * 14 + light][0] / 255 * (Math.sin(upper) - Math.sin(lower)) / 24;
      }
      assert(Math.abs(outputMean - sourceMean / sourcePeak) < 1e-12, `Relative radiance changed at rotation ${rotation}`);
    }
    const seam = new ImageData(24, 12);
    for (let y = 0; y < 12; y++) for (const x of [0, 23]) {
      seam.data.set([255, 0, 0, 255], (y * 24 + x) * 4);
    }
    const red = new EnvironmentMap(seam).sample(12);
    assert(red.slice(6 * 14, 7 * 14).every(([r]) => Math.abs(r - 255) < 1e-10));
    assert(red.slice(0, 14).every(([r]) => r === 0));
  });
  await test("IBL imports locally, isolates preview, applies once and retains state on failure", async () => {
    const { installIBL } = await import("/assets/ibl.js");
    const scene = new StageScene();
    const ibl = installIBL(scene, () => {});
    scene.setFixtureIntensity(0, 0, "rgb", [80, 0, 0]);
    scene.setFixtureIntensity(0, 0, "white", [255, 255, 255]);
    scene.setLayerVisibility("rgb", false);
    ibl.setWorkspace("ibl");
    const assertRGBOnly = () => {
      const displayed = ibl.renderScene();
      assert(displayed !== scene);
      equal(displayed.visibility, { rgb: true, white: false });
      assert(displayed.rgbOnly);
      displayed.hoverFixture(0);
      displayed.selectFixture(1);
      for (let index = 0; index < displayed.logicalCount; index++) {
        assert(displayed.instanceData[index * 32 + 15] >= 1);
        equal(displayed.instanceData[index * 32 + 31], 0);
      }
      equal(scene.visibility, { rgb: false, white: true });
    };
    assertRGBOnly();
    equal(ibl.renderScene().fixtures[0].intensity.rgb, [80, 0, 0]);
    scene.setFixtureIntensity(0, 0, "rgb", [0, 0, 0]);
    assertRGBOnly();
    equal(ibl.renderScene().fixtures[0].intensity.rgb, [0, 0, 0]);
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
    assert(ibl.renderScene().fixtures.every(({ intensity }) => intensity.rgb[0] > 254));
    assertRGBOnly();
    // Both halves and the former divider carry the same RGB colour.
    const grid = document.createElement("canvas");
    grid.width = grid.height = 100;
    const renderer = new Canvas2DRenderer(grid);
    const cell = { x: 50, y: 50, radius: 32, logicalIndex: 2, arc: 0, light: 2 };
    renderer.drawCell(ibl.renderScene(), cell);
    const pixel = (x) => [...renderer.context.getImageData(x, 60, 1, 1).data];
    equal(pixel(40), pixel(60));
    equal(pixel(50), pixel(60));
    assert(pixel(60)[0] > 250 && pixel(60)[1] < 30);
    const paired = new StageScene();
    paired.setFixtureIntensity(0, 2, "rgb", [255, 0, 0]);
    paired.setFixtureIntensity(0, 2, "white", [255, 255, 255]);
    renderer.drawCell(paired, cell);
    assert(pixel(40)[1] < 30 && pixel(60)[1] > 200, "Manual still displays both emitters");
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
      const submitted = JSON.parse(options.body).intensities;
      equal(submitted.length, 168);
      assert(submitted.every(([r, g, b]) => r > 254 && g === 0 && b === 0));
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
    const intensity = document.querySelector("#ibl-intensity");
    equal([intensity.min, intensity.max, intensity.value], ["0", "100", "100"]);
    intensity.value = "50";
    intensity.dispatchEvent(new Event("input"));
    equal(document.querySelector("#ibl-intensity-value").textContent, "50%");
    assert(Math.abs(ibl.renderScene().fixtures[0].intensity.rgb[0] - 127.5) < 1e-10);
    window.fetch = async () => new Response('{"error":"offline"}', { status: 502 });
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    for (let i = 0; input.disabled && i < 100; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert(scene.fixtures[0].intensity.rgb[0] > 254);
    equal(document.querySelector("#ibl-status").dataset.state, "error");
    intensity.value = "0";
    intensity.dispatchEvent(new Event("input"));
    assert(ibl.renderScene().fixtures.every(({ intensity }) => intensity.rgb.every((value) => value === 0)));
    window.fetch = async (path, options) => {
      equal(path, "/api/ibl");
      equal(JSON.parse(options.body).intensities, Array.from({ length: 168 }, () => [0, 0, 0]));
      return new Response('{"result":null}');
    };
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    for (let i = 0; input.disabled && i < 100; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert(scene.fixtures.every(({ intensity }) => intensity.rgb.every((value) => value === 0)));
    // Fine black/white stripes must average in linear light before any resizing.
    canvas.width = 1200; canvas.height = 600;
    context.fillStyle = "black";
    context.fillRect(0, 0, 1200, 600);
    context.fillStyle = "white";
    for (let x = 0; x < 1200; x += 2) context.fillRect(x, 0, 1, 600);
    const stripedBlob = await new Promise((resolve) => canvas.toBlob(resolve));
    const stripedTransfer = new DataTransfer();
    stripedTransfer.items.add(new File([stripedBlob], "stripes.png", { type: "image/png" }));
    input.files = stripedTransfer.files;
    input.dispatchEvent(new Event("change"));
    for (let i = 0; document.querySelector("#ibl-filename").textContent !== "stripes.png" && i < 100; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    equal(document.querySelector("#ibl-filename").textContent, "stripes.png");
    equal(intensity.value, "100");
    equal(document.querySelector("#ibl-intensity-value").textContent, "100%");
    assert(ibl.renderScene().fixtures.every(({ intensity }) =>
      intensity.rgb.every((value) => Math.abs(value - 127.5) < 1e-8)));
    document.querySelector("#ibl-remove").click();
    assertRGBOnly();
    equal(ibl.renderScene().fixtures[0].intensity.rgb, scene.fixtures[0].intensity.rgb);
    ibl.setWorkspace("manual");
    assert(ibl.renderScene() === scene);
  });
  await test("native HDR imports preserve radiance through preview, colour changes and live sync", async () => {
    document.body.replaceChildren(...new DOMParser().parseFromString(
      await (await originalFetch("/index.html")).text(), "text/html",
    ).body.children);
    const { installIBL } = await import("/assets/ibl.js");
    const { EnvironmentMap } = await import("/assets/environment-map.js");
    const scene = new StageScene();
    const ibl = installIBL(scene, () => {});
    ibl.setWorkspace("ibl");
    const input = document.querySelector("#ibl-file");
    const colour = document.querySelector("#ibl-colour-space");
    const intensity = document.querySelector("#ibl-intensity");
    const rotation = document.querySelector("#ibl-rotation");
    const sync = document.querySelector("#ibl-live-sync");
    const status = document.querySelector("#ibl-status");
    const imported = [];
    const applied = [];
    window.fetch = (path, options) => {
      if (path.startsWith("/api/ibl/import?")) {
        imported.push(path);
        return originalFetch(path, options);
      }
      equal(path, "/api/ibl");
      applied.push(JSON.parse(options.body).intensities);
      return Promise.resolve(new Response('{"result":null}'));
    };
    const waitFor = async (condition) => {
      for (let i = 0; !condition() && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert(condition(), "Timed out waiting for HDR import");
    };
    // PFM stores bottom scanlines first, with little-endian float radiance.
    const pixels = new ArrayBuffer(8 * 3 * 4);
    const view = new DataView(pixels);
    for (let i = 0; i < 8; i++) {
      [i === 0 ? 40 : 4, 2, 1].forEach((value, channel) => view.setFloat32((i * 3 + channel) * 4, value, true));
    }
    const file = new File(["PF\n4 2\n-1.0\n", pixels], "studio.pfm");
    const upload = (source) => {
      const transfer = new DataTransfer();
      transfer.items.add(source);
      input.files = transfer.files;
      input.dispatchEvent(new Event("change"));
    };
    upload(file);
    await waitFor(() => document.querySelector("#ibl-filename").textContent === "studio.pfm");
    equal(imported.length, 1);
    equal(applied.length, 0);
    const radiance = ibl.renderScene().fixtures[0].intensity.rgb;
    assert(radiance.every((value, c) => Math.abs(value - [25.5, 12.75, 6.375][c]) < 1e-8),
      "Values above 1 preserve their ratios without sRGB conversion or clipping");
    equal(scene.fixtures[0].intensity.rgb, [0, 0, 0]);
    intensity.value = "50";
    intensity.dispatchEvent(new Event("input"));
    rotation.value = "90";
    rotation.dispatchEvent(new Event("input"));
    assert(ibl.renderScene().fixtures[0].intensity.rgb.every((value, c) => Math.abs(value - radiance[c] / 2) < 1e-8));
    equal(imported.length, 1); // Adjustments keep sampling the original native integrals locally.
    colour.value = "srgb";
    colour.dispatchEvent(new Event("change"));
    await waitFor(() => imported.length === 2 && ibl.renderScene().fixtures[0].intensity.rgb[0] < 1);
    assert(imported[1].includes("colour_space=srgb"));
    equal([intensity.value, rotation.value], ["50", "90"]);
    colour.value = "linear";
    colour.dispatchEvent(new Event("change"));
    await waitFor(() => Math.abs(ibl.renderScene().fixtures[0].intensity.rgb[0] - 12.75) < 1e-8);
    sync.checked = true;
    sync.dispatchEvent(new Event("change"));
    await waitFor(() => status.dataset.state === "success");
    equal(applied.length, 1);
    assert(applied[0][0].every((value, c) => Math.abs(value - radiance[c] / 2) < 1e-8));
    assert(scene.fixtures.every(({ intensity }) => intensity.white.every((value) => value === 0)));
    sync.checked = false;
    sync.dispatchEvent(new Event("change"));
    const retained = ibl.renderScene().fixtures[0].intensity.rgb;
    window.fetch = async (path) => {
      assert(path.startsWith("/api/ibl/import?"));
      return new Response('{"error":"Decode failed"}', { status: 400 });
    };
    colour.value = "acescg";
    colour.dispatchEvent(new Event("change"));
    await waitFor(() => document.querySelector("#ibl-import-status").dataset.state === "error");
    equal(colour.value, "linear");
    equal(ibl.renderScene().fixtures[0].intensity.rgb, retained);
    upload(new File(["broken"], "broken.exr"));
    await waitFor(() => document.querySelector("#ibl-import-status").dataset.state === "error");
    equal(document.querySelector("#ibl-filename").textContent, "studio.pfm");
    equal(ibl.renderScene().fixtures[0].intensity.rgb, retained);
    equal(applied.length, 1);
    // An import response must have valid floating-point integrals and the stage layout.
    throws(() => EnvironmentMap.fromIntegrated({ width: 2, lightsPerArc: 14, peak: NaN, columns: [] }));
    throws(() => EnvironmentMap.fromIntegrated({ width: 2, lightsPerArc: 13, peak: 1, columns: Array(78).fill(1) }));
    throws(() => EnvironmentMap.fromIntegrated({ width: 2, lightsPerArc: 14, peak: 1, columns: Array(84).fill(-1) }));
    // Manual Apply cancels an outstanding replacement, including its progress UI.
    let finishImport;
    window.fetch = (path, options) => {
      if (path.startsWith("/api/ibl/import?")) {
        return new Promise((resolve) => { finishImport = () => resolve(new Response('{"error":"late decode failure"}', { status: 400 })); });
      }
      equal(path, "/api/ibl");
      applied.push(JSON.parse(options.body).intensities);
      return Promise.resolve(new Response('{"result":null}'));
    };
    colour.value = "acescg";
    colour.dispatchEvent(new Event("change"));
    await waitFor(() => finishImport);
    equal(document.querySelector("#ibl-import-status").textContent, "Reading image…");
    document.querySelector("#ibl-form").dispatchEvent(new Event("submit", { cancelable: true }));
    await waitFor(() => status.dataset.state === "success");
    equal(colour.value, "linear");
    assert(document.querySelector("#ibl-import-status").textContent.includes("cancelled"));
    finishImport();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert(document.querySelector("#ibl-import-status").textContent.includes("cancelled"));
    equal(ibl.renderScene().fixtures[0].intensity.rgb, retained);
    equal(applied.length, 2);
    document.querySelector("#ibl-remove").click();
    ibl.setWorkspace("manual");
  });
  await test("IBL live sync serializes latest drafts, stays interactive and stops cleanly", async () => {
    document.body.replaceChildren(...new DOMParser().parseFromString(
      await (await originalFetch("/index.html")).text(), "text/html",
    ).body.children);
    const { installIBL } = await import("/assets/ibl.js");
    const scene = new StageScene();
    const ibl = installIBL(scene, () => {});
    ibl.setWorkspace("ibl");
    const sync = document.querySelector("#ibl-live-sync");
    const intensity = document.querySelector("#ibl-intensity");
    const rotation = document.querySelector("#ibl-rotation");
    const form = document.querySelector("#ibl-form");
    const apply = form.querySelector("button[type=submit]");
    const status = document.querySelector("#ibl-status");
    const calls = [];
    let active = 0;
    window.fetch = (path, options) => {
      equal(path, "/api/ibl");
      equal(++active, 1);
      return new Promise((resolve) => calls.push({
        values: JSON.parse(options.body).intensities,
        sentAt: performance.now(),
        finish(ok = true) {
          active--;
          resolve(new Response(ok ? '{"result":null}' : '{"error":"offline"}', { status: ok ? 200 : 502 }));
        },
      }));
    };
    const waitFor = async (condition) => {
      for (let i = 0; !condition() && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert(condition(), "Timed out waiting for live sync");
    };
    const changeSync = (checked) => { sync.checked = checked; sync.dispatchEvent(new Event("change")); };
    const changeIntensity = (value) => { intensity.value = String(value); intensity.dispatchEvent(new Event("input")); };
    const image = document.createElement("canvas");
    image.width = 32; image.height = 16;
    const context = image.getContext("2d");
    context.fillStyle = "red";
    context.fillRect(0, 0, 32, 16);
    const blob = await new Promise((resolve) => image.toBlob(resolve));
    const input = document.querySelector("#ibl-file");
    const upload = (name) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([blob], name, { type: "image/png" }));
      input.files = transfer.files;
      input.dispatchEvent(new Event("change"));
    };
    assert(!sync.checked && form.querySelector("fieldset").disabled);
    upload("live.png");
    await waitFor(() => !form.querySelector("fieldset").disabled);
    changeIntensity(80);
    equal(calls.length, 0);
    changeSync(true);
    await waitFor(() => calls.length === 1);
    assert(apply.hidden && !form.querySelector("fieldset").disabled && !input.disabled);
    assert(Math.abs(calls[0].values[0][0] - 204) < 1e-8);
    equal(scene.fixtures[0].intensity.rgb, [0, 0, 0]);
    changeIntensity(60);
    changeIntensity(40);
    rotation.value = "90";
    rotation.dispatchEvent(new Event("input"));
    changeIntensity(20);
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    equal(calls.length, 1);
    assert(Math.abs(ibl.renderScene().fixtures[0].intensity.rgb[0] - 51) < 1e-8);
    calls[0].finish();
    await waitFor(() => calls.length === 2);
    assert(calls[1].sentAt - calls[0].sentAt >= 95, "Live updates are rate limited");
    assert(Math.abs(calls[1].values[0][0] - 51) < 1e-8);
    assert(Math.abs(scene.fixtures[0].intensity.rgb[0] - 204) < 1e-8);
    assert(status.dataset.state !== "success", "Older acknowledgements must not mark a newer draft synced");
    calls[1].finish();
    await waitFor(() => !apply.disabled);
    assert(sync.checked && status.dataset.state === "success");
    assert(Math.abs(scene.fixtures[0].intensity.rgb[0] - 51) < 1e-8);
    // Cancelling the pending timer sends nothing more.
    changeIntensity(30);
    changeSync(false);
    await new Promise((resolve) => setTimeout(resolve, 150));
    equal(calls.length, 2);
    assert(!apply.hidden);
    changeSync(true);
    await waitFor(() => calls.length === 3);
    // A replacement image remains importable while a sync is in flight.
    upload("replacement.png");
    await waitFor(() => document.querySelector("#ibl-filename").textContent === "replacement.png");
    changeIntensity(70);
    calls[2].finish(false);
    await waitFor(() => !apply.disabled);
    assert(!sync.checked && !apply.hidden);
    assert(status.dataset.state === "error" && status.textContent.includes("Live sync stopped"));
    assert(Math.abs(scene.fixtures[0].intensity.rgb[0] - 51) < 1e-8);
    assert(Math.abs(ibl.renderScene().fixtures[0].intensity.rgb[0] - 178.5) < 1e-8);
    await new Promise((resolve) => setTimeout(resolve, 150));
    equal(calls.length, 3);
    // Leaving IBL clears queued drafts but preserves an acknowledged in-flight update.
    changeSync(true);
    await waitFor(() => calls.length === 4);
    changeIntensity(90);
    ibl.setWorkspace("manual");
    assert(!sync.checked);
    calls[3].finish();
    await waitFor(() => !apply.disabled);
    await new Promise((resolve) => setTimeout(resolve, 150));
    equal(calls.length, 4);
    assert(Math.abs(scene.fixtures[0].intensity.rgb[0] - 178.5) < 1e-8);
    ibl.setWorkspace("ibl");
    assert(!sync.checked, "Returning to IBL does not restart hardware updates");
    changeSync(true);
    document.querySelector("#ibl-remove").click();
    await new Promise((resolve) => setTimeout(resolve, 150));
    equal(calls.length, 4);
    assert(!sync.checked && form.querySelector("fieldset").disabled);
  });
  await test("Workspace controls fit desktop windows with readable view presets and active previews", async () => {
    const frame = document.createElement("iframe");
    frame.srcdoc = (await (await originalFetch("/index.html")).text())
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
    const loaded = new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
    document.body.append(frame);
    await loaded;
    try {
      const doc = frame.contentDocument;
      for (const [width, height] of [[1280, 720], [1440, 900], [1920, 1080]]) {
        frame.style.width = `${width}px`;
        frame.style.height = `${height}px`;
        await new Promise((resolve) => setTimeout(resolve, 50));
        for (const mode of ["manual", "ibl", "playback", "olat"]) {
          doc.querySelector(".dashboard").dataset.workspace = mode;
          for (const tab of doc.querySelectorAll("[role=tab]")) {
            doc.getElementById(tab.getAttribute("aria-controls")).hidden = tab.dataset.workspace !== mode;
          }
          doc.querySelectorAll("[data-manual-controls]").forEach((el) => { el.hidden = mode !== "manual"; });
          const sequenceWorkspace = mode === "playback" || mode === "olat";
          doc.querySelector("#sequence-inspector").hidden = !sequenceWorkspace;
          doc.querySelector("#ibl-inspector").hidden = mode !== "ibl";
          doc.querySelector("#ibl-thumbnail").hidden = mode !== "ibl";
          doc.querySelector("#ibl-filename").textContent = mode === "ibl" ? "environment.exr" : "";
          const layers = doc.querySelector("#fixture-layers");
          const viewSettings = doc.querySelector("#ibl-view-settings");
          layers.hidden = mode === "ibl";
          viewSettings.hidden = mode !== "ibl";
          (mode === "ibl" ? viewSettings : layers).append(doc.querySelector("#labels-control"));
          const simulationPanel = doc.querySelector("#simulation-panel");
          if (sequenceWorkspace) doc.querySelector("#sequence-inspector").append(simulationPanel);
          else if (mode === "ibl") doc.querySelector("#ibl-inspector").append(simulationPanel);
          else doc.querySelector(".toolbar-left").insertBefore(simulationPanel, doc.querySelector(".camera-control"));
          doc.querySelectorAll("[data-workspace-controls]").forEach((el) => {
            el.hidden = el.dataset.workspaceControls !== mode;
          });
          doc.querySelector("#simulation-controls").hidden = false;
          doc.querySelector("#simulation-status").textContent = "Preview running · frame 1 of 168";
          doc.querySelector("#sequence-status").textContent = "Sequence imported successfully.";
          doc.querySelector("#capture-status").textContent = "OLAT requested.";
          doc.querySelector("#sequence-list").innerHTML = '<li><div>Example sequence<small>168 frames · 30 Hz</small></div><div class="sequence-actions"><button class="sequence-button">Play</button><button class="sequence-button danger-button">Delete</button></div></li>';
          await new Promise((resolve) => frame.contentWindow.requestAnimationFrame(resolve));
          assert(doc.documentElement.scrollHeight <= height + 1, `${mode}: page overflows at ${width}×${height}`);
          for (const toolbar of doc.querySelectorAll(".toolbar:not([hidden])")) {
            assert(toolbar.scrollHeight <= toolbar.clientHeight + 1, `${mode}: ${toolbar.className} ${toolbar.scrollHeight}/${toolbar.clientHeight} overflows at ${width}×${height}`);
          }
          for (const button of doc.querySelectorAll(".scene-controls-dock button")) {
            assert(button.scrollWidth <= button.clientWidth + 1, `${button.textContent.trim()}: text exceeds button width`);
            assert(frame.contentWindow.getComputedStyle(button).minHeight !== "0px", "View controls need a usable height");
          }
          const viewControls = doc.querySelector("#camera-controls").getBoundingClientRect();
          const presets = doc.querySelector(".view-grid").getBoundingClientRect();
          const reset = doc.querySelector("#reset-view").getBoundingClientRect();
          if (mode === "ibl") {
            assert(reset.left >= presets.right, "IBL presets and reset share one balanced row");
            assert(Math.abs(reset.top - presets.top) < 1, "IBL view controls align vertically");
            assert(layers.hidden && !viewSettings.hidden, "IBL hides layers and keeps labels with view controls");
          } else {
            assert(Math.abs(presets.width - reset.width) < 1, "Preset row and reset fill the same width");
            assert(reset.top >= presets.bottom, "Reset occupies a separate row below presets");
          }
          assert(Math.abs(reset.bottom - viewControls.bottom) < 1, "View controls fill their section vertically");
          assert(doc.querySelector(".canvas-shell").clientHeight >= 250, "Stage view remains usable");
          if (mode === "ibl") {
            const shell = doc.querySelector(".canvas-shell");
            const height3D = shell.clientHeight;
            shell.dataset.mode = "2d";
            assert(frame.contentWindow.getComputedStyle(doc.querySelector(".scene-controls-dock")).display === "none");
            assert(shell.clientHeight > height3D, "IBL 2D uses the space reclaimed from the dock");
            shell.dataset.mode = "3d";
          }
          const previewInputs = sequenceWorkspace ? [mode === "olat" ? "simulate-olat" : "simulation-file"] : [];
          for (const id of ["camera-trigger", "camera-start", "camera-stop", "simulation-stop", ...previewInputs]) {
            const bounds = doc.getElementById(id).getBoundingClientRect();
            assert(bounds.bottom <= height && bounds.top >= 0, `${id} outside window`);
          }
        }
      }
      // Narrow IBL layouts keep the view presets and reset readable too.
      doc.querySelector(".dashboard").dataset.workspace = "ibl";
      doc.querySelector("#fixture-layers").hidden = true;
      doc.querySelector("#ibl-view-settings").hidden = false;
      doc.querySelector("#ibl-view-settings").append(doc.querySelector("#labels-control"));
      for (const width of [390, 760, 1024]) {
        frame.style.width = `${width}px`;
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert(doc.documentElement.scrollWidth <= width, `IBL overflows horizontally at ${width}px`);
        for (const button of doc.querySelectorAll("#camera-controls button")) {
          assert(button.scrollWidth <= button.clientWidth + 1, `IBL ${button.textContent.trim()} overflows at ${width}px`);
        }
      }
    } finally { frame.remove(); }
  });
  await test("application starts with the canvas fallback", async () => {
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = "/assets/styles.css";
    const styled = new Promise((resolve, reject) => {
      stylesheet.onload = resolve;
      stylesheet.onerror = reject;
    });
    document.head.append(stylesheet);
    await styled;
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
    assert(document.querySelector("#fixture-layers").hidden);
    equal(document.querySelector("#labels-control").parentElement.id, "ibl-view-settings");
    equal(getComputedStyle(document.querySelector(".scene-controls-dock")).display, "none");
    assert(document.querySelector("[data-manual-controls]").hidden);
    for (const mode of ["playback", "olat"]) {
      document.querySelector(`#${mode}-tab`).click();
      assert(!document.querySelector("#sequence-inspector").hidden);
      assert(!document.querySelector(`[data-workspace-controls="${mode}"]`).hidden);
      assert(document.querySelector("#simulation-panel").parentElement.id === "sequence-inspector");
    }
    document.querySelector("#manual-tab").click();
    assert(document.querySelector("#ibl-inspector").hidden);
    assert(document.querySelector("#sequence-inspector").hidden);
    assert(!document.querySelector("#fixture-layers").hidden);
    equal(document.querySelector("#labels-control").parentElement.id, "fixture-layers");
    assert(getComputedStyle(document.querySelector(".scene-controls-dock")).display !== "none");
    assert(document.querySelector("#simulation-panel").parentElement.classList.contains("toolbar-left"));
  });

} catch (error) { failures.push(`Setup: ${error.stack}`); }
await originalFetch("/results", { method: "POST", body: JSON.stringify({ passed, failures }) });
