# RF Coverage Explorer

**Live: <https://rf-coverage-explorer.vercel.app>**

An interactive browser tool for visualising RF coverage and KPI maps over real terrain and
land cover. Everything runs client-side: no backend, no API keys, no running costs.

The goal is **interaction speed, not prediction accuracy**. There are plenty of tools that
model propagation rigorously and slowly; the point of this one is to drag a transmitter,
retune a frequency, and watch the map change immediately.

> **Status: Pass 1.** The full data pipeline is live end-to-end — fetch, decode, project,
> radial engine, render — with free-space path loss as the model. Diffraction, clutter loss,
> multi-site aggregation and antenna patterns are scaffolded but not implemented. See
> [Roadmap](#roadmap).

## Quick start

```bash
npm install
npm run dev     # then click anywhere in the US to place a transmitter
```

```bash
npm run typecheck
npm run test
npm run build
```

## How it works

### Everything is in metres, in UTM

The engine works in a local UTM zone, never in lon/lat or Web Mercator. At 47°N an
EPSG:4326 grid has pixels 1.47× taller than wide, and Web Mercator's scale factor is
1/cos(lat) — either would silently corrupt every distance in every path profile.

Both data endpoints reproject **server-side**, so terrain and land cover arrive already
pixel-aligned on a true square-metre grid.

### Radial walk, not per-bin profiles

Coverage is computed by casting radials from the transmitter and resampling onto the output
grid. Over a 30 km area at 100 m bins:

| Approach | Terrain samples |
|---|---|
| Independent profile per output bin | ~34.7 M |
| Radials + resample | **~1.0 M** |

The usual objection to radials — star-shaped aliasing near the transmitter — is handled by
choosing the radial count so the arc gap at maximum range is still smaller than one output
bin. Resampling runs grid←radial (each destination bin pulls from the radial array), which
makes unfilled bins structurally impossible.

### The pipeline is staged by cost

```
data (0.5–3 s)  →  propagation (25–110 ms)  →  linkBudget (5–20 ms)  →  render (~0 ms)
```

Every piece of state declares the earliest stage its change invalidates, and the pipeline
runs from there to the end. Changing the colour ramp re-enters at `render`; EIRP at
`linkBudget`; frequency at `propagation`; the area at `data`. A cheap change never pays for
an expensive one, which is what lets nearly every control be a slider you drag rather than a
field you submit.

This is also why there is no UI framework here. The hot path is typed arrays and canvas, not
DOM, MapLibre is imperative regardless — and React has no way to express that `opacity` is
free while `freqMHz` costs 80 ms.

### What gets reused rather than recomputed

Staging decides *where* work restarts; three caches decide how much of it is real work:

| Cache | Key | Effect |
|---|---|---|
| IndexedDB raster cache | provider + bbox + size + EPSG | A revisited area never re-downloads |
| Loaded-AOI guard | `aoiKey(aoi)` | A redundant `data` trigger cannot cause a fetch |
| Per-site signature | AOI + bin + RX height + site position, height, frequency | Only sites whose propagation inputs actually changed are re-walked |

The AOI is a **study area, not a follow-cam**: terrain is fetched for the whole box, so a
site moving anywhere inside it costs no network access at all. Only a site pushed out past
the edge margin reloads the area. EIRP is deliberately absent from the site signature —
it belongs to the link budget, so changing it never re-walks a radial.

### The cost guard

The expensive configuration is not reachable from either slider alone — 10 m bins over 2 km
is instant, 200 m bins over 100 km is instant, but 10 m bins over 100 km is 100 M bins and
209 M radial samples, about 3.1 GB. So the guard looks at the product, and it **refuses
before allocating** rather than warning: at that size the tab dies during allocation and a
warning would never paint.

| AOI | bin | | estimate |
|---|---|---|---|
| 30 km | 100 m | ok | 1.9 M samples, ~48 ms, 16 MB |
| 30 km | 50 m | ok | 3.8 M samples, ~115 ms, 34 MB |
| 100 km | 200 m | ok | 10.5 M samples, ~237 ms, 84 MB |
| 100 km | 50 m | warn | 41.9 M samples, ~1.3 s, 381 MB |
| 100 km | 10 m | **block** | 209 M samples, ~15.2 s, 3.1 GB → suggests 40 m |

A blocked pass keeps the previous grids so the map still shows something real, and the
status line names the offending numbers and a bin size that would clear it. The panel also
carries a live readout, because nobody should be expected to multiply two sliders in their
head. A separate warning fires when bins are finer than the DEM — that is not a cost
problem, but it means the extra bins are buying smoothing rather than detail.

## Deployment

Static hosting on Vercel (`vercel.json`); the build is a plain `dist/` folder, so any static
host works. Nothing runs server-side — there are no serverless functions and no API routes.

Bandwidth is not a consideration: terrain, land cover and basemap tiles are all fetched by
the browser straight from USGS, MRLC and OpenFreeMap, so the host only ever ships the ~320 kB
app bundle. That is roughly 300,000 fresh page loads inside a 100 GB free tier.

Two header decisions worth recording:

- Assets are content-hashed by Vite, so `/assets/*` is served `immutable` for a year. Vercel's
  default of `max-age=0, must-revalidate` would make every repeat visit re-validate a bundle
  that cannot change. `index.html` stays uncached so new deploys are picked up at once.
- **COOP/COEP are deliberately absent.** They would enable `SharedArrayBuffer`, but terrain is
  uploaded to the worker once per AOI rather than per recompute, so sharing instead of copying
  saves roughly 30 ms per area change — and `require-corp` risks blocking the cross-origin
  basemap and data endpoints. Revisit only if Pass 3 profiling says otherwise.

### Bare earth vs surface elevation is enforced, not documented

`TerrainProvider` declares `kind: 'DTM' | 'DSM'`. A DSM already contains vegetation and
buildings, so adding representative clutter heights on top of one double-counts the clutter
(the classic Copernicus GLO-30 trap). The engine refuses the combination rather than relying
on a comment nobody reads.

Similarly, `ClutterProvider` emits **normalised** categories, never native codes. That is the
seam that lets a non-US source drop in later without the engine knowing anything changed.

## Data sources

All endpoints were verified to serve `access-control-allow-origin: *`, which is what makes a
backend unnecessary.

| Layer | Source | Notes |
|---|---|---|
| Elevation | [USGS 3DEP](https://www.usgs.gov/3d-elevation-program) via ArcGIS `exportImage` | Bare-earth DTM, 10 m native. ~4.2 MB / 0.6 s for 1000×1000 |
| Land cover | [NLCD 2021](https://www.mrlc.gov/) via MRLC WMS | 30 m, 20 classes. ~194 KB / 1.6 s for 1000×1000 |
| Basemap | [OpenFreeMap](https://openfreemap.org/) Positron | Keyless |

Two findings worth recording, since both shaped the design:

- **NLCD's WCS is EPSG:3857-only and cannot reproject**, so WMS is used instead — it
  reprojects server-side and lands the clutter grid aligned with the DEM.
- **The served PNG palette drifts a few units** from the canonical NLCD legend (Open Water
  arrives as `rgb(71,107,160)` against the documented `rgb(70,107,159)`). Classification is
  therefore nearest-colour, not exact match; an exact lookup returns nodata for every real
  pixel. There is a regression test pinning the observed values.

ESA WorldCover was evaluated for global support and rejected for now: its S3 bucket serves
no CORS headers (`OPTIONS` → 403), so it would require a proxy.

## Colour

The coverage ramp is a single-hue sequential blue, light→dark. Signal strength is a
magnitude, and a rainbow ramp is not monotone in lightness — it invents visual boundaries
where the data is smooth, which on a coverage map reads as contours that do not exist. Turbo
is offered as a non-default option purely so output can be eyeballed against commercial
tools that use it.

The land-cover overlay reproduces the published NLCD legend, which does **not** clear the
usual accessibility gates: forest against medium-intensity developed measures ΔE 3.0 under
simulated protanopia, and wetland against open measures 8.2 even with normal colour vision.
Recognisability is the point of that layer, so the colours stay — but the legend is always
swatch **plus text label**, so identity never rests on colour alone.

## Verification

Beyond `npm run test`, the vertical slice is checked visually:

- Toggle **Hillshade** — the shaded coastline must line up with the basemap coastline. This
  is the real test of the UTM request, the server-side reprojection, the TIFF decode and the
  corner placement, none of which FSPL itself would exercise.
- Toggle **Land cover** — water should cover Puget Sound. A 30 km box on Seattle reads
  roughly 40% water / 51% developed / 7% forest.
- The FSPL coverage map must be **perfectly radially symmetric**. It ignores terrain, so any
  asymmetry is a bug in the radial walk or the resample.
- Reload — terrain and land cover come from IndexedDB with no refetch.

## Roadmap

- **Pass 2** — single knife-edge diffraction (ITU-R P.526) off the radial horizon, per-bin
  clutter loss from an editable dB table, and a hover terrain-profile panel showing the ray,
  the Fresnel ellipse, the controlling knife edge and the clutter class.
- **Pass 3** — multi-site: site list, per-site frequency, best-server / SINR / overlap-count
  aggregation, SharedArrayBuffer and a worker pool.
- **Pass 4** — ITU-R F.1336 antenna patterns (applied in the link-budget stage, so downtilt
  stays instant), full budget through SNR to throughput KPI maps, A/B compare.

## Licence

MIT — see [LICENSE](LICENSE).

Elevation data courtesy of the U.S. Geological Survey (public domain). Land cover from the
National Land Cover Database, USGS/MRLC. Basemap © OpenFreeMap, © OpenStreetMap contributors.
