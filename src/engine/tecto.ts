import type { HexGrid } from '../grid/hexgrid';
import { useDeterministicMath, type MathExports } from '../core/dmath';
import { TECTO_WASM_BASE64 } from './tecto-wasm';

/**
 * Thin wrapper over the Rust tectonics engine (engine/, compiled to wasm).
 * Talks to it through a raw C ABI: inputs are copied into wasm memory,
 * outputs are read back through pointers and copied out.
 */

interface TectoExports extends MathExports {
  memory: WebAssembly.Memory;
  alloc(bytes: number): number;
  dealloc(ptr: number, bytes: number): void;
  sim_new(n: number, pos: number, off: number, nbrs: number, nnbrs: number, area: number, params: number, nparams: number): number;
  sim_init(sim: number, plate: number, cont: number, thick: number, age: number, omega: number, nplates: number): void;
  sim_run(sim: number, myr: number, maxSteps: number): number;
  sim_output(sim: number): void;
  sim_out(sim: number, which: number): number;
  sim_plate_count(sim: number): number;
  sim_layout(which: number): number;
  sim_free(sim: number): void;
}

/** Indices into the params array (must match engine/src/params.rs). */
export const P = {
  radius: 0, gravity: 1, seed: 2, meanSpeed: 3, minPlates: 4, maxPlates: 5,
  hotspots: 6, riftRate: 7, erosion: 8, maxDt: 9, landFraction: 10,
} as const;
export const PARAM_COUNT = 11;

export interface TectoInit {
  /** Plate index per cell. */
  plate: Uint32Array;
  /** 1 = continental crust. */
  cont: Uint8Array;
  /** Crust thickness, km. */
  thick: Float32Array;
  /** Crust age, Myr. */
  age: Float32Array;
  /** Angular velocity per plate, rad/Myr, xyz interleaved. */
  omega: Float64Array;
}

export interface TectoPlate {
  id: number;
  omega: [number, number, number];
  area: number;
  contArea: number;
  ageMyr: number;
}

export interface TectoOutput {
  owner: Uint32Array;
  cont: Uint8Array;
  thick: Float32Array;
  age: Float32Array;
  orogeny: Uint8Array;
  /** Isostatic elevation, km (datum, not yet sea-level corrected). */
  elevKm: Float32Array;
  plates: TectoPlate[];
  stats: TectoStats;
}

export interface TectoStats {
  time: number;
  steps: number;
  rifts: number;
  merges: number;
  subductionStarts: number;
  oceanSplits: number;
  platesRemoved: number;
  plates: number;
  seaLevelKm: number;
  subductedSr: number;
  createdSr: number;
  lastDt: number;
  /** Continental crust as a fraction of the surface. */
  contFraction: number;
  /** Rock eroded over the run, sr·km (× R² for km³). */
  erodedSrKm: number;
  /** Visible continental crust fraction. */
  contVisible: number;
  /** Diagnostics (sr): ocean→continent by arcs / hot spots, continent copied into gaps, continent thinned away. */
  convArc: number;
  convHot: number;
  copyCont: number;
  contLost: number;
  /** Continental volume budget, sr·km: subduction, rift, hotspot, erosion, deposition, collision, flow. */
  budget: number[];
  /** Mean continental crust thickness, km. */
  meanContThick: number;
}

let compiled: Promise<WebAssembly.Module> | undefined;

function wasmBytes(): Uint8Array<ArrayBuffer> {
  const bin = atob(TECTO_WASM_BASE64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let mathReady: Promise<void> | undefined;

/** Routes generation maths (`M.*`) through the engine's deterministic libm. */
export function initDeterministicMath(): Promise<void> {
  mathReady ??= loadTecto().then((t) => useDeterministicMath(t.exports));
  return mathReady;
}

/** Compiles (once) and instantiates a fresh engine instance. */
export async function loadTecto(): Promise<Tecto> {
  compiled ??= WebAssembly.compile(wasmBytes());
  const inst = await WebAssembly.instantiate(await compiled, {});
  return new Tecto(inst.exports as unknown as TectoExports);
}

type Typed = Float64Array | Float32Array | Uint32Array | Uint8Array;

export class Tecto {
  private sim = 0;
  private n = 0;
  constructor(private ex: TectoExports) {}

  get exports(): TectoExports {
    return this.ex;
  }

  private put(a: Typed): number {
    const p = this.ex.alloc(a.byteLength);
    new Uint8Array(this.ex.memory.buffer, p, a.byteLength).set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
    return p;
  }

  create(grid: HexGrid, params: Float64Array): void {
    this.dispose();
    const ex = this.ex;
    this.n = grid.count;
    const ptrs: [number, number][] = [];
    const put = (a: Typed) => {
      const p = this.put(a);
      ptrs.push([p, a.byteLength]);
      return p;
    };
    const pos = put(grid.pos);
    const off = put(grid.nbrOffset);
    const nb = put(grid.nbrs);
    const area = put(grid.area);
    const prm = put(params);
    this.sim = ex.sim_new(grid.count, pos, off, nb, grid.nbrs.length, area, prm, params.length);
    for (const [p, b] of ptrs) ex.dealloc(p, b);
  }

  init(s: TectoInit): void {
    const ex = this.ex;
    const bufs = [s.plate, s.cont, s.thick, s.age, s.omega];
    const ptrs = bufs.map((b) => this.put(b));
    ex.sim_init(this.sim, ptrs[0], ptrs[1], ptrs[2], ptrs[3], ptrs[4], s.omega.length / 3);
    bufs.forEach((b, i) => ex.dealloc(ptrs[i], b.byteLength));
  }

  /** Advances ~`myr` million years; returns the simulation time. */
  run(myr: number, maxSteps = 1_000_000): number {
    return this.ex.sim_run(this.sim, myr, maxSteps);
  }

  output(): TectoOutput {
    const ex = this.ex;
    ex.sim_output(this.sim);
    const n = this.n;
    const buf = () => ex.memory.buffer;
    const ptr = (w: number) => ex.sim_out(this.sim, w);
    const np = ex.sim_plate_count(this.sim);
    const pf = ex.sim_layout(0);
    const sf = ex.sim_layout(1);
    const pl = new Float64Array(buf(), ptr(6), np * pf).slice();
    const st = new Float64Array(buf(), ptr(7), sf).slice();
    const plates: TectoPlate[] = [];
    for (let i = 0; i < np; i++) {
      const o = i * pf;
      plates.push({ id: pl[o], omega: [pl[o + 1], pl[o + 2], pl[o + 3]], area: pl[o + 4], contArea: pl[o + 5], ageMyr: pl[o + 6] });
    }
    return {
      owner: new Uint32Array(buf(), ptr(0), n).slice(),
      cont: new Uint8Array(buf(), ptr(1), n).slice(),
      thick: new Float32Array(buf(), ptr(2), n).slice(),
      age: new Float32Array(buf(), ptr(3), n).slice(),
      orogeny: new Uint8Array(buf(), ptr(4), n).slice(),
      elevKm: new Float32Array(buf(), ptr(5), n).slice(),
      plates,
      stats: {
        time: st[0], steps: st[1], rifts: st[2], merges: st[3], subductionStarts: st[4], oceanSplits: st[5],
        platesRemoved: st[6], plates: st[7], seaLevelKm: st[8], subductedSr: st[9], createdSr: st[10], lastDt: st[11], contFraction: st[12], erodedSrKm: st[13], contVisible: st[14], convArc: st[15], convHot: st[16], copyCont: st[17], contLost: st[18], budget: Array.from(st.slice(20, 27)), meanContThick: st[27],
      },
    };
  }

  dispose(): void {
    if (this.sim) this.ex.sim_free(this.sim);
    this.sim = 0;
  }
}
