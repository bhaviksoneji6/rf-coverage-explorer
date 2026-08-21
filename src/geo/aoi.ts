import type { BBox, GridSize } from './bbox.js';
import { toUtm, zoneFor, type LonLat, type UtmPoint, type UtmZone } from './utm.js';

/** 3DEP's native resolution. Requesting finer just interpolates, so we clamp here. */
export const MIN_RES_M = 10;

/**
 * Fixed pixel budget, variable ground resolution.
 *
 * Memory and fetch time then stay bounded no matter how large a study area the user
 * draws: a 30km box comes back at 30m, a 100km box at 100m, both ~1000x1000.
 */
export const DEFAULT_PIXEL_BUDGET = 1000;

export const DEFAULT_SIDE_M = 30000;

export interface Aoi {
  zone: UtmZone;
  /** Raster extent in UTM metres. */
  bbox: BBox;
  /** DEM / clutter raster size in pixels. */
  size: GridSize;
  /** Ground metres per raster pixel. */
  resM: number;
  center: UtmPoint;
  centerLonLat: LonLat;
  sideM: number;
}

export function makeAoi(
  centerLonLat: LonLat,
  sideM: number = DEFAULT_SIDE_M,
  pixelBudget: number = DEFAULT_PIXEL_BUDGET,
): Aoi {
  const zone = zoneFor(centerLonLat);
  const center = toUtm(centerLonLat, zone);

  const px = Math.max(1, Math.min(pixelBudget, Math.ceil(sideM / MIN_RES_M)));
  const resM = sideM / px;
  const half = sideM / 2;

  return {
    zone,
    bbox: {
      minE: center.e - half,
      minN: center.n - half,
      maxE: center.e + half,
      maxN: center.n + half,
    },
    size: { width: px, height: px },
    resM,
    center,
    centerLonLat,
    sideM,
  };
}

/**
 * The coverage grid shares the AOI extent but has its own (usually coarser) bin size,
 * so output resolution can change without refetching terrain.
 */
export interface CoverageGrid {
  bbox: BBox;
  size: GridSize;
  binM: number;
}

export function makeCoverageGrid(aoi: Aoi, binM: number): CoverageGrid {
  const n = Math.max(1, Math.round(aoi.sideM / binM));
  return { bbox: aoi.bbox, size: { width: n, height: n }, binM: aoi.sideM / n };
}

export interface RadialParams {
  nRadials: number;
  nSteps: number;
  stepM: number;
  maxRangeM: number;
}

/**
 * Radial count is chosen so the arc gap between adjacent radials at maximum range stays
 * below one output bin -- that is what makes the grid<-radial resample gap-free, and it
 * is why radials beat a per-bin walk here (~1M samples instead of ~35M at 30km/100m).
 *
 * `stepM` defaults to 15m rather than the 30m DEM spacing because the first Fresnel
 * radius at mid-path is only ~21m at 3.7GHz; 30m steps can walk straight over a ridge.
 */
export function radialParams(aoi: Aoi, binM: number, stepM = 15): RadialParams {
  const maxRangeM = (aoi.sideM / 2) * Math.SQRT2;
  const needed = Math.ceil((2 * Math.PI * maxRangeM) / binM);
  const nRadials = Math.ceil(needed / 8) * 8;
  return { nRadials, nSteps: Math.ceil(maxRangeM / stepM), stepM, maxRangeM };
}
