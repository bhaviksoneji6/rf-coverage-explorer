import { describe, expect, it } from 'vitest';
import { makeAoi, makeCoverageGrid, radialParams } from '../src/geo/aoi.js';
import { computeRadials } from '../src/engine/radial.js';
import { resampleRadialToGrid } from '../src/engine/resample.js';
import { DEFAULT_K_FACTOR, type TerrainGridSpec } from '../src/engine/types.js';
import { fsplDb } from '../src/models/fspl.js';

const CENTER = { lon: -122.33, lat: 47.61 };
const FREQ = 3700;

function setup(sideM = 30000, binM = 100, elevation = 100) {
  const aoi = makeAoi(CENTER, sideM);
  const coverage = makeCoverageGrid(aoi, binM);
  const rp = radialParams(aoi, coverage.binM);

  const spec: TerrainGridSpec = {
    width: aoi.size.width,
    height: aoi.size.height,
    minE: aoi.bbox.minE,
    maxN: aoi.bbox.maxN,
    resM: aoi.resM,
  };
  const terrain = new Float32Array(aoi.size.width * aoi.size.height).fill(elevation);

  const params = {
    txE: aoi.center.e,
    txN: aoi.center.n,
    txHeightAglM: 30,
    rxHeightAglM: 1.5,
    freqMHz: FREQ,
    nRadials: rp.nRadials,
    nSteps: rp.nSteps,
    stepM: rp.stepM,
    kFactor: DEFAULT_K_FACTOR,
  };

  const radial = computeRadials(terrain, spec, params);
  const grid = {
    width: coverage.size.width,
    height: coverage.size.height,
    minE: coverage.bbox.minE,
    maxN: coverage.bbox.maxN,
    binM: coverage.binM,
  };
  const pathLoss = new Float32Array(grid.width * grid.height);
  resampleRadialToGrid(
    radial.pathLoss,
    params.nRadials,
    params.nSteps,
    params.stepM,
    params.txE,
    params.txN,
    grid,
    pathLoss,
  );

  return { aoi, coverage, rp, params, radial, grid, pathLoss };
}

describe('AOI and radial parameter sizing', () => {
  it('holds a 30 km AOI to a 1000 px raster at 30 m', () => {
    const aoi = makeAoi(CENTER, 30000);
    expect(aoi.size.width).toBe(1000);
    expect(aoi.resM).toBeCloseTo(30, 6);
    expect(aoi.zone.epsg).toBe(32610);
  });

  it('clamps ground resolution to the 10 m native limit on small areas', () => {
    const aoi = makeAoi(CENTER, 5000);
    expect(aoi.resM).toBeGreaterThanOrEqual(10);
    expect(aoi.size.width).toBeLessThanOrEqual(1000);
  });

  it('picks enough radials that the arc gap at max range stays under one bin', () => {
    const { rp, coverage } = setup();
    const arcGap = (2 * Math.PI * rp.maxRangeM) / rp.nRadials;
    expect(arcGap).toBeLessThan(coverage.binM);
  });

  it('costs far less than a per-bin walk', () => {
    const { rp, coverage } = setup();
    const radialSamples = rp.nRadials * rp.nSteps;
    const perBinSamples = coverage.size.width * coverage.size.height * (rp.maxRangeM / 2 / rp.stepM);
    expect(radialSamples).toBeLessThan(perBinSamples / 10);
  });
});

describe('radial walk and resample over flat terrain', () => {
  it('leaves no unfilled bins anywhere in the AOI', () => {
    const { pathLoss } = setup();
    const bad = pathLoss.findIndex((v) => !Number.isFinite(v));
    expect(bad).toBe(-1);
  });

  it('is symmetric about both axes and the diagonal', () => {
    const { pathLoss, grid } = setup();
    const W = grid.width;
    const H = grid.height;
    const at = (i: number, j: number) => pathLoss[j * W + i] as number;

    for (const [i, j] of [
      [10, 40],
      [77, 123],
      [149, 3],
      [200, 260],
    ] as [number, number][]) {
      expect(at(i, j)).toBeCloseTo(at(W - 1 - i, j), 4); // mirror east-west
      expect(at(i, j)).toBeCloseTo(at(i, H - 1 - j), 4); // mirror north-south
      expect(at(i, j)).toBeCloseTo(at(j, i), 4); // reflect across the diagonal
    }
  });

  it('reproduces closed-form FSPL at the bin centres', () => {
    const { pathLoss, grid, params } = setup();
    const W = grid.width;

    for (const [i, j] of [
      [149, 100],
      [50, 50],
      [280, 160],
    ] as [number, number][]) {
      const e = grid.minE + (i + 0.5) * grid.binM;
      const n = grid.maxN - (j + 0.5) * grid.binM;
      const r = Math.hypot(e - params.txE, n - params.txN);
      expect(pathLoss[j * W + i] as number).toBeCloseTo(fsplDb(r / 1000, FREQ), 2);
    }
  });

  it('increases monotonically with distance from the transmitter', () => {
    const { pathLoss, grid } = setup();
    const W = grid.width;
    const mid = Math.floor(grid.height / 2);
    let prev = -Infinity;
    for (let i = Math.floor(W / 2); i < W; i++) {
      const v = pathLoss[mid * W + i] as number;
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });
});

describe('elevation angle', () => {
  it('drops below the horizon on flat ground and steepens with range', () => {
    const { radial, params } = setup();
    const near = radial.elevAngle[10] as number;
    const far = radial.elevAngle[params.nSteps - 1] as number;
    // RX at 1.5 m is below a 30 m mast, so every angle is negative.
    expect(near).toBeLessThan(0);
    expect(far).toBeLessThan(0);
    // Near the mast the depression is steep; far away it flattens, then earth curvature
    // pulls it back down again.
    expect(Math.abs(near)).toBeGreaterThan(Math.abs(far));
  });

  it('applies effective-earth curvature over long ranges', () => {
    const { radial, params } = setup();
    const d = params.nSteps * params.stepM;

    // Two different curvature quantities are easy to confuse:
    //
    //   d1*d2/(2*k*Re)  departure of the surface from the straight TX-RX chord at a point
    //                   d1 along the path. At mid-path of a 21 km link this is ~6.6 m, and
    //                   it is the number that matters for Fresnel clearance.
    //   d^2/(2*k*Re)    drop of a point at range d below the tangent plane at the TX. This
    //                   is ~26.5 m at 21 km -- four times the mid-path figure, because the
    //                   midpoint is half the range and the term is quadratic.
    //
    // The engine flattens the earth against the TX tangent plane so plain straight-line
    // geometry is valid afterwards, so it is the second form that belongs here.
    const drop = (d * d) / (2 * params.kFactor * 6371008.8);
    expect(drop).toBeCloseTo(26.5, 0);

    const midPathBulge = ((d / 2) * (d / 2)) / (2 * params.kFactor * 6371008.8);
    expect(midPathBulge).toBeCloseTo(6.6, 0);
    expect(drop / midPathBulge).toBeCloseTo(4, 5);

    const last = radial.elevAngle[params.nSteps - 1] as number;
    const withoutCurvature = Math.atan2(1.5 - 30, d);
    expect(last).toBeLessThan(withoutCurvature);
  });
});
