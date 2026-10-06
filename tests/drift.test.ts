import { describe, expect, it } from 'vitest';
import { presetParams } from '../src/core/presets';
import { generateWorld } from '../src/sim/generate';
import { Crust } from '../src/sim/world';

// The Rust/wasm plate simulation, run small and short so the suite stays quick.
describe('drift engine (M2b)', async () => {
  it('starts with every continent inside a single plate', async () => {
    const { continentsInsidePlates } = await import('../src/sim/tectonics/drift');
    const { runSnapshotTectonics } = await import('../src/sim/tectonics/snapshot');
    const { getGrid } = await import('../src/sim/generate');
    const grid = getGrid(32);
    const snap = runSnapshotTectonics(grid, { ...presetParams('earth', 'drift-test'), gridFreq: 32 });
    const plate = continentsInsidePlates(grid, 6371, snap.crust, snap.plate, snap.plates.length);
    for (let c = 0; c < grid.count; c++) {
      if (snap.crust[c] !== Crust.Continent) continue;
      for (let k = grid.nbrOffset[c]; k < grid.nbrOffset[c + 1]; k++) {
        const d = grid.nbrs[k];
        if (snap.crust[d] === Crust.Continent) expect(plate[d]).toBe(plate[c]);
      }
    }
  });

  it('starts with every plate in one connected piece', async () => {
    const { continentsInsidePlates } = await import('../src/sim/tectonics/drift');
    const { runSnapshotTectonics } = await import('../src/sim/tectonics/snapshot');
    const { getGrid } = await import('../src/sim/generate');
    const grid = getGrid(32);
    for (const seed of ['drift-test', 'basalt-drift-7', 'ember-rift-12']) {
      const snap = runSnapshotTectonics(grid, { ...presetParams('earth', seed), gridFreq: 32 });
      const plate = continentsInsidePlates(grid, 6371, snap.crust, snap.plate, snap.plates.length);
      const seen = new Uint8Array(grid.count);
      const pieces = new Map<number, number>();
      for (let s = 0; s < grid.count; s++) {
        if (seen[s]) continue;
        pieces.set(plate[s], (pieces.get(plate[s]) ?? 0) + 1);
        const st = [s];
        seen[s] = 1;
        while (st.length) {
          const c = st.pop()!;
          for (let k = grid.nbrOffset[c]; k < grid.nbrOffset[c + 1]; k++) {
            const d = grid.nbrs[k];
            if (!seen[d] && plate[d] === plate[c]) { seen[d] = 1; st.push(d); }
          }
        }
      }
      for (const [, k] of pieces) expect(k).toBe(1);
    }
  });

  it('gives the same planet however the run is chunked or looked at', async () => {
    const { prepareDrift } = await import('../src/sim/tectonics/drift');
    const { loadTecto } = await import('../src/engine/tecto');
    const { getGrid } = await import('../src/sim/generate');
    const grid = getGrid(24);
    const { prm, init } = prepareDrift(grid, { ...presetParams('earth', 'chunk-test'), gridFreq: 24 });
    const runWith = async (chunk: number, look: boolean) => {
      const t = await loadTecto();
      t.create(grid, prm);
      t.init(init);
      let time = 0;
      while (time < 80 - 1e-6) {
        time = t.run(Math.min(chunk, 80 - time));
        if (look) t.output();
      }
      const o = t.output();
      t.dispose();
      return o;
    };
    const a = await runWith(80, false);
    const b = await runWith(3.3, true);
    expect(b.stats.time).toBe(a.stats.time);
    expect(Array.from(b.elevKm)).toEqual(Array.from(a.elevKm));
    expect(Array.from(b.owner)).toEqual(Array.from(a.owner));
  });

  it('keeps mountains and whole continents over a long history', async () => {
    // The world used to wear flat and break into strips past ~500 Myr.
    const { prepareDrift, finishDrift } = await import('../src/sim/tectonics/drift');
    const { loadTecto } = await import('../src/engine/tecto');
    const { landShape } = await import('../src/sim/metrics/landshape');
    const { getGrid } = await import('../src/sim/generate');
    const params = { ...presetParams('earth', 'drift-test'), gridFreq: 32 };
    const grid = getGrid(32);
    const { prm, init } = prepareDrift(grid, params);
    const t = await loadTecto();
    t.create(grid, prm);
    t.init(init);
    for (const at of [400, 900]) {
      let time = t.output().stats.time;
      while (time < at - 1e-6) time = t.run(at - time);
      const s = landShape(grid, finishDrift(grid, params, t.output()).elevation, 6371, 1);
      // (mountains take a few hundred Myr to build from the flat start;
      // what must not happen is that they are gone again later)
      expect(s.above1k, `high ground at ${at} Myr`).toBeGreaterThan(at < 500 ? 0.04 : 0.08);
      expect(s.interior, `interior land at ${at} Myr`).toBeGreaterThan(0.35);
      expect(s.scraps, `land in scraps at ${at} Myr`).toBeLessThan(0.12);
      expect(s.majorMasses, `landmasses at ${at} Myr`).toBeLessThanOrEqual(9);
    }
    t.dispose();
  }, 120_000);

  const p = { ...presetParams('earth', 'drift-test'), gridFreq: 32, simMyr: 150 };
  const w = await generateWorld(p);
  const d = w.stats.drift!;

  it('runs the requested history', () => {
    // whole steps: it stops within one step (≤ max dt, 2 Myr) past the end
    expect(d.time).toBeGreaterThanOrEqual(150);
    expect(d.time).toBeLessThan(152.001);
    expect(d.steps).toBeGreaterThan(20);
  });

  it('is deterministic for a given seed', async () => {
    const w2 = await generateWorld(p);
    expect(Array.from(w2.elevation)).toEqual(Array.from(w.elevation));
  });

  it('recycles sea floor: new crust at ridges, old crust down trenches', () => {
    expect(d.createdSr).toBeGreaterThan(0.5);
    expect(d.subductedSr).toBeGreaterThan(0.5);
    // production and consumption balance within a factor of ~1.5
    expect(d.createdSr / d.subductedSr).toBeGreaterThan(0.6);
    expect(d.createdSr / d.subductedSr).toBeLessThan(1.6);
  });

  it('keeps continental crust in a steady state', () => {
    expect(d.contFraction).toBeGreaterThan(0.2);
    expect(d.contFraction).toBeLessThan(0.55);
    expect(d.meanContThick).toBeGreaterThan(28);
    expect(d.meanContThick).toBeLessThan(48);
  });

  it('ages ocean floor and keeps plate count in range', () => {
    let young = 0, ocean = 0;
    for (let c = 0; c < w.grid.count; c++) {
      if (w.crust[c] === Crust.Ocean) {
        ocean++;
        if (w.oceanAge[c] < 150) young++;
      }
    }
    expect(young / ocean).toBeGreaterThan(0.5); // most sea floor formed during the run
    expect(w.plates.length).toBeGreaterThanOrEqual(6);
    expect(w.plates.length).toBeLessThanOrEqual(36);
  });

  it('keeps land near the starting share (sea level follows a fixed ocean volume)', () => {
    expect(w.stats.landFraction).toBeGreaterThan(0.2);
    expect(w.stats.landFraction).toBeLessThan(0.4);
  });

  it('keeps continents above water: most continental crust is dry land', () => {
    // (whether the land is in few solid pieces is checked over a long
    // history above; here: the continents must not be drowned)
    let cont = 0, dry = 0;
    for (let c = 0; c < w.grid.count; c++) {
      if (w.crust[c] !== Crust.Continent) continue;
      cont += w.grid.area[c];
      if (w.elevation[c] > 0) dry += w.grid.area[c];
    }
    expect(dry / cont).toBeGreaterThan(0.6);
    expect(dry / cont).toBeLessThan(0.95);
  });

  it('grows real relief', () => {
    // cell averages over ~220 km cells after 150 Myr (no texture added)
    expect(w.stats.maxElevation).toBeGreaterThan(1500);
    expect(w.stats.minElevation).toBeLessThan(-6000);
  });
});
