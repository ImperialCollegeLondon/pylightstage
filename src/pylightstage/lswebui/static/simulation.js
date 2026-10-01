import { previewSequence } from "./api.js";
import { query, errorMessage } from "./dom.js";
import { StageScene } from "./scene.js";

/** Clock-driven local preview; never mutates acknowledged hardware state. */
export class LightingSimulation {
  constructor(appliedScene) {
    this.appliedScene = appliedScene;
    this.scene = new StageScene(appliedScene.arcs, appliedScene.lightsPerArc);
    this.active = false;
    this.playing = false;
    this.frame = -1;
  }

  start(sequence, now = performance.now()) {
    if (!sequence.frames.length || !Number.isFinite(sequence.capture_hz) || sequence.capture_hz <= 0) {
      throw new Error("Simulation requires frames and a positive capture rate.");
    }
    this.sequence = sequence;
    this.baseline = this.appliedScene.fixtures.map(({ intensity }) => ({
      rgb: [...intensity.rgb], white: [...intensity.white],
    }));
    this.active = true;
    this.frame = -1;
    this.seek(0, now);
    this.playing = true;
  }

  seek(index, now = performance.now()) {
    const target = Math.max(0, Math.min(this.sequence.frames.length - 1, Math.floor(index)));
    // Resolve omitted channels backwards, so seeking and dropped animation frames
    // preserve the sequence's hold-last-value semantics without replaying every frame.
    for (const channel of ["rgb", "white"]) {
      let grid;
      for (let i = target; i >= 0; i--) {
        const candidate = this.sequence.frames[i][`${channel}_fixtures`];
        if (candidate?.length) { grid = candidate; break; }
      }
      this.scene.fixtures.forEach(({ arc, light }, i) => {
        this.scene.setFixtureIntensity(arc, light, channel,
          grid ? grid[arc][light].map((value) => value / 257) : this.baseline[i][channel]);
      });
    }
    this.frame = target;
    this.origin = now - target * 1000 / this.sequence.capture_hz;
  }

  tick(now = performance.now()) {
    if (!this.active || !this.playing) return;
    const index = Math.floor((now - this.origin) * this.sequence.capture_hz / 1000);
    const origin = this.origin;
    if (index !== this.frame) this.seek(index, now);
    this.origin = origin;
    if (index >= this.sequence.frames.length) this.playing = false;
  }

  toggle(now = performance.now()) {
    this.tick(now);
    if (!this.playing) this.origin = now - this.frame * 1000 / this.sequence.capture_hz;
    this.playing = !this.playing;
  }

  stop() { this.active = this.playing = false; }
}

export function olatSequence(scene, rate, channel) {
  const grid = () => Array.from({ length: scene.arcs }, () =>
    Array.from({ length: scene.lightsPerArc }, () => [0, 0, 0]));
  return {
    name: "OLAT", capture_hz: rate,
    frames: scene.fixtures.map(({ arc, light }) => {
      const frame = { rgb_fixtures: grid(), white_fixtures: grid() };
      frame[`${channel}_fixtures`][arc][light] = [65535, 65535, 65535];
      return frame;
    }),
  };
}

export function installSimulation(appliedScene) {
  const simulation = new LightingSimulation(appliedScene);
  const controls = query("#simulation-controls");
  const status = query("#simulation-status");
  const label = query("#simulation-label");
  const slider = query("#simulation-frame");
  const pause = query("#simulation-pause");
  let generation = 0;
  function update() {
    controls.hidden = label.hidden = !simulation.active;
    if (!simulation.active) return;
    slider.max = String(simulation.sequence.frames.length - 1);
    slider.value = String(simulation.frame);
    pause.textContent = simulation.playing ? "Pause" : "Resume";
    label.textContent = `Simulation · ${simulation.sequence.name} · ${simulation.frame + 1}/${simulation.sequence.frames.length}${simulation.playing ? "" : " · paused"}`;
    slider.setAttribute("aria-valuetext", `Frame ${simulation.frame + 1}`);
  }
  function stop() {
    generation++;
    simulation.stop();
    status.textContent = "";
    update();
  }
  query("#simulate-olat").addEventListener("click", () => {
    const rate = query("#capture-hz").valueAsNumber;
    if (!Number.isFinite(rate) || rate <= 0) {
      status.textContent = "Enter a positive, finite capture rate.";
      return;
    }
    generation++;
    simulation.start(olatSequence(appliedScene, rate, query("#simulation-channel").value));
    status.textContent = "Local OLAT sweep: arc order, then light order. No hardware commands.";
    update();
  });
  query("#simulation-file").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    const current = ++generation;
    status.textContent = "Decoding simulation…";
    try {
      if (!file.size || file.size > 64 * 1024 * 1024) throw new Error("Choose a file between 1 byte and 64 MiB.");
      const sequence = await previewSequence(file);
      if (current !== generation) return;
      simulation.start(sequence);
      status.textContent = "Local playback simulation. No hardware commands.";
      update();
    } catch (error) {
      if (current === generation) status.textContent = errorMessage(error);
    }
  });
  pause.addEventListener("click", () => { simulation.toggle(); update(); });
  query("#simulation-restart").addEventListener("click", () => {
    simulation.seek(0); simulation.playing = true; update();
  });
  query("#simulation-stop").addEventListener("click", stop);
  slider.addEventListener("input", () => {
    simulation.playing = false; simulation.seek(Number(slider.value)); update();
  });
  return {
    stop,
    renderScene(fallback) {
      if (!simulation.active) return fallback;
      simulation.tick();
      for (const channel of ["rgb", "white"]) {
        simulation.scene.setLayerVisibility(channel, appliedScene.visibility[channel]);
      }
      update();
      return simulation.scene;
    },
  };
}
