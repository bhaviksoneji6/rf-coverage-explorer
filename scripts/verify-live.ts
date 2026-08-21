/**
 * Live end-to-end check of the data pipeline.
 *
 * Deliberately NOT part of `npm test`: it hits third-party government endpoints, so it is
 * slow and can fail for reasons that have nothing to do with this repo. Run it by hand when
 * something looks wrong, or after changing a provider.
 *
 *   npm run verify:live
 *
 * It exercises the real fetch, the real GeoTIFF decode, and the real radial engine against
 * real terrain -- which is the part the unit tests cannot cover, since they run on synthetic
 * flat ground.
 */
import { makeAoi, makeCoverageGrid, radialParams } from '../src/geo/aoi.js';
import { computeRadials } from '../src/engine/radial.js';
import { resampleRadialToGrid } from '../src/engine/resample.js';
import { DEFAULT_K_FACTOR, type TerrainGridSpec } from '../src/engine/types.js';
import { Usgs3depProvider } from '../src/providers/terrain/usgs3dep.js';

const SEATTLE = { lon: -122.33, lat: 47.61 };

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  const aoi = makeAoi(SEATTLE, 30000);
  console.log(
    `AOI: ${aoi.size.width}x${aoi.size.height} @ ${aoi.resM.toFixed(1)} m, EPSG:${aoi.zone.epsg}\n`,
  );

  console.log('Terrain (USGS 3DEP exportImage):');
  const provider = new Usgs3depProvider();
  check('covers() accepts Seattle', provider.covers(aoi.bbox, aoi.zone.epsg), '');

  const t0 = Date.now();
  const terrain = await provider.fetch(aoi.bbox, aoi.size, aoi.zone.epsg);
  const fetchMs = Date.now() - t0;

  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let atSeaLevel = 0;
  for (const v of terrain) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    if (v <= 0.5) atSeaLevel++;
  }
  const seaFraction = atSeaLevel / terrain.length;

  check('sample count matches the requested grid', terrain.length === 1000 * 1000, `${terrain.length}`);
  check('fetch completed', fetchMs < 30000, `${fetchMs} ms`);
  check('no nodata sentinels survived', min > -1000, `min ${min.toFixed(1)} m`);
  check('relief is plausible for Seattle', max > 80 && max < 1200, `max ${max.toFixed(1)} m`);
  check(
    'Puget Sound shows up as sea level',
    seaFraction > 0.15 && seaFraction < 0.7,
    `${(seaFraction * 100).toFixed(1)}% at/below 0.5 m`,
  );
  console.log(`        mean ${(sum / terrain.length).toFixed(1)} m\n`);

  console.log('Engine (radial walk over real terrain):');
  const coverage = makeCoverageGrid(aoi, 100);
  const rp = radialParams(aoi, coverage.binM);
  const spec: TerrainGridSpec = {
    width: aoi.size.width,
    height: aoi.size.height,
    minE: aoi.bbox.minE,
    maxN: aoi.bbox.maxN,
    resM: aoi.resM,
  };
  const params = {
    txE: aoi.center.e,
    txN: aoi.center.n,
    txHeightAglM: 30,
    rxHeightAglM: 1.5,
    freqMHz: 3700,
    nRadials: rp.nRadials,
    nSteps: rp.nSteps,
    stepM: rp.stepM,
    kFactor: DEFAULT_K_FACTOR,
  };

  const t1 = Date.now();
  const radial = computeRadials(terrain, spec, params);
  const grid = {
    width: coverage.size.width,
    height: coverage.size.height,
    minE: coverage.bbox.minE,
    maxN: coverage.bbox.maxN,
    binM: coverage.binM,
  };
  const pathLoss = new Float32Array(grid.width * grid.height);
  const elev = new Float32Array(grid.width * grid.height);
  resampleRadialToGrid(radial.pathLoss, rp.nRadials, rp.nSteps, rp.stepM, params.txE, params.txN, grid, pathLoss);
  resampleRadialToGrid(radial.elevAngle, rp.nRadials, rp.nSteps, rp.stepM, params.txE, params.txN, grid, elev, NaN, true);
  const engineMs = Date.now() - t1;

  console.log(`        ${rp.nRadials} radials x ${rp.nSteps} steps = ${(rp.nRadials * rp.nSteps / 1e6).toFixed(2)} M samples`);
  check('engine is interactive', engineMs < 500, `${engineMs} ms for ${grid.width}x${grid.height} bins`);
  check('no unfilled bins', pathLoss.every(Number.isFinite), '');

  // FSPL ignores terrain, so the loss map must stay perfectly symmetric even over real hills.
  const W = grid.width;
  const at = (i: number, j: number) => pathLoss[j * W + i] as number;
  let worstAsym = 0;
  for (let j = 0; j < grid.height; j += 7) {
    for (let i = 0; i < W; i += 7) {
      worstAsym = Math.max(worstAsym, Math.abs(at(i, j) - at(W - 1 - i, j)));
    }
  }
  check('FSPL stays radially symmetric over real terrain', worstAsym < 0.01, `worst ${worstAsym.toExponential(1)} dB`);

  // Elevation angle DOES read terrain, so it must NOT be symmetric -- this is the assertion
  // that proves the DEM is actually reaching the engine rather than being ignored.
  const atE = (i: number, j: number) => elev[j * W + i] as number;
  let maxElevAsym = 0;
  for (let j = 0; j < grid.height; j += 7) {
    for (let i = 0; i < W; i += 7) {
      const d = Math.abs(atE(i, j) - atE(W - 1 - i, j));
      if (Number.isFinite(d)) maxElevAsym = Math.max(maxElevAsym, d);
    }
  }
  check(
    'elevation angle reflects real terrain (asymmetric)',
    maxElevAsym > 0.01,
    `max mirror difference ${(maxElevAsym * 1000).toFixed(1)} mrad`,
  );

  console.log(`\n${failures === 0 ? 'All live checks passed.' : `${failures} live check(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('verify-live failed:', err);
  process.exit(1);
});
