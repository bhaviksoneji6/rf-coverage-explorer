import { describe, expect, it } from 'vitest';
import {
  classifyRgbToCode,
  NLCD_LEGEND,
  rgbaToClutter,
} from '../src/providers/clutter/nlcdPalette.js';
import { Clutter } from '../src/providers/types.js';

describe('NLCD legend', () => {
  it('has unique class codes and colours', () => {
    const codes = new Set(NLCD_LEGEND.map((e) => e.code));
    const colors = new Set(NLCD_LEGEND.map((e) => e.rgb.join(',')));
    expect(codes.size).toBe(NLCD_LEGEND.length);
    expect(colors.size).toBe(NLCD_LEGEND.length);
  });

  it('classifies every canonical legend colour back to its own code', () => {
    for (const entry of NLCD_LEGEND) {
      const [r, g, b] = entry.rgb;
      expect(classifyRgbToCode(r, g, b)).toBe(entry.code);
    }
  });
});

describe('quantisation drift from the live MRLC endpoint', () => {
  /**
   * These are the exact RGB values observed in a real 1000x1000 GetMap response over
   * Seattle. GeoServer's quantiser shifts them a few units off the canonical legend, which
   * is precisely why classification is nearest-colour rather than exact match -- an exact
   * lookup would return nodata for every one of these.
   */
  const observed: [number, number, number, number][] = [
    [71, 107, 160, 11],
    [221, 201, 201, 21],
    [216, 147, 130, 22],
    [237, 0, 0, 23],
    [170, 0, 0, 24],
    [178, 173, 163, 31],
    [104, 170, 99, 41],
    [28, 99, 48, 42],
    [181, 201, 142, 43],
    [204, 186, 124, 52],
    [226, 226, 193, 71],
    [219, 216, 61, 81],
    [170, 112, 40, 82],
    [186, 216, 234, 90],
    [112, 163, 186, 95],
  ];

  for (const [r, g, b, code] of observed) {
    it(`maps rgb(${r},${g},${b}) to NLCD ${code}`, () => {
      expect(classifyRgbToCode(r, g, b)).toBe(code);
    });
  }
});

describe('normalised clutter mapping', () => {
  it('maps the four developed intensities across the density range', () => {
    const byCode = (c: number) => NLCD_LEGEND.find((e) => e.code === c)?.clutter;
    expect(byCode(21)).toBe(Clutter.OPEN);
    expect(byCode(22)).toBe(Clutter.SUBURBAN);
    expect(byCode(23)).toBe(Clutter.URBAN);
    expect(byCode(24)).toBe(Clutter.DENSE_URBAN);
  });

  it('groups all three forest classes together', () => {
    for (const code of [41, 42, 43]) {
      expect(NLCD_LEGEND.find((e) => e.code === code)?.clutter).toBe(Clutter.FOREST);
    }
  });

  it('rejects colours that match nothing rather than forcing a nearest class', () => {
    expect(classifyRgbToCode(255, 0, 255)).toBe(0);
    expect(classifyRgbToCode(0, 255, 255)).toBe(0);
  });
});

describe('rgbaToClutter', () => {
  it('treats transparent pixels as nodata regardless of colour', () => {
    const rgba = new Uint8ClampedArray([
      70, 107, 159, 255, // opaque water
      70, 107, 159, 0, // transparent, same colour
    ]);
    const out = rgbaToClutter(rgba, 2);
    expect(out[0]).toBe(Clutter.WATER);
    expect(out[1]).toBe(Clutter.NODATA);
  });
});
