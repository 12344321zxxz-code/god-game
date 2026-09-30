import { toHalf } from '../core/half';
import { SphereNoise } from '../core/noise';
import { reliefScale } from '../core/presets';
import { bakeScalar, nearestCellOf, type TextureSampler } from '../grid/sampler';
import type { World } from '../sim/world';
import { addSurfaceDetail } from './detail';
import { BOUNDARY_COLORS, hypsometric, oceanAgeColor, satelliteColor, type RGB } from './palettes';

export type MapMode = 'satellite' | 'elevation' | 'plates' | 'age';

export const MAP_MODES: { id: MapMode; label: string }[] = [
  { id: 'satellite', label: 'Satellite' },
  { id: 'plates', label: 'Plates' },
  { id: 'elevation', label: 'Elevation' },
  { id: 'age', label: 'Crust age' },
];

export interface BakeOptions {
  mode: MapMode;
  /** Show cells as flat hexes instead of smoothly interpolated. */
  hex: boolean;
}

/** Per-world cache of baked scalar fields (they don't change between modes). */
export class WorldBaker {
  private elevTex?: Float32Array;
  private elevHexTex?: Float32Array;
  private ageTex?: Float32Array;
  private wetTex?: Float32Array;

  constructor(private readonly world: World, private readonly sampler: TextureSampler) {}

  get width() { return this.sampler.width; }
  get height() { return this.sampler.height; }

  elevation(hex: boolean): Float32Array {
    if (hex) return (this.elevHexTex ??= this.bakeNearest(this.world.elevation));
    if (!this.elevTex) {
      const e = bakeScalar(this.sampler, this.world.grid.tris, this.world.elevation);
      // the sketch engine's heights already carry their texture
      if (this.world.params.engine === 'drift') addSurfaceDetail(this.world, this.sampler, e);
      this.elevTex = e;
    }
    return this.elevTex;
  }

  /** Land-only height (m) as half floats, for displacement and bump mapping. */
  heightMap(hex: boolean): Uint16Array {
    const e = this.elevation(hex);
    const out = new Uint16Array(e.length);
    for (let i = 0; i < e.length; i++) out[i] = e[i] > 0 ? toHalf(e[i]) : 0;
    return out;
  }

  private bakeNearest(field: ArrayLike<number>): Float32Array {
    const s = this.sampler;
    const out = new Float32Array(s.width * s.height);
    for (let i = 0; i < out.length; i++) out[i] = field[nearestCellOf(s, this.world.grid.tris, i)];
    return out;
  }

  private moisture(): Float32Array {
    if (this.wetTex) return this.wetTex;
    const { grid, params } = this.world;
    const n = new SphereNoise(params.seed, 'sat-moisture');
    const cellWet = new Float32Array(grid.count);
    for (let c = 0; c < grid.count; c++) {
      const x = grid.pos[3 * c], y = grid.pos[3 * c + 1], z = grid.pos[3 * c + 2];
      cellWet[c] = 0.5 + 0.7 * n.fbm(x, y, z, 2.2, 5);
    }
    return (this.wetTex = bakeScalar(this.sampler, grid.tris, cellWet));
  }

  bake(opts: BakeOptions): Uint8Array {
    const { width, height } = this.sampler;
    const rgba = new Uint8Array(width * height * 4);
    const c: RGB = [0, 0, 0];
    const w = this.world;
    const tris = w.grid.tris;
    const s = this.sampler;
    const put = (i: number, col: RGB) => {
      rgba[4 * i] = col[0];
      rgba[4 * i + 1] = col[1];
      rgba[4 * i + 2] = col[2];
      rgba[4 * i + 3] = 255;
    };
    switch (opts.mode) {
      case 'elevation': {
        const e = this.elevation(opts.hex);
        const g = reliefScale(w.params.gravity);
        for (let i = 0; i < e.length; i++) put(i, hypsometric(e[i] / g, c));
        break;
      }
      case 'satellite': {
        const e = this.elevation(opts.hex);
        const wet = this.moisture();
        const g = reliefScale(w.params.gravity);
        for (let r = 0; r < height; r++) {
          const lat = ((r + 0.5) / height - 0.5) * 180;
          for (let col = 0; col < width; col++) {
            const i = r * width + col;
            put(i, satelliteColor(e[i], lat, wet[i], g, c));
          }
        }
        break;
      }
      case 'age': {
        const age = (this.ageTex ??= bakeScalar(s, tris, w.oceanAge));
        const e = this.elevation(opts.hex);
        for (let i = 0; i < age.length; i++) {
          const cell = nearestCellOf(s, tris, i);
          if (w.oceanAge[cell] < 0) {
            const v = e[i] > 0 ? 150 : 110;
            c[0] = v; c[1] = v; c[2] = v;
          } else oceanAgeColor(opts.hex ? w.oceanAge[cell] : Math.max(0, age[i]), c);
          put(i, c);
        }
        break;
      }
      case 'plates': {
        const e = this.elevation(opts.hex);
        for (let i = 0; i < e.length; i++) {
          const cell = nearestCellOf(s, tris, i);
          const b = w.boundary[cell];
          if (b !== 0) {
            const bc = BOUNDARY_COLORS[b];
            c[0] = bc[0]; c[1] = bc[1]; c[2] = bc[2];
          } else {
            const pc = w.plates[w.plate[cell]].color;
            // land lighter, deep ocean darker, so continents stay readable
            const k = e[i] > 0 ? 1.12 : 0.62 + 0.25 * Math.max(0, 1 + e[i] / 6000);
            c[0] = Math.min(255, pc[0] * k);
            c[1] = Math.min(255, pc[1] * k);
            c[2] = Math.min(255, pc[2] * k);
          }
          put(i, c);
        }
        break;
      }
    }
    return rgba;
  }
}
