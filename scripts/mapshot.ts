// Renders flat maps of a generated world straight from Node (no browser):
//   npx tsx scripts/mapshot.ts [preset=earth] [freq=64] [myr=500] [seed] [out=shots/map.png]
// Writes one PNG with satellite / elevation / plates / crust-age maps stacked.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { deflateSync } from 'node:zlib';
import { presetParams, type PresetId } from '../src/core/presets';
import { buildTextureSampler } from '../src/grid/sampler';
import { WorldBaker, type MapMode } from '../src/render/bake';
import { generateWorld } from '../src/sim/generate';

const [preset = 'earth', freqS = '64', myrS = '500', seed = 'basalt-drift-7', out = 'shots/map.png', engine = 'drift'] = process.argv.slice(2);
const p = { ...presetParams(preset as Exclude<PresetId, 'custom'>, seed), gridFreq: Number(freqS), simMyr: Number(myrS), engine: engine as 'drift' | 'snapshot' };
const t0 = performance.now();
const w = await generateWorld(p);
console.log(`generated in ${((performance.now() - t0) / 1000).toFixed(1)} s`, w.stats.drift ?? '');
for (const m of w.score!.metrics) console.log(`  ${m.status.padEnd(4)} ${m.label.padEnd(26)} ${m.display}`);

const W = 1200, H = 600;
const sampler = buildTextureSampler(w.grid, W, H);
const baker = new WorldBaker(w, sampler);
const modes: MapMode[] = ['satellite', 'elevation', 'plates', 'age'];
const img = new Uint8Array(W * H * modes.length * 4);
modes.forEach((mode, k) => {
  const rgba = baker.bake({ mode, hex: false });
  for (let y = 0; y < H; y++) {
    const src = (H - 1 - y) * W * 4; // texture row 0 = south
    img.set(rgba.subarray(src, src + W * 4), ((k * H + y) * W) * 4);
  }
});
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png(W, H * modes.length, img));
console.log(`wrote ${out}`);

function png(w: number, h: number, rgba: Uint8Array): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const crcTable = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc = (b: Buffer) => {
    let c = -1;
    for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
