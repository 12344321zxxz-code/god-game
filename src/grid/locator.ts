import type { HexGrid } from './hexgrid';

/**
 * Point → cell lookup by greedy walk: step to whichever neighbour is closer
 * to the query until no neighbour improves. On a (near-)Delaunay mesh this
 * lands on the nearest cell, and because consecutive queries are usually
 * close together, starting from the last answer makes it ~O(1) per lookup.
 */
export class CellLocator {
  private last = 0;

  constructor(private readonly grid: Pick<HexGrid, 'pos' | 'nbrOffset' | 'nbrs' | 'count'>) {}

  nearest(x: number, y: number, z: number, start = this.last): number {
    const { pos, nbrOffset, nbrs } = this.grid;
    let cur = start;
    let best = x * pos[3 * cur] + y * pos[3 * cur + 1] + z * pos[3 * cur + 2];
    for (;;) {
      let next = cur;
      for (let k = nbrOffset[cur], k1 = nbrOffset[cur + 1]; k < k1; k++) {
        const d = nbrs[k];
        const dot = x * pos[3 * d] + y * pos[3 * d + 1] + z * pos[3 * d + 2];
        if (dot > best) {
          best = dot;
          next = d;
        }
      }
      if (next === cur) break;
      cur = next;
    }
    this.last = cur;
    return cur;
  }
}

/**
 * Finds the grid triangle containing direction (x,y,z) and its barycentric
 * weights, starting from the nearest cell. Writes [triIndex, w0, w1, w2] to out.
 * Returns false if no incident triangle contains the point (numerical edge
 * case); out then holds the nearest cell's first triangle with weight 1 on it.
 */
export function locateTriangle(
  grid: Pick<HexGrid, 'pos' | 'tris' | 'cellTriOffset' | 'cellTris'>,
  cell: number,
  x: number,
  y: number,
  z: number,
  out: Float64Array,
): boolean {
  const { pos, tris, cellTriOffset, cellTris } = grid;
  for (let k = cellTriOffset[cell], k1 = cellTriOffset[cell + 1]; k < k1; k++) {
    const t = cellTris[k];
    const a = tris[3 * t], b = tris[3 * t + 1], c = tris[3 * t + 2];
    // Möller–Trumbore: ray from the origin along (x,y,z) against triangle abc
    const ax = pos[3 * a], ay = pos[3 * a + 1], az = pos[3 * a + 2];
    const e1x = pos[3 * b] - ax, e1y = pos[3 * b + 1] - ay, e1z = pos[3 * b + 2] - az;
    const e2x = pos[3 * c] - ax, e2y = pos[3 * c + 1] - ay, e2z = pos[3 * c + 2] - az;
    const px = y * e2z - z * e2y, py = z * e2x - x * e2z, pz = x * e2y - y * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-15) continue;
    const inv = 1 / det;
    const tx = -ax, ty = -ay, tz = -az;
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < -1e-9 || u > 1 + 1e-9) continue;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (x * qx + y * qy + z * qz) * inv;
    if (v < -1e-9 || u + v > 1 + 1e-9) continue;
    out[0] = t;
    out[1] = 1 - u - v;
    out[2] = u;
    out[3] = v;
    return true;
  }
  const t = cellTris[cellTriOffset[cell]];
  out[0] = t;
  const k = tris[3 * t] === cell ? 0 : tris[3 * t + 1] === cell ? 1 : 2;
  out[1] = k === 0 ? 1 : 0;
  out[2] = k === 1 ? 1 : 0;
  out[3] = k === 2 ? 1 : 0;
  return false;
}
