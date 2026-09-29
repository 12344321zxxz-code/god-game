import { SphereNoise } from '../../core/noise';
import { MAX_PEAK_EARTH_M, reliefScale, type PlanetParams } from '../../core/presets';
import { hashString } from '../../core/rng';
import type { HexGrid } from '../../grid/hexgrid';
import { loadTecto, P, PARAM_COUNT, type TectoOutput, type TectoStats } from '../../engine/tecto';
import { buildElevation, smoothField } from '../terrain/elevation';
import { Crust, Orogeny, type Plate } from '../world';
import { areaQuantile, classifyBoundaries, hslToRgb, runSnapshotTectonics } from './snapshot';
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
  return (e + 4.7) / 0.1515;
}

export async function runDrift(grid: HexGrid, params: PlanetParams, progress: DriftProgress = () => {}): Promise<DriftResult> {
  // --- starting state from the M1 snapshot --------------------------------
  const snap = runSnapshotTectonics(grid, params);
  const m1 = buildElevation(grid, params, snap);
  const n = grid.count;
  const plate = new Uint32Array(n);
  const cont = new Uint8Array(n);
  const thick = new Float32Array(n);
  const age = new Float32Array(n);
  for (let c = 0; c < n; c++) {
    plate[c] = snap.plate[c];
    if (snap.crust[c] === Crust.Continent) {
      cont[c] = 1;
      // M1 heights (+0.6 km so typical interiors start near 35 km)
      thick[c] = Math.min(70, Math.max(26, thicknessForElevation(m1.elevation[c] / 1000 + 0.3)));
    } else {
      thick[c] = 7;
      age[c] = Math.max(0, m1.oceanAge[c]);
    }
  }
  const omega = new Float64Array(3 * snap.plates.length);
  snap.plates.forEach((p, i) => {
    omega[3 * i] = p.pole[0] * p.omega;
    omega[3 * i + 1] = p.pole[1] * p.omega;
    omega[3 * i + 2] = p.pole[2] * p.omega;
  });

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
  const seaLevel = areaQuantile(elevation, grid.area, 1 - params.landFraction);
  const cap = MAX_PEAK_EARTH_M * reliefScale(params.gravity);
  let land = 0;
  for (let c = 0; c < n; c++) {
    const x = grid.pos[3 * c], y = grid.pos[3 * c + 1], z = grid.pos[3 * c + 2];
    let e = elevation[c] - seaLevel;
    // sub-cell texture: rugged in mountains, gentle elsewhere, abyssal hills at sea
    if (e > 800) e += (e - 400) * 0.22 * (noise.ridged(x, y, z, 24, 4) - 0.45);
    else if (e > 0) e += 90 * noise.fbm(x, y, z, 20, 4);
    else if (!out.cont[c]) e += (80 + 150 * M.exp(-Math.max(0, out.age[c]) / 30)) * noise.fbm(x, y, z, 30, 3);
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

function softCap(e: number, cap: number): number {
  const knee = 0.7 * cap;
  if (e <= knee) return e;
  const room = cap - knee;
  return knee + room * (1 - M.exp(-(e - knee) / room));
}
