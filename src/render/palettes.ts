/**
 * Colour maps for the map modes. All return linear-ish sRGB bytes; the
 * textures are tagged sRGB on the GPU.
 */

export type RGB = [number, number, number];

type Stop = readonly [number, number, number, number]; // value, r, g, b

function ramp(stops: readonly Stop[], v: number, out: RGB): RGB {
  if (v <= stops[0][0]) {
    out[0] = stops[0][1]; out[1] = stops[0][2]; out[2] = stops[0][3];
    return out;
  }
  for (let i = 1; i < stops.length; i++) {
    const s1 = stops[i];
    if (v <= s1[0]) {
      const s0 = stops[i - 1];
      const t = (v - s0[0]) / (s1[0] - s0[0]);
      out[0] = s0[1] + (s1[1] - s0[1]) * t;
      out[1] = s0[2] + (s1[2] - s0[2]) * t;
      out[2] = s0[3] + (s1[3] - s0[3]) * t;
      return out;
    }
  }
  const s = stops[stops.length - 1];
  out[0] = s[1]; out[1] = s[2]; out[2] = s[3];
  return out;
}

/** Hypsometric tint (metres). */
const HYPSO: readonly Stop[] = [
  [-11000, 8, 14, 48], [-6000, 18, 38, 92], [-4000, 30, 70, 135], [-2000, 50, 110, 170],
  [-200, 95, 160, 205], [-1, 150, 200, 225],
  [0, 70, 125, 75], [300, 110, 150, 85], [800, 170, 170, 105], [1600, 175, 140, 90],
  [2800, 145, 105, 80], [4200, 185, 170, 160], [6000, 245, 245, 245], [9000, 255, 255, 255],
];

export function hypsometric(e: number, out: RGB): RGB {
  return ramp(HYPSO, e, out);
}

/** Ocean crust age (Myr): young = warm, old = cool. */
const AGE: readonly Stop[] = [
  [0, 220, 40, 40], [15, 240, 140, 40], [35, 240, 220, 70], [60, 110, 200, 90],
  [90, 60, 170, 200], [130, 50, 90, 190], [200, 70, 40, 130],
];

export function oceanAgeColor(age: number, out: RGB): RGB {
  return ramp(AGE, age, out);
}

// --- Satellite preview ------------------------------------------------------
// Until climate lands (M3), land colour comes from latitude + elevation only:
// a rough zonal model (wet tropics, subtropical dry belt, temperate, boreal,
// polar) so the planet reads like a planet. Replaced by Köppen biomes later.

const OCEAN: readonly Stop[] = [
  [-8000, 6, 18, 42], [-5000, 10, 28, 62], [-3000, 14, 40, 80], [-1000, 22, 60, 102],
  [-200, 34, 92, 120], [-40, 52, 122, 136], [0, 70, 140, 145],
];

const FOREST: RGB = [42, 70, 32];
const GRASS: RGB = [108, 120, 64];
const DESERT: RGB = [196, 164, 112];
const COLD_DESERT: RGB = [150, 136, 112];
const BOREAL: RGB = [36, 52, 36];
const TUNDRA: RGB = [112, 108, 88];
const ROCK: RGB = [118, 104, 92];
const ICE: RGB = [236, 240, 245];

function mix(a: RGB, b: RGB, t: number, out: RGB): RGB {
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  out[0] = a[0] + (b[0] - a[0]) * u;
  out[1] = a[1] + (b[1] - a[1]) * u;
  out[2] = a[2] + (b[2] - a[2]) * u;
  return out;
}

const tmpA: RGB = [0, 0, 0];
const tmpB: RGB = [0, 0, 0];

/**
 * @param e elevation m, @param latDeg latitude, @param wet 0–1 local
 * moisture jitter (noise), @param g relief scale (bigger on small worlds,
 * so snowlines scale with the terrain).
 */
export function satelliteColor(e: number, latDeg: number, wet: number, g: number, out: RGB): RGB {
  const alat = Math.abs(latDeg);
  if (e <= 0) {
    ramp(OCEAN, e / Math.min(g, 1.5), out);
    // sea ice near the poles
    const ice = smooth(72, 80, alat + 4 * (wet - 0.5));
    return mix(out, ICE, ice * 0.9, out);
  }
  // Effective latitude: 1 km of altitude ≈ 8° poleward (Worldbuilding Pasta).
  const eLat = alat + (8 * e) / 1000 / g;
  // Dryness: subtropical high at ~25°, plus noise.
  const dry = Math.max(0, 1 - Math.abs(alat - 25) / 13) * 0.75 + (wet - 0.5) * 1.6;
  // base vegetation by effective latitude
  if (eLat < 18) mix(FOREST, GRASS, smooth(8, 18, eLat), tmpA);
  else if (eLat < 45) mix(GRASS, FOREST, smooth(30, 45, eLat) * 0.7, tmpA);
  else if (eLat < 62) mix(FOREST, BOREAL, smooth(45, 58, eLat), tmpA);
  else mix(BOREAL, TUNDRA, smooth(60, 70, eLat), tmpA);
  // deserts
  const desert = alat < 40 ? DESERT : COLD_DESERT;
  mix(tmpA, desert, smooth(0.35, 0.75, dry), tmpB);
  // bare rock high up
  // (heights are ~60 km cell averages, so ranges read lower than their peaks)
  mix(tmpB, ROCK, smooth(1800, 3600, e / g) * 0.8, tmpB);
  // snow and ice caps
  const snow = smooth(66, 76, eLat + 3 * (wet - 0.5));
  return mix(tmpB, ICE, snow, out);
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export const BOUNDARY_COLORS: RGB[] = [
  [0, 0, 0],
  [230, 60, 50], // convergent
  [60, 150, 240], // divergent
  [120, 210, 90], // transform
];
