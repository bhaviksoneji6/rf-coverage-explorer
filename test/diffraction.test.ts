import { describe, expect, it } from 'vitest';
import {
  firstFresnelRadiusM,
  fresnelParameter,
  knifeEdgeLossDb,
  obstacleLossDb,
  wavelengthM,
} from '../src/models/diffraction.js';

describe('wavelength', () => {
  it('matches c/f', () => {
    expect(wavelengthM(300)).toBeCloseTo(0.9993, 3);
    expect(wavelengthM(3700)).toBeCloseTo(0.08103, 4);
    expect(wavelengthM(750)).toBeCloseTo(0.39972, 4);
  });
});

describe('ITU-R P.526 knife-edge loss J(v)', () => {
  it('gives about 6 dB at grazing incidence', () => {
    // v = 0 is the ray just touching the edge: half the wavefront is gone, so the exact
    // answer is 20log10(2) = 6.0206 dB. P.526 eq. 31 is a *fitted* approximation to the
    // Fresnel integral and returns 6.0329 there -- 12 millidecibels high. Pin the formula's
    // own value, and assert separately that it stays close to the theory it approximates.
    expect(knifeEdgeLossDb(0)).toBeCloseTo(6.0329, 3);
    expect(Math.abs(knifeEdgeLossDb(0) - 20 * Math.log10(2))).toBeLessThan(0.02);
  });

  it('matches published values along the curve', () => {
    expect(knifeEdgeLossDb(1)).toBeCloseTo(13.9257, 3);
    expect(knifeEdgeLossDb(2)).toBeCloseTo(19.0429, 3);
    expect(knifeEdgeLossDb(3)).toBeCloseTo(22.4160, 3);
  });

  it('is zero below the -0.78 cutoff, where the path is effectively clear', () => {
    expect(knifeEdgeLossDb(-0.78)).toBe(0);
    expect(knifeEdgeLossDb(-1)).toBe(0);
    expect(knifeEdgeLossDb(-5)).toBe(0);
  });

  it('increases monotonically with obstruction', () => {
    let prev = -Infinity;
    for (let v = -0.7; v <= 5; v += 0.1) {
      const loss = knifeEdgeLossDb(v);
      expect(loss).toBeGreaterThanOrEqual(prev);
      prev = loss;
    }
  });

  it('is never negative -- diffraction cannot add energy', () => {
    for (let v = -5; v <= 10; v += 0.25) {
      expect(knifeEdgeLossDb(v)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('Fresnel geometry', () => {
  it('reproduces the first-zone radius at mid-path', () => {
    // 21.2 km at 750 MHz: sqrt(0.4 * 10600^2 / 21200) ~ 46 m.
    const lambda = wavelengthM(750);
    expect(firstFresnelRadiusM(10600, 10600, lambda)).toBeCloseTo(46, 0);
    // Same path at 3.7 GHz is much tighter, ~20.7 m -- which is why the radial walk samples
    // at 15 m rather than at the 30 m DEM spacing.
    expect(firstFresnelRadiusM(10600, 10600, wavelengthM(3700))).toBeCloseTo(20.7, 0);
  });

  it('collapses to zero at both endpoints', () => {
    const lambda = wavelengthM(1900);
    expect(firstFresnelRadiusM(0, 10000, lambda)).toBe(0);
    expect(firstFresnelRadiusM(10000, 0, lambda)).toBe(0);
  });

  it('ties v = sqrt(2) to exactly one Fresnel radius of intrusion', () => {
    // v = h*sqrt(2d/(lambda d1 d2)) and F1 = sqrt(lambda d1 d2/d), so h = F1 gives v = sqrt(2).
    const lambda = wavelengthM(1900);
    const d1 = 4000;
    const d2 = 6000;
    const f1 = firstFresnelRadiusM(d1, d2, lambda);
    expect(fresnelParameter(f1, d1, d2, lambda)).toBeCloseTo(Math.SQRT2, 6);
  });

  it('is signed: a clear path gives negative v and therefore no loss', () => {
    const lambda = wavelengthM(1900);
    expect(fresnelParameter(-50, 4000, 6000, lambda)).toBeLessThan(0);
    expect(knifeEdgeLossDb(fresnelParameter(-50, 4000, 6000, lambda))).toBe(0);
  });

  it('returns zero for degenerate geometry rather than NaN', () => {
    expect(fresnelParameter(10, 0, 6000, 0.16)).toBe(0);
    expect(fresnelParameter(10, 4000, 0, 0.16)).toBe(0);
    expect(fresnelParameter(10, 4000, 6000, 0)).toBe(0);
  });
});

describe('obstacleLossDb', () => {
  const lambda = wavelengthM(1900);

  it('is zero when the obstacle sits on the direct ray minus a clear margin', () => {
    // TX and RX both at 100 m, obstacle at 50 m -- well below the line.
    expect(obstacleLossDb(50, 5000, 10000, 100, 100, lambda)).toBe(0);
  });

  it('gives about 6 dB when the obstacle exactly touches the ray', () => {
    expect(obstacleLossDb(100, 5000, 10000, 100, 100, lambda)).toBeCloseTo(6.0329, 3);
  });

  it('grows as the obstacle rises through the ray', () => {
    const a = obstacleLossDb(110, 5000, 10000, 100, 100, lambda);
    const b = obstacleLossDb(140, 5000, 10000, 100, 100, lambda);
    const c = obstacleLossDb(200, 5000, 10000, 100, 100, lambda);
    expect(a).toBeGreaterThan(6);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it('interpolates the ray height when the terminals differ', () => {
    // TX 200 m, RX 0 m: the ray is at 100 m one quarter of the way... no, at mid-path.
    // An obstacle at exactly 100 m at mid-path just grazes it.
    expect(obstacleLossDb(100, 5000, 10000, 200, 0, lambda)).toBeCloseTo(6.0329, 3);
    // A quarter of the way along, the ray is at 150 m, so 100 m is well clear.
    expect(obstacleLossDb(100, 2500, 10000, 200, 0, lambda)).toBe(0);
  });

  it('returns zero for obstacles at either terminal', () => {
    expect(obstacleLossDb(500, 0, 10000, 100, 100, lambda)).toBe(0);
    expect(obstacleLossDb(500, 10000, 10000, 100, 100, lambda)).toBe(0);
  });

  it('loses more at higher frequency for identical geometry', () => {
    const low = obstacleLossDb(150, 5000, 10000, 100, 100, wavelengthM(700));
    const high = obstacleLossDb(150, 5000, 10000, 100, 100, wavelengthM(3700));
    expect(high).toBeGreaterThan(low);
  });
});
