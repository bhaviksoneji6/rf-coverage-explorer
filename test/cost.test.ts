import { describe, expect, it } from 'vitest';
import { estimateCost, suggestBinM } from '../src/engine/cost.js';

const DEFAULTS = { demResM: 30 };

describe('cost estimate against measured reality', () => {
  it('lands near the 45 ms measured for a 30 km / 100 m pass', () => {
    const c = estimateCost({ ...DEFAULTS, sideM: 30000, binM: 100 });
    expect(c.bins).toBe(300 * 300);
    // Measured on real terrain: 1.89 M radial samples, 45 ms end to end.
    expect(c.radialSamples).toBeGreaterThan(1.5e6);
    expect(c.radialSamples).toBeLessThan(2.5e6);
    expect(c.ms).toBeGreaterThan(20);
    expect(c.ms).toBeLessThan(120);
    expect(c.level).toBe('ok');
    expect(c.reason).toBeNull();
  });

  it('treats the default 30 km / 50 m configuration as fine', () => {
    const c = estimateCost({ ...DEFAULTS, sideM: 30000, binM: 50 });
    expect(c.level).toBe('ok');
    expect(c.bytes).toBeLessThan(64 * 1024 * 1024);
  });
});

describe('the combination that motivated the guard', () => {
  it('blocks 100 km at 10 m bins', () => {
    const c = estimateCost({ ...DEFAULTS, sideM: 100000, binM: 10, demResM: 100 });
    expect(c.level).toBe('block');
    expect(c.bins).toBe(10000 * 10000);
    // The radial fan is the bigger allocation, and the reason a warning would never paint.
    expect(c.radialSamples).toBeGreaterThan(2e8);
    expect(c.bytes).toBeGreaterThan(1e9);
    expect(c.reason).toBeTruthy();
  });

  it('suggests a bin size that actually clears the block', () => {
    const input = { ...DEFAULTS, sideM: 100000, binM: 10, demResM: 100 };
    const c = estimateCost(input);
    expect(c.suggestedBinM).not.toBeNull();
    const fixed = estimateCost({ ...input, binM: c.suggestedBinM as number });
    expect(fixed.level).not.toBe('block');
  });

  it('never suggests going finer than the user already asked for', () => {
    const suggestion = suggestBinM({ ...DEFAULTS, sideM: 100000, binM: 10, demResM: 100 });
    expect(suggestion).toBeGreaterThanOrEqual(10);
  });

  it('leaves each slider individually usable at its extreme', () => {
    // 10 m bins over a small area is cheap...
    expect(estimateCost({ ...DEFAULTS, sideM: 2000, binM: 10, demResM: 10 }).level).toBe('ok');
    // ...and a huge area is cheap at a sensible bin size. Only the product is a problem.
    expect(estimateCost({ ...DEFAULTS, sideM: 100000, binM: 200, demResM: 100 }).level).toBe('ok');
  });
});

describe('warnings short of blocking', () => {
  it('flags bins finer than the terrain resolution as smoothing, not detail', () => {
    const c = estimateCost({ sideM: 30000, demResM: 30, binM: 10 });
    expect(c.level).toBe('warn');
    expect(c.reason).toMatch(/finer than/);
  });

  it('does not flag bins at or coarser than the terrain resolution', () => {
    expect(estimateCost({ sideM: 30000, demResM: 30, binM: 30 }).reason).toBeNull();
    expect(estimateCost({ sideM: 30000, demResM: 30, binM: 50 }).reason).toBeNull();
  });
});

describe('cost scaling', () => {
  it('grows roughly fourfold when bin size halves', () => {
    const a = estimateCost({ ...DEFAULTS, sideM: 30000, binM: 100 });
    const b = estimateCost({ ...DEFAULTS, sideM: 30000, binM: 50 });
    expect(b.bins / a.bins).toBeCloseTo(4, 1);
  });

  it('scales bins and memory with site count but not radial-fan size', () => {
    const one = estimateCost({ ...DEFAULTS, sideM: 30000, binM: 100, siteCount: 1 });
    const eight = estimateCost({ ...DEFAULTS, sideM: 30000, binM: 100, siteCount: 8 });
    expect(eight.radialSamples).toBe(one.radialSamples);
    expect(eight.bytes).toBeGreaterThan(one.bytes);
    expect(eight.ms).toBeGreaterThan(one.ms);
  });
});
