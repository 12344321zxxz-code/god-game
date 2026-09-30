import { SphereNoise } from '../../core/noise';
import { randRange, randUnitVec, streamFor, type Rng } from '../../core/rng';
import type { PlanetParams } from '../../core/presets';
import type { HexGrid } from '../../grid/hexgrid';
import { Boundary, Crust, type Plate } from '../world';
import { M } from '../../core/dmath';

/**
 * M1 "snapshot" tectonics (Gainey / Red Blob style): plates are assigned
 * once and given a rigid rotation; boundaries are classified from the
 * relative motion of the plates on each side. No time stepping yet — the M2
 * drift sim replaces this module but writes the same outputs.
 */
export interface TectonicSnapshot {
  plates: Plate[];
  plate: Uint16Array;
  crust: Uint8Array;
  velocity: Float32Array;
  boundary: Uint8Array;
  boundaryRate: Float32Array;
  /** For boundary cells: plate id on the other side of the strongest edge. */
  otherPlate: Int32Array;
}

/** Relative speed below which a boundary counts as transform, mm/yr. */
const MIN_NORMAL_RATE = 6;

/**
 * `contFraction`: share of the surface under continental crust (default
 * land × 1.1 + 2 %, i.e. land plus a thin shelf rim, as the sketch wants).
 */
export function runSnapshotTectonics(grid: HexGrid, params: PlanetParams, contFraction?: number): TectonicSnapshot {
  const crust = continentalCrust(grid, params, contFraction);
  const plate = growPlates(grid, params, streamFor(params.seed, 'plates'));
  const plates = makePlates(grid, params, plate, crust, streamFor(params.seed, 'plate-motion'));
  const velocity = surfaceVelocity(grid, params, plate, plates);
  const { boundary, boundaryRate, otherPlate } = classifyBoundaries(grid, plate, velocity);
  return { plates, plate, crust, velocity, boundary, boundaryRate, otherPlate };
}

// ---------------------------------------------------------------------------
// Continental crust: cratons blended with noise, thresholded to a target area.

function continentalCrust(grid: HexGrid, params: PlanetParams, contFraction?: number): Uint8Array {
  const rng = streamFor(params.seed, 'cratons');
  const noise = new SphereNoise(params.seed, 'continents');
  const { count, pos, area } = grid;
  // Continental crust covers the land target plus shelves.
  const target = contFraction ?? Math.min(0.9, params.landFraction * 1.1 + 0.02);
  const k = Math.max(1, Math.round(params.continents));
  // Angular radius so that k cratons roughly cover the target area.
  const baseSigma = Math.sqrt((4 * target) / k) * 0.9;
  const cr: { c: [number, number, number]; s: number; w: number }[] = [];
  for (let i = 0; i < k; i++) {
    // Rejection-sample so cratons don't sit on top of each other.
    let c = randUnitVec(rng);
    for (let tries = 0; tries < 30; tries++) {
      const ok = cr.every((o) => c[0] * o.c[0] + c[1] * o.c[1] + c[2] * o.c[2] < M.cos(baseSigma * 1.1));
      if (ok) break;
      c = randUnitVec(rng);
    }
    cr.push({ c, s: baseSigma * randRange(rng, 0.6, 1.4), w: randRange(rng, 0.8, 1.2) });
  }
  const score = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const x = pos[3 * i], y = pos[3 * i + 1], z = pos[3 * i + 2];
    // Domain warp gives irregular, peninsula-rich outlines.
    const wx = x + 0.25 * noise.fbm(x, y, z, 1.7, 3);
    const wy = y + 0.25 * noise.fbm(y + 5.2, z, x, 1.7, 3);
    const wz = z + 0.25 * noise.fbm(z - 3.1, x, y, 1.7, 3);
    const wl = M.hypot(wx, wy, wz);
    let s = 0;
    for (const o of cr) {
      const d = (wx * o.c[0] + wy * o.c[1] + wz * o.c[2]) / wl;
      const ang = M.acos(Math.max(-1, Math.min(1, d)));
      s = Math.max(s, o.w * M.exp(-((ang / o.s) * (ang / o.s))));
    }
    score[i] = s + 0.28 * noise.fbm(x, y, z, 2.3, 5) + 0.1 * noise.fbm(x, y, z, 7, 3);
  }
  const threshold = areaQuantile(score, area, 1 - target);
  const crust = new Uint8Array(count);
  for (let i = 0; i < count; i++) crust[i] = score[i] >= threshold ? Crust.Continent : Crust.Ocean;
  return crust;
}

/** Value v such that the area-weighted fraction of cells with field < v is q. */
export function areaQuantile(field: ArrayLike<number>, area: ArrayLike<number>, q: number): number {
  const n = field.length;
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  idx.sort((a, b) => field[a] - field[b]);
  let total = 0;
  for (let i = 0; i < n; i++) total += area[i];
  let acc = 0;
  const goal = q * total;
  for (let i = 0; i < n; i++) {
    acc += area[idx[i]];
    if (acc >= goal) return field[idx[i]];
  }
  return field[idx[n - 1]];
}

// ---------------------------------------------------------------------------
// Plates: weighted random flood fill, then a smoothing pass.

function growPlates(grid: HexGrid, params: PlanetParams, rng: Rng): Uint16Array {
  const { count, nbrOffset, nbrs } = grid;
  const n = Math.max(2, Math.min(200, Math.round(params.plates)));
  const plate = new Uint16Array(count).fill(0xffff);
  const weight = new Float64Array(n);
  const frontierCell: number[] = [];
  const frontierPlate: number[] = [];
  for (let p = 0; p < n; p++) {
    let c = Math.floor(rng() * count);
    while (plate[c] !== 0xffff) c = Math.floor(rng() * count);
    plate[c] = p;
    // Skewed growth rates → a mix of large and small plates, like Earth.
    weight[p] = 0.15 + 0.85 * M.pow(rng(), 1.5);
    for (let k = nbrOffset[c]; k < nbrOffset[c + 1]; k++) {
      frontierCell.push(nbrs[k]);
      frontierPlate.push(p);
    }
  }
  let assigned = n;
  while (assigned < count && frontierCell.length > 0) {
    const i = Math.floor(rng() * frontierCell.length);
    const c = frontierCell[i];
    const p = frontierPlate[i];
    if (plate[c] !== 0xffff) {
      frontierCell[i] = frontierCell[frontierCell.length - 1];
      frontierPlate[i] = frontierPlate[frontierPlate.length - 1];
      frontierCell.pop();
      frontierPlate.pop();
      continue;
    }
    if (rng() > weight[p]) continue;
    plate[c] = p;
    assigned++;
    frontierCell[i] = frontierCell[frontierCell.length - 1];
    frontierPlate[i] = frontierPlate[frontierPlate.length - 1];
    frontierCell.pop();
    frontierPlate.pop();
    for (let k = nbrOffset[c]; k < nbrOffset[c + 1]; k++) {
      const d = nbrs[k];
      if (plate[d] === 0xffff) {
        frontierCell.push(d);
        frontierPlate.push(p);
      }
    }
  }
  // Majority smoothing removes single-cell spikes along boundaries.
  const counts = new Map<number, number>();
  for (let pass = 0; pass < 2; pass++) {
    const next = plate.slice();
    for (let c = 0; c < count; c++) {
      counts.clear();
      for (let k = nbrOffset[c]; k < nbrOffset[c + 1]; k++) {
        const p = plate[nbrs[k]];
        counts.set(p, (counts.get(p) ?? 0) + 1);
      }
      let best = plate[c];
      let bestN = counts.get(best) ?? 0;
      for (const [p, m] of counts) if (m > bestN + 1) { best = p; bestN = m; }
      next[c] = best;
    }
    plate.set(next);
  }
  return plate;
}

function makePlates(grid: HexGrid, params: PlanetParams, plate: Uint16Array, crust: Uint8Array, rng: Rng): Plate[] {
  let n = 0;
  for (let c = 0; c < grid.count; c++) n = Math.max(n, plate[c] + 1);
  const area = new Float64Array(n);
  const cont = new Float64Array(n);
  for (let c = 0; c < grid.count; c++) {
    area[plate[c]] += grid.area[c];
    if (crust[c] === Crust.Continent) cont[plate[c]] += grid.area[c];
  }
  const plates: Plate[] = [];
  for (let p = 0; p < n; p++) {
    const cf = area[p] > 0 ? cont[p] / area[p] : 0;
    // Continental plates move slower (Earth: ~1–4 cm/yr vs up to ~10 for oceanic).
    const speed = cf > 0.35 ? randRange(rng, 12, 45) : randRange(rng, 25, 95); // mm/yr = km/Myr
    const omega = (speed / params.radiusKm) * (rng() < 0.5 ? -1 : 1);
    const hue = (p * 0.61803398875) % 1;
    plates.push({
      id: p,
      pole: randUnitVec(rng),
      omega,
      continentalFraction: cf,
      density: 1 - cf + 0.35 * rng(),
      area: area[p],
      color: hslToRgb(hue, 0.55, 0.55 + 0.1 * ((p % 3) - 1)),
    });
  }
  return plates;
}

function surfaceVelocity(grid: HexGrid, params: PlanetParams, plate: Uint16Array, plates: Plate[]): Float32Array {
  const v = new Float32Array(3 * grid.count);
  const R = params.radiusKm;
  for (let c = 0; c < grid.count; c++) {
    const pl = plates[plate[c]];
    const [wx, wy, wz] = pl.pole;
    const x = grid.pos[3 * c], y = grid.pos[3 * c + 1], z = grid.pos[3 * c + 2];
    const k = pl.omega * R;
    v[3 * c] = k * (wy * z - wz * y);
    v[3 * c + 1] = k * (wz * x - wx * z);
    v[3 * c + 2] = k * (wx * y - wy * x);
  }
  return v;
}

export function classifyBoundaries(grid: HexGrid, plate: Uint16Array, v: Float32Array) {
  const { count, edges, edgeCount, pos } = grid;
  const boundary = new Uint8Array(count);
  const boundaryRate = new Float32Array(count);
  const otherPlate = new Int32Array(count).fill(-1);
  const best = new Float32Array(count); // |rate| of the strongest edge seen
  const shearAt = new Float32Array(count);
  for (let e = 0; e < edgeCount; e++) {
    const a = edges[2 * e], b = edges[2 * e + 1];
    if (plate[a] === plate[b]) continue;
    // unit direction a → b
    let dx = pos[3 * b] - pos[3 * a], dy = pos[3 * b + 1] - pos[3 * a + 1], dz = pos[3 * b + 2] - pos[3 * a + 2];
    const l = M.hypot(dx, dy, dz);
    dx /= l; dy /= l; dz /= l;
    const rx = v[3 * b] - v[3 * a], ry = v[3 * b + 1] - v[3 * a + 1], rz = v[3 * b + 2] - v[3 * a + 2];
    const along = rx * dx + ry * dy + rz * dz;
    const conv = -along; // > 0 when b moves toward a
    const shear = M.hypot(rx - along * dx, ry - along * dy, rz - along * dz);
    for (const [c, o] of [[a, b], [b, a]]) {
      if (otherPlate[c] < 0 || Math.abs(conv) > best[c]) {
        best[c] = Math.abs(conv);
        boundaryRate[c] = conv;
        shearAt[c] = shear;
        otherPlate[c] = plate[o];
      }
    }
  }
  for (let c = 0; c < count; c++) {
    if (otherPlate[c] < 0) continue;
    const r = boundaryRate[c];
    if (r > MIN_NORMAL_RATE && r >= 0.5 * shearAt[c]) boundary[c] = Boundary.Convergent;
    else if (r < -MIN_NORMAL_RATE && -r >= 0.5 * shearAt[c]) boundary[c] = Boundary.Divergent;
    else boundary[c] = Boundary.Transform;
  }
  return { boundary, boundaryRate, otherPlate };
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}
