import maplibregl, { Map as MlMap, Marker } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';

import {
  aoiKey,
  makeAoi,
  makeCoverageGrid,
  radialParams,
  siteNeedsNewAoi,
  type Aoi,
  type CoverageGrid,
} from './geo/aoi.js';
import { toUtm } from './geo/utm.js';
import { EngineClient } from './engine/client.js';
import { estimateCost, formatCost } from './engine/cost.js';
import { computeProfile } from './engine/profile.js';
import { sampleNearest } from './engine/sampler.js';
import { DEFAULT_K_FACTOR, type SiteGrid, type TerrainGridSpec } from './engine/types.js';
import { NlcdProvider } from './providers/clutter/nlcd.js';
import { Usgs3depProvider } from './providers/terrain/usgs3dep.js';
import { CLUTTER_COLORS } from './providers/types.js';
import { rasterize } from './render/colormap.js';
import { clutterToRgba, hillshadeToRgba } from './render/hillshade.js';
import { aoiCorners, RasterOverlay, type Corners } from './render/rasterLayer.js';
import { createStore } from './store/store.js';
import { DEFAULT_STATE, LOSS_SCALE_MAX_DB, STAGE_FOR, type AppState, type Site } from './store/types.js';
import { buildControls } from './ui/controls.js';
import { renderLegend } from './ui/legend.js';
import { createProfileChart } from './ui/profile.js';

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
  /** Per-site hash of every propagation input, so unchanged sites are not recomputed. */
  signatures: Map<string, string>;
  /** Clutter class per coverage bin, resampled from the AOI raster once per grid change. */
  binClutter: Uint8Array | null;
  kpiValues: Float32Array | null;
  rgba: Uint8ClampedArray<ArrayBuffer> | null;
  demRgba: Uint8ClampedArray<ArrayBuffer> | null;
  /** Identity of the AOI currently loaded, so a redundant trigger cannot refetch. */
  loadedKey: string | null;
}

const ctx: Ctx = {
  aoi: null,
  terrain: null,
  clutter: null,
  corners: null,
  coverage: null,
  grids: new Map(),
  signatures: new Map(),
  binClutter: null,
  kpiValues: null,
  rgba: null,
  demRgba: null,
  loadedKey: null,
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

/** Clutter classes from the AOI raster onto the (usually coarser) coverage grid. */
function resampleClutterToBins(
  clutter: Uint8Array,
  spec: TerrainGridSpec,
  coverage: CoverageGrid,
): Uint8Array {
  const { width, height } = coverage.size;
  const out = new Uint8Array(width * height);
  for (let j = 0; j < height; j++) {
    const n = coverage.bbox.maxN - (j + 0.5) * coverage.binM;
    for (let i = 0; i < width; i++) {
      const e = coverage.bbox.minE + (i + 0.5) * coverage.binM;
      out[j * width + i] = sampleNearest(clutter, spec, e, n);
    }
  }
  return out;
}

// --- Stage: data (Class 3, network) -----------------------------------------------------

store.on('data', async (s) => {
  if (!s.aoiCenter) return;

  const aoi = makeAoi(s.aoiCenter, s.aoiSideM);

  // Nothing about the area actually changed, so there is nothing to fetch. The stage table
  // should already prevent this, but network access is the one thing worth guarding twice:
  // a future caller that sets aoiCenter redundantly must not be able to cause a download.
  const key = aoiKey(aoi);
  if (key === ctx.loadedKey && ctx.terrain) return;

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
  ctx.loadedKey = key;

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

  const enabled = s.sites.filter((x) => x.enabled).length;
  const cost = estimateCost({
    sideM: aoi.sideM,
    demResM: aoi.resM,
    binM: s.binM,
    siteCount: Math.max(1, enabled),
  });

  // Refuse before allocating, not after. At 100 km with 10 m bins the radial fan alone is
  // ~209 M samples; the tab dies during allocation, so there is no opportunity to warn
  // partway through. Previous grids are left intact so the map keeps showing something
  // real, and the status line says plainly that the new settings were not applied.
  if (cost.level === 'block') {
    const fix = cost.suggestedBinM
      ? `Raise bin size to ${cost.suggestedBinM} m or shrink the area.`
      : 'Shrink the area.';
    // Only claim a previous result exists when one actually does -- on a first placement
    // there is nothing behind the refusal and saying otherwise would be a lie.
    const showing = ctx.grids.size > 0 ? ' Showing the previous result.' : '';
    controls.setStatus(`Not computed — ${cost.reason}. ${fix}${showing}`, 'error');
    controls.setCost(formatCost(cost, Math.round(aoi.sideM / s.binM)), 'block');
    return;
  }
  controls.setCost(formatCost(cost, Math.round(aoi.sideM / s.binM)), cost.level);

  const coverage = makeCoverageGrid(aoi, s.binM);
  ctx.coverage = coverage;
  const rp = radialParams(aoi, coverage.binM);

  // Clutter classes onto the coverage grid, nearest-neighbour because class codes must never
  // be blended. Done once per grid change so the link-budget stage is a pure table lookup.
  ctx.binClutter = ctx.clutter
    ? resampleClutterToBins(ctx.clutter, demSpec(aoi), coverage)
    : null;

  // Forget sites that no longer exist, but keep the rest -- recomputing every site whenever
  // any one of them changes is exactly the waste this stage exists to avoid. With eight
  // sites, nudging one frequency would otherwise pay for eight radial walks.
  const liveIds = new Set(s.sites.filter((x) => x.enabled).map((x) => x.id));
  for (const id of [...ctx.grids.keys()]) {
    if (!liveIds.has(id)) {
      ctx.grids.delete(id);
      ctx.signatures.delete(id);
    }
  }

  const t0 = performance.now();
  let computed = 0;
  let reused = 0;

  for (const site of s.sites) {
    if (!site.enabled) continue;

    // Everything the radial walk depends on. If none of it moved, the cached grid is still
    // exactly correct -- note EIRP is absent, because it belongs to the link budget.
    const signature = [
      aoiKey(aoi),
      coverage.binM,
      s.rxHeightM,
      site.lon,
      site.lat,
      site.txHeightM,
      site.freqMHz,
      s.model,
    ].join('|');

    if (ctx.signatures.get(site.id) === signature && ctx.grids.has(site.id)) {
      reused++;
      continue;
    }

    const p = toUtm({ lon: site.lon, lat: site.lat }, aoi.zone);
    const out = await engine.compute(
      site.id,
      {
        txE: p.e,
        txN: p.n,
        txHeightAglM: site.txHeightM,
        rxHeightAglM: s.rxHeightM,
        freqMHz: site.freqMHz,
        model: s.model,
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
    // null means a newer request for this site superseded ours, or the worker errored.
    // Leave the signature unset either way, so the next pass retries rather than caching
    // a result that was never stored.
    if (out) {
      ctx.grids.set(site.id, out);
      ctx.signatures.set(site.id, signature);
      computed++;
    }
  }

  const ms = Math.round(performance.now() - t0);
  controls.setStatus(
    `${coverage.size.width}x${coverage.size.height} bins at ${coverage.binM.toFixed(0)} m · ` +
      `${rp.nRadials} radials x ${rp.nSteps} steps · ` +
      `${computed} computed${reused ? `, ${reused} reused` : ''} · ${ms} ms`,
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
  const binClutter = ctx.binClutter;

  // Clutter loss per receive bin. Applying it here rather than in the radial walk is what
  // makes the whole loss table a Class 1 control: editing a value recombines cached path
  // loss and never re-walks a radial.
  const clutterAt = (i: number): number => {
    if (!s.applyClutter || !binClutter) return 0;
    return s.clutterLossDb[binClutter[i] as number] ?? 0;
  };

  const out = new Float32Array(n);

  if (s.kpi === 'diffraction') {
    ctx.kpiValues = grid.diffraction;
    return;
  }

  if (s.kpi === 'clutter') {
    for (let i = 0; i < n; i++) {
      out[i] = Number.isFinite(grid.pathLoss[i] as number) ? clutterAt(i) : NaN;
    }
    ctx.kpiValues = out;
    return;
  }

  if (s.kpi === 'pathLoss') {
    for (let i = 0; i < n; i++) out[i] = (grid.pathLoss[i] as number) + clutterAt(i);
    ctx.kpiValues = out;
    return;
  }

  // Received level. Isotropic for now: no antenna pattern, RX gain or feeder loss.
  // Antenna gain will enter here rather than in propagation, because grid.elevAngle is
  // already cached -- which is what will make downtilt an instant control in Pass 4.
  for (let i = 0; i < n; i++) {
    out[i] = site.eirpDbm - (grid.pathLoss[i] as number) - clutterAt(i);
  }
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
    // Three different scales: received level uses the dBm range directly; total path loss
    // reuses it inverted so dark still means "better"; the diagnostic loss layers get their
    // own fixed 0..40 dB scale, where dark means "more loss here".
    const isLossLayer = s.kpi === 'diffraction' || s.kpi === 'clutter';
    const isPathLoss = s.kpi === 'pathLoss';
    rasterize(ctx.kpiValues, ctx.rgba, {
      min: isLossLayer ? 0 : isPathLoss ? -s.maxDbm : s.minDbm,
      max: isLossLayer ? LOSS_SCALE_MAX_DB : isPathLoss ? -s.minDbm : s.maxDbm,
      ramp: s.ramp,
      opacity: s.opacity,
      ...(isLossLayer || isPathLoss ? {} : { threshold: s.threshold }),
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
  // Keep the profile consistent with whatever the map is now showing.
  scheduleProfile();
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

  // The AOI is a study area, not a follow-cam. Terrain is loaded for the whole box, so a
  // site moving anywhere inside it is a Class 2 recompute with no network access at all --
  // only a site pushed out to the edge earns a reload.
  const aoi = ctx.aoi;
  if (aoi) {
    const p = toUtm({ lon, lat }, aoi.zone);
    if (!siteNeedsNewAoi(aoi, p.e, p.n)) {
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

// --- Hover path profile ------------------------------------------------------------------

const profileEl = document.getElementById('profile') as HTMLElement;
const profileChart = createProfileChart(
  document.getElementById('profile-canvas') as HTMLCanvasElement,
  document.getElementById('profile-readout') as HTMLElement,
);

let hoverLonLat: { lon: number; lat: number } | null = null;
let profileQueued = false;

/**
 * Recompute and redraw the cursor profile.
 *
 * Throttled to one animation frame: mousemove fires far faster than the screen updates, and
 * a profile is ~1400 samples plus a canvas repaint. Doing it per event would burn frames
 * for output nobody sees.
 */
function scheduleProfile(): void {
  if (profileQueued) return;
  profileQueued = true;
  requestAnimationFrame(() => {
    profileQueued = false;
    drawProfile();
  });
}

function drawProfile(): void {
  const s = store.get();
  const site = selectedSite(s);
  const aoi = ctx.aoi;
  if (!site || !aoi || !ctx.terrain || !hoverLonLat) {
    profileEl.hidden = true;
    return;
  }

  const tx = toUtm({ lon: site.lon, lat: site.lat }, aoi.zone);
  const rx = toUtm(hoverLonLat, aoi.zone);

  const profile = computeProfile(ctx.terrain, demSpec(aoi), ctx.clutter, {
    txE: tx.e,
    txN: tx.n,
    txHeightAglM: site.txHeightM,
    rxE: rx.e,
    rxN: rx.n,
    rxHeightAglM: s.rxHeightM,
    freqMHz: site.freqMHz,
    kFactor: DEFAULT_K_FACTOR,
  });

  // The panel must agree with the map, so it honours the same model and clutter switches.
  if (s.model === 'fspl') profile.diffractionDb = 0;
  const rxClass = profile.clutter ? (profile.clutter[profile.clutter.length - 1] as number) : 0;
  const clutterLossDb = s.applyClutter ? (s.clutterLossDb[rxClass] ?? 0) : 0;

  profileEl.hidden = false;
  profileChart.draw(profile, {
    freqMHz: site.freqMHz,
    eirpDbm: site.eirpDbm,
    clutterLossDb,
  });
}

map.on('mousemove', (ev) => {
  hoverLonLat = { lon: ev.lngLat.lng, lat: ev.lngLat.lat };
  scheduleProfile();
});

// Keep the last profile on screen when the cursor leaves, rather than flashing it away.
window.addEventListener('resize', scheduleProfile);

map.on('load', () => {
  renderLegend(legendEl, store.get());
  controls.setStatus('Click the map to place a transmitter.');
});
