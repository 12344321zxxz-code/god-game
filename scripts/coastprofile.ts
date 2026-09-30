// Mean elevation / thickness of continental crust vs distance inland,
// separately for passive coasts and plate-boundary coasts; with the
// orogeny labels found in the coastal 300 km.
import { presetParams } from '../src/core/presets';
import { distanceField } from '../src/grid/distance';
import { generateWorld } from '../src/sim/generate';
import { OROGENY_NAMES } from '../src/sim/world';
const [freqS = '64', myrS = '500', seed = 'tide-strata-180', binS = '100'] = process.argv.slice(2);
const BIN = Number(binS);
const w = await generateWorld({ ...presetParams('earth', seed), gridFreq: Number(freqS), simMyr: Number(myrS) });
const g = w.grid;
for (const kind of ['passive', 'active'] as const) {
  const src: number[] = [];
  for (let c = 0; c < g.count; c++) {
    if (!w.crust[c]) continue;
    for (let k = g.nbrOffset[c]; k < g.nbrOffset[c + 1]; k++) {
      const d = g.nbrs[k];
      if (!w.crust[d] && ((w.plate[d] === w.plate[c]) === (kind === 'passive'))) { src.push(c); break; }
    }
  }
  const df = distanceField(g, w.params.radiusKm, src, undefined, 1200);
  const bins = new Array(12).fill(0).map(() => ({ e: 0, t: 0, n: 0 }));
  const oro = new Map<string, number>();
  for (let c = 0; c < g.count; c++) {
    if (!w.crust[c] || !isFinite(df.dist[c])) continue;
    const b = Math.min(11, Math.floor(df.dist[c] / BIN));
    bins[b].e += w.elevation[c]; bins[b].t += w.thickness![c]; bins[b].n++;
    if (df.dist[c] < 300) oro.set(OROGENY_NAMES[w.orogeny[c]], (oro.get(OROGENY_NAMES[w.orogeny[c]]) ?? 0) + 1);
  }
  console.log(`${kind} coasts (${src.length} cells): ` + bins.map((b, i) => `${i * BIN}km ${b.n ? Math.round(b.e / b.n) : '-'}m/${b.n ? (b.t / b.n).toFixed(1) : '-'}`).join('  '));
  console.log('   orogeny within 300 km:', [...oro].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '));
}
