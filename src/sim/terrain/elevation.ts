import { SphereNoise } from '../../core/noise';
import { MAX_PEAK_EARTH_M, reliefScale, type PlanetParams } from '../../core/presets';
import { distanceField } from '../../grid/distance';
import { meanSpacingKm, type HexGrid } from '../../grid/hexgrid';
import { areaQuantile, type TectonicSnapshot } from '../tectonics/snapshot';
import { Boundary, Crust, Orogeny } from '../world';
import { M } from '../../core/dmath';

/**
 * Height pass. Turns crust type, crust age and boundary history into
 * elevation (metres above sea level):
 *   - ocean floor from crust age (Parsons & Sclater, as in WorldSmith)
 *   - mountain cross-sections by orogeny type (WorldSmith tectonics sheet)
 *   - relief scaled by g⊕/g (capped ×3)
 *   - sea level solved so land covers the target fraction
 */

/**
 * Ocean depth (positive metres) for sea-floor age in Myr: GDH1 (Stein &
 * Stein 1992), the standard fit to observed depths. It matches the √age
 * cooling curve for young floor and flattens at ~5.65 km, where the older
 * Parsons & Sclater curve (WorldSmith's table) keeps sinking to 6.4 km.
 */
export function oceanDepth(tMyr: number): number {
  const t = Math.max(0, tMyr);
  return t < 20 ? 2600 + 365 * Math.sqrt(t) : 5651 - 2473 * M.exp(-0.0278 * t);
}

type Profile = readonly (readonly [number, number])[]; // [distance km, height m]

/** Piecewise-linear profile lookup; 0 beyond the last point. */
function profile(p: Profile, x: number): number {
  if (x <= p[0][0]) return p[0][1];
  for (let i = 1; i < p.length; i++) {
    if (x <= p[i][0]) {
      const [x0, y0] = p[i - 1];
      const [x1, y1] = p[i];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return 0;
}

// Cross-sections measured inland from the plate boundary. Heights are added
// on top of the continental base. Numbers follow the WorldSmith ranges
// (Andean: outer-arc ridge ≤1.5 km, forearc basin, plateau ≤6 km, back arc).
const ANDEAN: Profile = [[0, 200], [50, 1400], [120, 600], [200, 500], [300, 4600], [420, 5600], [520, 4800], [700, 900], [1000, 250], [1300, 0]];
const HIMALAYAN_FORELAND: Profile = [[0, 2200], [35, 3200], [120, 1100], [260, 300], [420, 0]];
const ISLAND_ARC: Profile = [[0, 0], [60, 900], [130, 5200], [210, 900], [340, 0]];

function himalayanProfile(strength: number): Profile {
  const plateau = 250 + 900 * strength; // WorldSmith: 300–1400 km
  return [[0, 1800], [45, 6800], [110, 6000], [170, 5000], [170 + plateau, 4600], [320 + plateau, 1800], [620 + plateau, 250], [900 + plateau, 0]];
}

export interface HeightResult {
  elevation: Float32Array;
  oceanAge: Float32Array;
  orogeny: Uint8Array;
  landFraction: number;
}

export function buildElevation(grid: HexGrid, params: PlanetParams, t: TectonicSnapshot): HeightResult {
  const { count, pos } = grid;
  const R = params.radiusKm;
  // Structural relief is boosted to offset the smoothing pass further down.
  const G = reliefScale(params.gravity) * 1.3;
  const noise = new SphereNoise(params.seed, 'terrain');
  const { plate, plates, crust, boundary, boundaryRate, otherPlate } = t;

  // --- roles at convergent boundary cells ----------------------------------
  const ROLE_NONE = 0, ROLE_ANDEAN = 1, ROLE_HIMALAYAN = 2, ROLE_FORELAND = 3, ROLE_ARC = 4, ROLE_TRENCH = 5;
  const convSrc: number[] = [];
  const convRole: number[] = [];
  const convStrength: number[] = [];
  const divSrc: number[] = [];
  const divHalfRate: number[] = [];
  for (let c = 0; c < count; c++) {
    if (boundary[c] === Boundary.Convergent) {
      const own = crust[c], op = otherPlate[c];
      // crust across the boundary: majority of the other plate's neighbours of c
      const other = crustAcross(grid, crust, plate, c, op);
      const denser = plates[plate[c]].density > plates[op].density;
      let role = ROLE_NONE;
      if (own === Crust.Continent && other === Crust.Continent) role = denser ? ROLE_FORELAND : ROLE_HIMALAYAN;
      else if (own === Crust.Continent) role = ROLE_ANDEAN;
      else if (other === Crust.Continent) role = ROLE_TRENCH;
      else role = denser ? ROLE_TRENCH : ROLE_ARC;
      convSrc.push(c);
      convRole.push(role);
      convStrength.push(Math.min(1, Math.max(0.3, boundaryRate[c] / 60)));
    } else if (boundary[c] === Boundary.Divergent) {
      divSrc.push(c);
      divHalfRate.push(Math.max(8, -boundaryRate[c] / 2));
    }
  }

  // --- distance fields -----------------------------------------------------
  const conv = distanceField(grid, R, convSrc, plate, 2500);
  const div = distanceField(grid, R, divSrc, plate);
  const coastSrc: number[] = [];
  for (let c = 0; c < count; c++) {
    for (let k = grid.nbrOffset[c]; k < grid.nbrOffset[c + 1]; k++) {
      if (crust[grid.nbrs[k]] !== crust[c]) { coastSrc.push(c); break; }
    }
  }
  const coast = distanceField(grid, R, coastSrc);

  // --- per-cell elevation --------------------------------------------------
  const elevation = new Float32Array(count);
  const detail = new Float32Array(count);
  const oceanAge = new Float32Array(count);
  const orogeny = new Uint8Array(count);
  for (let c = 0; c < count; c++) {
    const x = pos[3 * c], y = pos[3 * c + 1], z = pos[3 * c + 2];
    let e: number;
    let mountain = 0;
    if (crust[c] === Crust.Ocean) {
      // crust age from distance to this plate's spreading ridge
      let age: number;
      const s = div.source[c];
      if (s >= 0) age = div.dist[c] / divHalfRate[s];
      else age = 110 + 50 * noise.fbm(x, y, z, 1.5, 2);
      age *= 1 + 0.12 * noise.fbm(x, y, z, 4, 3);
      age = Math.min(200, Math.max(0, age));
      oceanAge[c] = age;
      const floor = -oceanDepth(age);
      // passive margin: continental slope and rise over ~250 km
      const w = smoothstep(0, 250, coast.dist[c]);
      e = lerp(-250, floor, w);
      // abyssal hills, stronger on young crust
      e += (120 + 180 * M.exp(-age / 30)) * noise.fbm(x, y, z, 30, 3);
    } else {
      oceanAge[c] = -1;
      const inland = coast.dist[c];
      let base = 250 + 450 * noise.fbm(x, y, z, 2.5, 4) + 250 * noise.fbm(x, y, z, 9, 3);
      // Old, eroded ranges inside continents (Urals / Appalachians).
      const ancientMask = smoothstep(0.15, 0.45, noise.fbm(x + 3.3, y, z, 1.8, 3));
      const ancient = ancientMask * noise.ridged(x, y, z, 5, 4) * 1400 * G;
      if (ancient > 350) orogeny[c] = Orogeny.Ancient;
      base += ancient;
      mountain = ancient;
      // Shelf: continental crust near its edge sits just below sea level.
      e = lerp(-180, base, smoothstep(0, 220, inland));
    }

    // Convergent-margin landforms on this plate
    const si = conv.source[c];
    const isCont = crust[c] === Crust.Continent;
    if (si >= 0) {
      const d = conv.dist[c];
      const role = convRole[si];
      const s = convStrength[si];
      // along-range variation so ranges have passes and high massifs
      const along = 0.55 + 0.45 * noise.ridged(x, y, z, 7, 3) + 0.15 * noise.fbm(x, y, z, 2, 2);
      switch (role) {
        case ROLE_ANDEAN: {
          if (!isCont) break;
          const h = profile(ANDEAN, d) * s * along * G;
          if (h > 300) orogeny[c] = Orogeny.Andean;
          e += h;
          mountain = Math.max(mountain, h);
          break;
        }
        case ROLE_HIMALAYAN: {
          if (!isCont) break;
          const h = profile(himalayanProfile(s), d) * (0.4 + 0.6 * s) * (0.75 + 0.25 * along) * G;
          if (h > 300) orogeny[c] = Orogeny.Himalayan;
          e += h;
          mountain = Math.max(mountain, h);
          break;
        }
        case ROLE_FORELAND: {
          if (!isCont) break;
          const h = profile(HIMALAYAN_FORELAND, d) * (0.4 + 0.6 * s) * along * G;
          if (h > 300) orogeny[c] = Orogeny.Foreland;
          e += h;
          mountain = Math.max(mountain, h);
          break;
        }
        case ROLE_ARC: {
          if (isCont) break;
          const h = profile(ISLAND_ARC, d) * s * along * G;
          if (h > 1500) orogeny[c] = Orogeny.IslandArc;
          e += h;
          break;
        }
        case ROLE_TRENCH: {
          if (isCont) break;
          const depth = (2200 + 2800 * s) * M.exp(-(d / 55) * (d / 55)) * Math.min(G, 1.5);
          if (depth > 1000) orogeny[c] = Orogeny.Trench;
          e -= depth;
          break;
        }
      }
    }
    // Continental rifts: a sunken valley with raised shoulders
    if (crust[c] === Crust.Continent && div.source[c] >= 0 && div.dist[c] < 400) {
      const d = div.dist[c];
      e += (-1100 * M.exp(-(d / 45) * (d / 45)) + 900 * M.exp(-((d - 110) / 60) * ((d - 110) / 60))) * G;
      if (d < 60) orogeny[c] = Orogeny.Rift;
    }
    // Rugged texture scaled by how mountainous the cell is (added after smoothing)
    if (mountain > 0) detail[c] = mountain * 0.3 * (noise.ridged(x, y, z, 24, 4) - 0.45);
    else if (crust[c] === Crust.Continent) detail[c] = 120 * noise.fbm(x, y, z, 20, 4);
    elevation[c] = e;
  }

  // Profiles change over tens of km but cells are ~30–110 km apart, so range
  // fronts become one-cell cliffs. Smooth the structural relief over ~160 km
  // (independent of resolution), then add the texture back on top.
  const spacingKm = meanSpacingKm(grid, R);
  smoothField(grid, elevation, Math.max(1, Math.round(160 / spacingKm)));
  for (let c = 0; c < count; c++) elevation[c] += detail[c];

  // --- sea level: shift so the target land fraction sits above 0 -----------
  const seaLevel = areaQuantile(elevation, grid.area, 1 - params.landFraction);
  const cap = MAX_PEAK_EARTH_M * reliefScale(params.gravity);
  let land = 0;
  for (let c = 0; c < count; c++) {
    let e = elevation[c] - seaLevel;
    if (e > 0) e = softCap(e, cap); // keep peaks under the gravity-scaled maximum
    elevation[c] = e;
    if (e > 0) land += grid.area[c];
  }
  return { elevation, oceanAge, orogeny, landFraction: land / (4 * Math.PI) };
}

/** Repeated half-step Laplacian smoothing over the cell graph. */
export function smoothField(grid: HexGrid, f: Float32Array, passes: number): void {
  const { count, nbrOffset, nbrs } = grid;
  const tmp = new Float32Array(count);
  for (let p = 0; p < passes; p++) {
    for (let c = 0; c < count; c++) {
      let s = 0;
      const k0 = nbrOffset[c], k1 = nbrOffset[c + 1];
      for (let k = k0; k < k1; k++) s += f[nbrs[k]];
      tmp[c] = 0.5 * f[c] + (0.5 * s) / (k1 - k0);
    }
    f.set(tmp);
  }
}

function crustAcross(grid: HexGrid, crust: Uint8Array, plate: Uint16Array, c: number, op: number): number {
  let cont = 0, tot = 0;
  for (let k = grid.nbrOffset[c]; k < grid.nbrOffset[c + 1]; k++) {
    const d = grid.nbrs[k];
    if (plate[d] === op) {
      tot++;
      if (crust[d] === Crust.Continent) cont++;
    }
  }
  return tot > 0 && cont * 2 >= tot ? Crust.Continent : Crust.Ocean;
}

/** Smoothly compresses values approaching the cap instead of clipping them. */
function softCap(e: number, cap: number): number {
  const knee = 0.7 * cap;
  if (e <= knee) return e;
  const over = e - knee;
  const room = cap - knee;
  return knee + room * (1 - M.exp(-over / room));
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
