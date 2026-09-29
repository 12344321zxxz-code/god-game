import type { PlanetParams } from '../core/presets';
import { buildHexGrid, meanSpacingKm, type HexGrid } from '../grid/hexgrid';
import { runSnapshotTectonics } from './tectonics/snapshot';
import { buildElevation } from './terrain/elevation';
import type { World } from './world';

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

/** Runs the full pipeline: grid → tectonics → elevation. */
export function generateWorld(params: PlanetParams, progress: ProgressFn = () => {}): World {
  const timings: Record<string, number> = {};
  const time = <T>(label: string, f: () => T): T => {
    const t0 = performance.now();
    const r = f();
    timings[label] = Math.round(performance.now() - t0);
    return r;
  };

  progress('Building hex grid', 0.05);
  const grid = time('grid', () => getGrid(params.gridFreq));
  progress('Moving plates', 0.25);
  const tect = time('tectonics', () => runSnapshotTectonics(grid, params));
  progress('Raising mountains', 0.55);
  const h = time('elevation', () => buildElevation(grid, params, tect));

  let maxE = -Infinity, minE = Infinity;
  for (let c = 0; c < grid.count; c++) {
    if (h.elevation[c] > maxE) maxE = h.elevation[c];
    if (h.elevation[c] < minE) minE = h.elevation[c];
  }
  return {
    params,
    grid,
    plates: tect.plates,
    plate: tect.plate,
    crust: tect.crust,
    velocity: tect.velocity,
    boundary: tect.boundary,
    boundaryRate: tect.boundaryRate,
    oceanAge: h.oceanAge,
    orogeny: h.orogeny,
    elevation: h.elevation,
    stats: {
      cells: grid.count,
      spacingKm: meanSpacingKm(grid, params.radiusKm),
      landFraction: h.landFraction,
      maxElevation: maxE,
      minElevation: minE,
      timings,
    },
  };
}
