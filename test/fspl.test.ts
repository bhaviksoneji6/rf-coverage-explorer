import { describe, expect, it } from 'vitest';
import { fsplDb, FSPL_CONST_DB } from '../src/models/fspl.js';

describe('free-space path loss', () => {
  it('matches the closed form at 1 km / 3700 MHz', () => {
    // 32.44778 + 20log10(3700) + 20log10(1) = 103.81 dB
    expect(fsplDb(1, 3700)).toBeCloseTo(103.81, 2);
  });

  it('uses the correct 20log10(4*pi*1e9/c) constant', () => {
    const expected = 20 * Math.log10((4 * Math.PI * 1e9) / 299792458);
    expect(FSPL_CONST_DB).toBeCloseTo(expected, 4);
  });

  it('adds 6.02 dB per doubling of distance', () => {
    expect(fsplDb(2, 1000) - fsplDb(1, 1000)).toBeCloseTo(6.0206, 3);
    expect(fsplDb(8, 1000) - fsplDb(4, 1000)).toBeCloseTo(6.0206, 3);
  });

  it('adds 6.02 dB per doubling of frequency', () => {
    expect(fsplDb(5, 1500) - fsplDb(5, 750)).toBeCloseTo(6.0206, 3);
  });

  it('returns 0 for degenerate inputs rather than -Infinity', () => {
    expect(fsplDb(0, 3700)).toBe(0);
    expect(fsplDb(-1, 3700)).toBe(0);
    expect(fsplDb(1, 0)).toBe(0);
  });
});
