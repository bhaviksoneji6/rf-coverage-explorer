import type { TerrainGridSpec } from '../engine/types.js';

/**
 * Horn hillshade.
 *
 * This is a debug layer with a real job: FSPL ignores terrain entirely, so without a
 * visual of the DEM there is nothing in Pass 1 that would reveal a georeferencing bug.
 * If the shaded coastline lines up with the basemap coastline, the UTM request, the
 * server-side reprojection, the TIFF decode and the corner placement are all correct.
 */
export function hillshadeToRgba(
  terrain: Float32Array,
  spec: TerrainGridSpec,
  out: Uint8ClampedArray<ArrayBuffer>,
  opts: { azimuthDeg?: number; altitudeDeg?: number; zFactor?: number; opacity?: number } = {},
): Uint8ClampedArray<ArrayBuffer> {
  const { width, height, resM } = spec;
  const azimuth = ((opts.azimuthDeg ?? 315) * Math.PI) / 180;
  const altitude = ((opts.altitudeDeg ?? 45) * Math.PI) / 180;
  const z = opts.zFactor ?? 1;
  const alpha = Math.round(Math.max(0, Math.min(1, opts.opacity ?? 1)) * 255);

  const cosZenith = Math.cos(Math.PI / 2 - altitude);
  const sinZenith = Math.sin(Math.PI / 2 - altitude);
  const eightRes = 8 * resM;

  const at = (r: number, c: number): number => {
    const rr = r < 0 ? 0 : r >= height ? height - 1 : r;
    const cc = c < 0 ? 0 : c >= width ? width - 1 : c;
    return terrain[rr * width + cc] as number;
  };

  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const a = at(r - 1, c - 1);
      const b = at(r - 1, c);
      const cc = at(r - 1, c + 1);
      const d = at(r, c - 1);
      const f = at(r, c + 1);
      const g = at(r + 1, c - 1);
      const h = at(r + 1, c);
      const i = at(r + 1, c + 1);

      const dzdx = (cc + 2 * f + i - (a + 2 * d + g)) / eightRes;
      const dzdy = (g + 2 * h + i - (a + 2 * b + cc)) / eightRes;

      const slope = Math.atan(z * Math.hypot(dzdx, dzdy));
      const aspect = Math.atan2(dzdy, -dzdx);

      let v =
        cosZenith * Math.cos(slope) + sinZenith * Math.sin(slope) * Math.cos(azimuth - aspect);
      if (v < 0) v = 0;

      const shade = Math.round(v * 255);
      const o = (r * width + c) * 4;
      out[o] = shade;
      out[o + 1] = shade;
      out[o + 2] = shade;
      out[o + 3] = alpha;
    }
  }
  return out;
}

/** Colourise a clutter-class raster using the normalised class colours. */
export function clutterToRgba(
  clutter: Uint8Array,
  colors: Record<number, [number, number, number]>,
  out: Uint8ClampedArray<ArrayBuffer>,
  opacity = 0.7,
): Uint8ClampedArray<ArrayBuffer> {
  const alpha = Math.round(Math.max(0, Math.min(1, opacity)) * 255);
  for (let i = 0; i < clutter.length; i++) {
    const cls = clutter[i] as number;
    const o = i * 4;
    const rgb = colors[cls];
    if (!rgb || cls === 0) {
      out[o + 3] = 0;
      continue;
    }
    out[o] = rgb[0];
    out[o + 1] = rgb[1];
    out[o + 2] = rgb[2];
    out[o + 3] = alpha;
  }
  return out;
}
