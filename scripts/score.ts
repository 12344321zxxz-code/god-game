// Scores many generated planets and prints a baseline table.
// Usage: npm run score -- [seedsPerPreset=8] [--md out.md]
import { writeFileSync } from 'node:fs';
import { presetParams } from '../src/core/presets';
import { generateWorld } from '../src/sim/generate';
import { scoreWorld, type Metric } from '../src/sim/metrics/scorecard';

const n = Number(process.argv[2] ?? 8);
const mdIdx = process.argv.indexOf('--md');
const mdPath = mdIdx > 0 ? process.argv[mdIdx + 1] : null;
const engIdx = process.argv.indexOf('--engine');
const engine = engIdx > 0 ? (process.argv[engIdx + 1] as 'drift' | 'snapshot') : undefined;
const myrIdx = process.argv.indexOf('--myr');
const myr = myrIdx > 0 ? Number(process.argv[myrIdx + 1]) : undefined;
const fIdx = process.argv.indexOf('--freq');
const freq = fIdx > 0 ? Number(process.argv[fIdx + 1]) : undefined;

type Row = { preset: string; seed: string; metrics: Metric[] };
const rows: Row[] = [];
for (const preset of ['earth', 'mars', 'moon'] as const) {
  for (let i = 0; i < n; i++) {
    const seed = `baseline-${i}`;
    const w = await generateWorld({ ...presetParams(preset, seed), ...(engine ? { engine } : {}), ...(myr ? { simMyr: myr } : {}), ...(freq ? { gridFreq: freq } : {}) });
    const sc = scoreWorld(w);
    rows.push({ preset, seed, metrics: sc.metrics });
    const flags = sc.metrics.map((m) => (m.status === 'fail' ? 'F' : m.status === 'warn' ? 'w' : m.status === 'pass' ? '.' : '-')).join('');
    console.log(`${preset.padEnd(5)} ${seed.padEnd(11)} ${flags}  pass ${sc.pass} warn ${sc.warn} fail ${sc.fail}  (${sc.ms} ms)`);
  }
}

// Per metric: pass/warn/fail counts and the value range across all planets.
const ids = rows[0].metrics.map((m) => m.id);
const lines: string[] = ['| Metric | Preset | Pass | Warn | Fail | Values (min – median – max) | Band | Earth |', '| --- | --- | --- | --- | --- | --- | --- | --- |'];
for (const id of ids) {
  for (const preset of ['earth', 'mars', 'moon']) {
    const ms = rows.filter((r) => r.preset === preset).map((r) => r.metrics.find((m) => m.id === id)!);
    if (ms.every((m) => m.status === 'na')) continue;
    const vals = ms.map((m) => m.value).filter((v): v is number => v !== null).sort((a, b) => a - b);
    const f = (v: number) => (Math.abs(v) >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(2));
    const range = vals.length ? `${f(vals[0])} – ${f(vals[Math.floor(vals.length / 2)])} – ${f(vals[vals.length - 1])}` : '—';
    const c = (s: string) => ms.filter((m) => m.status === s).length;
    lines.push(`| ${ms[0].label} | ${preset} | ${c('pass')} | ${c('warn')} | ${c('fail')} | ${range} | ${ms[0].band} | ${ms[0].earth} |`);
  }
}
console.log('\n' + lines.join('\n'));
if (mdPath) {
  writeFileSync(mdPath, `# Scorecard baseline\n\n${n} planets per preset, seeds baseline-0 … baseline-${n - 1}, default settings.\nValues column shows each metric's headline number.\n\n${lines.join('\n')}\n`);
  console.log(`\nwrote ${mdPath}`);
}
