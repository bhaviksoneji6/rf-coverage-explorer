import { describe, expect, it } from 'vitest';
import { aggregate } from '../src/engine/aggregate.js';
import { isCoChannel, noiseFloorDbm } from '../src/models/linkBudget.js';

const NOISE = noiseFloorDbm(20, 7);

function run(levels: number[][], freqs: number[], opts: Partial<{ bw: number; thr: number }> = {}) {
  const binCount = (levels[0] as number[]).length;
  return aggregate({
    rsl: levels.map((l) => Float32Array.from(l)),
    freqMHz: freqs,
    bandwidthMHz: opts.bw ?? 20,
    noiseDbm: NOISE,
    serviceThresholdDbm: opts.thr ?? -110,
    binCount,
  });
}

describe('noise floor', () => {
  it('gives -94 dBm for 20 MHz at 7 dB NF', () => {
    // -174 + 10log10(20e6) + 7 = -174 + 73.01 + 7
    expect(noiseFloorDbm(20, 7)).toBeCloseTo(-93.99, 2);
  });

  it('rises 3 dB per doubling of bandwidth', () => {
    expect(noiseFloorDbm(40, 7) - noiseFloorDbm(20, 7)).toBeCloseTo(3.0103, 3);
  });

  it('tracks noise figure one for one', () => {
    expect(noiseFloorDbm(20, 10) - noiseFloorDbm(20, 7)).toBeCloseTo(3, 6);
  });
});

describe('co-channel test', () => {
  it('treats identical carriers as interfering', () => {
    expect(isCoChannel(3700, 3700, 20)).toBe(true);
  });

  it('separates carriers more than a channel apart', () => {
    expect(isCoChannel(3700, 3720, 20)).toBe(false);
    expect(isCoChannel(3700, 3730, 20)).toBe(false);
  });

  it('still overlaps for partial offsets', () => {
    expect(isCoChannel(3700, 3710, 20)).toBe(true);
  });
});

describe('serving site selection', () => {
  it('picks the strongest site per bin', () => {
    const r = run(
      [
        [-80, -95, -120],
        [-90, -85, -118],
      ],
      [3700, 3700],
    );
    expect(Array.from(r.serving)).toEqual([0, 1, 1]);
    expect(Array.from(r.bestRsl)).toEqual([-80, -85, -118]);
  });

  it('reports -1 and NaN where nothing reaches', () => {
    const r = run([[NaN, -80], [NaN, -90]], [3700, 3700]);
    expect(r.serving[0]).toBe(-1);
    expect(Number.isNaN(r.bestRsl[0] as number)).toBe(true);
    expect(Number.isNaN(r.sinr[0] as number)).toBe(true);
    expect(r.serving[1]).toBe(0);
  });

  it('ignores sites that do not reach a bin when others do', () => {
    const r = run([[NaN, -80], [-70, -90]], [3700, 3700]);
    expect(r.serving[0]).toBe(1);
    expect(r.bestRsl[0]).toBe(-70);
  });
});

describe('SINR', () => {
  it('is noise-limited with a single site', () => {
    // -80 dBm against a -94 dBm floor is 14 dB, with no interference in the denominator.
    const r = run([[-80]], [3700]);
    expect(r.sinr[0] as number).toBeCloseTo(-80 - NOISE, 1);
  });

  it('collapses to ~0 dB for two equal co-channel sites', () => {
    // Equal powers, so signal/interference is 1 and the noise term is negligible.
    const r = run([[-70], [-70]], [3700, 3700]);
    expect(r.sinr[0] as number).toBeGreaterThan(-0.1);
    expect(r.sinr[0] as number).toBeLessThan(0.1);
  });

  it('recovers completely when the interferer is retuned off channel', () => {
    const co = run([[-70], [-70]], [3700, 3700]);
    const adj = run([[-70], [-70]], [3700, 3760]);
    expect(co.sinr[0] as number).toBeLessThan(1);
    // Off channel it is noise-limited again: -70 against -94.
    expect(adj.sinr[0] as number).toBeCloseTo(-70 - NOISE, 1);
    expect(adj.sinr[0] as number).toBeGreaterThan((co.sinr[0] as number) + 20);
  });

  it('degrades as more co-channel interferers pile on', () => {
    const one = run([[-70], [-80]], [3700, 3700]);
    const two = run([[-70], [-80], [-80]], [3700, 3700, 3700]);
    const three = run([[-70], [-80], [-80], [-80]], [3700, 3700, 3700, 3700]);
    expect(two.sinr[0] as number).toBeLessThan(one.sinr[0] as number);
    expect(three.sinr[0] as number).toBeLessThan(two.sinr[0] as number);
  });

  it('never exceeds the noise-limited ceiling', () => {
    const ceiling = -70 - NOISE;
    const r = run([[-70], [-95]], [3700, 3700]);
    expect(r.sinr[0] as number).toBeLessThan(ceiling);
  });
});

describe('overlap count', () => {
  it('counts sites above the service threshold, not just the server', () => {
    const r = run(
      [
        [-80, -80, -80],
        [-90, -105, -120],
        [-95, -108, -125],
      ],
      [3700, 3700, 3700],
      { thr: -100 },
    );
    expect(Array.from(r.overlap)).toEqual([3, 1, 1]);
  });

  it('is zero where nothing meets the threshold', () => {
    const r = run([[-130], [-140]], [3700, 3700], { thr: -110 });
    expect(r.overlap[0]).toBe(0);
    // Still has a serving site -- "strongest" and "served" are different questions.
    expect(r.serving[0]).toBe(0);
  });

  it('moves with the threshold, which is why it is a link-budget input', () => {
    const levels = [[-85], [-95], [-105]];
    const freqs = [3700, 3700, 3700];
    expect(run(levels, freqs, { thr: -90 }).overlap[0]).toBe(1);
    expect(run(levels, freqs, { thr: -100 }).overlap[0]).toBe(2);
    expect(run(levels, freqs, { thr: -110 }).overlap[0]).toBe(3);
  });
});

describe('frequency planning', () => {
  it('shows the whole point: retuning half a co-channel cluster lifts SINR', () => {
    const levels = [[-70], [-72], [-74], [-76]];
    const allCo = run(levels, [3700, 3700, 3700, 3700]);
    const planned = run(levels, [3700, 3760, 3820, 3880]);
    expect(allCo.sinr[0] as number).toBeLessThan(3);
    expect(planned.sinr[0] as number).toBeGreaterThan(20);
  });
});
