import type { HexGrid } from './hexgrid';
import { CellLocator, locateTriangle } from './locator';

/**
 * Precomputed mapping from every texel of an equirectangular texture to the
 * grid triangle under it plus barycentric weights. Built once per grid and
 * texture size; after that, baking any per-cell field into a texture is just
 * three array reads per texel, so switching map modes is cheap.
 *
 * Texel convention matches three.js SphereGeometry UVs with flipY = false:
 *   row r (0 = south) → lat = ((r + 0.5) / H − 0.5) · π
 *   col c             → φ = 2π (c + 0.5) / W
 *   direction         = (−cos φ · cos lat, sin lat, sin φ · cos lat)
 */
export interface TextureSampler {
  width: number;
  height: number;
  /** Triangle index per texel. */
  tri: Uint32Array;
  /** Barycentric weights ×255 for the triangle's 1st and 2nd vertex (3rd = 255 − w0 − w1). */
  w0: Uint8Array;
  w1: Uint8Array;
}

export function texelDirection(width: number, height: number, col: number, row: number, out: Float64Array): void {
  const lat = ((row + 0.5) / height - 0.5) * Math.PI;
  const phi = (2 * Math.PI * (col + 0.5)) / width;
  const cl = Math.cos(lat);
  out[0] = -Math.cos(phi) * cl;
  out[1] = Math.sin(lat);
  out[2] = Math.sin(phi) * cl;
}

/** lat/lon in degrees → unit direction (lon 0 at the map centre). */
export function latLonToDir(latDeg: number, lonDeg: number, out: Float64Array): void {
  const lat = (latDeg * Math.PI) / 180;
  const phi = ((lonDeg + 180) * Math.PI) / 180;
  const cl = Math.cos(lat);
  out[0] = -Math.cos(phi) * cl;
  out[1] = Math.sin(lat);
  out[2] = Math.sin(phi) * cl;
}

export function dirToLatLon(x: number, y: number, z: number): { lat: number; lon: number } {
  const lat = (Math.asin(Math.max(-1, Math.min(1, y))) * 180) / Math.PI;
  let phi = Math.atan2(z, -x);
  if (phi < 0) phi += 2 * Math.PI;
  let lon = (phi * 180) / Math.PI - 180;
  if (lon < -180) lon += 360;
  return { lat, lon };
}

export function buildTextureSampler(grid: HexGrid, width: number, height: number): TextureSampler {
  const n = width * height;
  const tri = new Uint32Array(n);
  const w0 = new Uint8Array(n);
  const w1 = new Uint8Array(n);
  const loc = new CellLocator(grid);
  const out = new Float64Array(4);

  // Precompute trig per column / row.
  const cosPhi = new Float64Array(width);
  const sinPhi = new Float64Array(width);
  for (let c = 0; c < width; c++) {
    const phi = (2 * Math.PI * (c + 0.5)) / width;
    cosPhi[c] = Math.cos(phi);
    sinPhi[c] = Math.sin(phi);
  }
  let rowStart = 0;
  for (let r = 0; r < height; r++) {
    const lat = ((r + 0.5) / height - 0.5) * Math.PI;
    const sl = Math.sin(lat);
    const cl = Math.cos(lat);
    let cell = rowStart;
    for (let c = 0; c < width; c++) {
      const x = -cosPhi[c] * cl;
      const y = sl;
      const z = sinPhi[c] * cl;
      cell = loc.nearest(x, y, z, cell);
      if (c === 0) rowStart = cell;
      locateTriangle(grid, cell, x, y, z, out);
      const i = r * width + c;
      tri[i] = out[0];
      let a = Math.round(out[1] * 255);
      let b = Math.round(out[2] * 255);
      a = a < 0 ? 0 : a > 255 ? 255 : a;
      b = b < 0 ? 0 : b > 255 - a ? 255 - a : b;
      w0[i] = a;
      w1[i] = b;
    }
  }
  return { width, height, tri, w0, w1 };
}

/** Bilinear-on-the-mesh: interpolate a per-cell scalar into a texture. */
export function bakeScalar(s: TextureSampler, tris: Uint32Array, field: ArrayLike<number>, out?: Float32Array): Float32Array {
  const n = s.width * s.height;
  const res = out ?? new Float32Array(n);
  const k = 1 / 255;
  for (let i = 0; i < n; i++) {
    const t = 3 * s.tri[i];
    const a = s.w0[i], b = s.w1[i];
    res[i] = (a * field[tris[t]] + b * field[tris[t + 1]] + (255 - a - b) * field[tris[t + 2]]) * k;
  }
  return res;
}

/** Cell index under each texel (largest barycentric weight → hex-shaped cells). */
export function nearestCellOf(s: TextureSampler, tris: Uint32Array, i: number): number {
  const t = 3 * s.tri[i];
  const a = s.w0[i], b = s.w1[i], c = 255 - a - b;
  return a >= b && a >= c ? tris[t] : b >= c ? tris[t + 1] : tris[t + 2];
}
