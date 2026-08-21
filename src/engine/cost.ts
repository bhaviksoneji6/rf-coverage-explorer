import { radialParamsFor } from '../geo/aoi.js';

/**
 * Cost estimate for one propagation pass.
 *
 * This exists because the expensive combination is not reachable from either slider alone.
 * 10 m bins over a 2 km area is 200x200 and instant; 200 m bins over 100 km is 500x500 and
 * instant; 10 m bins over 100 km is 100 M bins and ~209 M radial samples, which allocates
 * roughly 1.7 GB and kills the tab before any warning could paint. So the guard has to look
 * at the product, and it has to *prevent* rather than warn.
 */

/**
 * Timing constants, back-fitted from a measured run: 1.89 M radial samples resampled to
 * 90,601 bins took 45 ms on an M-series laptop (35 ms walk + 10 ms resample). They are a
 * rough model, not a promise -- the thresholds below carry enough headroom that being off
 * by 2x changes nothing important.
 */
const NS_PER_RADIAL_SAMPLE = 20;
const NS_PER_BIN = 110;

const WARN_MS = 1_500;
const BLOCK_MS = 8_000;
const WARN_BYTES = 256 * 1024 * 1024;
const BLOCK_BYTES = 700 * 1024 * 1024;

/** Bin sizes offered when suggesting a way out of a blocked configuration. */
const BIN_LADDER = [10, 15, 20, 25, 30, 40, 50, 75, 100, 150, 200, 250, 300, 400, 500];

export type CostLevel = 'ok' | 'warn' | 'block';

export interface CostInput {
  sideM: number;
  /** Ground resolution of the fetched DEM, used to flag pointless oversampling. */
  demResM: number;
  binM: number;
  stepM?: number;
  siteCount?: number;
}

export interface CostEstimate {
  bins: number;
  radialSamples: number;
  bytes: number;
  ms: number;
  level: CostLevel;
  /** Human-readable explanation when not `ok`. */
  reason: string | null;
  /** Coarsest-to-finest suggestion that would clear the block, or null if none helps. */
  suggestedBinM: number | null;
}

function megabytes(bytes: number): string {
  return bytes >= 1024 * 1024 * 1024
    ? `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
    : `${Math.round(bytes / 1024 / 1024)} MB`;
}

export function formatCount(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} G`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} k`;
  return String(n);
}

/** Raw sizes only -- no thresholds applied. Shared by the estimate and the bin search. */
function rawCost(input: CostInput): { bins: number; radialSamples: number; bytes: number; ms: number } {
  const siteCount = Math.max(1, input.siteCount ?? 1);
  const perSide = Math.max(1, Math.round(input.sideM / input.binM));
  const bins = perSide * perSide;

  const rp = radialParamsFor(input.sideM, input.binM, input.stepM ?? 15);
  const radialSamples = rp.nRadials * rp.nSteps;

  const bytes =
    // pathLoss + elevAngle over the radial fan, held transiently in the worker
    2 * 4 * radialSamples +
    // pathLoss + elevAngle per site on the output grid, held for the session
    2 * 4 * bins * siteCount +
    // the derived KPI grid plus its RGBA rendering
    4 * bins +
    4 * bins;

  const ms = (radialSamples * NS_PER_RADIAL_SAMPLE + bins * NS_PER_BIN * siteCount) / 1e6;
  return { bins, radialSamples, bytes, ms };
}

export function estimateCost(input: CostInput): CostEstimate {
  const raw = rawCost(input);

  let level: CostLevel = 'ok';
  const notes: string[] = [];

  if (raw.bytes > BLOCK_BYTES || raw.ms > BLOCK_MS) {
    level = 'block';
    notes.push(
      `${formatCount(raw.bins)} bins and ${formatCount(raw.radialSamples)} radial samples ` +
        `would need about ${megabytes(raw.bytes)} and ${(raw.ms / 1000).toFixed(1)} s`,
    );
  } else if (raw.bytes > WARN_BYTES || raw.ms > WARN_MS) {
    level = 'warn';
    notes.push(`heavy: about ${megabytes(raw.bytes)} and ${(raw.ms / 1000).toFixed(1)} s per pass`);
  }

  // Independent of cost, and worth reporting alongside it rather than instead of it: when
  // this fires together with a cost warning it says the expensive bins are buying nothing,
  // which makes coarsening them an obvious win rather than a compromise.
  if (input.binM < input.demResM) {
    if (level === 'ok') level = 'warn';
    notes.push(
      `bins finer than the ${Math.round(input.demResM)} m terrain data — smoother, not sharper`,
    );
  }

  const reason = notes.length ? notes.join(' · ') : null;

  return {
    ...raw,
    level,
    reason,
    suggestedBinM: level === 'block' ? suggestBinM(input) : null,
  };
}

/** Smallest ladder bin size whose cost clears both block thresholds. */
export function suggestBinM(input: CostInput): number | null {
  for (const binM of BIN_LADDER) {
    if (binM < input.binM) continue;
    const raw = rawCost({ ...input, binM });
    if (raw.bytes <= BLOCK_BYTES && raw.ms <= BLOCK_MS) return binM;
  }
  return null;
}

/** One-line readout for the control panel. */
export function formatCost(c: CostEstimate, perSide: number): string {
  return (
    `${perSide}x${perSide} bins · ${formatCount(c.radialSamples)} samples · ` +
    `~${c.ms < 1000 ? `${Math.round(c.ms)} ms` : `${(c.ms / 1000).toFixed(1)} s`} · ` +
    `${megabytes(c.bytes)}`
  );
}
