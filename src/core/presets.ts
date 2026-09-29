/**
 * Planet presets. Everything downstream works in real units (km, Myr, m,
 * mm/yr), so Moon, Mars and Earth run the same code and only these numbers
 * change.
 */

export type PresetId = 'earth' | 'mars' | 'moon' | 'custom';

export interface PlanetParams {
  seed: string;
  preset: PresetId;
  /** Planet radius in km. */
  radiusKm: number;
  /** Surface gravity relative to Earth (1 = 9.81 m/s²). */
  gravity: number;
  /** Grid subdivision frequency n: cells = 10n² + 2. */
  gridFreq: number;
  /** Number of tectonic plates. */
  plates: number;
  /** Number of continental cores (cratons). */
  continents: number;
  /** Target fraction of the surface above sea level, 0–1. */
  landFraction: number;
  /** Axial tilt in degrees (used by climate from M3). */
  tiltDeg: number;
}

export const EARTH_RADIUS_KM = 6371;

/** WorldSmith: max peak ≈ 9,267 m at 1 g, scaling with 1/g. */
export const MAX_PEAK_EARTH_M = 9267;

/** Relief multiplier g⊕/g, capped at 3 so small worlds don't get 50 km ranges. */
export function reliefScale(gravity: number): number {
  return Math.min(3, 1 / Math.max(gravity, 1e-3));
}

export const GRID_OPTIONS: { freq: number; label: string }[] = [
  { freq: 32, label: '10k cells (fast)' },
  { freq: 64, label: '41k cells' },
  { freq: 90, label: '81k cells' },
  { freq: 128, label: '164k cells' },
  { freq: 181, label: '328k cells' },
  { freq: 256, label: '655k cells (slow)' },
];

export function cellCount(freq: number): number {
  return 10 * freq * freq + 2;
}

const BASE: Record<Exclude<PresetId, 'custom'>, Omit<PlanetParams, 'seed' | 'preset'>> = {
  earth: { radiusKm: 6371, gravity: 1, gridFreq: 128, plates: 12, continents: 9, landFraction: 0.29, tiltDeg: 23.5 },
  mars: { radiusKm: 3390, gravity: 0.378, gridFreq: 90, plates: 6, continents: 4, landFraction: 0.29, tiltDeg: 25.2 },
  moon: { radiusKm: 1737, gravity: 0.165, gridFreq: 90, plates: 6, continents: 3, landFraction: 0.29, tiltDeg: 1.5 },
};

export function presetParams(preset: Exclude<PresetId, 'custom'>, seed: string): PlanetParams {
  return { seed, preset, ...BASE[preset] };
}

export const PRESET_LABELS: Record<PresetId, string> = {
  earth: 'Earth',
  mars: 'Mars-size',
  moon: 'Moon-size',
  custom: 'Custom',
};

/** Encode params into a short URL hash so a planet can be shared. */
export function encodeParams(p: PlanetParams): string {
  const q = new URLSearchParams({
    s: p.seed,
    p: p.preset,
    r: String(p.radiusKm),
    g: String(p.gravity),
    n: String(p.gridFreq),
    pl: String(p.plates),
    c: String(p.continents),
    l: String(p.landFraction),
    t: String(p.tiltDeg),
  });
  return q.toString();
}

export function decodeParams(hash: string): PlanetParams | null {
  try {
    const q = new URLSearchParams(hash.replace(/^#/, ''));
    if (!q.has('s')) return null;
    const preset = (q.get('p') ?? 'earth') as PresetId;
    const base = presetParams(preset === 'custom' ? 'earth' : preset, q.get('s')!);
    const num = (k: string, d: number) => {
      const v = Number(q.get(k));
      return q.has(k) && Number.isFinite(v) ? v : d;
    };
    return {
      ...base,
      preset,
      radiusKm: num('r', base.radiusKm),
      gravity: num('g', base.gravity),
      gridFreq: num('n', base.gridFreq),
      plates: num('pl', base.plates),
      continents: num('c', base.continents),
      landFraction: num('l', base.landFraction),
      tiltDeg: num('t', base.tiltDeg),
    };
  } catch {
    return null;
  }
}
