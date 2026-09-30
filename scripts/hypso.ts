// Area share by elevation band (vs Earth's hypsometry), plus crust stats.
//   npx tsx scripts/hypso.ts [freq=64] [myr=500] [seed] [engine=drift]
import { presetParams } from '../src/core/presets';
import { generateWorld } from '../src/sim/generate';
import { Crust } from '../src/sim/world';

const [freqS = '64', myrS = '500', seed = 'basalt-drift-7', engine = 'drift'] = process.argv.slice(2);
const w = await generateWorld({ ...presetParams('earth', seed), gridFreq: Number(freqS), simMyr: Number(myrS), engine: engine as 'drift' | 'snapshot' });
const bands = [-1e9, -6000, -4000, -1000, -200, 0, 1000, 2000, 1e9];
// Earth, % of total surface. Ocean: sea-floor area by depth zone
// (Wikipedia "Ocean", × 0.709 ocean share); land: classic 1 km bins
// (Kossinna), 29.3 % in all. Sums to ~100 %.
const earth = [0.7, 36.9, 25.0, 3.1, 5.2, 20.9, 4.5, 3.9];
const share = new Array(bands.length - 1).fill(0);
let tot = 0, contA = 0, contLow = 0;
for (let c = 0; c < w.grid.count; c++) {
  const a = w.grid.area[c], e = w.elevation[c];
  tot += a;
  for (let i = 0; i < bands.length - 1; i++) if (e >= bands[i] && e < bands[i + 1]) share[i] += a;
  if (w.crust[c] === Crust.Continent) {
    contA += a;
    if (Math.abs(e) < 200) contLow += a;
  }
}
console.log('band (m)'.padEnd(20), 'this'.padStart(6), 'earth'.padStart(6));
for (let i = 0; i < share.length; i++) {
  const lo = bands[i] < -1e8 ? '-∞' : bands[i], hi = bands[i + 1] > 1e8 ? '∞' : bands[i + 1];
  console.log(`${lo} … ${hi}`.padEnd(20), (100 * share[i] / tot).toFixed(1).padStart(6), earth[i].toFixed(1).padStart(6));
}
console.log(`continental crust ${(100 * contA / tot).toFixed(1)}% of surface; within ±200 m of sea level: ${(100 * contLow / contA).toFixed(0)}% of it`);
if (w.thickness) {
  const t: number[] = [];
  for (let c = 0; c < w.grid.count; c++) if (w.crust[c] === Crust.Continent) t.push(w.thickness[c]);
  t.sort((a, b) => a - b);
  const q = (p: number) => t[Math.floor(p * (t.length - 1))].toFixed(1);
  console.log(`continental thickness km: p10 ${q(0.1)} p25 ${q(0.25)} p50 ${q(0.5)} p75 ${q(0.75)} p90 ${q(0.9)} p99 ${q(0.99)}`);
}

// Ocean floor: how far below the age-depth curve does it sit, and why?
{
  const { oceanDepth } = await import('../src/sim/terrain/elevation');
  const ages: number[] = [];
  const resid: number[] = [];
  const thick: number[] = [];
  for (let c = 0; c < w.grid.count; c++) {
    if (w.crust[c] !== Crust.Ocean) continue;
    ages.push(w.oceanAge[c]);
    resid.push(w.elevation[c] + oceanDepth(w.oceanAge[c]));
    if (w.thickness) thick.push(w.thickness[c]);
  }
  const q = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.floor(p * (a.length - 1))].toFixed(0);
  console.log(`ocean age Myr: p10 ${q(ages, 0.1)} p50 ${q(ages, 0.5)} p90 ${q(ages, 0.9)}`);
  console.log(`elevation minus age-depth curve (m): p10 ${q(resid, 0.1)} p50 ${q(resid, 0.5)} p90 ${q(resid, 0.9)}`);
  if (thick.length) console.log(`ocean crust thickness km: p10 ${q(thick, 0.1)} p50 ${q(thick, 0.5)} p90 ${q(thick, 0.9)}`);
}

// What makes the deepest floor deep?
{
  const { Orogeny } = await import('../src/sim/world');
  let deep = 0, trench = 0, old = 0;
  for (let c = 0; c < w.grid.count; c++) {
    if (w.elevation[c] >= -6000) continue;
    const a = w.grid.area[c];
    deep += a;
    if (w.orogeny[c] === Orogeny.Trench) trench += a;
    else if (w.oceanAge[c] > 120) old += a;
  }
  console.log(`below −6 km: ${(100 * trench / deep).toFixed(0)}% trench, ${(100 * old / deep).toFixed(0)}% old (>120 Myr) floor, rest other`);
}
