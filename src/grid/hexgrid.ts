/**
 * Goldberg hex-sphere grid.
 *
 * Built as the dual of a class-I subdivided icosahedron: every vertex of the
 * triangle mesh is a cell (12 pentagons, the rest hexagons) and every small
 * triangle is a cell corner. Cells = 10n² + 2 for subdivision frequency n.
 *
 * Everything is flat typed arrays so it can move between the worker and the
 * main thread cheaply.
 */

export interface HexGrid {
  freq: number;
  /** Number of cells. */
  count: number;
  /** Unit-sphere cell centres, xyz interleaved (length 3·count). */
  pos: Float64Array;
  /** CSR neighbour list: neighbours of c are nbrs[nbrOffset[c] .. nbrOffset[c+1]). */
  nbrOffset: Uint32Array;
  nbrs: Uint32Array;
  /** Triangles (cell corners) as cell-index triples (length 3·triCount). */
  tris: Uint32Array;
  triCount: number;
  /** CSR list of triangles touching each cell. */
  cellTriOffset: Uint32Array;
  cellTris: Uint32Array;
  /** Cell area in steradians (sums to 4π). */
  area: Float64Array;
  /** Unique undirected edges a<b, as pairs (length 2·edgeCount). */
  edges: Uint32Array;
  edgeCount: number;
  /** Great-circle length of each edge in radians. */
  edgeLen: Float64Array;
}

const PHI = (1 + Math.sqrt(5)) / 2;

function icosahedron(): { v: number[][]; f: number[][] } {
  const raw = [
    [-1, PHI, 0], [1, PHI, 0], [-1, -PHI, 0], [1, -PHI, 0],
    [0, -1, PHI], [0, 1, PHI], [0, -1, -PHI], [0, 1, -PHI],
    [PHI, 0, -1], [PHI, 0, 1], [-PHI, 0, -1], [-PHI, 0, 1],
  ];
  const v = raw.map(([x, y, z]) => {
    const l = Math.hypot(x, y, z);
    return [x / l, y / l, z / l];
  });
  const f = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  return { v, f };
}

function slerp(a: number[], b: number[], t: number, out: number[]): number[] {
  const d = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const th = Math.acos(d);
  if (th < 1e-9) {
    out[0] = a[0]; out[1] = a[1]; out[2] = a[2];
    return out;
  }
  const s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s;
  const wb = Math.sin(t * th) / s;
  out[0] = wa * a[0] + wb * b[0];
  out[1] = wa * a[1] + wb * b[1];
  out[2] = wa * a[2] + wb * b[2];
  return out;
}

export function buildHexGrid(freq: number, relaxIterations = 2): HexGrid {
  const n = Math.max(1, Math.floor(freq));
  const { v: iv, f: faces } = icosahedron();
  const count = 10 * n * n + 2;
  const pos = new Float64Array(3 * count);
  const set = (id: number, p: number[]) => {
    pos[3 * id] = p[0]; pos[3 * id + 1] = p[1]; pos[3 * id + 2] = p[2];
  };

  // --- index layout: 12 corners, then 30 edges × (n-1), then 20 faces × interior ---
  for (let i = 0; i < 12; i++) set(i, iv[i]);
  const edgeIndex = new Map<number, number>();
  let nextEdge = 0;
  for (const [a, b, c] of faces) {
    for (const [u, w] of [[a, b], [b, c], [c, a]]) {
      const key = Math.min(u, w) * 12 + Math.max(u, w);
      if (!edgeIndex.has(key)) edgeIndex.set(key, nextEdge++);
    }
  }
  const edgeBase = 12;
  const faceBase = edgeBase + 30 * (n - 1);
  const interiorPerFace = ((n - 1) * (n - 2)) / 2;

  const tmp = [0, 0, 0];
  // edge vertices, computed from the canonical (low → high) direction
  for (const [key, e] of edgeIndex) {
    const a = Math.floor(key / 12);
    const b = key % 12;
    for (let t = 1; t < n; t++) set(edgeBase + e * (n - 1) + (t - 1), slerp(iv[a], iv[b], t / n, tmp));
  }
  const edgeVertex = (u: number, w: number, t: number): number => {
    const e = edgeIndex.get(Math.min(u, w) * 12 + Math.max(u, w))!;
    const tt = u < w ? t : n - t;
    return edgeBase + e * (n - 1) + (tt - 1);
  };
  const rowOffset = (i: number) => ((i - 1) * (2 * n - 2 - i)) / 2; // Σ_{i'=1}^{i-1}(n-1-i')

  const tris = new Uint32Array(3 * 20 * n * n);
  let tc = 0;
  const P = [0, 0, 0];
  const Q = [0, 0, 0];
  faces.forEach(([A, B, C], fi) => {
    const fBase = faceBase + fi * interiorPerFace;
    const vid = (i: number, j: number): number => {
      if (i === 0 && j === 0) return A;
      if (i === n) return B;
      if (j === n) return C;
      if (j === 0) return edgeVertex(A, B, i);
      if (i === 0) return edgeVertex(A, C, j);
      if (i + j === n) return edgeVertex(B, C, j);
      return fBase + rowOffset(i) + (j - 1);
    };
    // interior positions: slerp along row r = i + j between the two edges
    for (let i = 1; i <= n - 2; i++) {
      for (let j = 1; i + j <= n - 1; j++) {
        const r = i + j;
        slerp(iv[A], iv[B], r / n, P);
        slerp(iv[A], iv[C], r / n, Q);
        set(vid(i, j), slerp(P, Q, j / r, tmp));
      }
    }
    for (let i = 0; i < n; i++) {
      for (let j = 0; i + j < n; j++) {
        tris[tc++] = vid(i, j); tris[tc++] = vid(i + 1, j); tris[tc++] = vid(i, j + 1);
        if (i + j < n - 1) {
          tris[tc++] = vid(i + 1, j); tris[tc++] = vid(i + 1, j + 1); tris[tc++] = vid(i, j + 1);
        }
      }
    }
  });
  const triCount = tc / 3;

  // --- adjacency from triangles ---
  const { nbrOffset, nbrs } = neighboursFromTris(count, tris, triCount);

  // --- light relaxation: evens out cell sizes near the 12 pentagons ---
  for (let it = 0; it < relaxIterations; it++) relax(pos, nbrOffset, nbrs, count);

  // --- cell → triangles ---
  const cellTriOffset = new Uint32Array(count + 1);
  for (let t = 0; t < 3 * triCount; t++) cellTriOffset[tris[t] + 1]++;
  for (let c = 0; c < count; c++) cellTriOffset[c + 1] += cellTriOffset[c];
  const cellTris = new Uint32Array(3 * triCount);
  const fill = cellTriOffset.slice(0, count);
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) cellTris[fill[tris[3 * t + k]]++] = t;
  }

  // --- orient triangles counter-clockwise (outward normal) ---
  for (let t = 0; t < triCount; t++) {
    const a = tris[3 * t], b = tris[3 * t + 1], c = tris[3 * t + 2];
    const ax = pos[3 * a], ay = pos[3 * a + 1], az = pos[3 * a + 2];
    const e1x = pos[3 * b] - ax, e1y = pos[3 * b + 1] - ay, e1z = pos[3 * b + 2] - az;
    const e2x = pos[3 * c] - ax, e2y = pos[3 * c + 1] - ay, e2z = pos[3 * c + 2] - az;
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    if (nx * ax + ny * ay + nz * az < 0) {
      tris[3 * t + 1] = c;
      tris[3 * t + 2] = b;
    }
  }

  // --- areas: each spherical triangle split equally between its 3 cells ---
  const area = new Float64Array(count);
  for (let t = 0; t < triCount; t++) {
    const a = tris[3 * t], b = tris[3 * t + 1], c = tris[3 * t + 2];
    const s = sphericalTriangleArea(pos, a, b, c) / 3;
    area[a] += s; area[b] += s; area[c] += s;
  }

  // --- unique edges ---
  let edgeCount = 0;
  for (let c = 0; c < count; c++) {
    for (let k = nbrOffset[c]; k < nbrOffset[c + 1]; k++) if (nbrs[k] > c) edgeCount++;
  }
  const edges = new Uint32Array(2 * edgeCount);
  const edgeLen = new Float64Array(edgeCount);
  let ei = 0;
  for (let c = 0; c < count; c++) {
    for (let k = nbrOffset[c]; k < nbrOffset[c + 1]; k++) {
      const d = nbrs[k];
      if (d > c) {
        edges[2 * ei] = c;
        edges[2 * ei + 1] = d;
        edgeLen[ei] = angleBetween(pos, c, d);
        ei++;
      }
    }
  }

  return { freq: n, count, pos, nbrOffset, nbrs, tris, triCount, cellTriOffset, cellTris, area, edges, edgeCount, edgeLen };
}

function neighboursFromTris(count: number, tris: Uint32Array, triCount: number) {
  const sets: number[][] = Array.from({ length: count }, () => []);
  const add = (a: number, b: number) => {
    const s = sets[a];
    if (!s.includes(b)) s.push(b);
  };
  for (let t = 0; t < triCount; t++) {
    const a = tris[3 * t], b = tris[3 * t + 1], c = tris[3 * t + 2];
    add(a, b); add(b, a); add(b, c); add(c, b); add(a, c); add(c, a);
  }
  const nbrOffset = new Uint32Array(count + 1);
  for (let c = 0; c < count; c++) nbrOffset[c + 1] = nbrOffset[c] + sets[c].length;
  const nbrs = new Uint32Array(nbrOffset[count]);
  for (let c = 0; c < count; c++) nbrs.set(sets[c], nbrOffset[c]);
  return { nbrOffset, nbrs };
}

function relax(pos: Float64Array, off: Uint32Array, nbrs: Uint32Array, count: number) {
  const next = new Float64Array(pos.length);
  for (let c = 0; c < count; c++) {
    let x = 0, y = 0, z = 0;
    const k0 = off[c], k1 = off[c + 1];
    for (let k = k0; k < k1; k++) {
      const d = nbrs[k];
      x += pos[3 * d]; y += pos[3 * d + 1]; z += pos[3 * d + 2];
    }
    // blend half-way toward the neighbour centroid, then back onto the sphere
    x = 0.5 * pos[3 * c] + (0.5 * x) / (k1 - k0);
    y = 0.5 * pos[3 * c + 1] + (0.5 * y) / (k1 - k0);
    z = 0.5 * pos[3 * c + 2] + (0.5 * z) / (k1 - k0);
    const l = Math.hypot(x, y, z);
    next[3 * c] = x / l; next[3 * c + 1] = y / l; next[3 * c + 2] = z / l;
  }
  pos.set(next);
}

export function angleBetween(pos: Float64Array, a: number, b: number): number {
  const d = pos[3 * a] * pos[3 * b] + pos[3 * a + 1] * pos[3 * b + 1] + pos[3 * a + 2] * pos[3 * b + 2];
  return Math.acos(Math.min(1, Math.max(-1, d)));
}

/** Area of a spherical triangle on the unit sphere (Van Oosterom–Strackee). */
function sphericalTriangleArea(pos: Float64Array, a: number, b: number, c: number): number {
  const ax = pos[3 * a], ay = pos[3 * a + 1], az = pos[3 * a + 2];
  const bx = pos[3 * b], by = pos[3 * b + 1], bz = pos[3 * b + 2];
  const cx = pos[3 * c], cy = pos[3 * c + 1], cz = pos[3 * c + 2];
  const triple = ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  const ab = ax * bx + ay * by + az * bz;
  const bc = bx * cx + by * cy + bz * cz;
  const ca = cx * ax + cy * ay + cz * az;
  return 2 * Math.abs(Math.atan2(triple, 1 + ab + bc + ca));
}

/** Mean spacing between neighbouring cell centres, in km, for a planet radius. */
export function meanSpacingKm(grid: HexGrid, radiusKm: number): number {
  let s = 0;
  for (let e = 0; e < grid.edgeCount; e++) s += grid.edgeLen[e];
  return (s / grid.edgeCount) * radiusKm;
}
