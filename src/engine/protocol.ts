import type { ComputeParams, GridSpec, TerrainGridSpec } from './types.js';

export type WorkerRequest =
  /**
   * Terrain is uploaded once per AOI and retained in the worker, so a Class-2 change
   * (height, frequency, model) posts only a few numbers rather than 4MB.
   */
  | { type: 'setTerrain'; terrain: ArrayBuffer; spec: TerrainGridSpec }
  | { type: 'compute'; reqId: number; siteId: string; params: ComputeParams; grid: GridSpec };

export type WorkerResponse =
  | { type: 'terrainReady' }
  | {
      type: 'result';
      reqId: number;
      siteId: string;
      pathLoss: ArrayBuffer;
      diffraction: ArrayBuffer;
      elevAngle: ArrayBuffer;
      width: number;
      height: number;
      ms: number;
    }
  | { type: 'error'; reqId: number; message: string };
