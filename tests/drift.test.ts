import { describe, expect, it } from 'vitest';
import { presetParams } from '../src/core/presets';
import { generateWorld } from '../src/sim/generate';
import { Crust } from '../src/sim/world';

// The Rust/wasm plate simulation, run small and short so the suite stays quick.
describe('drift engine (M2b)', async () => {
  const p = { ...presetParams('earth', 'drift-test'), gridFreq: 32, simMyr: 150 };
  const w = await generateWorld(p);
  const d = w.stats.drift!;

  it('runs the requested history', () => {
    expect(d.time).toBeCloseTo(150, 5);
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
    expect(w.plates.length).toBeLessThanOrEqual(21);
  });

  it('hits the land target and grows real relief', () => {
    expect(w.stats.landFraction).toBeGreaterThan(0.26);
    expect(w.stats.landFraction).toBeLessThan(0.32);
    expect(w.stats.maxElevation).toBeGreaterThan(2000);
    expect(w.stats.minElevation).toBeLessThan(-6000);
  });
});
