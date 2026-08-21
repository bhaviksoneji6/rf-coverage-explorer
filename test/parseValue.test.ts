import { describe, expect, it } from 'vitest';
import { parseFieldValue } from '../src/ui/parseValue.js';

const FREQ = { min: 30, max: 6000 };
const OPACITY = { min: 0, max: 1, fromDisplay: (v: number) => v / 100 };
const AOI = { min: 2000, max: 100000, fromDisplay: (v: number) => v * 1000 };

describe('parseFieldValue', () => {
  it('parses a plain number', () => {
    expect(parseFieldValue('3700', FREQ)).toBe(3700);
  });

  it('reaches values the slider step cannot land on', () => {
    // The frequency step is 10 MHz; these are the bands that matters for.
    expect(parseFieldValue('2412', FREQ)).toBe(2412);
    expect(parseFieldValue('3555', FREQ)).toBe(3555);
    expect(parseFieldValue('5925', FREQ)).toBe(5925);
  });

  it('tolerates a unit pasted back in', () => {
    expect(parseFieldValue('3700 MHz', FREQ)).toBe(3700);
    expect(parseFieldValue('-95 dBm', { min: -160, max: 0 })).toBe(-95);
    expect(parseFieldValue('30 m', { min: 1, max: 300 })).toBe(30);
  });

  it('tolerates thousands separators', () => {
    expect(parseFieldValue('1,500', { min: 0, max: 5000 })).toBe(1500);
  });

  it('accepts decimals, signs and exponents', () => {
    expect(parseFieldValue('47.5', { min: 0, max: 100 })).toBeCloseTo(47.5);
    expect(parseFieldValue('-20', { min: -160, max: 0 })).toBe(-20);
    expect(parseFieldValue('1e3', { min: 0, max: 5000 })).toBe(1000);
  });

  it('clamps to the control bounds', () => {
    expect(parseFieldValue('99999', FREQ)).toBe(6000);
    expect(parseFieldValue('-5', FREQ)).toBe(30);
  });

  it('returns null for text with no number, so the caller can restore', () => {
    expect(parseFieldValue('', FREQ)).toBeNull();
    expect(parseFieldValue('abc', FREQ)).toBeNull();
    expect(parseFieldValue('MHz', FREQ)).toBeNull();
    expect(parseFieldValue('   ', FREQ)).toBeNull();
  });

  it('converts display units back to model units', () => {
    // Opacity is stored 0..1 but edited as a percentage.
    expect(parseFieldValue('80', OPACITY)).toBeCloseTo(0.8);
    expect(parseFieldValue('0', OPACITY)).toBe(0);
    expect(parseFieldValue('150', OPACITY)).toBe(1); // clamped after conversion

    // AOI is stored in metres but edited in km.
    expect(parseFieldValue('30', AOI)).toBe(30000);
    expect(parseFieldValue('7.5', AOI)).toBe(7500);
    expect(parseFieldValue('500', AOI)).toBe(100000); // clamped after conversion
  });

  it('clamps in model units, not display units', () => {
    // 1 km is below the 2000 m minimum -- the bound must be applied after conversion.
    expect(parseFieldValue('1', AOI)).toBe(2000);
  });
});
