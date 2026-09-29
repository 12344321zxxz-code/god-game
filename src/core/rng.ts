/**
 * Seeded randomness. Every stage of generation takes its own stream derived
 * from the world seed and a stage label, so changing one stage never shifts
 * the random numbers another stage sees.
 */

export type Rng = () => number;

/** FNV-1a string hash → 32-bit unsigned int. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: small, fast, good enough for procedural generation. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A deterministic random stream for one generation stage. */
export function streamFor(seed: string, stage: string): Rng {
  return mulberry32(hashString(`${seed}::${stage}`));
}

export function randRange(rng: Rng, lo: number, hi: number): number {
  return lo + (hi - lo) * rng();
}

export function randInt(rng: Rng, lo: number, hiExclusive: number): number {
  return lo + Math.floor(rng() * (hiExclusive - lo));
}

/** Uniform random unit vector. */
export function randUnitVec(rng: Rng): [number, number, number] {
  const z = 2 * rng() - 1;
  const t = 2 * Math.PI * rng();
  const r = Math.sqrt(1 - z * z);
  return [r * Math.cos(t), r * Math.sin(t), z];
}

/** Standard normal via Box–Muller. */
export function randNormal(rng: Rng): number {
  const u = Math.max(1e-12, rng());
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
