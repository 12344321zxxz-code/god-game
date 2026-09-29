import { describe, expect, it } from 'vitest';
import { presetParams } from '../src/core/presets';
import { generateWorld } from '../src/sim/generate';
import { coastlineDimension, hypsometryPeaks, scoreWorld } from '../src/sim/metrics/scorecard';
import type { World } from '../src/sim/world';

// One real world, then mutated copies that break one physical rule each.
const base = generateWorld({ ...presetParams('earth', 'score-test'), gridFreq: 48 });

function mutate(f: (w: World) => void): World {
  const w: World = {
    ...base,
    elevation: base.elevation.slice(),
    oceanAge: base.oceanAge.slice(),
    velocity: base.velocity.slice(),
    stats: { ...base.stats },
    plates: base.plates.map((p) => ({ ...p })),
  };
  f(w);
  let mx = -Infinity, mn = Infinity;
  for (const e of w.elevation) { mx = Math.max(mx, e); mn = Math.min(mn, e); }
  w.stats.maxElevation = mx;
  w.stats.minElevation = mn;
  return w;
}

const statusOf = (w: World, id: string) => scoreWorld(w).metrics.find((m) => m.id === id)!.status;

describe('scorecard', () => {
  it('passes a generated planet with no impossible results', () => {
    const s = scoreWorld(base);
    expect(s.fail).toBe(0);
    expect(s.metrics.length).toBeGreaterThanOrEqual(12);
  });

  it('fails a planet whose heights have one hump (no continents vs ocean floor)', () => {
    const w = mutate((w) => {
      // sum of incommensurate sines ≈ a single bell curve around −1.5 km
      for (let c = 0; c < w.grid.count; c++) w.elevation[c] = 600 * (Math.sin(c * 0.37) + Math.sin(c * 1.13) + Math.sin(c * 2.71) + Math.sin(c * 0.071)) - 1500;
    });
    expect(hypsometryPeaks(w).bimodal).toBe(false);
    expect(statusOf(w, 'hypsometry')).toBe('fail');
  });

  it('fails ocean crust that never recycles', () => {
    const w = mutate((w) => {
      for (let c = 0; c < w.grid.count; c++) if (w.oceanAge[c] >= 0) w.oceanAge[c] = 900;
    });
    expect(statusOf(w, 'crust-age')).toBe('fail');
  });

  it('fails peaks above the gravity limit', () => {
    const w = mutate((w) => { w.elevation[0] = 12000; });
    expect(statusOf(w, 'peak')).toBe('fail');
  });

  it('fails impossible plate speeds', () => {
    const w = mutate((w) => { w.velocity[0] = 400; });
    expect(statusOf(w, 'plate-speed')).toBe('fail');
  });

  it('fails a single plate covering most of the planet', () => {
    const w = mutate((w) => {
      w.plates[0].area = 0.8 * 4 * Math.PI;
    });
    expect(statusOf(w, 'plate-size')).toBe('fail');
  });

  it('measures a perfectly smooth coastline as dimension ≈ 1', () => {
    // land = one spherical cap → a circle, the smoothest possible coast
    const w = mutate((w) => {
      for (let c = 0; c < w.grid.count; c++) w.elevation[c] = w.grid.pos[3 * c + 1] > 0.3 ? 500 : -4000;
    });
    const d = coastlineDimension(w)!;
    expect(d).toBeLessThan(1.08);
    expect(statusOf(w, 'coast')).not.toBe('pass');
  });

  it('scales the peak limit with gravity', () => {
    const moon = generateWorld({ ...presetParams('moon', 'score-test'), gridFreq: 40 });
    const peak = scoreWorld(moon).metrics.find((m) => m.id === 'peak')!;
    expect(peak.failIf).toContain('27.8 km');
    expect(peak.status).not.toBe('fail');
  });
});
