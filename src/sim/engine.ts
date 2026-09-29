import { buildTextureSampler, type TextureSampler } from '../grid/sampler';
import { WorldBaker } from '../render/bake';
import { generateWorld } from './generate';
import type { WorkerRequest, WorkerResponse } from './protocol';
import type { World } from './world';

/**
 * The generation engine. Runs inside a Web Worker normally, or in-process
 * as a fallback. Holds the current world so map-mode changes only re-bake.
 */
export class Engine {
  /** The latest generated world (kept for later stages like climate re-runs). */
  world?: World;
  private baker?: WorldBaker;
  private sampler?: { key: string; s: TextureSampler };

  handle(req: WorkerRequest, send: (msg: WorkerResponse) => void): void {
    try {
      if (req.type === 'generate') {
        const progress = (stage: string, fraction: number) => send({ type: 'progress', id: req.id, stage, fraction });
        const world = generateWorld(req.params, progress);
        const key = `${world.grid.freq}:${req.texWidth}x${req.texHeight}`;
        if (this.sampler?.key !== key) {
          progress('Mapping texture', 0.8);
          const t0 = performance.now();
          this.sampler = { key, s: buildTextureSampler(world.grid, req.texWidth, req.texHeight) };
          world.stats.timings.sampler = Math.round(performance.now() - t0);
        }
        this.world = world;
        this.baker = new WorldBaker(world, this.sampler.s);
        progress('Painting', 0.9);
        const t1 = performance.now();
        const rgba = this.baker.bake({ mode: req.mode, hex: req.hex });
        const heightMap = this.baker.heightMap(req.hex);
        world.stats.timings.paint = Math.round(performance.now() - t1);
        const g = world.grid;
        send({
          type: 'generated',
          id: req.id,
          params: world.params,
          stats: world.stats,
          score: world.score,
          plates: world.plates,
          width: this.baker.width,
          height: this.baker.height,
          heightMap,
          rgba,
          mode: req.mode,
          cells: {
            pos: g.pos.slice(),
            nbrOffset: g.nbrOffset.slice(),
            nbrs: g.nbrs.slice(),
            plate: world.plate.slice(),
            crust: world.crust.slice(),
            elevation: world.elevation.slice(),
            oceanAge: world.oceanAge.slice(),
            orogeny: world.orogeny.slice(),
            boundary: world.boundary.slice(),
            boundaryRate: world.boundaryRate.slice(),
            velocity: world.velocity.slice(),
          },
        });
      } else if (req.type === 'render') {
        if (!this.baker) throw new Error('No world generated yet');
        const rgba = this.baker.bake({ mode: req.mode, hex: req.hex });
        send({
          type: 'texture',
          id: req.id,
          mode: req.mode,
          width: this.baker.width,
          height: this.baker.height,
          rgba,
          heightMap: this.baker.heightMap(req.hex),
        });
      }
    } catch (e) {
      send({ type: 'error', id: req.id, message: e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e) });
    }
  }
}
