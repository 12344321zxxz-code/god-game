import { describe, expect, it } from 'vitest';
import { buildHexGrid } from '../src/grid/hexgrid';
import { CellLocator, locateTriangle } from '../src/grid/locator';
import { buildTextureSampler, dirToLatLon, latLonToDir, texelDirection } from '../src/grid/sampler';
import { mulberry32, randUnitVec } from '../src/core/rng';

describe('hex grid', () => {
  for (const n of [1, 2, 5, 16, 40]) {
    it(`GP(${n},0) has 10n²+2 cells, 12 pentagons, the rest hexagons`, () => {
      const g = buildHexGrid(n);
      expect(g.count).toBe(10 * n * n + 2);
      expect(g.triCount).toBe(20 * n * n);
      let pent = 0, hex = 0;
      for (let c = 0; c < g.count; c++) {
        const d = g.nbrOffset[c + 1] - g.nbrOffset[c];
        if (d === 5) pent++;
        else if (d === 6) hex++;
      }
      expect(pent).toBe(12);
      expect(hex).toBe(g.count - 12);
      expect(g.edgeCount).toBe(30 * n * n); // Euler: E = V + F − 2
    });
  }

  it('cell areas sum to 4π and are fairly even', () => {
    const g = buildHexGrid(30);
    let sum = 0, min = Infinity, max = 0;
    for (let c = 0; c < g.count; c++) {
      sum += g.area[c];
      min = Math.min(min, g.area[c]);
      max = Math.max(max, g.area[c]);
    }
    expect(sum).toBeCloseTo(4 * Math.PI, 3);
    expect(max / min).toBeLessThan(2.2);
  });

  it('positions are unit vectors and neighbour lists are symmetric', () => {
    const g = buildHexGrid(12);
    for (let c = 0; c < g.count; c++) {
      expect(Math.hypot(g.pos[3 * c], g.pos[3 * c + 1], g.pos[3 * c + 2])).toBeCloseTo(1, 9);
      for (let k = g.nbrOffset[c]; k < g.nbrOffset[c + 1]; k++) {
        const d = g.nbrs[k];
        const back = Array.from(g.nbrs.subarray(g.nbrOffset[d], g.nbrOffset[d + 1]));
        expect(back).toContain(c);
      }
    }
  });
});

describe('locator', () => {
  it('greedy walk finds the true nearest cell', () => {
    const g = buildHexGrid(24);
    const loc = new CellLocator(g);
    const rng = mulberry32(7);
    let misses = 0;
    for (let q = 0; q < 2000; q++) {
      const [x, y, z] = randUnitVec(rng);
      const got = loc.nearest(x, y, z, Math.floor(rng() * g.count));
      let best = 0, bd = -2;
      for (let c = 0; c < g.count; c++) {
        const d = x * g.pos[3 * c] + y * g.pos[3 * c + 1] + z * g.pos[3 * c + 2];
        if (d > bd) { bd = d; best = c; }
      }
      if (got !== best) misses++;
    }
    expect(misses).toBe(0);
  });

  it('every point falls inside a triangle incident to its nearest cell', () => {
    const g = buildHexGrid(24);
    const loc = new CellLocator(g);
    const rng = mulberry32(11);
    const out = new Float64Array(4);
    let fails = 0;
    for (let q = 0; q < 5000; q++) {
      const [x, y, z] = randUnitVec(rng);
      if (!locateTriangle(g, loc.nearest(x, y, z), x, y, z, out)) fails++;
      else expect(out[1] + out[2] + out[3]).toBeCloseTo(1, 9);
    }
    expect(fails).toBe(0);
  });
});

describe('sampler', () => {
  it('lat/lon round trip and texel directions agree', () => {
    const d = new Float64Array(3);
    for (const [lat, lon] of [[0, 0], [45, 90], [-30, -120], [60, 179]]) {
      latLonToDir(lat, lon, d);
      const r = dirToLatLon(d[0], d[1], d[2]);
      expect(r.lat).toBeCloseTo(lat, 9);
      expect(r.lon).toBeCloseTo(lon, 9);
    }
    texelDirection(360, 180, 180, 90, d); // centre texel ≈ lat 0.5, lon 0.5
    const r = dirToLatLon(d[0], d[1], d[2]);
    expect(r.lat).toBeCloseTo(0.5, 6);
    expect(r.lon).toBeCloseTo(0.5, 6);
  });

  it('builds a sampler covering every texel', () => {
    const g = buildHexGrid(16);
    const s = buildTextureSampler(g, 256, 128);
    for (let i = 0; i < s.tri.length; i++) {
      expect(s.tri[i]).toBeLessThan(g.triCount);
      expect(s.w0[i] + s.w1[i]).toBeLessThanOrEqual(255);
    }
  });
});
