import { MinHeap } from '../core/heap';
import type { HexGrid } from './hexgrid';

export interface DistanceField {
  /** Great-circle distance in km to the nearest source (Infinity if unreached). */
  dist: Float32Array;
  /** Index into the sources array of the nearest source (−1 if unreached). */
  source: Int32Array;
}

/**
 * Multi-source Dijkstra over the cell graph, in km.
 * If `group` is given, the search never crosses between cells of different
 * group values (e.g. stays inside one tectonic plate).
 */
export function distanceField(
  grid: HexGrid,
  radiusKm: number,
  sources: ArrayLike<number>,
  group?: ArrayLike<number>,
  maxKm = Infinity,
): DistanceField {
  const { count, nbrOffset, nbrs, pos } = grid;
  const dist = new Float32Array(count).fill(Infinity);
  const source = new Int32Array(count).fill(-1);
  const heap = new MinHeap(Math.max(64, sources.length * 2));
  for (let i = 0; i < sources.length; i++) {
    const c = sources[i];
    if (dist[c] > 0) {
      dist[c] = 0;
      source[c] = i;
      heap.push(0, c);
    }
  }
  while (heap.size > 0) {
    const d0 = heap.peekKey();
    const c = heap.pop();
    if (d0 > dist[c]) continue;
    const cx = pos[3 * c], cy = pos[3 * c + 1], cz = pos[3 * c + 2];
    for (let k = nbrOffset[c], k1 = nbrOffset[c + 1]; k < k1; k++) {
      const n = nbrs[k];
      if (group && group[n] !== group[c]) continue;
      const dot = cx * pos[3 * n] + cy * pos[3 * n + 1] + cz * pos[3 * n + 2];
      const nd = d0 + Math.acos(dot > 1 ? 1 : dot) * radiusKm;
      if (nd < dist[n] && nd <= maxKm) {
        dist[n] = nd;
        source[n] = source[c];
        heap.push(nd, n);
      }
    }
  }
  return { dist, source };
}
