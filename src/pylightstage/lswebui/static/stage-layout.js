// Nominal geometry shared by IBL and both renderers; angles are radians.
export const MAX_ELEVATION = 1.08;

/** Hardware IDs comprise two halves interleaved from top to bottom. */
export function fixtureRow(light, lightsPerArc = 14) {
  const half = Math.ceil(lightsPerArc / 2);
  return light < half ? light * 2 : (light - half) * 2 + 1;
}

export function lightAtRow(row, lightsPerArc = 14) {
  return row % 2 === 0 ? row / 2 : Math.ceil(lightsPerArc / 2) + (row - 1) / 2;
}

export function fixtureElevation(light, lightsPerArc = 14) {
  return MAX_ELEVATION - fixtureRow(light, lightsPerArc) * 2 * MAX_ELEVATION / (lightsPerArc - 1);
}
