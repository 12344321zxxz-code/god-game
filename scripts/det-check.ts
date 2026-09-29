// Prints checksums of a small world (compare Node with the browser build).
import { presetParams } from '../src/core/presets';
import { generateWorld } from '../src/sim/generate';
const engine = (process.argv[2] ?? 'snapshot') as 'snapshot' | 'drift';
const p = { ...presetParams('earth', 'basalt-drift-7'), gridFreq: 32, simMyr: 200, engine };
const w = await generateWorld(p);
const hash = (a: ArrayLike<number>, k: number) => {
  let h = 0;
  for (let c = 0; c < a.length; c++) h = (h * 31 + Math.round(a[c] * k)) | 0;
  return h;
};
console.log({ pos: hash(w.grid.pos, 1e12), plate: hash(w.plate, 1), crust: hash(w.crust, 1), age: hash(w.oceanAge, 1000), elev: hash(w.elevation, 1000), vel: hash(w.velocity, 1e6) });
