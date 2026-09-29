import type { PlanetParams } from '../core/presets';
import { buildHexGrid, meanSpacingKm, type HexGrid } from '../grid/hexgrid';
import { runSnapshotTectonics } from './tectonics/snapshot';
import { runDrift } from './tectonics/drift';
import { buildElevation } from './terrain/elevation';
import { scoreWorld } from './metrics/scorecard';
import type { World } from './world';
import { initDeterministicMath } from '../engine/tecto';

export type ProgressFn = (stage: string, fraction: number) => void;

const gridCache = new Map<number, HexGrid>();

export function getGrid(freq: number): HexGrid {
  let g = gridCache.get(freq);
  if (!g) {
    g = buildHexGrid(freq);
    // Keep at most two grids in memory.
    if (gridCache.size >= 2) gridCache.delete(gridCache.keys().next().value!);
    gridCache.set(freq, g);
  }
  return g;
}

/** Runs the full pipeline: grid → tectonics → elevation → score. */
export async function generateWorld(params: PlanetParams, progress: ProgressFn = () => {}): Promise<World> {
  const timings: Record<string, number> = {};
  const t0 = performance.now();
  const mark = (label: string, since: number) => (timings[label] = Math.round(performance.now() - since));

  // same seed → same planet in every browser (see core/dmath.ts)
  await initDeterministicMath();
  progress('Building hex grid', 0.02);
  const grid = getGrid(params.gridFreq);
  mark('grid', t0);

  let world: World;
  if (params.engine === 'snapshot') {
    progress('Placing plates', 0.25);
    const t1 = performance.now();
    const tect = runSnapshotTectonics(grid, params);
    mark('tectonics', t1);
    progress('Raising mountains', 0.55);
    const t2 = performance.now();
    const h = buildElevation(grid, params, tect);
    mark('elevation', t2);
    world = {
      params, grid, plates: tect.plates, plate: tect.plate, crust: tect.crust, velocity: tect.velocity,
      boundary: tect.boundary, boundaryRate: tect.boundaryRate, oceanAge: h.oceanAge, orogeny: h.orogeny,
      elevation: h.elevation, stats: stats(grid, params, h.elevation, h.landFraction, timings),
    };
  } else {
    const t1 = performance.now();
    const d = await runDrift(grid, params, (f, myr) => progress(`Simulating plates · ${Math.round(myr)} / ${params.simMyr} Myr`, 0.05 + 0.7 * f));
    mark('tectonics', t1);
    world = {
      params, grid, plates: d.plates, plate: d.plate, crust: d.crust, velocity: d.velocity, boundary: d.boundary,
      boundaryRate: d.boundaryRate, oceanAge: d.oceanAge, orogeny: d.orogeny, thickness: d.thickness,
      elevation: d.elevation, stats: stats(grid, params, d.elevation, d.landFraction, timings),
    };
    world.stats.drift = d.drift;
  }
  progress('Scoring', 0.78);
  const t3 = performance.now();
  world.score = scoreWorld(world);
  mark('score', t3);
  return world;
}

function stats(grid: HexGrid, params: PlanetParams, elevation: Float32Array, landFraction: number, timings: Record<string, number>) {
  let maxE = -Infinity, minE = Infinity;
  for (let c = 0; c < grid.count; c++) {
    if (elevation[c] > maxE) maxE = elevation[c];
    if (elevation[c] < minE) minE = elevation[c];
  }
  return {
    cells: grid.count,
    spacingKm: meanSpacingKm(grid, params.radiusKm),
    landFraction,
    maxElevation: maxE,
    minElevation: minE,
    timings,
  };
}
