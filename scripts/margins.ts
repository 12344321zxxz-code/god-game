// Share of continental coastline that is passive (ocean on the same plate)
// versus a plate boundary, and plate speeds by type.
import { presetParams } from '../src/core/presets';
import { generateWorld } from '../src/sim/generate';
const [freqS = '64', myrS = '500', seed = 'tide-strata-180'] = process.argv.slice(2);
const w = await generateWorld({ ...presetParams('earth', seed), gridFreq: Number(freqS), simMyr: Number(myrS) });
const g = w.grid;
let passive = 0, active = 0;
for (let c = 0; c < g.count; c++) {
  if (!w.crust[c]) continue;
  for (let k = g.nbrOffset[c]; k < g.nbrOffset[c + 1]; k++) {
    const d = g.nbrs[k];
    if (w.crust[d]) continue;
    if (w.plate[d] === w.plate[c]) passive++; else active++;
  }
}
console.log(`coast edges: passive ${(100 * passive / (passive + active)).toFixed(0)}%, at a plate boundary ${(100 * active / (passive + active)).toFixed(0)}%   [Earth ≈ 55% passive]`);
const R = w.params.radiusKm;
for (const p of w.plates) console.log(`plate ${p.id}: area ${(p.area / (4 * Math.PI) * 100).toFixed(1)}%  continental ${(p.continentalFraction * 100).toFixed(0)}%  speed ~${(p.omega * R).toFixed(0)} mm/yr`);
