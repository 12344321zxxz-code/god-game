// Diagnostic map: continental crust coloured by thickness (dark = thin),
// ocean grey by age, land outlined; plate boundaries in red.
//   npx tsx scripts/diagmap.ts [freq=64] [myr=500] [seed] [out]
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { presetParams } from '../src/core/presets';
import { buildTextureSampler, nearestCellOf } from '../src/grid/sampler';
import { generateWorld } from '../src/sim/generate';

const [freqS = '64', myrS = '500', seed = 'tide-strata-180', out = 'shots/diag.png'] = process.argv.slice(2);
const w = await generateWorld({ ...presetParams('earth', seed), gridFreq: Number(freqS), simMyr: Number(myrS) });
const W = 1200, H = 600;
const s = buildTextureSampler(w.grid, W, H);
const img = new Uint8Array(W * H * 4);
const th = w.thickness!;
for (let i = 0; i < W * H; i++) {
  const c = nearestCellOf(s, w.grid.tris, i);
  const y = H - 1 - Math.floor(i / W), x = i % W;
  const o = 4 * (y * W + x);
  let r, g, b;
  if (w.crust[c]) {
    // thickness 20..50 km: dark red → yellow → white
    const t = Math.min(1, Math.max(0, (th[c] - 20) / 30));
    r = 120 + 135 * Math.min(1, t * 2); g = 40 + 215 * Math.max(0, t * 1.4 - 0.3); b = 30 + 200 * Math.max(0, t - 0.7) / 0.3;
    if (w.elevation[c] <= 0) { r *= 0.45; g *= 0.45; b = b * 0.45 + 90; }
  } else {
    const a = Math.min(1, w.oceanAge[c] / 200);
    r = g = 60 - 30 * a; b = 110 - 40 * a;
  }
  if (w.boundary[c]) { r = 255; g = 0; b = 255; }
  img[o] = r; img[o + 1] = g; img[o + 2] = b; img[o + 3] = 255;
}
const raw = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) Buffer.from(img.buffer, y * W * 4, W * 4).copy(raw, y * (W * 4 + 1) + 1);
const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc = (b: Buffer) => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const cc = Buffer.alloc(4); cc.writeUInt32BE(crc(td)); return Buffer.concat([l, td, cc]); };
const ih = Buffer.alloc(13); ih.writeUInt32BE(W, 0); ih.writeUInt32BE(H, 4); ih[8] = 8; ih[9] = 6;
writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
console.log('wrote', out);
