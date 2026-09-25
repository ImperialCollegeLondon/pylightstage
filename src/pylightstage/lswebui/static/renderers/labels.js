import { resizeCanvas } from "../math.js";

/** Project with the exact WebGPU matrix, retaining depth for front-to-back layout. */
export function projectLabel(point, matrix, width, height, clipViewport = true) {
  const clip = [0, 1, 2, 3].map((row) => matrix[row + 12]
    + point.reduce((sum, value, axis) => sum + matrix[axis * 4 + row] * value, 0));
  if (clip[3] <= 0 || clip[2] < 0 || clip[2] > clip[3]) return null;
  const x = (clip[0] / clip[3] + 1) * width / 2;
  const y = (1 - clip[1] / clip[3]) * height / 2;
  if (clipViewport && (x < 0 || x > width || y < 0 || y > height)) return null;
  return { x, y, depth: clip[3] };
}

function overlaps(a, b) {
  return a.x < b.x + b.width + 4 && a.x + a.width + 4 > b.x
    && a.y < b.y + b.height + 4 && a.y + a.height + 4 > b.y;
}

/** Screen-space labels stay upright and a fixed CSS size at every orbit angle. */
export class StageLabels {
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d");
  }

  render(scene, matrix, enabled) {
    if (!matrix || !this.context) return;
    resizeCanvas(this.canvas);
    const { width, height } = this.canvas.getBoundingClientRect();
    if (!width || !height) return;
    const signature = JSON.stringify([
      ...matrix, scene.version, enabled, width, height,
      this.canvas.width, this.canvas.height,
    ]);
    if (signature === this.signature) return;
    this.signature = signature;
    const context = this.context;
    context.setTransform(this.canvas.width / width, 0, 0, this.canvas.height / height, 0, 0);
    context.clearRect(0, 0, width, height);
    if (!enabled || (!scene.visibility.rgb && !scene.visibility.white)) return;

    const hovered = scene.hoveredLogicalIndex;
    const arcs = Array.from({ length: scene.arcs }, () => []);
    const fixtureBounds = [];
    for (let index = 0; index < scene.logicalCount; index += 1) {
      const point = projectLabel(scene.getLogicalCentre(index), matrix, width, height);
      if (point) arcs[scene.fixtures[index].arc].push(point);
    }
    // A 0.06 world-unit half-extent encloses each physical cylinder in any
    // orientation (radius 0.052, half-depth 0.026). Project all eight corners
    // without viewport clipping so partially visible models are protected too.
    for (let index = 0; index < scene.count; index += 1) {
      const offset = index * scene.instanceStride;
      if (scene.instanceData[offset + 15] < 0.5) continue;
      const corners = [];
      for (const dx of [-0.06, 0.06]) for (const dy of [-0.06, 0.06]) {
        for (const dz of [-0.06, 0.06]) {
          const point = projectLabel([
            scene.instanceData[offset] + dx,
            scene.instanceData[offset + 1] + dy,
            scene.instanceData[offset + 2] + dz,
          ], matrix, width, height, false);
          if (point) corners.push(point);
        }
      }
      if (!corners.length) continue;
      const x = Math.min(...corners.map((point) => point.x));
      const y = Math.min(...corners.map((point) => point.y));
      fixtureBounds.push({ x, y,
        width: Math.max(...corners.map((point) => point.x)) - x,
        height: Math.max(...corners.map((point) => point.y)) - y });
    }
    const candidates = [];
    if (hovered !== null) {
      const point = projectLabel(scene.getLogicalCentre(hovered), matrix, width, height);
      const fixture = scene.fixtures[hovered];
      if (point) candidates.push({ points: [point], hovered: true,
        text: `Arc ${fixture.arc} · Fixture #${fixture.light}` });
    }
    arcs.forEach((points, arc) => {
      // Prefer the outside of the projected arc, including in top/bottom views.
      points.sort((a, b) => Math.hypot(b.x - width / 2, b.y - height / 2)
        - Math.hypot(a.x - width / 2, a.y - height / 2));
      if (points.length) candidates.push({ points, text: `Arc ${arc}` });
    });

    // Keep labels clear of the controls and orientation indicator as well as each other.
    const bounds = this.canvas.getBoundingClientRect();
    const occupied = [...this.canvas.parentElement.querySelectorAll(
      ".brush-toolbar, .interaction-hint:not([hidden]), .axis-indicator",
    )].map((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.left - bounds.left, y: rect.top - bounds.top,
        width: rect.width, height: rect.height };
    });
    occupied.push(...fixtureBounds);
    context.font = "600 11px ui-monospace, monospace";
    context.textBaseline = "middle";

    for (const candidate of candidates) {
      const { text } = candidate;
      const lines = candidate.hovered ? text.split(" · ") : [text];
      const labelWidth = Math.max(...lines.map((line) => context.measureText(line).width)) + 12;
      const labelHeight = lines.length * 14 + 8;
      const positions = [];
      for (const { x, y } of candidate.points) {
        const angle = Math.atan2(y - height / 2, x - width / 2);
        for (const distance of [24, 48, 72, 96]) {
          for (const turn of [0, -Math.PI / 4, Math.PI / 4, -Math.PI / 2, Math.PI / 2]) {
            const direction = angle + turn;
            positions.push([
              x + Math.cos(direction) * (distance + labelWidth / 2) - labelWidth / 2,
              y + Math.sin(direction) * (distance + labelHeight / 2) - labelHeight / 2,
            ]);
          }
        }
      }
      if (candidate.hovered) {
        // At close zoom, the nearest free space may be beyond the local offsets.
        const { x, y } = candidate.points[0];
        const fallback = [];
        for (let top = 6; top + labelHeight <= height - 6; top += 12) {
          for (let left = 6; left + labelWidth <= width - 6; left += 12) {
            fallback.push([left, top]);
          }
        }
        fallback.sort((a, b) => Math.hypot(a[0] + labelWidth / 2 - x, a[1] + labelHeight / 2 - y)
          - Math.hypot(b[0] + labelWidth / 2 - x, b[1] + labelHeight / 2 - y));
        positions.push(...fallback);
      }
      const boxes = positions.map(([left, top]) => ({
        x: Math.max(6, Math.min(width - labelWidth - 6, left)),
        y: Math.max(6, Math.min(height - labelHeight - 6, top)),
        width: labelWidth, height: labelHeight,
      }));
      let box = boxes.find((rect) => rect.x + rect.width <= width - 6
        && !occupied.some((other) => overlaps(rect, other)));
      // A hover tooltip must remain available even when zoomed models fill the
      // viewport. Only that transient tooltip may cover geometry, never arcs.
      if (!box && candidate.hovered) {
        box = boxes.find((rect) => rect.x + rect.width <= width - 6
          && !occupied.some((other) => !fixtureBounds.includes(other) && overlaps(rect, other)));
      }
      if (!box) continue;
      occupied.push(box);

      context.strokeStyle = candidate.hovered ? "#72ead8" : "#607d84";
      context.lineWidth = 1;
      if (candidate.hovered) {
        const { x, y } = candidate.points[0];
        context.beginPath();
        context.moveTo(x, y);
        context.lineTo(Math.max(box.x, Math.min(box.x + box.width, x)),
          Math.max(box.y, Math.min(box.y + box.height, y)));
        context.stroke();
      }
      context.fillStyle = "#091215";
      context.fillRect(box.x, box.y, box.width, box.height);
      context.strokeRect(box.x, box.y, box.width, box.height);
      context.fillStyle = candidate.hovered ? "#d9fff7" : "#c0d0d5";
      lines.forEach((line, index) => {
        context.fillText(line, box.x + 6, box.y + 11 + index * 14);
      });
    }
  }
}
