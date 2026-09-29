// Quick drift run for tuning: npx tsx scripts/drift-try.ts [freq] [myr] [seed]
import { presetParams } from '../src/core/presets';
import { generateWorld } from '../src/sim/generate';

const freq = Number(process.argv[2] ?? 48);
const myr = Number(process.argv[3] ?? 200);
const seed = process.argv[4] ?? 'drift-1';
const p = { ...presetParams('earth', seed), gridFreq: freq, simMyr: myr };
const t0 = performance.now();
let last = 0;
const w = await generateWorld(p, (s, f) => {
  if (performance.now() - last > 3000) {
    last = performance.now();
    console.log(`  ${s} ${(f * 100).toFixed(0)}% ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  }
});
console.log(`done in ${((performance.now() - t0) / 1000).toFixed(1)}s`, w.stats.timings);
console.log('drift', w.stats.drift);
for (const m of w.score!.metrics) console.log(`${m.status.padEnd(4)} ${m.label.padEnd(26)} ${m.display}`);
