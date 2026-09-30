import { SphereNoise } from '../../core/noise';
import { MAX_PEAK_EARTH_M, reliefScale, type PlanetParams } from '../../core/presets';
import { hashString } from '../../core/rng';
import type { HexGrid } from '../../grid/hexgrid';
import { distanceField } from '../../grid/distance';
import { loadTecto, P, PARAM_COUNT, type TectoOutput, type TectoStats } from '../../engine/tecto';
import { buildElevation, smoothField } from '../terrain/elevation';
import { Crust, Orogeny, type Plate } from '../world';
import { classifyBoundaries, hslToRgb, runSnapshotTectonics } from './snapshot';
import { M } from '../../core/dmath';

/**
 * M2b drift tectonics. The M1 snapshot supplies the starting plates and
 * crust; the Rust engine then runs the plate history (motion from forces,
 * subduction, collision, rifting, hot spots, isostasy, erosion) for
 * `params.simMyr` million years. The finish converts crust to metres and
 * sets sea level.
 */
export interface DriftResult {
  plates: Plate[];
  plate: Uint16Array;
  crust: Uint8Array;
  velocity: Float32Array;
  boundary: Uint8Array;
  boundaryRate: Float32Array;
  oceanAge: Float32Array;
  orogeny: Uint8Array;
  thickness: Float32Array;
  elevation: Float32Array;
  landFraction: number;
  drift: TectoStats;
}

/** Set DRIFT_LOG=1 (Node) to print history counters while running. */
const LOG = typeof process !== 'undefined' && !!process.env?.DRIFT_LOG;

/** Set DRIFT_DUMP=path (Node) to write the engine's inputs for native debugging (engine/examples/run.rs). */
const DUMP = typeof process !== 'undefined' ? process.env?.DRIFT_DUMP : undefined;

async function dumpInitAsync(path: string, grid: HexGrid, prm: Float64Array, s: { plate: Uint32Array; cont: Uint8Array; thick: Float32Array; age: Float32Array; omega: Float64Array }) {
  const fs = await import('node:fs');
  const parts: ArrayBufferView[] = [];
  const head = new Uint32Array([grid.count, grid.nbrs.length, prm.length, s.omega.length / 3]);
  parts.push(head, grid.pos, grid.nbrOffset, grid.nbrs, grid.area, prm, s.plate, s.cont, s.thick, s.age, s.omega);
  const bufs = parts.map((p) => {
    const b = Buffer.from(p.buffer, p.byteOffset, p.byteLength);
    const pad = (8 - (b.length % 8)) % 8;
    return Buffer.concat([b, Buffer.alloc(pad)]);
  });
  fs.writeFileSync(path, Buffer.concat(bufs));
}
function dumpInit(...a: Parameters<typeof dumpInitAsync>) {
  void dumpInitAsync(...a);
}

export type DriftProgress = (fraction: number, myr: number) => void;

/** Continental thickness (km) that floats at elevation e (km, datum). Inverse of the engine's isostasy. */
export function thicknessForElevation(eKm: number): number {
  const e = eKm < 0 ? eKm / 1.45 : eKm;
  return (e + 5.3) / 0.1515;
}

export async function runDrift(grid: HexGrid, params: PlanetParams, progress: DriftProgress = () => {}): Promise<DriftResult> {
  // --- starting state from the M1 snapshot --------------------------------
  // Continental crust covers land plus its drowned margins (Earth: 41 % of
  // the surface for 29 % land). With too little, sea level has to sit high
  // on the continents' own plains and every sea-level rise floods them.
  const snap = runSnapshotTectonics(grid, params, Math.min(0.9, params.landFraction + 0.04));
  fillEnclosedSeas(grid, snap.crust, 0.004);
  const m1 = buildElevation(grid, params, snap);
  const n = grid.count;
  const plate = new Uint32Array(n);
  const cont = new Uint8Array(n);
  const thick = new Float32Array(n);
  const age = new Float32Array(n);
  // Plates must carry whole continents. The M1 plates were drawn
  // independently of the continents, so their boundaries slice through
  // them — and a boundary inside a continent immediately rifts it or
  // crumples it, which shredded every world into strips and islands.
  // Each continent goes wholly to the plate holding most of it, together
  // with a ring of sea floor, so plate boundaries start out at sea (like
  // Earth's, where they mostly run through the oceans).
  const startPlate = continentsInsidePlates(grid, params.radiusKm, snap.crust, snap.plate, snap.plates.length);
  const used = new Map<number, number>();
  for (let c = 0; c < n; c++) {
    if (!used.has(startPlate[c])) used.set(startPlate[c], used.size);
    plate[c] = used.get(startPlate[c])!;
  }
  // Continental crust = plains + drowned margins. The outer band of each
  // continent — as wide as needed to hold the continental crust that is not
  // land (Earth: ~30 % of it) — is a stretched margin thinning seaward from
  // ~34 km to ~20 km, so the starting coastline runs along the margin and
  // the plains (~38.5 km) stand ~0.5 km above the sea. Too narrow a margin
  // put sea level on the plains themselves, and every later rise of sea
  // level flooded the continents' interiors.
  const edge: number[] = [];
  for (let c = 0; c < n; c++) {
    if (snap.crust[c] !== Crust.Continent) continue;
    for (let k = grid.nbrOffset[c]; k < grid.nbrOffset[c + 1]; k++) {
      if (snap.crust[grid.nbrs[k]] !== Crust.Continent) {
        edge.push(c);
        break;
      }
    }
  }
  const inland = distanceField(grid, params.radiusKm, edge, undefined, 2000).dist;
  const crustNoise = new SphereNoise(params.seed, 'drift-crust');
  const contCells: number[] = [];
  let contArea = 0;
  for (let c = 0; c < n; c++) if (snap.crust[c] === Crust.Continent) { contCells.push(c); contArea += grid.area[c]; }
  contCells.sort((a, b) => inland[a] - inland[b]);
  const marginShare = Math.max(0.1, 1 - params.landFraction / Math.max(1e-6, contArea / (4 * Math.PI)));
  let acc = 0, marginKm = 0;
  for (const c of contCells) {
    acc += grid.area[c];
    marginKm = inland[c];
    if (acc >= marginShare * contArea) break;
  }
  // (capped: wider margins would sink every neck and peninsula)
  marginKm = Math.min(250, Math.max(marginKm, 60));
  for (let c = 0; c < n; c++) {
    if (snap.crust[c] === Crust.Continent) {
      cont[c] = 1;
      const x = grid.pos[3 * c], y = grid.pos[3 * c + 1], z = grid.pos[3 * c + 2];
      // broad, gentle variation only (cratons and basins thousands of km
      // across); small-scale bumps here became blotchy inland seas later
      const plain = 40 + 4 * crustNoise.fbm(x, y, z, 1.3, 3);
      const u = Math.min(inland[c], 2000) / marginKm;
      thick[c] = u < 1 ? 20 + 14 * u : u < 1.6 ? 34 + (plain - 34) * smoothT((u - 1) / 0.6) : plain;
    } else {
      // 7 km of basalt plus the sediment blanket old floor carries (the
      // run settles near ~1 km on average; starting bare made sea level
      // creep up as the blanket built, drowning the continents)
      thick[c] = 7 + Math.min(1.5, (0.55 * Math.min(180, Math.max(0, m1.oceanAge[c]))) / 50);
      // M1 ages run old (median ~110 Myr); a planet with moving plates keeps
      // its sea floor young (Earth: median ~60). Starting near that steady
      // state keeps the basins — and so sea level — from drifting at first.
      age[c] = 0.55 * Math.min(180, Math.max(0, m1.oceanAge[c]));
    }
  }
  const omega = new Float64Array(3 * used.size);
  for (const [old, i] of used) {
    const p = snap.plates[old];
    omega[3 * i] = p.pole[0] * p.omega;
    omega[3 * i + 1] = p.pole[1] * p.omega;
    omega[3 * i + 2] = p.pole[2] * p.omega;
  }

  // --- run the engine -------------------------------------------------------
  const prm = new Float64Array(PARAM_COUNT);
  const areaScale = (params.radiusKm / 6371) * (params.radiusKm / 6371);
  prm[P.radius] = params.radiusKm;
  prm[P.gravity] = params.gravity;
  prm[P.seed] = hashString(params.seed);
  prm[P.meanSpeed] = params.mantleSpeed;
  prm[P.minPlates] = Math.max(3, Math.round(params.plates * 0.5));
  prm[P.maxPlates] = Math.max(6, Math.round(params.plates * 1.5));
  prm[P.hotspots] = Math.max(2, Math.round(40 * areaScale));
  prm[P.riftRate] = 1;
  prm[P.erosion] = 1;
  prm[P.maxDt] = 2;
  prm[P.landFraction] = params.landFraction;
  if (DUMP) dumpInit(DUMP, grid, prm, { plate, cont, thick, age, omega });
  const tecto = await loadTecto();
  let out: TectoOutput;
  try {
    tecto.create(grid, prm);
    tecto.init({ plate, cont, thick, age, omega });
    const total = Math.max(0, params.simMyr);
    let t = 0;
    progress(0, 0);
    while (t < total - 1e-6) {
      t = tecto.run(Math.min(5, total - t));
      progress(t / total, t);
      // let the event loop breathe (UI on the main-thread fallback, messages in a worker)
      await new Promise((r) => setTimeout(r, 0));
      if (LOG && Math.round(t) % 50 === 0) {
        const s = tecto.output().stats;
        console.log(`t=${t.toFixed(0)} plates=${s.plates} cont=${s.contFraction.toFixed(3)} sea=${s.seaLevelKm.toFixed(2)} sub=${s.subductedSr.toFixed(1)} new=${s.createdSr.toFixed(1)} eroded=${s.erodedSrKm.toFixed(2)} H=${s.meanContThick.toFixed(1)} budget=[${s.budget.map((b) => b.toFixed(1)).join(' ')}] rifts=${s.rifts} merges=${s.merges} inits=${s.subductionStarts} steps=${s.steps}`);
      }
    }
    out = tecto.output();
  } finally {
    tecto.dispose();
  }
  return finish(grid, params, out);
}

function finish(grid: HexGrid, params: PlanetParams, out: TectoOutput): DriftResult {
  const n = grid.count;
  const R = params.radiusKm;
  const plates: Plate[] = out.plates.map((p, i) => {
    const w = M.hypot(...p.omega);
    const cf = p.area > 0 ? p.contArea / p.area : 0;
    const hue = (p.id * 0.61803398875) % 1;
    return {
      id: i,
      pole: w > 0 ? [p.omega[0] / w, p.omega[1] / w, p.omega[2] / w] : [0, 0, 1],
      omega: w,
      continentalFraction: cf,
      density: 1 - cf,
      area: p.area,
      color: hslToRgb(hue, 0.55, 0.55 + 0.1 * ((p.id % 3) - 1)),
    };
  });
  const plate = new Uint16Array(n);
  const velocity = new Float32Array(3 * n);
  for (let c = 0; c < n; c++) {
    const pi = Math.min(out.owner[c], plates.length - 1);
    plate[c] = pi;
    const pl = out.plates[pi];
    const [wx, wy, wz] = pl.omega;
    const x = grid.pos[3 * c], y = grid.pos[3 * c + 1], z = grid.pos[3 * c + 2];
    velocity[3 * c] = R * (wy * z - wz * y);
    velocity[3 * c + 1] = R * (wz * x - wx * z);
    velocity[3 * c + 2] = R * (wx * y - wy * x);
  }
  const { boundary, boundaryRate } = classifyBoundaries(grid, plate, velocity);
  const oceanAge = new Float32Array(n);
  for (let c = 0; c < n; c++) oceanAge[c] = out.cont[c] ? -1 : out.age[c];

  // --- metres, texture, sea level ------------------------------------------
  const noise = new SphereNoise(params.seed, 'drift-detail');
  const elevation = new Float32Array(n);
  for (let c = 0; c < n; c++) elevation[c] = out.elevKm[c] * 1000;
  // one light pass takes the edge off single-cell steps
  smoothField(grid, elevation, 1);
  // Sea level comes from the engine's fixed ocean volume: the land fraction
  // starts at params.landFraction and then follows the planet's history.
  const seaLevel = out.stats.seaLevelKm * 1000;
  const cap = MAX_PEAK_EARTH_M * reliefScale(params.gravity);
  let land = 0;
  for (let c = 0; c < n; c++) {
    const x = grid.pos[3 * c], y = grid.pos[3 * c + 1], z = grid.pos[3 * c + 2];
    let e = elevation[c] - seaLevel;
    // Sub-cell texture, scaled to the height itself so it can never push a
    // cell across sea level (that used to pepper lowlands with fake lakes
    // and fray every coast): rugged ridges on high ground, a gentle roll on
    // lowlands and shelves, abyssal hills on the ocean floor.
    if (e > 0) {
      const rugged = smooth01((e - 600) / 1400);
      const tex = rugged * 1.6 * (noise.ridged(x, y, z, 24, 4) - 0.45) + (1 - rugged) * noise.fbm(x, y, z, 20, 4);
      e += Math.min(0.3 * e, 1500) * tex;
    } else if (out.cont[c]) {
      e += 0.15 * -e * noise.fbm(x, y, z, 20, 3);
    } else {
      e += Math.min(0.3 * -e, 80 + 150 * M.exp(-Math.max(0, out.age[c]) / 30)) * noise.fbm(x, y, z, 30, 3);
    }
    if (e > 0) e = softCap(e, cap);
    elevation[c] = e;
    if (e > 0) land += grid.area[c];
  }
  const orogeny = new Uint8Array(n);
  for (let c = 0; c < n; c++) orogeny[c] = out.orogeny[c] <= Orogeny.Hotspot ? out.orogeny[c] : 0;
  return {
    plates,
    plate,
    crust: out.cont,
    velocity,
    boundary,
    boundaryRate,
    oceanAge,
    orogeny,
    thickness: out.thick,
    elevation,
    landFraction: land / (4 * Math.PI),
    drift: out.stats,
  };
}

function smooth01(t: number): number {
  const u = Math.min(1, Math.max(0, t));
  return u * u * (3 - 2 * u);
}

function softCap(e: number, cap: number): number {
  const knee = 0.7 * cap;
  if (e <= knee) return e;
  const room = cap - knee;
  return knee + room * (1 - M.exp(-(e - knee) / room));
}

/**
 * Reassigns plates so that no continent is split between plates and each
 * continent sits inside its plate with a ~300 km rim of ocean floor.
 */
export function continentsInsidePlates(grid: HexGrid, radiusKm: number, crust: Uint8Array, plate: ArrayLike<number>, nPlates: number): Uint16Array {
  const n = grid.count;
  const out = Uint16Array.from(plate as ArrayLike<number>);
  // continents = connected components of continental crust
  const comp = new Int32Array(n).fill(-1);
  const compPlate: number[] = [];
  const cells: number[] = [];
  for (let s = 0; s < n; s++) {
    if (crust[s] !== Crust.Continent || comp[s] >= 0) continue;
    const id = compPlate.length;
    const votes = new Float64Array(nPlates);
    const stack = [s];
    comp[s] = id;
    while (stack.length) {
      const c = stack.pop()!;
      cells.push(c);
      votes[plate[c]] += grid.area[c];
      for (let k = grid.nbrOffset[c]; k < grid.nbrOffset[c + 1]; k++) {
        const d = grid.nbrs[k];
        if (crust[d] === Crust.Continent && comp[d] < 0) {
          comp[d] = id;
          stack.push(d);
        }
      }
    }
    let best = 0;
    for (let p = 1; p < nPlates; p++) if (votes[p] > votes[best]) best = p;
    compPlate.push(best);
  }
  for (const c of cells) out[c] = compPlate[comp[c]];
  // the ocean rim goes with its nearest continent
  const coast: number[] = [];
  for (let c = 0; c < n; c++) {
    if (comp[c] < 0) continue;
    for (let k = grid.nbrOffset[c]; k < grid.nbrOffset[c + 1]; k++) {
      if (comp[grid.nbrs[k]] < 0) {
        coast.push(c);
        break;
      }
    }
  }
  const rim = distanceField(grid, radiusKm, coast, undefined, 300);
  for (let c = 0; c < n; c++) {
    if (comp[c] >= 0 || rim.source[c] < 0) continue;
    out[c] = compPlate[comp[coast[rim.source[c]]]];
  }
  return out;
}

function smoothT(t: number): number {
  const u = Math.min(1, Math.max(0, t));
  return u * u * (3 - 2 * u);
}

/**
 * Ocean-crust pockets enclosed by a continent and smaller than `maxShare`
 * of the surface become continental crust: the sketch's noise leaves small
 * holes that would otherwise start life as deep, drowned inland seas.
 */
function fillEnclosedSeas(grid: HexGrid, crust: Uint8Array, maxShare: number): void {
  const n = grid.count;
  const seen = new Uint8Array(n);
  const limit = maxShare * 4 * Math.PI;
  for (let s0 = 0; s0 < n; s0++) {
    if (seen[s0] || crust[s0] === Crust.Continent) continue;
    const cells: number[] = [];
    const stack = [s0];
    seen[s0] = 1;
    let area = 0;
    while (stack.length) {
      const c = stack.pop()!;
      cells.push(c);
      area += grid.area[c];
      for (let k = grid.nbrOffset[c]; k < grid.nbrOffset[c + 1]; k++) {
        const d = grid.nbrs[k];
        if (!seen[d] && crust[d] !== Crust.Continent) {
          seen[d] = 1;
          stack.push(d);
        }
      }
    }
    if (area < limit) for (const c of cells) crust[c] = Crust.Continent;
  }
}
