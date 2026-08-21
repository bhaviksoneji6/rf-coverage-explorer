/** Geometry of a north-up raster in projected (UTM) metres. */
export interface TerrainGridSpec {
  width: number;
  height: number;
  /** Western edge of the raster (not the centre of the first pixel). */
  minE: number;
  /** Northern edge of the raster. */
  maxN: number;
  resM: number;
}

export interface GridSpec {
  width: number;
  height: number;
  minE: number;
  maxN: number;
  binM: number;
}

/** Mean Earth radius, metres. */
export const EARTH_RADIUS_M = 6371008.8;

/**
 * Standard atmosphere refraction factor. At the 21km corner range of a 30km AOI the
 * effective-earth bulge is d^2/(2*k*Re) ~ 6.6m -- small, but no longer the ~1.5m it
 * would be over 10km, so it is worth carrying.
 */
export const DEFAULT_K_FACTOR = 4 / 3;

export interface ComputeParams {
  txE: number;
  txN: number;
  txHeightAglM: number;
  rxHeightAglM: number;
  freqMHz: number;
  nRadials: number;
  nSteps: number;
  stepM: number;
  kFactor: number;
}

export interface RadialFields {
  /** nRadials * nSteps, dB. */
  pathLoss: Float32Array;
  /** nRadials * nSteps, radians, TX -> RX geometric elevation angle. */
  elevAngle: Float32Array;
}

/** One site's results on the coverage grid. NaN outside maximum range. */
export interface SiteGrid {
  pathLoss: Float32Array;
  elevAngle: Float32Array;
  width: number;
  height: number;
}
