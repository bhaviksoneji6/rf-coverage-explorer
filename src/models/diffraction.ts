/** Speed of light, m/s. */
const C = 299792458;

export function wavelengthM(freqMHz: number): number {
  return C / (freqMHz * 1e6);
}

/**
 * Fresnel-Kirchhoff diffraction parameter.
 *
 *   v = h * sqrt( 2(d1 + d2) / (lambda * d1 * d2) )
 *
 * `h` is the obstacle height above the straight transmitter-receiver line, signed: positive
 * when the obstacle intrudes, negative when the line clears it. All distances in metres.
 */
export function fresnelParameter(h: number, d1: number, d2: number, lambda: number): number {
  if (!(d1 > 0) || !(d2 > 0) || !(lambda > 0)) return 0;
  return h * Math.sqrt((2 * (d1 + d2)) / (lambda * d1 * d2));
}

/** Radius of the first Fresnel zone at a point d1/d2 along a path. */
export function firstFresnelRadiusM(d1: number, d2: number, lambda: number): number {
  const d = d1 + d2;
  if (!(d > 0)) return 0;
  return Math.sqrt((lambda * d1 * d2) / d);
}

/**
 * Single knife-edge diffraction loss, ITU-R P.526 eq. 31.
 *
 *   J(v) = 6.9 + 20 log10( sqrt((v - 0.1)^2 + 1) + v - 0.1 )   for v > -0.78
 *   J(v) = 0                                                    otherwise
 *
 * Returns dB, always >= 0. The v = 0 case gives 6.02 dB, the familiar grazing-incidence
 * figure -- a ray that just touches the obstacle has already lost half its field.
 *
 * Known weakness, and the reason this is Model 1 rather than the destination: a single edge
 * under-predicts loss when several obstacles block the path, because it accounts for only
 * the one with the highest diffraction angle. Delta-Bullington is the fix, and it is the
 * same profile walk feeding it.
 */
export function knifeEdgeLossDb(v: number): number {
  if (v <= -0.78) return 0;
  const t = v - 0.1;
  return 6.9 + 20 * Math.log10(Math.sqrt(t * t + 1) + t);
}

/**
 * Diffraction loss for an obstacle of height `obstacleZ` at distance `d1` from the
 * transmitter, on a path from `txZ` to `rxZ` of total length `d`.
 *
 * Heights must already be in the earth-flattened frame so the transmitter-receiver line is
 * genuinely straight.
 */
export function obstacleLossDb(
  obstacleZ: number,
  d1: number,
  d: number,
  txZ: number,
  rxZ: number,
  lambda: number,
): number {
  const d2 = d - d1;
  if (!(d1 > 0) || !(d2 > 0)) return 0;
  // Height of the direct ray where it passes the obstacle.
  const rayZ = txZ + ((rxZ - txZ) * d1) / d;
  return knifeEdgeLossDb(fresnelParameter(obstacleZ - rayZ, d1, d2, lambda));
}
