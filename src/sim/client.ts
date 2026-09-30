import type { Engine } from './engine';
import type { WorkerRequest, WorkerResponse } from './protocol';
import WorldgenWorker from './worldgen.worker.ts?worker&inline';

type Listener = (msg: WorkerResponse) => void;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * Talks to the generation engine. Prefers a Web Worker so the page stays
 * responsive; if workers are unavailable (some sandboxed previews block
 * them) it runs the engine on the main thread instead, with the same API.
 */
export class WorldClient {
  private worker?: Worker;
  private fallback?: Engine;
  private listeners = new Set<Listener>();
  private nextId = 1;
  /** Requests sent to the worker that haven't produced any reply yet. */
  private unanswered: WorkerRequest[] = [];
  private workerAlive = false;
  mode: 'worker' | 'main-thread' = 'worker';

  /** Id of the generate request the worker is busy with, if any. */
  private generating = 0;
  /** Main-thread requests run one after another, in order. */
  private localQueue: Promise<void> = Promise.resolve();

  constructor() {
    this.spawn();
  }

  private spawn() {
    this.workerAlive = false; // a respawned worker must prove itself again
    try {
      this.worker = new WorldgenWorker();
      this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
        this.workerAlive = true;
        this.unanswered = [];
        const m = ev.data;
        if ((m.type === 'generated' || m.type === 'error') && m.id === this.generating) this.generating = 0;
        this.emit(m);
      };
      this.worker.onerror = (ev) => {
        console.error('worker error', ev);
        if (!this.workerAlive) this.switchToMainThread();
      };
    } catch (e) {
      console.warn('Web Worker unavailable, generating on the main thread', e);
      this.worker = undefined;
      this.mode = 'main-thread';
    }
  }

  onMessage(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit(msg: WorkerResponse) {
    for (const l of this.listeners) l(msg);
  }

  private switchToMainThread() {
    this.worker?.terminate();
    this.worker = undefined;
    this.mode = 'main-thread';
    const pending = this.unanswered;
    this.unanswered = [];
    for (const r of pending) this.enqueueLocal(r);
  }

  /** Queues a request on the main thread without waiting for it, so the
   *  caller learns the request id before any reply for it is emitted. */
  private enqueueLocal(req: WorkerRequest) {
    this.localQueue = this.localQueue
      .then(() => this.runLocal(req))
      .catch((e: unknown) => this.emit({ type: 'error', id: req.id, message: String(e) }));
  }

  private async runLocal(req: WorkerRequest) {
    if (!this.fallback) {
      const { Engine } = await import('./engine');
      this.fallback = new Engine();
    }
    // Yield so the UI can paint its "working…" state before the long run.
    await new Promise((r) => setTimeout(r, 30));
    await this.fallback.handle(req, (m) => this.emit(m));
  }

  send(req: DistributiveOmit<WorkerRequest, 'id'>): number {
    const id = this.nextId++;
    const full = { ...req, id } as WorkerRequest;
    if (this.worker && full.type === 'generate' && this.generating && this.workerAlive) {
      // A plate simulation can run for minutes: drop the stale one by
      // restarting the worker rather than queueing behind it.
      this.worker.terminate();
      this.unanswered = [];
      this.spawn();
    }
    if (full.type === 'generate') this.generating = id;
    if (this.worker) {
      this.unanswered.push(full);
      this.worker.postMessage(full);
    } else {
      this.enqueueLocal(full);
    }
    return id;
  }
}
