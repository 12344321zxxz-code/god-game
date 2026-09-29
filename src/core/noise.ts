import { createNoise3D, type NoiseFunction3D } from 'simplex-noise';
import { streamFor } from './rng';

/**
 * Seeded 3D noise sampled on the unit sphere. Sampling in 3D (not lat/lon)
 * means no seams at the antimeridian and no pinching at the poles.
 */
export class SphereNoise {
  private readonly n: NoiseFunction3D;

  constructor(seed: string, label: string) {
    this.n = createNoise3D(streamFor(seed, `noise:${label}`));
  }

  /** Raw simplex value in [-1, 1]. */
  raw(x: number, y: number, z: number): number {
    return this.n(x, y, z);
  }

  /** Fractal Brownian motion, roughly in [-1, 1]. */
  fbm(x: number, y: number, z: number, freq: number, octaves: number, gain = 0.5, lacunarity = 2): number {
    let amp = 1;
    let f = freq;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.n(x * f + o * 17.3, y * f - o * 9.1, z * f + o * 3.7);
      norm += amp;
      amp *= gain;
      f *= lacunarity;
    }
    return sum / norm;
  }

  /** Ridged multifractal in [0, 1]: sharp crests, good for mountain texture. */
  ridged(x: number, y: number, z: number, freq: number, octaves: number, gain = 0.5, lacunarity = 2.1): number {
    let amp = 1;
    let f = freq;
    let sum = 0;
    let norm = 0;
    let weight = 1;
    for (let o = 0; o < octaves; o++) {
      let v = 1 - Math.abs(this.n(x * f + o * 5.9, y * f + o * 11.3, z * f - o * 7.7));
      v *= v;
      v *= weight;
      weight = Math.min(1, Math.max(0, v * 2));
      sum += amp * v;
      norm += amp;
      amp *= gain;
      f *= lacunarity;
    }
    return sum / norm;
  }
}
