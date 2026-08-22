/**
 * Receiver-side radio arithmetic.
 *
 * Lives beside the propagation models rather than in the store because none of it is about
 * application state -- and because `engine/` needs it, which must not mean `engine/`
 * importing from `store/`.
 */

/** Thermal noise floor in dBm: -174 dBm/Hz + 10log10(B) + NF. */
export function noiseFloorDbm(bandwidthMHz: number, noiseFigureDb: number): number {
  const bwHz = Math.max(1, bandwidthMHz * 1e6);
  return -174 + 10 * Math.log10(bwHz) + noiseFigureDb;
}

/**
 * Whether two carriers overlap enough to interfere.
 *
 * Deliberately simple -- centre frequencies closer than one channel width -- but it is what
 * makes frequency planning visible: retune a site and watch it drop out of the interference
 * sum entirely.
 */
export function isCoChannel(aMHz: number, bMHz: number, bandwidthMHz: number): boolean {
  return Math.abs(aMHz - bMHz) < Math.max(0.001, bandwidthMHz);
}

export const dbmToMw = (dbm: number): number => Math.pow(10, dbm / 10);
export const mwToDbm = (mw: number): number => 10 * Math.log10(mw);
