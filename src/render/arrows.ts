import { CellLocator } from '../grid/locator';
import type { CellData } from '../sim/protocol';

/**
 * Plate-motion arrows: ~N evenly spread sample points (Fibonacci lattice),
 * each drawn as a shaft + two-line head along the local surface velocity.
 * Returns xyz segment pairs on the unit sphere.
 */
export function plateArrows(cells: CellData, samples = 700): Float32Array {
  const loc = new CellLocator({ pos: cells.pos, nbrOffset: cells.nbrOffset, nbrs: cells.nbrs, count: cells.plate.length });
  const out: number[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  const MAX_SPEED = 100; // mm/yr
  for (let i = 0; i < samples; i++) {
    const y = 1 - (2 * (i + 0.5)) / samples;
    const r = Math.sqrt(1 - y * y);
    const px = Math.cos(golden * i) * r, pz = Math.sin(golden * i) * r;
    const c = loc.nearest(px, y, pz);
    const x0 = cells.pos[3 * c], y0 = cells.pos[3 * c + 1], z0 = cells.pos[3 * c + 2];
    let vx = cells.velocity[3 * c], vy = cells.velocity[3 * c + 1], vz = cells.velocity[3 * c + 2];
    const speed = Math.hypot(vx, vy, vz);
    if (speed < 1) continue;
    vx /= speed; vy /= speed; vz /= speed;
    const len = 0.012 + 0.05 * Math.min(1, speed / MAX_SPEED);
    const ex = x0 + vx * len, ey = y0 + vy * len, ez = z0 + vz * len;
    const el = Math.hypot(ex, ey, ez);
    const tx = ex / el, ty = ey / el, tz = ez / el;
    out.push(x0, y0, z0, tx, ty, tz);
    // arrow head: side vector = normal × direction
    const sx = ty * vz - tz * vy, sy = tz * vx - tx * vz, sz = tx * vy - ty * vx;
    const h = len * 0.35;
    for (const s of [1, -1]) {
      const hx = tx - vx * h + sx * h * 0.6 * s;
      const hy = ty - vy * h + sy * h * 0.6 * s;
      const hz = tz - vz * h + sz * h * 0.6 * s;
      const hl = Math.hypot(hx, hy, hz);
      out.push(tx, ty, tz, hx / hl, hy / hl, hz / hl);
    }
  }
  return new Float32Array(out);
}
