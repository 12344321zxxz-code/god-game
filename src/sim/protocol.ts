import type { PlanetParams } from '../core/presets';
import type { MapMode } from '../render/bake';
import type { Plate, WorldStats } from './world';

export type WorkerRequest =
  | { type: 'generate'; id: number; params: PlanetParams; texWidth: number; texHeight: number; mode: MapMode; hex: boolean }
  | { type: 'render'; id: number; mode: MapMode; hex: boolean };

/** Per-cell data mirrored on the main thread (for hover info and overlays). */
export interface CellData {
  pos: Float64Array;
  nbrOffset: Uint32Array;
  nbrs: Uint32Array;
  plate: Uint16Array;
  crust: Uint8Array;
  elevation: Float32Array;
  oceanAge: Float32Array;
  orogeny: Uint8Array;
  boundary: Uint8Array;
  boundaryRate: Float32Array;
  velocity: Float32Array;
}

export type WorkerResponse =
  | { type: 'progress'; id: number; stage: string; fraction: number }
  | {
      type: 'generated';
      id: number;
      params: PlanetParams;
      stats: WorldStats;
      plates: Plate[];
      cells: CellData;
      width: number;
      height: number;
      heightMap: Uint16Array;
      rgba: Uint8Array;
      mode: MapMode;
    }
  | { type: 'texture'; id: number; mode: MapMode; width: number; height: number; rgba: Uint8Array; heightMap: Uint16Array }
  | { type: 'error'; id: number; message: string };

/** Buffers to transfer (not copy) for a response. */
export function transferables(msg: WorkerResponse): Transferable[] {
  if (msg.type === 'generated') {
    const c = msg.cells;
    return [
      msg.heightMap.buffer, msg.rgba.buffer, c.pos.buffer, c.nbrOffset.buffer, c.nbrs.buffer, c.plate.buffer,
      c.crust.buffer, c.elevation.buffer, c.oceanAge.buffer, c.orogeny.buffer, c.boundary.buffer,
      c.boundaryRate.buffer, c.velocity.buffer,
    ] as Transferable[];
  }
  if (msg.type === 'texture') return [msg.rgba.buffer, msg.heightMap.buffer] as Transferable[];
  return [];
}
