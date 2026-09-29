import { describe, expect, it } from 'vitest';
import { presetParams, reliefScale } from '../src/core/presets';
import { toHalf, fromHalf } from '../src/core/half';
import { generateWorld } from '../src/sim/generate';
import { oceanDepth } from '../src/sim/terrain/elevation';
import { Boundary, Crust } from '../src/sim/world';

describe('ocean depth vs crust age', () => {
  // WorldSmith 8.00 ocean depth table (m): exact at the table points.
  const table: [number, number][] = [[0, 2600], [10, 3707], [20, 4165], [40, 4775], [50, 5014], [100, 5775], [150, 6118], [200, 6273], [300, 6374], [500, 6399]];
  for (const [t, d] of table) {
    it(`${t} Myr = ${d} m`, () => expect(oceanDepth(t)).toBeCloseTo(d, 6));
  }
  it('between points it stays within 2.5% of Parsons & Sclater', () => {
    for (const t of [5, 15, 25, 70, 120]) {
      const ps = Math.min(2600 + 350 * Math.sqrt(t), 6400 - 3200 * Math.exp(-t / 62.8));
      expect(Math.abs(oceanDepth(t) - ps) / ps).toBeLessThan(0.025);
    }
  });
  it('is monotonic and levels off at 6.4 km', () => {
    let prev = 0;
    for (let t = 0; t <= 800; t += 5) {
      expect(oceanDepth(t)).toBeGreaterThanOrEqual(prev);
      prev = oceanDepth(t);
    }
    expect(oceanDepth(2000)).toBe(6400);
  });
});

describe('relief scaling', () => {
  it('scales with 1/g and caps at ×3', () => {
    expect(reliefScale(1)).toBe(1);
    expect(reliefScale(0.5)).toBe(2);
    expect(reliefScale(0.165)).toBe(3);
  });
});

describe('half floats', () => {
  it('round-trips elevations to within a few metres', () => {
    for (const v of [0, 1, 250.5, 4000, 8848, 27000]) {
      expect(Math.abs(fromHalf(toHalf(v)) - v)).toBeLessThanOrEqual(Math.max(0.01, v / 1024));
    }
  });
});

describe('snapshot world generation (M1)', async () => {
  const p = { ...presetParams('earth', 'test-seed'), gridFreq: 40, engine: 'snapshot' as const };
  const w = await generateWorld(p);

  it('is deterministic for a given seed', async () => {
    const w2 = await generateWorld(p);
    expect(Array.from(w2.elevation.slice(0, 500))).toEqual(Array.from(w.elevation.slice(0, 500)));
    expect(Array.from(w2.plate)).toEqual(Array.from(w.plate));
  });

  it('hits the land fraction target', () => {
    expect(w.stats.landFraction).toBeGreaterThan(0.27);
    expect(w.stats.landFraction).toBeLessThan(0.31);
  });

  it('keeps peaks under the gravity-scaled cap and has deep trenches', () => {
    expect(w.stats.maxElevation).toBeLessThanOrEqual(9267);
    expect(w.stats.maxElevation).toBeGreaterThan(3000);
    expect(w.stats.minElevation).toBeLessThan(-6000);
  });

  it('has every boundary type and plausible plate speeds', () => {
    const seen = new Set(w.boundary);
    expect(seen.has(Boundary.Convergent)).toBe(true);
    expect(seen.has(Boundary.Divergent)).toBe(true);
    for (let c = 0; c < w.grid.count; c += 97) {
      const v = Math.hypot(w.velocity[3 * c], w.velocity[3 * c + 1], w.velocity[3 * c + 2]);
      expect(v).toBeLessThanOrEqual(100); // mm/yr
    }
  });

  it('gives ocean crust an age and continents none', () => {
    for (let c = 0; c < w.grid.count; c++) {
      if (w.crust[c] === Crust.Continent) expect(w.oceanAge[c]).toBe(-1);
      else {
        expect(w.oceanAge[c]).toBeGreaterThanOrEqual(0);
        expect(w.oceanAge[c]).toBeLessThanOrEqual(200);
      }
    }
  });

  it('small low-gravity worlds get taller relief', async () => {
    const moon = await generateWorld({ ...presetParams('moon', 'test-seed'), gridFreq: 32, engine: 'snapshot' });
    expect(moon.stats.maxElevation).toBeGreaterThan(w.stats.maxElevation);
    expect(moon.stats.maxElevation).toBeLessThanOrEqual(9267 * 3);
  });
});
