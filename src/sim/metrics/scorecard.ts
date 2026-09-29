import { MAX_PEAK_EARTH_M, reliefScale } from '../../core/presets';
import { MinHeap } from '../../core/heap';
import { buildHexGrid, type HexGrid } from '../../grid/hexgrid';
import { CellLocator } from '../../grid/locator';
import type { World } from '../world';
import { M } from '../../core/dmath';

/**
 * Planet scorecard.
 *
 * Earth is one possible planet, not the target. Each metric has:
 *   - a hard failure test for results that are physically impossible
 *     (e.g. ocean crust that never recycles, peaks above what gravity allows)
 *   - a wide "plausible" band; outside it the metric warns
 *   - Earth's value, shown for reference only
 * Bands scale with gravity where the physics does.
 */

export type MetricStatus = 'pass' | 'warn' | 'fail' | 'na';

export interface Metric {
  id: string;
  label: string;
  /** Headline value (null when not measurable yet). */
  value: number | null;
  /** Formatted value for display. */
  display: string;
  /** Plausible band, formatted. */
  band: string;
  /** Hard failure condition, formatted. */
  failIf: string;
  /** Earth reference, formatted. */
  earth: string;
  status: MetricStatus;
  /** Extra detail (why it warned or failed). */
  note?: string;
}

export interface Scorecard {
  metrics: Metric[];
  pass: number;
  warn: number;
  fail: number;
  ms: number;
}

const km = (v: number) => `${Math.round(v).toLocaleString('en-US')} km`;
const kmh = (m: number) => `${(m / 1000).toFixed(1)} km`;

export function scoreWorld(w: World): Scorecard {
  const t0 = performance.now();
  const G = reliefScale(w.params.gravity);
  const metrics: Metric[] = [
    hypsometry(w),
    meanLandElevation(w, G),
    landmasses(w),
    medianCrustAge(w),
    oldestCrust(w),
    highestPeak(w, G),
    deepestTrench(w, G),
    plateSpeeds(w),
    plateSizes(w),
    mountainBelts(w, G),
    shelfWidth(w),
    coastlineRoughness(w),
    {
      id: 'rivers',
      label: 'Rivers',
      value: null,
      display: 'from M4',
      band: 'closed basins ≤ ~30% of land',
      failIf: 'uphill flow or splits outside deltas',
      earth: '~21% closed',
      status: 'na',
    },
  ];
  const count = (s: MetricStatus) => metrics.filter((m) => m.status === s).length;
  return { metrics, pass: count('pass'), warn: count('warn'), fail: count('fail'), ms: Math.round(performance.now() - t0) };
}

function status(fail: boolean, inBand: boolean): MetricStatus {
  return fail ? 'fail' : inBand ? 'pass' : 'warn';
}

// --- height distribution ------------------------------------------------------

export function hypsometryPeaks(w: World): { land: number; ocean: number; bimodal: boolean } {
  const BIN = 250;
  const LO = -12000;
  const nb = Math.ceil(32000 / BIN);
  const hist = new Float64Array(nb);
  const { elevation, grid } = w;
  for (let c = 0; c < grid.count; c++) {
    const b = Math.min(nb - 1, Math.max(0, Math.floor((elevation[c] - LO) / BIN)));
    hist[b] += grid.area[c];
  }
  // light smoothing so single-bin noise doesn't make fake peaks
  const sm = new Float64Array(nb);
  for (let i = 0; i < nb; i++) sm[i] = (hist[Math.max(0, i - 1)] + 2 * hist[i] + hist[Math.min(nb - 1, i + 1)]) / 4;
  const binOf = (e: number) => Math.floor((e - LO) / BIN);
  let li = binOf(-1000), oi = binOf(-12000);
  for (let i = binOf(-1000); i < nb; i++) if (sm[i] > sm[li]) li = i;
  for (let i = 0; i <= binOf(-1500); i++) if (sm[i] > sm[oi]) oi = i;
  let dip = Infinity;
  for (let i = oi; i <= li; i++) dip = Math.min(dip, sm[i]);
  const bimodal = dip < 0.6 * Math.min(sm[li], sm[oi]);
  return { land: LO + (li + 0.5) * BIN, ocean: LO + (oi + 0.5) * BIN, bimodal };
}

function hypsometry(w: World): Metric {
  const p = hypsometryPeaks(w);
  const inBand = p.land >= -500 && p.land <= 1500 && p.ocean >= -6500 && p.ocean <= -2500;
  return {
    id: 'hypsometry',
    label: 'Height distribution',
    value: p.ocean,
    display: `${p.land >= 0 ? '+' : ''}${kmh(p.land)} / ${kmh(p.ocean)}`,
    band: 'land peak −0.5–1.5 km, ocean peak −6.5 to −2.5 km',
    failIf: 'no separate land and ocean peaks',
    earth: '~+0.1 km and ~−4.5 km',
    status: status(!p.bimodal, inBand),
    note: p.bimodal ? undefined : 'Heights form one hump: continents and ocean floor are not distinct.',
  };
}

function meanLandElevation(w: World, G: number): Metric {
  let sum = 0, area = 0;
  for (let c = 0; c < w.grid.count; c++) {
    if (w.elevation[c] > 0) {
      sum += w.elevation[c] * w.grid.area[c];
      area += w.grid.area[c];
    }
  }
  const v = area > 0 ? sum / area : 0;
  const lo = 200 * G, hi = 2000 * G;
  return {
    id: 'land-mean',
    label: 'Mean land height',
    value: v,
    display: `${Math.round(v).toLocaleString('en-US')} m`,
    band: `${Math.round(lo)}–${Math.round(hi).toLocaleString('en-US')} m`,
    failIf: '—',
    earth: '~840 m',
    status: status(false, v >= lo && v <= hi),
  };
}

/** Area shares of connected landmasses, largest first. */
export function landmassShares(w: World): number[] {
  const { grid, elevation } = w;
  const seen = new Uint8Array(grid.count);
  const shares: number[] = [];
  let total = 0;
  for (let s = 0; s < grid.count; s++) {
    if (elevation[s] <= 0 || seen[s]) continue;
    let a = 0;
    const stack = [s];
    seen[s] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      a += grid.area[c];
      for (let k = grid.nbrOffset[c]; k < grid.nbrOffset[c + 1]; k++) {
        const d = grid.nbrs[k];
        if (!seen[d] && elevation[d] > 0) { seen[d] = 1; stack.push(d); }
      }
    }
    shares.push(a);
    total += a;
  }
  return shares.map((a) => a / total).sort((a, b) => b - a);
}

function landmasses(w: World): Metric {
  const sh = landmassShares(w);
  const largest = sh[0] ?? 0;
  const big = sh.filter((f) => f >= 0.01).length;
  return {
    id: 'landmass',
    label: 'Landmasses',
    value: largest,
    display: `largest ${Math.round(largest * 100)}% of land, ${big} over 1%`,
    band: 'largest 20–95% of land',
    failIf: '—',
    earth: 'Afro-Eurasia 57%',
    status: status(false, largest >= 0.2 && largest <= 0.95),
  };
}

// --- ocean crust age -------------------------------------------------------------

function medianCrustAge(w: World): Metric {
  const cells: number[] = [];
  for (let c = 0; c < w.grid.count; c++) if (w.oceanAge[c] >= 0) cells.push(c);
  cells.sort((a, b) => w.oceanAge[a] - w.oceanAge[b]);
  let total = 0;
  for (const c of cells) total += w.grid.area[c];
  let acc = 0, v = 0;
  for (const c of cells) {
    acc += w.grid.area[c];
    v = w.oceanAge[c];
    if (acc >= 0.5 * total) break;
  }
  return {
    id: 'crust-median',
    label: 'Median ocean crust age',
    value: v,
    display: `${Math.round(v)} Myr`,
    band: '30–120 Myr',
    failIf: '—',
    earth: '~60 Myr',
    status: status(false, v >= 30 && v <= 120),
  };
}

function oldestCrust(w: World): Metric {
  // 99.9th percentile by area, so a few odd cells don't decide it
  const cells: number[] = [];
  for (let c = 0; c < w.grid.count; c++) if (w.oceanAge[c] >= 0) cells.push(c);
  cells.sort((a, b) => w.oceanAge[a] - w.oceanAge[b]);
  let total = 0;
  for (const c of cells) total += w.grid.area[c];
  let acc = 0, v = 0;
  for (const c of cells) {
    acc += w.grid.area[c];
    v = w.oceanAge[c];
    if (acc >= 0.999 * total) break;
  }
  return {
    id: 'crust-age',
    label: 'Oldest ocean crust',
    value: v,
    display: `${Math.round(v)} Myr`,
    band: '100–350 Myr',
    // Old sea floor is dense and founders on its own, but slowly: a few
    // hundred Myr is unusual (sluggish plates), a billion years means the
    // plates simply are not recycling it.
    failIf: 'over ~1,000 Myr (sea floor not recycled)',
    earth: '~180 Myr (outlier ~340)',
    status: status(v > 1000, v >= 100 && v <= 350),
  };
}

// --- relief extremes -------------------------------------------------------------

function highestPeak(w: World, G: number): Metric {
  const cap = MAX_PEAK_EARTH_M * G;
  const v = w.stats.maxElevation;
  return {
    id: 'peak',
    label: 'Highest peak',
    value: v,
    display: kmh(v),
    band: `${kmh(0.35 * cap)}–${kmh(cap)}`,
    failIf: `above ${kmh(cap)} (gravity limit)`,
    earth: '8.8 km',
    status: status(v > cap * 1.001, v >= 0.35 * cap),
    note: v < 0.35 * cap ? 'No major mountain range formed.' : undefined,
  };
}

function deepestTrench(w: World, G: number): Metric {
  const v = -w.stats.minElevation;
  const g = Math.min(G, 1.5);
  return {
    id: 'trench',
    label: 'Deepest trench',
    value: v,
    display: kmh(v),
    band: `${kmh(6000 * g)}–${kmh(12000 * g)}`,
    failIf: `deeper than ${kmh(16000 * g)}`,
    earth: '11.0 km',
    status: status(v > 16000 * g, v >= 6000 * g && v <= 12000 * g),
  };
}

// --- plates ---------------------------------------------------------------------------

function plateSpeeds(w: World): Metric {
  let sum = 0, area = 0, max = 0;
  for (let c = 0; c < w.grid.count; c++) {
    const s = M.hypot(w.velocity[3 * c], w.velocity[3 * c + 1], w.velocity[3 * c + 2]);
    sum += s * w.grid.area[c];
    area += w.grid.area[c];
    if (s > max) max = s;
  }
  const mean = sum / area;
  return {
    id: 'plate-speed',
    label: 'Plate speeds',
    value: mean,
    display: `mean ${Math.round(mean)}, max ${Math.round(max)} mm/yr`,
    band: 'mean 10–100 mm/yr',
    failIf: 'any plate over ~200 mm/yr',
    earth: 'mean ~40, max ~100 mm/yr',
    status: status(max > 200, mean >= 10 && mean <= 100),
  };
}

function plateSizes(w: World): Metric {
  const total = 4 * Math.PI;
  const fr = w.plates.map((p) => p.area / total).filter((f) => f > 0).sort((a, b) => b - a);
  const largest = fr[0] ?? 0;
  const major = fr.filter((f) => f >= 0.02).length;
  const inBand = largest >= 0.08 && largest <= 0.45 && major >= 3;
  return {
    id: 'plate-size',
    label: 'Plate sizes',
    value: largest,
    display: `largest ${Math.round(largest * 100)}%, ${major} over 2%`,
    band: 'largest 8–45%, at least 3 over 2%',
    failIf: 'one plate over ~75% of the surface',
    earth: 'largest 20%, 8 over 2%',
    status: status(largest > 0.75, inBand),
  };
}

// --- mountain belts ------------------------------------------------------------------

export function mountainBeltWidths(w: World, G: number): { widths: number[]; areas: number[] } {
  const { grid, elevation } = w;
  const R = w.params.radiusKm;
  const thr = 1500 * G;
  const isM = new Uint8Array(grid.count);
  for (let c = 0; c < grid.count; c++) isM[c] = elevation[c] > thr ? 1 : 0;
  const comp = new Int32Array(grid.count).fill(-1);
  const widths: number[] = [];
  const areas: number[] = [];
  const cellKm2 = R * R;
  const scratch = new Float64Array(grid.count).fill(Infinity);
  let id = 0;
  for (let s = 0; s < grid.count; s++) {
    if (!isM[s] || comp[s] >= 0) continue;
    const members: number[] = [];
    const stack = [s];
    comp[s] = id;
    while (stack.length) {
      const c = stack.pop()!;
      members.push(c);
      for (let k = grid.nbrOffset[c]; k < grid.nbrOffset[c + 1]; k++) {
        const d = grid.nbrs[k];
        if (isM[d] && comp[d] < 0) {
          comp[d] = id;
          stack.push(d);
        }
      }
    }
    id++;
    if (members.length < 4) continue; // too small to call a belt
    let a = 0;
    for (const c of members) a += grid.area[c] * cellKm2;
    // Length ≈ the belt's diameter along itself (two passes of farthest point).
    const p = farthestWithin(grid, R, members, comp, id - 1, members[0], scratch);
    const q = farthestWithin(grid, R, members, comp, id - 1, p.best, scratch);
    const length = Math.max(q.bd, Math.sqrt(a));
    widths.push(a / length);
    areas.push(a);
  }
  return { widths, areas };
}

/** Dijkstra inside one component; returns the farthest member from `from`. */
function farthestWithin(grid: HexGrid, R: number, members: number[], comp: Int32Array, id: number, from: number, dist: Float64Array) {
  const heap = new MinHeap(64);
  dist[from] = 0;
  heap.push(0, from);
  while (heap.size) {
    const d0 = heap.peekKey();
    const c = heap.pop();
    if (d0 > dist[c]) continue;
    for (let k = grid.nbrOffset[c]; k < grid.nbrOffset[c + 1]; k++) {
      const n = grid.nbrs[k];
      if (comp[n] !== id) continue;
      const dot = grid.pos[3 * c] * grid.pos[3 * n] + grid.pos[3 * c + 1] * grid.pos[3 * n + 1] + grid.pos[3 * c + 2] * grid.pos[3 * n + 2];
      const nd = d0 + M.acos(Math.min(1, dot)) * R;
      if (nd < dist[n]) {
        dist[n] = nd;
        heap.push(nd, n);
      }
    }
  }
  let best = from, bd = 0;
  for (const c of members) {
    if (dist[c] > bd && Number.isFinite(dist[c])) { bd = dist[c]; best = c; }
  }
  for (const c of members) dist[c] = Infinity; // reset only what we touched
  return { best, bd };
}

function mountainBelts(w: World, G: number): Metric {
  const { widths } = mountainBeltWidths(w, G);
  if (widths.length === 0) {
    return {
      id: 'belts',
      label: 'Mountain belts',
      value: null,
      display: 'none',
      band: '100–1,500 km wide',
      failIf: 'wider than ~2,000 km',
      earth: 'Andes ~300 km, Tibet ~1,000 km',
      status: 'warn',
      note: `No land above ${kmh(1500 * G)} forms a belt.`,
    };
  }
  const sorted = [...widths].sort((a, b) => a - b);
  const widest = sorted[sorted.length - 1];
  const median = sorted[Math.floor(sorted.length / 2)];
  return {
    id: 'belts',
    label: 'Mountain belts',
    value: widest,
    display: `${widths.length} belts, median ${km(median)}, widest ${km(widest)}`,
    band: '100–1,500 km wide',
    failIf: 'wider than ~2,000 km',
    earth: 'Andes ~300 km, Tibet ~1,000 km',
    status: status(widest > 2000, widest <= 1500 && median >= 50),
  };
}

// --- continental shelves -------------------------------------------------------------

/** Coastline length in km on a grid for a land mask (hex side ≈ spacing / √3). */
function coastLengthKm(grid: HexGrid, land: Uint8Array, R: number): number {
  let L = 0;
  for (let e = 0; e < grid.edgeCount; e++) {
    if (land[grid.edges[2 * e]] !== land[grid.edges[2 * e + 1]]) L += (grid.edgeLen[e] * R) / Math.sqrt(3);
  }
  return L;
}

export function meanShelfWidthKm(w: World): number {
  const { grid, elevation } = w;
  const R = w.params.radiusKm;
  const land = new Uint8Array(grid.count);
  for (let c = 0; c < grid.count; c++) land[c] = elevation[c] > 0 ? 1 : 0;
  // shelf = shallow sea (0 to −200 m) connected to a coast through shallow sea
  const shallow = new Uint8Array(grid.count);
  const stack: number[] = [];
  for (let c = 0; c < grid.count; c++) {
    if (land[c] || elevation[c] < -200) continue;
    for (let k = grid.nbrOffset[c]; k < grid.nbrOffset[c + 1]; k++) {
      if (land[grid.nbrs[k]]) { shallow[c] = 1; stack.push(c); break; }
    }
  }
  while (stack.length) {
    const c = stack.pop()!;
    for (let k = grid.nbrOffset[c]; k < grid.nbrOffset[c + 1]; k++) {
      const d = grid.nbrs[k];
      if (!shallow[d] && !land[d] && elevation[d] >= -200) { shallow[d] = 1; stack.push(d); }
    }
  }
  let area = 0;
  for (let c = 0; c < grid.count; c++) if (shallow[c]) area += grid.area[c] * R * R;
  const L = coastLengthKm(grid, land, R);
  return L > 0 ? area / L : 0;
}

function shelfWidth(w: World): Metric {
  const v = meanShelfWidthKm(w);
  return {
    id: 'shelf',
    label: 'Continental shelves',
    value: v,
    display: `${km(v)} mean width`,
    band: '0–400 km',
    failIf: '—',
    earth: '~80 km mean',
    status: status(false, v <= 400),
  };
}

// --- coastline roughness (divider method across grid scales) -------------------------

const coarseGrids = new Map<number, HexGrid>();
function coarseGrid(freq: number): HexGrid {
  let g = coarseGrids.get(freq);
  if (!g) {
    g = buildHexGrid(freq);
    coarseGrids.set(freq, g);
  }
  return g;
}

/**
 * Fractal dimension D of the coastline from how its length grows as the
 * measuring scale shrinks: L(ε) ∝ ε^(1−D). The land mask is resampled onto
 * coarser hex grids (½, ¼, ⅛ of the resolution) and measured on each.
 */
export function coastlineDimension(w: World): number | null {
  const { grid, elevation } = w;
  const R = w.params.radiusKm;
  const fine = new Uint8Array(grid.count);
  for (let c = 0; c < grid.count; c++) fine[c] = elevation[c] > 0 ? 1 : 0;
  const pts: [number, number][] = [];
  const loc = new CellLocator(grid);
  for (const div of [1, 2, 4, 8]) {
    const f = Math.floor(grid.freq / div);
    if (f < 12) break;
    let g = grid;
    let land = fine;
    if (div > 1) {
      g = coarseGrid(f);
      land = new Uint8Array(g.count);
      for (let c = 0; c < g.count; c++) land[c] = fine[loc.nearest(g.pos[3 * c], g.pos[3 * c + 1], g.pos[3 * c + 2])];
    }
    const L = coastLengthKm(g, land, R);
    let s = 0;
    for (let e = 0; e < g.edgeCount; e++) s += g.edgeLen[e];
    const eps = (s / g.edgeCount) * R;
    if (L > 0) pts.push([M.log(eps), M.log(L)]);
  }
  if (pts.length < 3) return null;
  const n = pts.length;
  const mx = pts.reduce((a, p) => a + p[0], 0) / n;
  const my = pts.reduce((a, p) => a + p[1], 0) / n;
  let num = 0, den = 0;
  for (const [x, y] of pts) {
    num += (x - mx) * (y - my);
    den += (x - mx) * (x - mx);
  }
  const slope = num / den;
  return 1 - slope;
}

function coastlineRoughness(w: World): Metric {
  const d = coastlineDimension(w);
  if (d === null) {
    return { id: 'coast', label: 'Coastline roughness', value: null, display: 'grid too coarse', band: '1.1–1.4', failIf: 'below ~1.05', earth: '~1.25', status: 'na' };
  }
  return {
    id: 'coast',
    label: 'Coastline roughness',
    value: d,
    display: `D = ${d.toFixed(2)}`,
    band: '1.1–1.4',
    failIf: 'below ~1.05 (smooth blobs)',
    earth: '~1.25',
    status: status(d < 1.05, d >= 1.1 && d <= 1.4),
  };
}
