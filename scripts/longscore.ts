// Scores planets along their history: one run per seed, looked at every
// `step` Myr (looking never changes the run). The tuning harness for
// "does the world hold up over time?".
//   npx tsx scripts/longscore.ts [freq=64] [end=1500] [step=500] [seed…]
import { presetParams } from '../src/core/presets';
import { initDeterministicMath, loadTecto } from '../src/engine/tecto';
import { getGrid } from '../src/sim/generate';
import { landShape } from '../src/sim/metrics/landshape';
import { scoreWorld } from '../src/sim/metrics/scorecard';
import { finishDrift, prepareDrift } from '../src/sim/tectonics/drift';
import type { World } from '../src/sim/world';

const [freqS = '64', endS = '1500', stepS = '500', ...seedArgs] = process.argv.slice(2);
const seeds = seedArgs.length ? seedArgs : ['baseline-0', 'baseline-1', 'baseline-2'];
const preset = (process.env.PRESET ?? 'earth') as 'earth' | 'mars' | 'moon';
await initDeterministicMath();
const pct = (v: number) => (100 * v).toFixed(0).padStart(3);
console.log('seed          Myr  land  mean  med  >1k  >2k inter scrap big1 n1%  peak  age50 age99 shelf pl  flags');
const sums = new Map<number, number[]>();
for (const seed of seeds) {
  const params = { ...presetParams(preset, seed), gridFreq: Number(freqS) };
  const grid = getGrid(params.gridFreq);
  const { prm, init } = prepareDrift(grid, params);
  const t = await loadTecto();
  t.create(grid, prm);
  t.init(init);
  for (let at = Number(stepS); at <= Number(endS) + 1e-6; at += Number(stepS)) {
    let time = t.output().stats.time;
    while (time < at - 1e-6) time = t.run(Math.min(20, at - time));
    const d = finishDrift(grid, params, t.output());
    let maxE = -Infinity, minE = Infinity;
    for (const e of d.elevation) { maxE = Math.max(maxE, e); minE = Math.min(minE, e); }
    const w: World = {
      params, grid, plates: d.plates, plate: d.plate, crust: d.crust, velocity: d.velocity, boundary: d.boundary,
      boundaryRate: d.boundaryRate, oceanAge: d.oceanAge, orogeny: d.orogeny, thickness: d.thickness, elevation: d.elevation,
      stats: { cells: grid.count, spacingKm: 0, landFraction: d.landFraction, maxElevation: maxE, minElevation: minE, timings: {}, drift: d.drift },
    };
    const sc = scoreWorld(w);
    const s = landShape(grid, d.elevation, params.radiusKm, Math.sqrt(1 / Math.max(params.gravity, 1 / 3)));
    const m = (id: string) => sc.metrics.find((x) => x.id === id)!;
    const flags = sc.metrics.filter((x) => x.status === 'fail' || x.status === 'warn').map((x) => `${x.status === 'fail' ? 'FAIL' : 'warn'}:${x.id}`).join(' ');
    console.log(
      `${seed.padEnd(13)} ${String(at).padStart(4)} ${pct(s.landFraction)}% ${s.meanM.toFixed(0).padStart(5)} ${s.medianM.toFixed(0).padStart(4)} ${pct(s.above1k)}% ${(100 * s.above2k).toFixed(1).padStart(4)} ${pct(s.interior)}%  ${(100 * s.scraps).toFixed(1).padStart(4)} ${pct(m('landmass').value!)}% ${String(s.majorMasses).padStart(3)} ${(maxE / 1000).toFixed(1).padStart(5)} ${m('crust-median').value!.toFixed(0).padStart(6)} ${m('crust-age').value!.toFixed(0).padStart(5)} ${m('shelf').value!.toFixed(0).padStart(5)} ${String(d.plates.length).padStart(2)}  ${flags}`,
    );
    const row = [s.landFraction, s.meanM, s.medianM, s.above1k, s.above2k, s.interior, s.scraps, m('landmass').value!, s.majorMasses, maxE / 1000, m('crust-median').value!, m('crust-age').value!, m('shelf').value!];
    const acc = sums.get(at) ?? new Array(row.length + 1).fill(0);
    row.forEach((v, i) => (acc[i] += v));
    acc[row.length]++;
    sums.set(at, acc);
  }
  t.dispose();
}
for (const [at, acc] of sums) {
  const k = acc[acc.length - 1];
  const a = acc.map((v) => v / k);
  console.log(`MEAN          ${String(at).padStart(4)} ${pct(a[0])}% ${a[1].toFixed(0).padStart(5)} ${a[2].toFixed(0).padStart(4)} ${pct(a[3])}% ${(100 * a[4]).toFixed(1).padStart(4)} ${pct(a[5])}%  ${(100 * a[6]).toFixed(1).padStart(4)} ${pct(a[7])}% ${a[8].toFixed(1).padStart(3)} ${a[9].toFixed(1).padStart(5)} ${a[10].toFixed(0).padStart(6)} ${a[11].toFixed(0).padStart(5)} ${a[12].toFixed(0).padStart(5)}`);
}
console.log('EARTH              29%   665  390  20%  5.5  63%   3.0  ~45%   6   5.8     ~55  ~180    64');
