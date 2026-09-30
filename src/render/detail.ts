import { SphereNoise } from '../core/noise';
import { MAX_PEAK_EARTH_M, reliefScale } from '../core/presets';
import { bakeScalar, nearestCellOf, type TextureSampler } from '../grid/sampler';
import { Crust, type World } from '../sim/world';

/**
 * Sub-cell surface texture for the plate engine's worlds, added per pixel
 * when a map is painted. The simulation's cells are ~50–100 km wide; the
 * relief inside a cell (ridges, valleys, abyssal hills) is texture, not
 * simulation, so it lives here and not in the world's elevation (which the
 * metrics measure).
 *
 * The texture is scaled by the height above or below sea level, so it can
 * never move a coastline: the shoreline stays the simulation's.
 */
export function addSurfaceDetail(world: World, s: TextureSampler, elev: Float32Array): void {
  const { grid, params } = world;
  const noise = new SphereNoise(params.seed, 'drift-detail');
  const ageCell = new Float32Array(grid.count);
  for (let c = 0; c < grid.count; c++) ageCell[c] = Math.max(0, world.oceanAge[c]);
  const age = bakeScalar(s, grid.tris, ageCell);
  const cap = MAX_PEAK_EARTH_M * reliefScale(params.gravity);
  const { width, height } = s;
  const cosPhi = new Float64Array(width);
  const sinPhi = new Float64Array(width);
  for (let c = 0; c < width; c++) {
    const phi = (2 * Math.PI * (c + 0.5)) / width;
    cosPhi[c] = Math.cos(phi);
    sinPhi[c] = Math.sin(phi);
  }
  for (let r = 0; r < height; r++) {
    const lat = ((r + 0.5) / height - 0.5) * Math.PI;
    const y = Math.sin(lat);
    const cl = Math.cos(lat);
    for (let col = 0; col < width; col++) {
      const i = r * width + col;
      const x = -cosPhi[col] * cl;
      const z = sinPhi[col] * cl;
      let e = elev[i];
      if (e > 0) {
        // rugged ridges on high ground, a gentle roll on lowlands
        const rugged = smooth01((e - 600) / 1400);
        let tex = 0;
        if (rugged > 0) tex += rugged * 1.6 * (noise.ridged(x, y, z, 24, 7) - 0.45);
        if (rugged < 1) tex += (1 - rugged) * noise.fbm(x, y, z, 20, 7);
        e += Math.min(0.3 * e, 1500) * tex;
        e = softCap(e, cap);
      } else if (world.crust[nearestCellOf(s, grid.tris, i)] === Crust.Continent) {
        // shelves and drowned margins
        e += 0.15 * -e * noise.fbm(x, y, z, 20, 6);
      } else {
        // abyssal hills, rougher on young floor
        e += Math.min(0.3 * -e, 80 + 150 * Math.exp(-age[i] / 30)) * noise.fbm(x, y, z, 30, 6);
      }
      elev[i] = e;
    }
  }
}

function smooth01(t: number): number {
  const u = Math.min(1, Math.max(0, t));
  return u * u * (3 - 2 * u);
}

function softCap(e: number, cap: number): number {
  const knee = 0.7 * cap;
  if (e <= knee) return e;
  const room = cap - knee;
  return knee + room * (1 - Math.exp(-(e - knee) / room));
}
