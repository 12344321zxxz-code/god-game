// What built the high ground? Orogeny types of land above 800 m, and of the
// drowned continental crust.
import { presetParams } from '../src/core/presets';
import { generateWorld } from '../src/sim/generate';
import { OROGENY_NAMES } from '../src/sim/world';
const [freqS = '64', myrS = '500', seed = 'tide-strata-180'] = process.argv.slice(2);
const w = await generateWorld({ ...presetParams('earth', seed), gridFreq: Number(freqS), simMyr: Number(myrS) });
const hi = new Map<string, number>(), low = new Map<string, number>();
let th = 0, tl = 0;
for (let c = 0; c < w.grid.count; c++) {
  if (!w.crust[c]) continue;
  const k = OROGENY_NAMES[w.orogeny[c]] ?? '?';
  if (w.elevation[c] > 800) { hi.set(k, (hi.get(k) ?? 0) + w.grid.area[c]); th += w.grid.area[c]; }
  if (w.elevation[c] < 0) { low.set(k, (low.get(k) ?? 0) + w.grid.area[c]); tl += w.grid.area[c]; }
}
const f = (m: Map<string, number>, t: number) => [...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(100 * v / t).toFixed(0)}%`).join(', ');
console.log('land >800 m:', f(hi, th));
console.log('drowned continental crust:', f(low, tl));
