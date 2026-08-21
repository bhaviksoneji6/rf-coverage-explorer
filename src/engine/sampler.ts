import type { TerrainGridSpec } from './types.js';

/**
 * Bilinear elevation sample at a projected (UTM) coordinate.
 *
 * Pixel centres sit half a cell inside the raster edge, hence the -0.5. Coordinates
 * outside the raster clamp to the edge rather than returning nodata -- the AOI always
 * extends past the maximum radial range, so this only bites in the far corners where
 * results are masked out anyway.
 */
export function sampleBilinear(
  data: Float32Array,
  spec: TerrainGridSpec,
  e: number,
  n: number,
): number {
  const { width, height, resM } = spec;

  let col = (e - spec.minE) / resM - 0.5;
  let row = (spec.maxN - n) / resM - 0.5;

  if (col < 0) col = 0;
  else if (col > width - 1) col = width - 1;
  if (row < 0) row = 0;
  else if (row > height - 1) row = height - 1;

  const c0 = Math.floor(col);
  const r0 = Math.floor(row);
  const c1 = c0 + 1 < width ? c0 + 1 : c0;
  const r1 = r0 + 1 < height ? r0 + 1 : r0;

  const fx = col - c0;
  const fy = row - r0;

  const i00 = r0 * width + c0;
  const i10 = r0 * width + c1;
  const i01 = r1 * width + c0;
  const i11 = r1 * width + c1;

  const v00 = data[i00] as number;
  const v10 = data[i10] as number;
  const v01 = data[i01] as number;
  const v11 = data[i11] as number;

  const top = v00 + (v10 - v00) * fx;
  const bot = v01 + (v11 - v01) * fx;
  return top + (bot - top) * fy;
}

/** Nearest-neighbour lookup for categorical rasters (clutter classes must not be interpolated). */
export function sampleNearest(
  data: Uint8Array,
  spec: TerrainGridSpec,
  e: number,
  n: number,
): number {
  const { width, height, resM } = spec;
  let col = Math.round((e - spec.minE) / resM - 0.5);
  let row = Math.round((spec.maxN - n) / resM - 0.5);
  if (col < 0) col = 0;
  else if (col > width - 1) col = width - 1;
  if (row < 0) row = 0;
  else if (row > height - 1) row = height - 1;
  return data[row * width + col] as number;
}
