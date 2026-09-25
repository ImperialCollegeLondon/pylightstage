/** Average linear-light pixels over each fixture's angular cell, weighted by solid angle.
 * Panorama centre faces +X (arc 0); its right-hand quarter faces +Z (arc 3).
 * Geometry follows StageScene's evenly spaced elevations, from -1.08 to +1.08 radians.
 */
export function sampleEnvironment({ data, width, height }, arcs, lightsPerArc, rotation = 0, exposure = 0) {
  const sums = Array.from({ length: arcs * lightsPerArc }, () => [0, 0, 0, 0]);
  const linear = Array.from({ length: 256 }, (_, value) => {
    const s = value / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  for (let y = 0; y < height; y += 1) {
    const elevation = (0.5 - (y + 0.5) / height) * Math.PI;
    const light = Math.max(0, Math.min(lightsPerArc - 1,
      Math.round((elevation + 1.08) / 2.16 * (lightsPerArc - 1))));
    const weight = Math.cos(elevation);
    for (let x = 0; x < width; x += 1) {
      const direction = (x + 0.5) / width - 0.5 + rotation / 360;
      const arc = ((Math.round(direction * arcs) % arcs) + arcs) % arcs;
      const sum = sums[arc * lightsPerArc + light];
      const offset = (y * width + x) * 4;
      const alpha = data[offset + 3] / 255;
      for (let channel = 0; channel < 3; channel += 1) {
        sum[channel] += linear[data[offset + channel]] * alpha * weight;
      }
      sum[3] += weight;
    }
  }
  const gain = 255 * 2 ** exposure;
  return sums.map((sum) => sum.slice(0, 3).map(
    (value) => Math.min(255, gain * value / (sum[3] || 1)),
  ));
}
