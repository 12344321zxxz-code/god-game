// Times each generation stage for every preset and resolution.
// Usage: npm run bench
import { presetParams, GRID_OPTIONS } from '../src/core/presets';
import { generateWorld } from '../src/sim/generate';
import { buildTextureSampler } from '../src/grid/sampler';

const seed = 'bench';
for (const preset of ['earth', 'mars', 'moon'] as const) {
  for (const { freq, label } of GRID_OPTIONS) {
    const p = { ...presetParams(preset, seed), gridFreq: freq };
    const w = await generateWorld(p);
    const t0 = performance.now();
    buildTextureSampler(w.grid, 4096, 2048);
    const sampler = Math.round(performance.now() - t0);
    const t = w.stats.timings;
    console.log(
      `${preset.padEnd(5)} ${label.padEnd(18)} grid ${String(t.grid).padStart(4)} ms · tectonics ${String(t.tectonics).padStart(4)} ms · elevation ${String(t.elevation).padStart(4)} ms · 4k sampler ${String(sampler).padStart(5)} ms · peak ${Math.round(w.stats.maxElevation)} m`,
    );
  }
}
