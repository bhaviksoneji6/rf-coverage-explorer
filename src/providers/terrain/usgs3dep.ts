import { fromArrayBuffer } from 'geotiff';
import { bboxParam, type BBox, type GridSize } from '../../geo/bbox.js';
import { toLonLat } from '../../geo/utm.js';
import { cacheGet, cacheKey, cachePut } from '../cache.js';
import type { TerrainProvider } from '../types.js';

const ENDPOINT =
  'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage';

/** Rough CONUS + AK/HI envelope in lon/lat, used only for a cheap `covers` check. */
const US_LON = [-180, -66] as const;
const US_LAT = [17, 72] as const;

/**
 * USGS 3DEP via the ArcGIS ImageServer `exportImage` operation.
 *
 * Chosen over range-reading the COGs on S3 because this endpoint clips, resamples AND
 * reprojects server-side: we hand it a UTM bbox and a pixel size and get back exactly
 * the grid we want, in one request, with `access-control-allow-origin: *`.
 *
 * Measured: 1000x1000 float32 over a 30km box is ~4.2MB in ~0.6s.
 */
export class Usgs3depProvider implements TerrainProvider {
  readonly id = 'usgs-3dep';
  /** Bare earth. This is what allows clutter heights to be added later without double-counting. */
  readonly kind = 'DTM' as const;
  readonly nativeResolutionM = 10;
  readonly attribution = 'Elevation: USGS 3DEP (public domain)';

  covers(bbox: BBox, epsg: number): boolean {
    // Coarse guard only -- the service is authoritative. This just avoids firing off
    // obviously out-of-area requests (3DEP is US-only, including AK/HI/territories).
    const north = epsg >= 32601 && epsg <= 32660;
    const south = epsg >= 32701 && epsg <= 32760;
    if (!north && !south) return false;
    const zone = epsg - (north ? 32600 : 32700);
    const c = toLonLat(
      { e: (bbox.minE + bbox.maxE) / 2, n: (bbox.minN + bbox.maxN) / 2 },
      { zone, north, epsg, lambda0: (zone - 1) * 6 - 180 + 3 },
    );
    return c.lon >= US_LON[0] && c.lon <= US_LON[1] && c.lat >= US_LAT[0] && c.lat <= US_LAT[1];
  }

  async fetch(
    bbox: BBox,
    size: GridSize,
    epsg: number,
    signal?: AbortSignal,
  ): Promise<Float32Array> {
    const key = cacheKey(this.id, bbox, size, epsg);
    const cached = await cacheGet(key);
    if (cached) return new Float32Array(cached);

    const url =
      `${ENDPOINT}?bbox=${bboxParam(bbox)}` +
      `&bboxSR=${epsg}&imageSR=${epsg}` +
      `&size=${size.width},${size.height}` +
      `&format=tiff&pixelType=F32` +
      `&interpolation=RSP_BilinearInterpolation&f=image`;

    const res = await fetch(url, signal ? { signal } : {});
    if (!res.ok) throw new Error(`3DEP exportImage failed: HTTP ${res.status}`);

    const contentType = res.headers.get('content-type') ?? '';
    const buf = await res.arrayBuffer();
    if (!contentType.includes('tiff')) {
      // ArcGIS reports errors as JSON with a 200 status.
      throw new Error(`3DEP returned ${contentType || 'unknown type'}: ${decodeError(buf)}`);
    }

    const out = await decodeFloat32Tiff(buf, size);
    await cachePut(key, out.buffer as ArrayBuffer);
    return out;
  }
}

function decodeError(buf: ArrayBuffer): string {
  try {
    return new TextDecoder().decode(buf.slice(0, 300));
  } catch {
    return 'unreadable response';
  }
}

async function decodeFloat32Tiff(buf: ArrayBuffer, size: GridSize): Promise<Float32Array> {
  const tiff = await fromArrayBuffer(buf);
  const image = await tiff.getImage();
  const rasters = await image.readRasters({ interleave: false });
  const band = Array.isArray(rasters) ? rasters[0] : rasters;
  if (!band || typeof band === 'number') throw new Error('3DEP: no raster band returned');

  const src = band as unknown as ArrayLike<number>;
  const expected = size.width * size.height;
  if (src.length !== expected) {
    throw new Error(`3DEP: expected ${expected} samples, got ${src.length}`);
  }

  // 3DEP signals nodata with a large negative sentinel (typically -3.4e38). Left in place
  // it would dominate hillshade normalisation and produce garbage elevation angles.
  const out = new Float32Array(expected);
  for (let i = 0; i < expected; i++) {
    const v = src[i] as number;
    out[i] = Number.isFinite(v) && v > -1e6 && v < 1e6 ? v : 0;
  }
  return out;
}
