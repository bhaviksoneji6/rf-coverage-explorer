import maplibregl, { Map as MlMap, Marker } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';

import { makeAoi, makeCoverageGrid, radialParams, type Aoi, type CoverageGrid } from './geo/aoi.js';
import { bboxCovers } from './geo/bbox.js';
import { toUtm } from './geo/utm.js';
import { EngineClient } from './engine/client.js';
import { DEFAULT_K_FACTOR, type SiteGrid, type TerrainGridSpec } from './engine/types.js';
import { NlcdProvider } from './providers/clutter/nlcd.js';
import { Usgs3depProvider } from './providers/terrain/usgs3dep.js';
import { CLUTTER_COLORS } from './providers/types.js';
import { rasterize } from './render/colormap.js';
import { clutterToRgba, hillshadeToRgba } from './render/hillshade.js';
import { aoiCorners, RasterOverlay, type Corners } from './render/rasterLayer.js';
import { createStore } from './store/store.js';
import { DEFAULT_STATE, STAGE_FOR, type AppState, type Site } from './store/types.js';
import { buildControls } from './ui/controls.js';
import { renderLegend } from './ui/legend.js';

const BASEMAP = 'https://tiles.openfreemap.org/styles/positron';
const START = { lon: -122.33, lat: 47.61, zoom: 10.2 };

const terrainProvider = new Usgs3depProvider();
const clutterProvider = new NlcdProvider();

/**
 * Derived data, kept outside the store.
 *
 * These are large typed arrays with clear ownership by pipeline stage, and putting them in
 * reactive state would only invite accidental copies. The store holds the knobs; this
 * holds the buffers they produce.
 */
interface Ctx {
  aoi: Aoi | null;
  terrain: Float32Array | null;
  clutter: Uint8Array | null;
  corners: Corners | null;
  coverage: CoverageGrid | null;
  grids: Map<string, SiteGrid>;
  kpiValues: Float32Array | null;
  rgba: Uint8ClampedArray<ArrayBuffer> | null;
  demRgba: Uint8ClampedArray<ArrayBuffer> | null;
}

const ctx: Ctx = {
  aoi: null,
  terrain: null,
  clutter: null,
  corners: null,
  coverage: null,
  grids: new Map(),
  kpiValues: null,
  rgba: null,
  demRgba: null,
};

const store = createStore<AppState>(DEFAULT_STATE, STAGE_FOR);

const map = new MlMap({
  container: 'map',
  style: BASEMAP,
  center: [START.lon, START.lat],
  zoom: START.zoom,
});
map.addControl(new maplibregl.NavigationControl({}), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

const controls = buildControls(document.getElementById('panel') as HTMLElement, store);
const legendEl = document.getElementById('legend') as HTMLElement;

const engine = new EngineClient((msg) => controls.setStatus(`Engine error: ${msg}`, 'error'));

let coverageLayer: RasterOverlay | null = null;
let hillshadeLayer: RasterOverlay | null = null;
let clutterLayer: RasterOverlay | null = null;
const markers = new Map<string, Marker>();

function selectedSite(s: AppState): Site | null {
  return s.sites.find((x) => x.id === s.selectedSiteId) ?? null;
}

function demSpec(aoi: Aoi): TerrainGridSpec {
  return {
    width: aoi.size.width,
    height: aoi.size.height,
    minE: aoi.bbox.minE,
    maxN: aoi.bbox.maxN,
    resM: aoi.resM,
  };
}

function ensureBuffer(current: Uint8ClampedArray<ArrayBuffer> | null, n: number): Uint8ClampedArray<ArrayBuffer> {
  return current && current.length === n * 4 ? current : new Uint8ClampedArray(n * 4);
}

// --- Stage: data (Class 3, network) -----------------------------------------------------

store.on('data', async (s) => {
  if (!s.aoiCenter) return;

  const aoi = makeAoi(s.aoiCenter, s.aoiSideM);
  ctx.aoi = aoi;
  ctx.corners = aoiCorners(aoi.bbox, aoi.zone);

  const epsg = aoi.zone.epsg;
  if (!terrainProvider.covers(aoi.bbox, epsg)) {
    controls.setStatus(
      'Outside the USGS 3DEP coverage area. This build is US-only; the provider interface is where a global source would plug in.',
      'error',
    );
    ctx.terrain = null;
    return;
  }

  controls.setStatus(`Fetching terrain and land cover (${aoi.resM.toFixed(0)} m)…`, 'busy');
  const t0 = performance.now();

  const terrain = await terrainProvider.fetch(aoi.bbox, aoi.size, epsg);
  // Land cover is unused by FSPL, so a failure here must not block Pass 1's coverage map.
  const clutter = clutterProvider.covers(aoi.bbox, epsg)
    ? await clutterProvider.fetch(aoi.bbox, aoi.size, epsg).catch(() => null)
    : null;

  ctx.terrain = terrain;
  ctx.clutter = clutter;
  ctx.demRgba = null;

  await engine.setTerrain(terrain, demSpec(aoi));
  controls.setStatus(
    `Loaded ${aoi.size.width}x${aoi.size.height} at ${aoi.resM.toFixed(0)} m in ${Math.round(performance.now() - t0)} ms.` +
      (clutter ? '' : ' Land cover unavailable here.'),
  );
});

// --- Stage: propagation (Class 2, radial walk) ------------------------------------------

store.on('propagation', async (s) => {
  const aoi = ctx.aoi;
  if (!aoi || !ctx.terrain) return;

  const coverage = makeCoverageGrid(aoi, s.binM);
  ctx.coverage = coverage;
  const rp = radialParams(aoi, coverage.binM);

  ctx.grids.clear();
  const t0 = performance.now();

  for (const site of s.sites) {
    if (!site.enabled) continue;
    const p = toUtm({ lon: site.lon, lat: site.lat }, aoi.zone);
    const out = await engine.compute(
      site.id,
      {
        txE: p.e,
        txN: p.n,
        txHeightAglM: site.txHeightM,
        rxHeightAglM: s.rxHeightM,
        freqMHz: site.freqMHz,
        nRadials: rp.nRadials,
        nSteps: rp.nSteps,
        stepM: rp.stepM,
        kFactor: DEFAULT_K_FACTOR,
      },
      {
        width: coverage.size.width,
        height: coverage.size.height,
        minE: coverage.bbox.minE,
        maxN: coverage.bbox.maxN,
        binM: coverage.binM,
      },
    );
    ctx.grids.set(site.id, out);
  }

  const ms = Math.round(performance.now() - t0);
  controls.setStatus(
    `${coverage.size.width}x${coverage.size.height} bins at ${coverage.binM.toFixed(0)} m · ` +
      `${rp.nRadials} radials x ${rp.nSteps} steps · ${ms} ms`,
  );
});

// --- Stage: link budget (Class 1, recombine) --------------------------------------------

store.on('linkBudget', (s) => {
  const site = selectedSite(s);
  const grid = site ? ctx.grids.get(site.id) : undefined;
  if (!site || !grid) {
    ctx.kpiValues = null;
    return;
  }

  const n = grid.pathLoss.length;
  if (s.kpi === 'pathLoss') {
    ctx.kpiValues = grid.pathLoss;
    return;
  }

  // Pass 1 link budget: isotropic, no antenna pattern, no RX gain, no feeder loss.
  // Antenna gain enters here (not in propagation) because grid.elevAngle is already
  // cached -- which is what will make downtilt an instant control in Pass 4.
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = site.eirpDbm - (grid.pathLoss[i] as number);
  ctx.kpiValues = out;
});

// --- Stage: render (Class 0, recolour) --------------------------------------------------

store.on('render', (s) => {
  const aoi = ctx.aoi;
  const corners = ctx.corners;
  if (!aoi || !corners) return;

  // Coverage
  const coverage = ctx.coverage;
  if (s.showCoverage && ctx.kpiValues && coverage) {
    const n = coverage.size.width * coverage.size.height;
    ctx.rgba = ensureBuffer(ctx.rgba, n);
    const isLoss = s.kpi === 'pathLoss';
    rasterize(ctx.kpiValues, ctx.rgba, {
      // Path loss reads "more is worse", so invert the domain to keep dark = better signal.
      min: isLoss ? -s.maxDbm : s.minDbm,
      max: isLoss ? -s.minDbm : s.maxDbm,
      ramp: s.ramp,
      opacity: s.opacity,
      ...(isLoss ? {} : { threshold: s.threshold }),
    });
    coverageLayer ??= new RasterOverlay(map, 'coverage', { resampling: 'linear' });
    coverageLayer.update(ctx.rgba, coverage.size.width, coverage.size.height, corners);
    coverageLayer.setVisible(true);
  } else {
    coverageLayer?.setVisible(false);
  }

  // Hillshade -- proves the DEM decoded and is georeferenced correctly.
  if (s.showHillshade && ctx.terrain) {
    const n = aoi.size.width * aoi.size.height;
    ctx.demRgba = ensureBuffer(ctx.demRgba, n);
    hillshadeToRgba(ctx.terrain, demSpec(aoi), ctx.demRgba, { opacity: 0.55 });
    hillshadeLayer ??= new RasterOverlay(map, 'hillshade', { resampling: 'linear' });
    hillshadeLayer.update(ctx.demRgba, aoi.size.width, aoi.size.height, corners);
    hillshadeLayer.setVisible(true);
  } else {
    hillshadeLayer?.setVisible(false);
  }

  // Land cover -- nearest-neighbour: class codes must never be blended.
  if (s.showClutter && ctx.clutter) {
    const n = aoi.size.width * aoi.size.height;
    const buf = new Uint8ClampedArray(n * 4);
    clutterToRgba(ctx.clutter, CLUTTER_COLORS, buf, 0.7);
    clutterLayer ??= new RasterOverlay(map, 'clutter', { resampling: 'nearest' });
    clutterLayer.update(buf, aoi.size.width, aoi.size.height, corners);
    clutterLayer.setVisible(true);
  } else {
    clutterLayer?.setVisible(false);
  }

  renderLegend(legendEl, s);
  controls.syncSite(selectedSite(s));
});

// --- Interaction ------------------------------------------------------------------------

function placeOrMoveSite(lon: number, lat: number): void {
  const s = store.get();
  const existing = selectedSite(s);

  if (!existing) {
    const site: Site = {
      id: `site-${Date.now().toString(36)}`,
      name: 'Site A',
      lon,
      lat,
      enabled: true,
      freqMHz: 3700,
      eirpDbm: 55,
      txHeightM: 30,
    };
    addMarker(site);
    store.set({ sites: [...s.sites, site], selectedSiteId: site.id, aoiCenter: { lon, lat } });
    return;
  }

  const moved: Site = { ...existing, lon, lat };
  const sites = s.sites.map((x) => (x.id === moved.id ? moved : x));
  markers.get(moved.id)?.setLngLat([lon, lat]);

  // Only refetch when the site actually leaves the loaded area -- otherwise moving a
  // transmitter is a Class 2 recompute and stays interactive during the drag.
  const aoi = ctx.aoi;
  if (aoi) {
    const p = toUtm({ lon, lat }, aoi.zone);
    const half = s.aoiSideM / 2;
    const needed = { minE: p.e - half, minN: p.n - half, maxE: p.e + half, maxN: p.n + half };
    if (bboxCovers(aoi.bbox, needed)) {
      store.set({ sites }, 'propagation');
      return;
    }
  }
  store.set({ sites, aoiCenter: { lon, lat } });
}

function addMarker(site: Site): void {
  const marker = new maplibregl.Marker({ color: '#2a78d6', draggable: true })
    .setLngLat([site.lon, site.lat])
    .addTo(map);
  marker.on('dragend', () => {
    const { lng, lat } = marker.getLngLat();
    placeOrMoveSite(lng, lat);
  });
  markers.set(site.id, marker);
}

map.on('click', (ev) => placeOrMoveSite(ev.lngLat.lng, ev.lngLat.lat));

map.on('load', () => {
  renderLegend(legendEl, store.get());
  controls.setStatus('Click the map to place a transmitter.');
});
