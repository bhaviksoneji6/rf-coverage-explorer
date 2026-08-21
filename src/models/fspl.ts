/**
 * Free-space path loss.
 *
 * L = 20log10(4*pi*d/lambda), rearranged for kilometres and megahertz:
 *   L(dB) = 32.44778 + 20log10(f_MHz) + 20log10(d_km)
 *
 * The constant is 20log10(4*pi*1e9/c) with c = 299792458 m/s.
 *
 * This is Model 0: no terrain, no clutter, no diffraction. Its job is to be obviously
 * correct so the rest of the pipeline (projection, radial walk, resample, render) can be
 * validated against something with a closed-form answer -- an FSPL coverage map over any
 * terrain whatsoever must come out perfectly radially symmetric.
 */
export const FSPL_CONST_DB = 32.44778;

export function fsplDb(distanceKm: number, freqMHz: number): number {
  if (!(distanceKm > 0) || !(freqMHz > 0)) return 0;
  return FSPL_CONST_DB + 20 * Math.log10(freqMHz) + 20 * Math.log10(distanceKm);
}
