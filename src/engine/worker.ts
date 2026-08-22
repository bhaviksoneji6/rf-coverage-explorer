/// <reference lib="webworker" />
import { computeRadials } from './radial.js';
import { resampleRadialToGrid } from './resample.js';
import type { WorkerRequest, WorkerResponse } from './protocol.js';
import type { TerrainGridSpec } from './types.js';

let terrain: Float32Array | null = null;
let spec: TerrainGridSpec | null = null;

function post(msg: WorkerResponse, transfer: Transferable[] = []): void {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer);
}

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;

  if (msg.type === 'setTerrain') {
    terrain = new Float32Array(msg.terrain);
    spec = msg.spec;
    post({ type: 'terrainReady' });
    return;
  }

  if (msg.type !== 'compute') return;

  try {
    if (!terrain || !spec) throw new Error('compute requested before terrain was set');

    const t0 = performance.now();
    const { params, grid } = msg;

    const radial = computeRadials(terrain, spec, params);

    const n = grid.width * grid.height;
    const pathLoss = new Float32Array(n);
    const diffraction = new Float32Array(n);
    const elevAngle = new Float32Array(n);

    const resample = (src: Float32Array, dst: Float32Array, angular = false): void => {
      resampleRadialToGrid(
        src,
        params.nRadials,
        params.nSteps,
        params.stepM,
        params.txE,
        params.txN,
        grid,
        dst,
        NaN,
        angular,
      );
    };

    resample(radial.pathLoss, pathLoss);
    resample(radial.diffraction, diffraction);
    resample(radial.elevAngle, elevAngle, true);

    post(
      {
        type: 'result',
        reqId: msg.reqId,
        siteId: msg.siteId,
        pathLoss: pathLoss.buffer as ArrayBuffer,
        diffraction: diffraction.buffer as ArrayBuffer,
        elevAngle: elevAngle.buffer as ArrayBuffer,
        width: grid.width,
        height: grid.height,
        ms: performance.now() - t0,
      },
      [
        pathLoss.buffer as ArrayBuffer,
        diffraction.buffer as ArrayBuffer,
        elevAngle.buffer as ArrayBuffer,
      ],
    );
  } catch (err) {
    post({ type: 'error', reqId: msg.reqId, message: err instanceof Error ? err.message : String(err) });
  }
};
