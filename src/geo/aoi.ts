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

/**
 * How far inside the AOI edge a site must stay before we reload the area.
 *
 * The AOI is a *study area*, not a follow-cam: terrain is fetched for the whole box, so a
 * site moving anywhere inside it needs no new data at all. The margin exists only so a site
 * dragged hard against the edge -- where most of its coverage would fall outside the loaded
 * box -- recentres rather than rendering a mostly empty map.
 */
export const AOI_EDGE_MARGIN = 0.1;

/**
 * True when a site has moved far enough that the AOI should be reloaded around it.
 *
 * Note what this deliberately does NOT ask: whether a full-size AOI centred on the new
 * position fits inside the current one. That can only be true when the site has not moved,
 * so using it would refetch on every drag.
 */
export function siteNeedsNewAoi(aoi: Aoi, e: number, n: number, margin = AOI_EDGE_MARGIN): boolean {
  const inset = aoi.sideM * margin;
  return (
    e < aoi.bbox.minE + inset ||
    e > aoi.bbox.maxE - inset ||
    n < aoi.bbox.minN + inset ||
    n > aoi.bbox.maxN - inset
  );
}

/** Identity of a fetched AOI, so the data stage can skip work when nothing actually moved. */
export function aoiKey(aoi: Aoi): string {
  return `${aoi.zone.epsg}|${Math.round(aoi.bbox.minE)},${Math.round(aoi.bbox.maxN)}|${aoi.size.width}x${aoi.size.height}|${aoi.resM.toFixed(3)}`;
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
