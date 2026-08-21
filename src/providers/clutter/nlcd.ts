import { bboxParam, type BBox, type GridSize } from '../../geo/bbox.js';
import { toLonLat } from '../../geo/utm.js';
import { cacheGet, cacheKey, cachePut } from '../cache.js';
import type { ClutterProvider } from '../types.js';
import { rgbaToClutter } from './nlcdPalette.js';

const ENDPOINT = 'https://www.mrlc.gov/geoserver/mrlc_display/wms';
const LAYER = 'NLCD_2021_Land_Cover_L48';

/**
 * NLCD 2021 land cover via MRLC's WMS.
 *
 * WMS rather than WCS deliberately: the WCS coverage is published in EPSG:3857 only and
 * cannot reproject, which would force a client-side resample onto our UTM grid. WMS
 * reprojects server-side, so clutter lands pixel-aligned with the DEM.
 *
 * 30m NLCD against a 100m output bin is ample, and NLCD's four developed-intensity
 * classes map onto suburban/urban/dense-urban far better than WorldCover's single
 * "Built-up" class would.
 *
 * Measured: 1000x1000 over a 30km box is ~194KB in ~1.6s.
 */
export class NlcdProvider implements ClutterProvider {
  readonly id = 'nlcd-2021-l48';
  readonly attribution = 'Land cover: NLCD 2021 (USGS/MRLC)';

  covers(bbox: BBox, epsg: number): boolean {
    const north = epsg >= 32601 && epsg <= 32660;
    const south = epsg >= 32701 && epsg <= 32760;
    if (!north && !south) return false;
    const zone = epsg - (north ? 32600 : 32700);
    const c = toLonLat(
      { e: (bbox.minE + bbox.maxE) / 2, n: (bbox.minN + bbox.maxN) / 2 },
      { zone, north, epsg, lambda0: (zone - 1) * 6 - 180 + 3 },
    );
    // Conterminous US only -- this layer is the L48 product.
    return c.lon >= -125 && c.lon <= -66 && c.lat >= 24 && c.lat <= 50;
  }

  async fetch(
    bbox: BBox,
    size: GridSize,
    epsg: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const key = cacheKey(this.id, bbox, size, epsg);
    const cached = await cacheGet(key);
    if (cached) return new Uint8Array(cached);

    const url =
      `${ENDPOINT}?service=WMS&version=1.1.1&request=GetMap` +
      `&layers=${LAYER}&styles=` +
      `&srs=EPSG:${epsg}&bbox=${bboxParam(bbox)}` +
      `&width=${size.width}&height=${size.height}` +
      `&format=image/png&transparent=true`;

    const res = await fetch(url, signal ? { signal } : {});
    if (!res.ok) throw new Error(`NLCD GetMap failed: HTTP ${res.status}`);

    const type = res.headers.get('content-type') ?? '';
    const blob = await res.blob();
    if (!type.includes('image')) {
      throw new Error(`NLCD returned ${type || 'unknown type'}: ${await blob.slice(0, 300).text()}`);
    }

    const rgba = await decodePngToRgba(blob, size);
    const out = rgbaToClutter(rgba, size.width * size.height);
    await cachePut(key, out.buffer as ArrayBuffer);
    return out;
  }
}

async function decodePngToRgba(blob: Blob, size: GridSize): Promise<Uint8ClampedArray> {
  // colorSpaceConversion:'none' stops Safari applying display colour management, which
  // would shift the palette out from under the nearest-colour classifier.
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none' });
  try {
    const canvas =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(size.width, size.height)
        : Object.assign(document.createElement('canvas'), {
            width: size.width,
            height: size.height,
          });
    const ctx = (
      canvas as OffscreenCanvas | HTMLCanvasElement
    ).getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' }) as
      | OffscreenCanvasRenderingContext2D
      | CanvasRenderingContext2D
      | null;
    if (!ctx) throw new Error('NLCD: could not obtain a 2D canvas context');
    ctx.drawImage(bitmap, 0, 0);
    return ctx.getImageData(0, 0, size.width, size.height).data;
  } finally {
    bitmap.close();
  }
}
