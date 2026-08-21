import type { BBox, GridSize } from '../geo/bbox.js';

/**
 * Bare-earth (DTM) vs surface (DSM) elevation.
 *
 * This is not documentation -- it is enforced. A DSM already contains vegetation and
 * buildings, so adding representative clutter heights on top of one double-counts the
 * clutter. Copernicus GLO-30 is the classic trap. The engine refuses the combination.
 */
export type ElevationModel = 'DTM' | 'DSM';

export interface TerrainProvider {
  readonly id: string;
  readonly kind: ElevationModel;
  readonly nativeResolutionM: number;
  readonly attribution: string;
  covers(bbox: BBox, epsg: number): boolean;
  /** Elevation in metres above mean sea level, row-major, north-up. */
  fetch(bbox: BBox, size: GridSize, epsg: number, signal?: AbortSignal): Promise<Float32Array>;
}

/**
 * Normalised clutter categories.
 *
 * Providers MUST emit these, never their own native codes (NLCD 11/21/42, WorldCover
 * 10/50/80, ...). That is the seam that lets a global provider drop in later without the
 * engine or the loss table knowing anything changed.
 */
export const Clutter = {
  NODATA: 0,
  WATER: 1,
  OPEN: 2,
  SUBURBAN: 3,
  URBAN: 4,
  DENSE_URBAN: 5,
  FOREST: 6,
  WETLAND: 7,
} as const;

export type ClutterClass = (typeof Clutter)[keyof typeof Clutter];

export const CLUTTER_NAMES: Record<number, string> = {
  [Clutter.NODATA]: 'No data',
  [Clutter.WATER]: 'Water',
  [Clutter.OPEN]: 'Open / rural',
  [Clutter.SUBURBAN]: 'Suburban',
  [Clutter.URBAN]: 'Urban',
  [Clutter.DENSE_URBAN]: 'Dense urban',
  [Clutter.FOREST]: 'Forest',
  [Clutter.WETLAND]: 'Wetland',
};

/** Display colours for the clutter debug overlay. */
export const CLUTTER_COLORS: Record<number, [number, number, number]> = {
  [Clutter.NODATA]: [0, 0, 0],
  [Clutter.WATER]: [71, 107, 160],
  [Clutter.OPEN]: [222, 226, 193],
  [Clutter.SUBURBAN]: [216, 147, 130],
  [Clutter.URBAN]: [237, 0, 0],
  [Clutter.DENSE_URBAN]: [140, 0, 0],
  [Clutter.FOREST]: [28, 99, 48],
  [Clutter.WETLAND]: [186, 216, 234],
};

export interface ClutterProvider {
  readonly id: string;
  readonly attribution: string;
  covers(bbox: BBox, epsg: number): boolean;
  /** Normalised `Clutter` codes, row-major, north-up. */
  fetch(bbox: BBox, size: GridSize, epsg: number, signal?: AbortSignal): Promise<Uint8Array>;
}
