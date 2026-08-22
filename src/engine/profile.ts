import { firstFresnelRadiusM, obstacleLossDb, wavelengthM } from '../models/diffraction.js';
import { fsplDb } from '../models/fspl.js';
import { sampleBilinear, sampleNearest } from './sampler.js';
import { EARTH_RADIUS_M, type TerrainGridSpec } from './types.js';

export interface ProfileRequest {
  txE: number;
  txN: number;
  txHeightAglM: number;
  rxE: number;
  rxN: number;
  rxHeightAglM: number;
  freqMHz: number;
  kFactor: number;
  /** Sample spacing along the path; ~15 m keeps ridge crests from being stepped over. */
  stepM?: number;
}

export interface Profile {
  /** Distance from the transmitter, metres. */
  d: Float32Array;
  /** Bare-earth elevation, metres AMSL -- as measured, not earth-flattened. */
  ground: Float32Array;
  /** Height of the earth-flattening drop at each sample, for drawing the curved datum. */
  drop: Float32Array;
  /** Normalised clutter class per sample, or null when no land cover is loaded. */
  clutter: Uint8Array | null;
  /** First Fresnel zone radius at each sample, metres. */
  fresnel: Float32Array;

  totalM: number;
  txZ: number;
  rxZ: number;
  txGround: number;
  rxGround: number;

  /** Index of the controlling knife edge, or -1 when the path is line-of-sight. */
  obstacleIndex: number;
  los: boolean;
  fsplDb: number;
  diffractionDb: number;
  /** Worst intrusion into the first Fresnel zone, as a fraction (1 = fully clear). */
  worstClearance: number;
}

/**
 * Full terrain profile along one transmitter-receiver path.
 *
 * Kept separate from the radial walk because the hover panel needs everything -- ground,
 * clutter, Fresnel radius, the controlling edge -- for a single path, whereas the coverage
 * pass needs three numbers for a million of them. Recomputing one profile on demand is
 * about 1400 samples, far cheaper than storing all of this for every radial.
 */
export function computeProfile(
  terrain: Float32Array,
  spec: TerrainGridSpec,
  clutterRaster: Uint8Array | null,
  req: ProfileRequest,
): Profile {
  const stepM = req.stepM ?? 15;
  const dx = req.rxE - req.txE;
  const dy = req.rxN - req.txN;
  const totalM = Math.hypot(dx, dy);

  const n = Math.max(2, Math.ceil(totalM / stepM) + 1);
  const ux = totalM > 0 ? dx / totalM : 0;
  const uy = totalM > 0 ? dy / totalM : 0;

  const d = new Float32Array(n);
  const ground = new Float32Array(n);
  const drop = new Float32Array(n);
  const fresnel = new Float32Array(n);
  const clutter = clutterRaster ? new Uint8Array(n) : null;

  const twoKRe = 2 * req.kFactor * EARTH_RADIUS_M;
  const lambda = wavelengthM(req.freqMHz);

  for (let i = 0; i < n; i++) {
    const di = (totalM * i) / (n - 1);
    const e = req.txE + ux * di;
    const nn = req.txN + uy * di;
    d[i] = di;
    ground[i] = sampleBilinear(terrain, spec, e, nn);
    drop[i] = (di * di) / twoKRe;
    fresnel[i] = firstFresnelRadiusM(di, totalM - di, lambda);
    // Categorical: nearest neighbour, never interpolated between classes.
    if (clutter && clutterRaster) clutter[i] = sampleNearest(clutterRaster, spec, e, nn);
  }

  const txGround = ground[0] as number;
  const rxGround = ground[n - 1] as number;
  const txZ = txGround + req.txHeightAglM;
  const rxZ = rxGround - (drop[n - 1] as number) + req.rxHeightAglM;

  // Same horizon logic as the radial walk, over the interior samples only.
  let maxSlope = -Infinity;
  let obstacleIndex = -1;
  let worstClearance = Infinity;

  for (let i = 1; i < n - 1; i++) {
    const di = d[i] as number;
    const gz = (ground[i] as number) - (drop[i] as number);
    const slope = (gz - txZ) / di;
    if (slope > maxSlope) {
      maxSlope = slope;
      obstacleIndex = i;
    }
    // Clearance relative to the first Fresnel zone: 1 means the ray grazes the terrain,
    // above 1 means fully clear, below 0 means blocked.
    const rayZ = txZ + ((rxZ - txZ) * di) / totalM;
    const r = fresnel[i] as number;
    if (r > 0) {
      const clearance = (rayZ - gz) / r;
      if (clearance < worstClearance) worstClearance = clearance;
    }
  }

  const rxSlope = totalM > 0 ? (rxZ - txZ) / totalM : 0;
  const los = obstacleIndex < 0 || rxSlope >= maxSlope;

  let diffractionDb = 0;
  if (!los && obstacleIndex >= 0) {
    diffractionDb = obstacleLossDb(
      (ground[obstacleIndex] as number) - (drop[obstacleIndex] as number),
      d[obstacleIndex] as number,
      totalM,
      txZ,
      rxZ,
      lambda,
    );
  }

  return {
    d,
    ground,
    drop,
    clutter,
    fresnel,
    totalM,
    txZ,
    rxZ,
    txGround,
    rxGround,
    obstacleIndex: los ? -1 : obstacleIndex,
    los,
    fsplDb: fsplDb(totalM / 1000, req.freqMHz),
    diffractionDb,
    worstClearance: Number.isFinite(worstClearance) ? worstClearance : 1,
  };
}
