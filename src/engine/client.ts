import type { WorkerRequest, WorkerResponse } from './protocol.js';
import type { ComputeParams, GridSpec, SiteGrid, TerrainGridSpec } from './types.js';

export interface ComputeOutcome extends SiteGrid {
  siteId: string;
  ms: number;
}

interface Slot {
  worker: Worker;
  busy: boolean;
  ready: boolean;
}

interface Job {
  reqId: number;
  siteId: string;
  params: ComputeParams;
  grid: GridSpec;
  settle: (r: ComputeOutcome | null) => void;
}

/**
 * Pool of propagation workers.
 *
 * Sites are independent, so they parallelise perfectly. The pool only matters on a fresh
 * area though: the per-site memo means nudging one site recomputes one site regardless of
 * how many exist, so this earns its keep on first load and on AOI change rather than during
 * ordinary tuning.
 *
 * Terrain is copied to each worker rather than shared. SharedArrayBuffer would avoid the
 * copy but needs COOP/COEP, and since terrain is uploaded once per AOI rather than per
 * recompute the whole saving is a few tens of milliseconds -- not worth the risk of
 * `require-corp` blocking the cross-origin basemap.
 */
export class EngineClient {
  private slots: Slot[] = [];
  private queue: Job[] = [];
  private nextId = 1;
  private latestPerSite = new Map<string, number>();
  private pending = new Map<number, Job>();
  private terrainReady: Promise<void> = Promise.resolve();
  private onError: (msg: string) => void;

  constructor(onError: (msg: string) => void = console.error, poolSize?: number) {
    this.onError = onError;
    // Four is plenty: each worker holds its own 4 MB terrain copy, and real networks here
    // are a handful of sites rather than dozens.
    const size = Math.max(1, poolSize ?? Math.min(navigator.hardwareConcurrency || 2, 4));
    for (let i = 0; i < size; i++) {
      const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      const slot: Slot = { worker, busy: false, ready: false };
      worker.onmessage = (ev: MessageEvent<WorkerResponse>) => this.handle(slot, ev.data);
      this.slots.push(slot);
    }
  }

  get size(): number {
    return this.slots.length;
  }

  private handle(slot: Slot, msg: WorkerResponse): void {
    if (msg.type === 'terrainReady') {
      slot.ready = true;
      return;
    }

    slot.busy = false;
    const job = this.pending.get(msg.reqId);
    this.pending.delete(msg.reqId);
    this.drain();

    if (!job) return;

    if (msg.type === 'error') {
      this.onError(msg.message);
      // Settle even on failure: an unsettled promise here would hang the awaiting stage and
      // latch the store's `running` guard, blocking every later change permanently.
      job.settle(null);
      return;
    }

    // A newer request for this site has superseded this result. Resolve null rather than
    // dropping it, for the same reason.
    if (this.latestPerSite.get(msg.siteId) !== msg.reqId) {
      job.settle(null);
      return;
    }

    job.settle({
      siteId: msg.siteId,
      pathLoss: new Float32Array(msg.pathLoss),
      diffraction: new Float32Array(msg.diffraction),
      elevAngle: new Float32Array(msg.elevAngle),
      width: msg.width,
      height: msg.height,
      ms: msg.ms,
    });
  }

  private drain(): void {
    while (this.queue.length > 0) {
      const slot = this.slots.find((s) => !s.busy);
      if (!slot) return;
      const job = this.queue.shift() as Job;
      slot.busy = true;
      const req: WorkerRequest = {
        type: 'compute',
        reqId: job.reqId,
        siteId: job.siteId,
        params: job.params,
        grid: job.grid,
      };
      slot.worker.postMessage(req);
    }
  }

  /** Upload terrain to every worker. Each gets its own copy; the caller keeps the original. */
  setTerrain(terrain: Float32Array, spec: TerrainGridSpec): Promise<void> {
    this.terrainReady = Promise.all(
      this.slots.map(
        (slot) =>
          new Promise<void>((resolve) => {
            slot.ready = false;
            const copy = terrain.slice();
            const previous = slot.worker.onmessage;
            slot.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
              if (ev.data.type === 'terrainReady') {
                slot.worker.onmessage = previous;
                slot.ready = true;
                resolve();
                return;
              }
              (previous as ((e: MessageEvent<WorkerResponse>) => void) | null)?.call(
                slot.worker,
                ev,
              );
            };
            const req: WorkerRequest = {
              type: 'setTerrain',
              terrain: copy.buffer as ArrayBuffer,
              spec,
            };
            slot.worker.postMessage(req, [copy.buffer as ArrayBuffer]);
          }),
      ),
    ).then(() => undefined);
    return this.terrainReady;
  }

  /** Resolves to `null` when superseded by a newer request for the same site, or on error. */
  async compute(
    siteId: string,
    params: ComputeParams,
    grid: GridSpec,
  ): Promise<ComputeOutcome | null> {
    await this.terrainReady;
    const reqId = this.nextId++;
    this.latestPerSite.set(siteId, reqId);
    return new Promise<ComputeOutcome | null>((settle) => {
      const job: Job = { reqId, siteId, params, grid, settle };
      this.pending.set(reqId, job);
      this.queue.push(job);
      this.drain();
    });
  }

  dispose(): void {
    for (const slot of this.slots) slot.worker.terminate();
    this.slots = [];
  }
}
