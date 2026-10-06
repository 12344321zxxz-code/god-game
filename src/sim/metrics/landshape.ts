import { distanceField } from '../../grid/distance';
import type { HexGrid } from '../../grid/hexgrid';

/**
 * Shape and height statistics of the land, from cell elevations only — so
 * the same code measures a generated planet and the real Earth (ETOPO
 * sampled onto the grid, see scripts/earth-ref.ts).
 */
export interface LandShape {
  /** Land as a share of the surface. */
  landFraction: number;
  /** Mean and median land height, m. */
  meanM: number;
  medianM: number;
  /** Shares of the land above 1 km and 2 km (× relief scale). */
  above1k: number;
  above2k: number;
  /** Share of the land farther than `interiorKm` from any sea. Thin,
   *  stringy land scores near zero whatever its total area. */
  interior: number;
  interiorKm: number;
  /** Share of the land in landmasses smaller than `scrapShare` of the surface. */
  scraps: number;
  /** Landmasses holding at least 1 % of the land. */
  majorMasses: number;
}

/** Distance from the sea (km at Earth's size) beyond which land counts as interior. */
export const INTERIOR_KM_EARTH = 300;
/** Landmasses below this share of the planet's surface are scraps (Earth: ~1 M km², between Greenland and New Guinea). */
export const SCRAP_SURFACE_SHARE = 0.002;

/**
 * @param G          relief scale (height thresholds scale with it)
 * @param skipHeight cells left out of the height statistics (Earth's ice
 *                   sheets: their surface is ice, not rock); they still
 *                   count as land for the shape statistics
 */
export function landShape(grid: HexGrid, elevation: ArrayLike<number>, radiusKm: number, G: number, skipHeight?: ArrayLike<number>): LandShape {
  const n = grid.count;
  let landA = 0, total = 0;
  const coast: number[] = [];
  const cells: number[] = [];
  let hA = 0, hSum = 0, a1 = 0, a2 = 0;
  for (let c = 0; c < n; c++) {
    total += grid.area[c];
    const e = elevation[c];
    if (!(e > 0)) continue;
    const a = grid.area[c];
    landA += a;
    for (let k = grid.nbrOffset[c]; k < grid.nbrOffset[c + 1]; k++) {
      if (!(elevation[grid.nbrs[k]] > 0)) { coast.push(c); break; }
    }
    if (skipHeight && skipHeight[c]) continue;
    cells.push(c);
    hA += a;
    hSum += a * e;
    if (e > 1000 * G) a1 += a;
    if (e > 2000 * G) a2 += a;
  }
  cells.sort((x, y) => elevation[x] - elevation[y]);
  let acc = 0, median = 0;
  for (const c of cells) {
    acc += grid.area[c];
    median = elevation[c];
    if (acc >= 0.5 * hA) break;
  }
  // interior land
  const interiorKm = INTERIOR_KM_EARTH * (radiusKm / 6371);
  let inner = 0;
  if (coast.length) {
    const d = distanceField(grid, radiusKm, coast).dist;
    for (let c = 0; c < n; c++) if (elevation[c] > 0 && d[c] > interiorKm) inner += grid.area[c];
  } else if (landA > 0) {
    inner = landA; // no sea at all
  }
  // landmasses
  const seen = new Uint8Array(n);
  let scrapA = 0, major = 0;
  for (let s = 0; s < n; s++) {
    if (seen[s] || !(elevation[s] > 0)) continue;
    let a = 0;
    const stack = [s];
    seen[s] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      a += grid.area[c];
      for (let k = grid.nbrOffset[c]; k < grid.nbrOffset[c + 1]; k++) {
        const dn = grid.nbrs[k];
        if (!seen[dn] && elevation[dn] > 0) { seen[dn] = 1; stack.push(dn); }
      }
    }
    if (a < SCRAP_SURFACE_SHARE * total) scrapA += a;
    if (a >= 0.01 * landA) major++;
  }
  const L = Math.max(landA, 1e-12), H = Math.max(hA, 1e-12);
  return {
    landFraction: landA / total,
    meanM: hSum / H,
    medianM: median,
    above1k: a1 / H,
    above2k: a2 / H,
    interior: inner / L,
    interiorKm,
    scraps: scrapA / L,
    majorMasses: major,
  };
}
