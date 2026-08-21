import { fsplDb } from '../models/fspl.js';
import { sampleBilinear } from './sampler.js';
import {
  EARTH_RADIUS_M,
  type ComputeParams,
  type RadialFields,
  type TerrainGridSpec,
} from './types.js';

/**
 * Radial walk from the transmitter.
 *
 * Casting radials and resampling onto the output grid costs ~1M terrain samples at
 * 30km/100m, against ~35M for walking an independent profile to every output bin. The
 * usual objection -- star-shaped aliasing near the transmitter -- does not apply because
 * `radialParams` picks the radial count so the arc gap at maximum range is still smaller
 * than one output bin.
 *
 * The walk maintains no running horizon state yet: Pass 1's model is FSPL. The loop
 * structure is deliberately the one diffraction needs, so Pass 2 adds a running max
 * elevation angle here and nothing else moves.
 */
export function computeRadials(
  terrain: Float32Array,
  spec: TerrainGridSpec,
  p: ComputeParams,
): RadialFields {
  const { nRadials, nSteps, stepM, txE, txN, freqMHz, kFactor } = p;
  const total = nRadials * nSteps;

  const pathLoss = new Float32Array(total);
  const elevAngle = new Float32Array(total);

  const txGround = sampleBilinear(terrain, spec, txE, txN);
  const txZ = txGround + p.txHeightAglM;

  // FSPL depends only on range, so precompute it once per step instead of per sample.
  const lossByStep = new Float32Array(nSteps);
  for (let s = 0; s < nSteps; s++) {
    lossByStep[s] = fsplDb(((s + 1) * stepM) / 1000, freqMHz);
  }

  const twoKRe = 2 * kFactor * EARTH_RADIUS_M;

  for (let k = 0; k < nRadials; k++) {
    // Bearing measured clockwise from grid north.
    const theta = (2 * Math.PI * k) / nRadials;
    const dE = Math.sin(theta);
    const dN = Math.cos(theta);
    const base = k * nSteps;

    for (let s = 0; s < nSteps; s++) {
      const d = (s + 1) * stepM;
      const ground = sampleBilinear(terrain, spec, txE + dE * d, txN + dN * d);

      // Effective-earth flattening: drop each point by its fall below the tangent plane at
      // the TX, after which plain straight-line geometry is valid. Note this is d^2/(2kRe)
      // (~26.5 m at 21 km), not the d1*d2/(2kRe) mid-path-versus-chord bulge (~6.6 m there)
      // that Fresnel clearance is quoted against -- same physics, different reference.
      const drop = (d * d) / twoKRe;
      const rxZ = ground + p.rxHeightAglM - drop;

      const i = base + s;
      elevAngle[i] = Math.atan2(rxZ - txZ, d);
      pathLoss[i] = lossByStep[s] as number;
    }
  }

  return { pathLoss, elevAngle };
}
