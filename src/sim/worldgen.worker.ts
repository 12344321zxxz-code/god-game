/// <reference lib="webworker" />
import { Engine } from './engine';
import { transferables, type WorkerRequest, type WorkerResponse } from './protocol';

const engine = new Engine();
const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  engine.handle(ev.data, (msg: WorkerResponse) => scope.postMessage(msg, transferables(msg)));
};
