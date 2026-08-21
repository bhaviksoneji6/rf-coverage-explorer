import { Clutter, type ClutterClass } from '../types.js';

export interface NlcdEntry {
  /** NLCD class code, e.g. 42 = Evergreen Forest. */
  code: number;
  name: string;
  rgb: [number, number, number];
  clutter: ClutterClass;
}

/**
 * Canonical NLCD legend, in the same order as the palette PNG's PLTE chunk.
 *
 * The served PNG is an 8-bit palette image whose 22 entries map index->class in exactly
 * this order. We do not rely on that, though: GeoServer's quantiser shifts the RGB values
 * by a few units (observed Open Water as (71,107,160) against the canonical (70,107,159)),
 * so classification is nearest-colour, not exact match. The smallest gap between any two
 * canonical entries is ~26 in RGB distance and the observed drift is <=5, so there is a
 * wide margin.
 */
export const NLCD_LEGEND: readonly NlcdEntry[] = [
  { code: 11, name: 'Open Water', rgb: [70, 107, 159], clutter: Clutter.WATER },
  { code: 12, name: 'Perennial Ice/Snow', rgb: [209, 222, 248], clutter: Clutter.OPEN },
  { code: 21, name: 'Developed, Open Space', rgb: [222, 197, 197], clutter: Clutter.OPEN },
  { code: 22, name: 'Developed, Low Intensity', rgb: [217, 146, 130], clutter: Clutter.SUBURBAN },
  { code: 23, name: 'Developed, Medium Intensity', rgb: [235, 0, 0], clutter: Clutter.URBAN },
  { code: 24, name: 'Developed, High Intensity', rgb: [171, 0, 0], clutter: Clutter.DENSE_URBAN },
  { code: 31, name: 'Barren Land', rgb: [179, 172, 159], clutter: Clutter.OPEN },
  { code: 41, name: 'Deciduous Forest', rgb: [104, 171, 95], clutter: Clutter.FOREST },
  { code: 42, name: 'Evergreen Forest', rgb: [28, 95, 44], clutter: Clutter.FOREST },
  { code: 43, name: 'Mixed Forest', rgb: [181, 197, 143], clutter: Clutter.FOREST },
  { code: 51, name: 'Dwarf Scrub', rgb: [166, 140, 48], clutter: Clutter.OPEN },
  { code: 52, name: 'Shrub/Scrub', rgb: [204, 184, 121], clutter: Clutter.OPEN },
  { code: 71, name: 'Grassland/Herbaceous', rgb: [223, 223, 194], clutter: Clutter.OPEN },
  { code: 72, name: 'Sedge/Herbaceous', rgb: [209, 209, 130], clutter: Clutter.OPEN },
  { code: 73, name: 'Lichens', rgb: [163, 204, 81], clutter: Clutter.OPEN },
  { code: 74, name: 'Moss', rgb: [130, 186, 157], clutter: Clutter.OPEN },
  { code: 81, name: 'Pasture/Hay', rgb: [220, 217, 57], clutter: Clutter.OPEN },
  { code: 82, name: 'Cultivated Crops', rgb: [171, 108, 40], clutter: Clutter.OPEN },
  { code: 90, name: 'Woody Wetlands', rgb: [184, 217, 235], clutter: Clutter.WETLAND },
  {
    code: 95,
    name: 'Emergent Herbaceous Wetlands',
    rgb: [108, 159, 184],
    clutter: Clutter.WETLAND,
  },
];

/**
 * Anything further than this from every legend entry is treated as nodata rather than
 * being force-fitted to the nearest class. Catches the transparent/background pixels
 * GeoServer emits outside the NLCD footprint.
 */
const MAX_MATCH_DIST_SQ = 60 * 60;

const memo = new Map<number, ClutterClass>();

/** Nearest legend entry, or null if nothing is close enough to be a real match. */
export function nearestEntry(r: number, g: number, b: number): NlcdEntry | null {
  let best: NlcdEntry | null = null;
  let bestD = Infinity;
  for (const entry of NLCD_LEGEND) {
    const [er, eg, eb] = entry.rgb;
    const d = (r - er) ** 2 + (g - eg) ** 2 + (b - eb) ** 2;
    if (d < bestD) {
      bestD = d;
      best = entry;
    }
  }
  return bestD <= MAX_MATCH_DIST_SQ ? best : null;
}

/** NLCD class code (11, 21, 42, ...), or 0 when the colour matches nothing. */
export function classifyRgbToCode(r: number, g: number, b: number): number {
  return nearestEntry(r, g, b)?.code ?? 0;
}

function nearest(r: number, g: number, b: number): ClutterClass {
  return nearestEntry(r, g, b)?.clutter ?? Clutter.NODATA;
}

/**
 * Classify one RGB triple. Memoised on packed RGB: a 1M-pixel tile contains only ~20
 * distinct colours, so this collapses to 20 nearest-colour searches and a hash lookup
 * per pixel thereafter.
 */
export function classifyRgb(r: number, g: number, b: number): ClutterClass {
  const key = (r << 16) | (g << 8) | b;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  const c = nearest(r, g, b);
  memo.set(key, c);
  return c;
}

/** Convert an RGBA buffer from canvas into normalised clutter codes. */
export function rgbaToClutter(rgba: Uint8ClampedArray, count: number): Uint8Array {
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    // Fully transparent pixels are outside the NLCD footprint.
    out[i] =
      (rgba[o + 3] as number) < 128
        ? Clutter.NODATA
        : classifyRgb(rgba[o] as number, rgba[o + 1] as number, rgba[o + 2] as number);
  }
  return out;
}
