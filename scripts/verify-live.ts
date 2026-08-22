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
  const grid = {
    width: coverage.size.width,
    height: coverage.size.height,
    minE: coverage.bbox.minE,
    maxN: coverage.bbox.maxN,
    binM: coverage.binM,
  };
  const W = grid.width;

  function run(model: 'fspl' | 'diffraction') {
    const params = {
      txE: aoi.center.e,
      txN: aoi.center.n,
      txHeightAglM: 30,
      rxHeightAglM: 1.5,
      freqMHz: 3700,
      model,
      nRadials: rp.nRadials,
      nSteps: rp.nSteps,
      stepM: rp.stepM,
      kFactor: DEFAULT_K_FACTOR,
    };
    const t = Date.now();
    const radial = computeRadials(terrain, spec, params);
    const pathLoss = new Float32Array(W * grid.height);
    const diff = new Float32Array(W * grid.height);
    const elev = new Float32Array(W * grid.height);
    const rs = (src: Float32Array, dst: Float32Array, ang = false) =>
      resampleRadialToGrid(src, rp.nRadials, rp.nSteps, rp.stepM, params.txE, params.txN, grid, dst, NaN, ang);
    rs(radial.pathLoss, pathLoss);
    rs(radial.diffraction, diff);
    rs(radial.elevAngle, elev, true);
    return { pathLoss, diff, elev, ms: Date.now() - t };
  }

  const mirrorAsymmetry = (f: Float32Array): number => {
    let worst = 0;
    for (let j = 0; j < grid.height; j += 7) {
      for (let i = 0; i < W; i += 7) {
        const d = Math.abs((f[j * W + i] as number) - (f[j * W + (W - 1 - i)] as number));
        if (Number.isFinite(d)) worst = Math.max(worst, d);
      }
    }
    return worst;
  };

  console.log(`        ${rp.nRadials} radials x ${rp.nSteps} steps = ${(rp.nRadials * rp.nSteps / 1e6).toFixed(2)} M samples`);

  const fspl = run('fspl');
  check('engine is interactive', fspl.ms < 500, `${fspl.ms} ms for ${W}x${grid.height} bins (FSPL)`);
  check('no unfilled bins', fspl.pathLoss.every(Number.isFinite), '');

  // Free space ignores terrain, so its map must be perfectly symmetric even over real hills.
  check(
    'FSPL stays radially symmetric over real terrain',
    mirrorAsymmetry(fspl.pathLoss) < 0.01,
    `worst ${mirrorAsymmetry(fspl.pathLoss).toExponential(1)} dB`,
  );

  // Elevation angle reads terrain, so it must NOT be symmetric. This is what proves the DEM
  // is actually reaching the engine rather than being quietly ignored.
  check(
    'elevation angle reflects real terrain (asymmetric)',
    mirrorAsymmetry(fspl.elev) > 0.01,
    `max mirror difference ${(mirrorAsymmetry(fspl.elev) * 1000).toFixed(1)} mrad`,
  );

  console.log('\nDiffraction (Model 1 over real terrain):');
  const dif = run('diffraction');
  check('still interactive with diffraction', dif.ms < 800, `${dif.ms} ms`);
  check('no unfilled bins', dif.pathLoss.every(Number.isFinite), '');

  let shadowed = 0;
  let worstDb = 0;
  let diffSum = 0;
  for (const v of dif.diff) {
    if (v > 0.1) shadowed++;
    if (v > worstDb) worstDb = v;
    if (Number.isFinite(v)) diffSum += v;
  }
  const shadowFrac = shadowed / dif.diff.length;

  check('diffraction is never negative (it is a loss)', Array.from(dif.diff).every((v) => !(v < 0)), '');
  check(
    'real terrain casts real shadows',
    shadowFrac > 0.02 && shadowFrac < 0.9,
    `${(shadowFrac * 100).toFixed(1)}% of bins obstructed`,
  );
  check('shadow depth is physically plausible', worstDb > 5 && worstDb < 60, `worst ${worstDb.toFixed(1)} dB`);
  check(
    'diffraction breaks the symmetry FSPL had',
    mirrorAsymmetry(dif.pathLoss) > 1,
    `worst mirror difference ${mirrorAsymmetry(dif.pathLoss).toFixed(1)} dB`,
  );
  check(
    'total loss equals free space plus diffraction',
    Array.from(dif.pathLoss).every((v, i) => {
      const expect = (fspl.pathLoss[i] as number) + (dif.diff[i] as number);
      return !Number.isFinite(v) || Math.abs(v - expect) < 0.02;
    }),
    '',
  );
  console.log(`        mean diffraction loss ${(diffSum / dif.diff.length).toFixed(2)} dB`);

  console.log(`\n${failures === 0 ? 'All live checks passed.' : `${failures} live check(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('verify-live failed:', err);
  process.exit(1);
});
