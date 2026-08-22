import type { WorkerRequest, WorkerResponse } from './protocol.js';
import type { ComputeParams, GridSpec, SiteGrid, TerrainGridSpec } from './types.js';

export interface ComputeOutcome extends SiteGrid {
  siteId: string;
  ms: number;
}

/**
 * Main-thread handle on the propagation worker.
 *
 * Requests are superseded rather than queued: while the user drags a slider we only care
 * about the newest result, so stale replies are dropped on arrival. Without this a fast
 * drag builds a backlog and the map lags behind the control by seconds.
 */
export class EngineClient {
  private worker: Worker;
  private nextId = 1;
  private latestPerSite = new Map<string, number>();
  private pending = new Map<number, (r: ComputeOutcome | null) => void>();
  private terrainReady: Promise<void>;
  private resolveTerrain: (() => void) | null = null;
  private onError: (msg: string) => void;

  constructor(onError: (msg: string) => void = console.error) {
    this.onError = onError;
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.terrainReady = new Promise((resolve) => {
      this.resolveTerrain = resolve;
    });
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => this.handle(ev.data);
  }

  private handle(msg: WorkerResponse): void {
    if (msg.type === 'terrainReady') {
      this.resolveTerrain?.();
      return;
    }
    if (msg.type === 'error') {
      const reject = this.pending.get(msg.reqId);
      this.pending.delete(msg.reqId);
      this.onError(msg.message);
      // Settle even on failure, or the pipeline stage awaiting this never returns and the
      // store's `running` guard blocks every later change permanently.
      reject?.(null);
      return;
    }
    const resolve = this.pending.get(msg.reqId);
    this.pending.delete(msg.reqId);
    if (!resolve) return;

    // A newer request for this site has superseded this result. Resolve with null rather
    // than dropping it: an unsettled promise here would deadlock the pipeline.
    if (this.latestPerSite.get(msg.siteId) !== msg.reqId) {
      resolve(null);
      return;
    }

    resolve({
      siteId: msg.siteId,
      pathLoss: new Float32Array(msg.pathLoss),
      diffraction: new Float32Array(msg.diffraction),
      elevAngle: new Float32Array(msg.elevAngle),
      width: msg.width,
      height: msg.height,
      ms: msg.ms,
    });
  }

  /** Upload terrain once per AOI. A copy is transferred so the caller keeps its own array. */
  setTerrain(terrain: Float32Array, spec: TerrainGridSpec): Promise<void> {
    this.terrainReady = new Promise((resolve) => {
      this.resolveTerrain = resolve;
    });
    const copy = terrain.slice();
    const req: WorkerRequest = { type: 'setTerrain', terrain: copy.buffer as ArrayBuffer, spec };
    this.worker.postMessage(req, [copy.buffer as ArrayBuffer]);
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
    const req: WorkerRequest = { type: 'compute', reqId, siteId, params, grid };
    return new Promise<ComputeOutcome | null>((resolve) => {
      this.pending.set(reqId, resolve);
      this.worker.postMessage(req);
    });
  }

  dispose(): void {
    this.worker.terminate();
  }
}
