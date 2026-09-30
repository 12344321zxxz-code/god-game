// Landmass census: sizes of connected land areas and of continental-crust
// pieces, plus how much continental crust lies below sea level.
//   npx tsx scripts/landmass.ts [freq=64] [myr=500] [seed] [engine=drift]
import { presetParams } from '../src/core/presets';
import { generateWorld } from '../src/sim/generate';
import { Crust } from '../src/sim/world';

const [freqS = '64', myrS = '500', seed = 'tide-strata-180', engine = 'drift'] = process.argv.slice(2);
const w = await generateWorld({ ...presetParams('earth', seed), gridFreq: Number(freqS), simMyr: Number(myrS), engine: engine as 'drift' | 'snapshot' });
const g = w.grid;
function components(inside: (c: number) => boolean): number[] {
  const seen = new Uint8Array(g.count);
  const sizes: number[] = [];
  for (let s = 0; s < g.count; s++) {
    if (seen[s] || !inside(s)) continue;
    let a = 0;
    const st = [s];
    seen[s] = 1;
    while (st.length) {
      const c = st.pop()!;
      a += g.area[c];
      for (let k = g.nbrOffset[c]; k < g.nbrOffset[c + 1]; k++) {
        const d = g.nbrs[k];
        if (!seen[d] && inside(d)) { seen[d] = 1; st.push(d); }
      }
    }
    sizes.push(a / (4 * Math.PI) * 100);
  }
  return sizes.sort((a, b) => b - a);
}
const fmt = (s: number[]) => {
  const big = s.filter((v) => v >= 1).map((v) => v.toFixed(1));
  const mid = s.filter((v) => v >= 0.04 && v < 1).length; // Great Britain ≈ 0.04 %
  const small = s.filter((v) => v < 0.04).length;
  return `≥1%: [${big.join(', ')}]  GB-size..1%: ${mid}  smaller: ${small}`;
};
console.log(`${engine} ${seed}`);
console.log('land      ', fmt(components((c) => w.elevation[c] > 0)));
console.log('cont crust', fmt(components((c) => w.crust[c] === Crust.Continent)));
let ca = 0, drowned = 0, deep = 0;
for (let c = 0; c < g.count; c++) if (w.crust[c] === Crust.Continent) {
  ca += g.area[c];
  if (w.elevation[c] < 0) drowned += g.area[c];
  if (w.elevation[c] < -200) deep += g.area[c];
}
console.log(`continental crust ${(ca / (4 * Math.PI) * 100).toFixed(1)}% of surface; below sea level ${(drowned / ca * 100).toFixed(0)}% (deeper than 200 m: ${(deep / ca * 100).toFixed(0)}%)  [Earth: ~41%, ~30%, ~12%]`);
