/**
 * Combine per-site received levels into network KPIs.
 *
 * Everything here is a recombination of already-computed path loss, so it lives in the
 * link-budget stage and stays Class 1: eight sites over 360k bins is ~3M operations, around
 * 10-25 ms. Retuning a frequency or nudging an EIRP re-runs this and nothing more.
 */

import { dbmToMw, isCoChannel } from '../models/linkBudget.js';

export interface AggregateInput {
  /** One received-level grid per enabled site, dBm, NaN outside range. */
  rsl: Float32Array[];
  /** Centre frequency per site, index-aligned with `rsl`. */
  freqMHz: number[];
  bandwidthMHz: number;
  /** Thermal noise floor in dBm. */
  noiseDbm: number;
  /** Level at or above which a bin counts as served. */
  serviceThresholdDbm: number;
  binCount: number;
}

export interface AggregateResult {
  /** Strongest received level at each bin, dBm. */
  bestRsl: Float32Array;
  /** Index into the input arrays of the serving site, or -1 where nothing reaches. */
  serving: Int16Array;
  /** Signal to interference-plus-noise ratio, dB. */
  sinr: Float32Array;
  /** How many sites exceed the service threshold -- pilot pollution / handover churn. */
  overlap: Uint8Array;
}

export function aggregate(input: AggregateInput): AggregateResult {
  const { rsl, freqMHz, bandwidthMHz, noiseDbm, serviceThresholdDbm, binCount } = input;
  const n = rsl.length;

  const bestRsl = new Float32Array(binCount);
  const serving = new Int16Array(binCount);
  const sinr = new Float32Array(binCount);
  const overlap = new Uint8Array(binCount);

  const noiseMw = dbmToMw(noiseDbm);
  const bw = Math.max(0.001, bandwidthMHz);

  // Co-channel is a property of the site pair, not of the bin, so resolve it once rather
  // than once per bin per pair.
  const coChannel: boolean[][] = [];
  for (let a = 0; a < n; a++) {
    coChannel[a] = [];
    for (let b = 0; b < n; b++) {
      (coChannel[a] as boolean[])[b] =
        a !== b && isCoChannel(freqMHz[a] as number, freqMHz[b] as number, bw);
    }
  }

  for (let i = 0; i < binCount; i++) {
    let best = -Infinity;
    let bestIdx = -1;
    let served = 0;

    for (let s = 0; s < n; s++) {
      const v = (rsl[s] as Float32Array)[i] as number;
      if (!Number.isFinite(v)) continue;
      if (v > best) {
        best = v;
        bestIdx = s;
      }
      if (v >= serviceThresholdDbm) served++;
    }

    overlap[i] = served > 255 ? 255 : served;

    if (bestIdx < 0) {
      bestRsl[i] = NaN;
      serving[i] = -1;
      sinr[i] = NaN;
      continue;
    }

    bestRsl[i] = best;
    serving[i] = bestIdx;

    // Only co-channel sites contribute interference; everything else is out of band.
    let interferenceMw = 0;
    const row = coChannel[bestIdx] as boolean[];
    for (let s = 0; s < n; s++) {
      if (!row[s]) continue;
      const v = (rsl[s] as Float32Array)[i] as number;
      if (Number.isFinite(v)) interferenceMw += dbmToMw(v);
    }

    sinr[i] = 10 * Math.log10(dbmToMw(best) / (interferenceMw + noiseMw));
  }

  return { bestRsl, serving, sinr, overlap };
}
