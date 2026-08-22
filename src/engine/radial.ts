import { fsplDb } from '../models/fspl.js';
import { obstacleLossDb, wavelengthM } from '../models/diffraction.js';
import { sampleBilinear } from './sampler.js';
import {
  EARTH_RADIUS_M,
  type ComputeParams,
  type RadialFields,
  type TerrainGridSpec,
} from './types.js';

/**
 * Radial walk from the transmitter, with a running horizon.
 *
 * Casting radials and resampling grid<-radial costs ~1M terrain samples at 30km/100m against
 * ~34.7M for walking an independent profile to every output bin. `radialParams` picks the
 * radial count so the arc gap at maximum range is still under one output bin, which is why
 * there is no star aliasing and why unfilled bins are structurally impossible.
 *
 * The diffraction test is what makes this shape worth having. Walking outward and keeping
 * the maximum elevation angle seen so far gives, in O(1) per sample:
 *
 *   - whether the receiver is line-of-sight (its own angle clears the running maximum), and
 *   - the controlling knife edge (the sample that set that maximum),
 *
 * so a whole coverage map costs one pass rather than a search per bin.
 */
export function computeRadials(
  terrain: Float32Array,
  spec: TerrainGridSpec,
  p: ComputeParams,
): RadialFields {
  const { nRadials, nSteps, stepM, txE, txN, freqMHz, kFactor } = p;
  const total = nRadials * nSteps;
  const withDiffraction = p.model === 'diffraction';

  const pathLoss = new Float32Array(total);
  const diffraction = new Float32Array(total);
  const elevAngle = new Float32Array(total);

  const txGround = sampleBilinear(terrain, spec, txE, txN);
  const txZ = txGround + p.txHeightAglM;
  const lambda = wavelengthM(freqMHz);

  // Free space depends only on range, so it is computed once per step rather than per sample.
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

    // Highest elevation angle to bare terrain seen so far along this radial, and where.
    let maxSlope = -Infinity;
    let obstacleD = 0;
    let obstacleZ = 0;

    for (let s = 0; s < nSteps; s++) {
      const d = (s + 1) * stepM;
      const ground = sampleBilinear(terrain, spec, txE + dE * d, txN + dN * d);

      // Effective-earth flattening: drop each point by its fall below the tangent plane at
      // the transmitter, after which plain straight-line geometry is valid. This is
      // d^2/(2kRe) (~26.5 m at 21 km), not the d1*d2/(2kRe) mid-path-versus-chord bulge
      // (~6.6 m there) that Fresnel clearance is quoted against.
      const drop = (d * d) / twoKRe;
      const groundZ = ground - drop;
      const rxZ = groundZ + p.rxHeightAglM;

      const i = base + s;
      elevAngle[i] = Math.atan2(rxZ - txZ, d);

      if (withDiffraction) {
        // Compare the receiver against the horizon established by everything BEFORE it --
        // a point cannot shadow itself.
        const rxSlope = (rxZ - txZ) / d;
        if (rxSlope < maxSlope && obstacleD > 0) {
          diffraction[i] = obstacleLossDb(obstacleZ, obstacleD, d, txZ, rxZ, lambda);
        }

        // Now fold this sample's bare terrain into the horizon for everything beyond it.
        const groundSlope = (groundZ - txZ) / d;
        if (groundSlope > maxSlope) {
          maxSlope = groundSlope;
          obstacleD = d;
          obstacleZ = groundZ;
        }
      }

      pathLoss[i] = (lossByStep[s] as number) + (diffraction[i] as number);
    }
  }

  return { pathLoss, diffraction, elevAngle };
}
