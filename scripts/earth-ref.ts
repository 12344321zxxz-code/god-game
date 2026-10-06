// The real Earth on the hex grid: samples an ETOPO elevation grid onto the
// cells (area-weighted cell averages, like the simulation's heights) and
// runs the same metrics the scorecard uses, to get honest reference values.
//
//   npx tsx scripts/earth-ref.ts <etopo.bin> [freq=64] [out.i16]
//
// etopo.bin: int32 nLat, int32 nLon, float32 lats[], float32 lons[],
// int16 metres[nLat·nLon] (row = latitude). Made from the public-domain
// ETOPO 20-arc-minute grid (NOAA). With `out`, writes the cell heights
// (int16 metres per cell) — tests/data/earth-f64.i16 is such a file.
import { readFileSync, writeFileSync } from 'node:fs';
import { presetParams } from '../src/core/presets';
import { CellLocator } from '../src/grid/locator';
import { getGrid } from '../src/sim/generate';
import { landShape } from '../src/sim/metrics/landshape';
import { coastlineDimension, hypsometryPeaks, meanShelfWidthKm, mountainBeltWidths } from '../src/sim/metrics/scorecard';
import type { World } from '../src/sim/world';
import { initDeterministicMath } from '../src/engine/tecto';

const [path, freqS = '64', out] = process.argv.slice(2);
await initDeterministicMath();
const buf = readFileSync(path);
const nLat = buf.readInt32LE(0), nLon = buf.readInt32LE(4);
const lats = new Float32Array(buf.buffer.slice(buf.byteOffset + 8, buf.byteOffset + 8 + 4 * nLat));
const lons = new Float32Array(buf.buffer.slice(buf.byteOffset + 8 + 4 * nLat, buf.byteOffset + 8 + 4 * (nLat + nLon)));
const data = new Int16Array(buf.buffer.slice(buf.byteOffset + 8 + 4 * (nLat + nLon), buf.byteOffset + 8 + 4 * (nLat + nLon) + 2 * nLat * nLon));

const grid = getGrid(Number(freqS));
const sum = new Float64Array(grid.count), wsum = new Float64Array(grid.count);
const loc = new CellLocator(grid);
const rad = Math.PI / 180;
const dirOf = (latDeg: number, lonDeg: number) => {
  const lat = latDeg * rad, phi = (lonDeg + 180) * rad, cl = Math.cos(lat);
  return [-Math.cos(phi) * cl, Math.sin(lat), Math.sin(phi) * cl] as const;
};
for (let i = 0; i < nLat; i++) {
  const w = Math.cos(lats[i] * rad);
  // the last longitude repeats the first (360° apart)
  for (let j = 0; j < nLon - 1; j++) {
    const [x, y, z] = dirOf(lats[i], lons[j]);
    const c = loc.nearest(x, y, z);
    sum[c] += w * data[i * nLon + j];
    wsum[c] += w;
  }
}
const elevation = new Float32Array(grid.count);
let empty = 0;
for (let c = 0; c < grid.count; c++) {
  if (wsum[c] > 0) { elevation[c] = sum[c] / wsum[c]; continue; }
  // finer than the data here: take the nearest sample
  empty++;
  const lat = Math.asin(grid.pos[3 * c + 1]) / rad;
  let lon = Math.atan2(grid.pos[3 * c + 2], -grid.pos[3 * c]) / rad - 180;
  while (lon < lons[0]) lon += 360;
  const i = Math.min(nLat - 1, Math.max(0, Math.round((lat - lats[0]) / (lats[1] - lats[0]))));
  const j = Math.min(nLon - 1, Math.max(0, Math.round((lon - lons[0]) / (lons[1] - lons[0]))));
  elevation[c] = data[i * nLon + j];
}
if (out) writeFileSync(out, Buffer.from(Int16Array.from(elevation, (e) => Math.round(e)).buffer));

/** Ice sheets (Antarctica, Greenland): the surface is ice, so their heights say nothing about rock. */
export function iceMask(g: typeof grid): Uint8Array {
  const m = new Uint8Array(g.count);
  for (let c = 0; c < g.count; c++) {
    const lat = Math.asin(g.pos[3 * c + 1]) / rad;
    let lon = Math.atan2(g.pos[3 * c + 2], -g.pos[3 * c]) / rad - 180;
    if (lon < -180) lon += 360;
    if (lat < -60 || (lat > 59 && lat < 84 && lon > -74 && lon < -11)) m[c] = 1;
  }
  return m;
}

const params = { ...presetParams('earth', 'earth'), gridFreq: grid.freq };
const w = { params, grid, elevation } as unknown as World;
const ice = iceMask(grid);
const s = landShape(grid, elevation, 6371, 1, ice);
const sIce = landShape(grid, elevation, 6371, 1);
let maxE = -Infinity, minE = Infinity;
for (let c = 0; c < grid.count; c++) { maxE = Math.max(maxE, elevation[c]); minE = Math.min(minE, elevation[c]); }
const pct = (v: number) => `${(100 * v).toFixed(1)}%`;
console.log(`Earth on ${grid.count} cells (${empty} cells from nearest sample)`);
console.log(`  land ${pct(s.landFraction)} of surface`);
console.log(`  ice-free land: mean ${s.meanM.toFixed(0)} m, median ${s.medianM.toFixed(0)} m, above 1 km ${pct(s.above1k)}, above 2 km ${pct(s.above2k)}`);
console.log(`  with ice sheets: mean ${sIce.meanM.toFixed(0)} m, above 1 km ${pct(sIce.above1k)}, above 2 km ${pct(sIce.above2k)}`);
console.log(`  interior land (> ${s.interiorKm} km from sea) ${pct(s.interior)}, scraps ${pct(s.scraps)}, landmasses over 1%: ${s.majorMasses}`);
console.log(`  highest cell ${maxE.toFixed(0)} m, deepest ${minE.toFixed(0)} m`);
const hp = hypsometryPeaks(w);
console.log(`  hypsometry peaks land ${hp.land} m ocean ${hp.ocean} m bimodal ${hp.bimodal}`);
console.log(`  shelf width ${meanShelfWidthKm(w).toFixed(0)} km, coastline D ${coastlineDimension(w)?.toFixed(2)}`);
const belts = mountainBeltWidths(w, 1).widths.sort((a, b) => a - b);
console.log(`  mountain belts ${belts.length}, median ${belts[Math.floor(belts.length / 2)]?.toFixed(0)} km, widest ${belts[belts.length - 1]?.toFixed(0)} km`);
