import { lightAtRow, MAX_ELEVATION } from "./stage-layout.js";

const LINEAR_SRGB = Float64Array.from({ length: 256 }, (_, value) => {
  const s = value / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
});

/** Integrate original sRGB pixels, treated as constant radiance over their area.
 * Latitude cells meet halfway between nominal fixture elevations; end cells
 * extend to the poles. Pixel/cell intersections use exact solid angle, including
 * partial pixels at cell edges. Cache latitude integrals for responsive sliders.
 */
export class EnvironmentMap {
  constructor({ data, width, height }, lightsPerArc = 14) {
    this.width = width;
    this.lightsPerArc = lightsPerArc;
    this.columns = new Float64Array(lightsPerArc * width * 3);
    const step = 2 * MAX_ELEVATION / (lightsPerArc - 1);
    for (let row = 0; row < lightsPerArc; row += 1) {
      const upper = row === 0 ? Math.PI / 2 : MAX_ELEVATION - (row - 0.5) * step;
      const lower = row === lightsPerArc - 1 ? -Math.PI / 2 : MAX_ELEVATION - (row + 0.5) * step;
      const area = Math.sin(upper) - Math.sin(lower);
      const firstY = Math.max(0, Math.floor((0.5 - upper / Math.PI) * height));
      const lastY = Math.min(height, Math.ceil((0.5 - lower / Math.PI) * height));
      const light = lightAtRow(row, lightsPerArc);
      for (let y = firstY; y < lastY; y += 1) {
        const pixelUpper = (0.5 - y / height) * Math.PI;
        const pixelLower = (0.5 - (y + 1) / height) * Math.PI;
        const weight = (Math.sin(Math.min(upper, pixelUpper))
          - Math.sin(Math.max(lower, pixelLower))) / area;
        for (let x = 0; x < width; x += 1) {
          const offset = (y * width + x) * 4;
          const target = (light * width + x) * 3;
          const alphaWeight = data[offset + 3] / 255 * weight;
          for (let channel = 0; channel < 3; channel += 1) {
            this.columns[target + channel] += LINEAR_SRGB[data[offset + channel]] * alphaWeight;
          }
        }
      }
    }
  }

  /** Panorama centre faces +X (arc 0); +90 degrees moves it to arc 3 of 12. */
  sample(arcs, rotation = 0, exposure = 0) {
    const { width, lightsPerArc, columns } = this;
    const values = Array.from({ length: arcs * lightsPerArc }, () => [0, 0, 0]);
    const cellWidth = width / arcs;
    const turns = ((rotation % 360) + 360) % 360 / 360;
    const gain = 255 * 2 ** exposure;
    for (let arc = 0; arc < arcs; arc += 1) {
      const centre = width * (0.5 + arc / arcs - turns);
      const start = centre - cellWidth / 2;
      const end = centre + cellWidth / 2;
      for (let x = Math.floor(start); x < Math.ceil(end); x += 1) {
        const weight = (Math.min(end, x + 1) - Math.max(start, x)) / cellWidth;
        const column = ((x % width) + width) % width;
        for (let light = 0; light < lightsPerArc; light += 1) {
          const target = values[arc * lightsPerArc + light];
          const offset = (light * width + column) * 3;
          for (let channel = 0; channel < 3; channel += 1) {
            target[channel] += columns[offset + channel] * weight;
          }
        }
      }
    }
    return values.map((rgb) => rgb.map((value) => Math.min(255, Math.max(0, gain * value))));
  }
}

export function sampleEnvironment(pixels, arcs, lightsPerArc, rotation = 0, exposure = 0) {
  return new EnvironmentMap(pixels, lightsPerArc).sample(arcs, rotation, exposure);
}
