import type { PlanetParams } from '../core/presets';
import type { HexGrid } from '../grid/hexgrid';
import type { Scorecard } from './metrics/scorecard';
import type { TectoStats } from '../engine/tecto';

/** Crust type per cell. */
export const Crust = { Ocean: 0, Continent: 1 } as const;

/** Plate-boundary class per cell (only boundary cells are non-zero). */
export const Boundary = { None: 0, Convergent: 1, Divergent: 2, Transform: 3 } as const;

/**
 * What built the relief at a cell. The M2 drift sim will write the same
 * field from collision history; the height pass reads it either way.
 */
export const Orogeny = {
  None: 0,
  Andean: 1,
  Himalayan: 2,
  Foreland: 3,
  IslandArc: 4,
  Trench: 5,
  Rift: 6,
  Ancient: 7,
  Hotspot: 8,
} as const;

export const OROGENY_NAMES = ['—', 'Andean cordillera', 'Collision plateau', 'Collision foreland', 'Island arc', 'Trench', 'Rift', 'Old range', 'Hotspot volcanism'];
export const BOUNDARY_NAMES = ['—', 'Convergent', 'Divergent', 'Transform'];

export interface Plate {
  id: number;
  /** Euler pole (unit vector). */
  pole: [number, number, number];
  /** Angular speed in radians per Myr (sign gives direction). */
  omega: number;
  /** Fraction of the plate's area that is continental crust. */
  continentalFraction: number;
  /** Relative buoyancy rank; the denser plate subducts. */
  density: number;
  /** Area in steradians. */
  area: number;
  /** Display colour (0–255 RGB). */
  color: [number, number, number];
}

export interface World {
  params: PlanetParams;
  grid: HexGrid;
  plates: Plate[];
  plate: Uint16Array;
  crust: Uint8Array;
  /** Surface velocity, km/Myr (= mm/yr), xyz interleaved. */
  velocity: Float32Array;
  boundary: Uint8Array;
  /** Convergence rate at boundary cells, mm/yr (negative = spreading). */
  boundaryRate: Float32Array;
  /** Oceanic crust age in Myr (−1 on continents). */
  oceanAge: Float32Array;
  orogeny: Uint8Array;
  /** Crust thickness in km (drift engine only). */
  thickness?: Float32Array;
  /** Elevation relative to sea level, metres. */
  elevation: Float32Array;
  stats: WorldStats;
  /** Plausibility report (see metrics/scorecard.ts). */
  score?: Scorecard;
}

export interface WorldStats {
  cells: number;
  spacingKm: number;
  landFraction: number;
  maxElevation: number;
  minElevation: number;
  timings: Record<string, number>;
  /** Drift-engine history counters (drift engine only). */
  drift?: TectoStats;
}
