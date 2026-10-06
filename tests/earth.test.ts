import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { presetParams } from '../src/core/presets';
import { initDeterministicMath } from '../src/engine/tecto';
import { getGrid } from '../src/sim/generate';
import { scoreWorld } from '../src/sim/metrics/scorecard';
import type { World } from '../src/sim/world';

// The real Earth (ETOPO 20′ heights averaged onto the 41k-cell grid, made by
// scripts/earth-ref.ts) must pass every height-and-shape check of the
// scorecard. A check that fails Earth is measuring the wrong thing.
describe('scorecard on the real Earth', async () => {
  await initDeterministicMath();
  const grid = getGrid(64);
  const raw = readFileSync(new URL('./data/earth-f64.i16', import.meta.url));
  const elevation = Float32Array.from(new Int16Array(raw.buffer, raw.byteOffset, grid.count));
  let maxE = -Infinity, minE = Infinity;
  for (const e of elevation) { maxE = Math.max(maxE, e); minE = Math.min(minE, e); }
  const w = {
    params: { ...presetParams('earth', 'earth'), gridFreq: 64 },
    grid,
    elevation,
    plates: [],
    plate: new Uint16Array(grid.count),
    crust: new Uint8Array(grid.count),
    velocity: new Float32Array(3 * grid.count),
    boundary: new Uint8Array(grid.count),
    boundaryRate: new Float32Array(grid.count),
    oceanAge: new Float32Array(grid.count).fill(-1),
    orogeny: new Uint8Array(grid.count),
    stats: { cells: grid.count, spacingKm: 111, landFraction: 0.29, maxElevation: maxE, minElevation: minE, timings: {} },
  } as World;
  const sc = scoreWorld(w);
  const by = new Map(sc.metrics.map((m) => [m.id, m]));

  for (const id of ['hypsometry', 'land-mean', 'landmass', 'interior', 'scraps', 'peak', 'trench', 'belts', 'shelf', 'coast']) {
    it(`Earth passes "${id}"`, () => {
      const m = by.get(id);
      expect(m, `metric ${id} exists`).toBeDefined();
      expect(`${m!.status} (${m!.display})`).toMatch(/^pass/);
    });
  }

  // With its ice sheets counted as rock Earth has more high ground than the
  // ice-free reference, but it stays inside the band either way.
  it('Earth passes "high-ground"', () => {
    expect(by.get('high-ground')!.status).toBe('pass');
  });
});
