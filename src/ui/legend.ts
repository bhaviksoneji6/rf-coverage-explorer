import { sampleRamp } from '../render/colormap.js';
import { CLUTTER_COLORS, CLUTTER_NAMES } from '../providers/types.js';
import { siteColor } from '../store/sites.js';
import {
  LOSS_SCALE_MAX_DB,
  SINR_SCALE_MAX_DB,
  SINR_SCALE_MIN_DB,
  type AppState,
} from '../store/types.js';

const CLUTTER_ORDER = [1, 2, 3, 4, 5, 6, 7];

/**
 * Legend for the coverage ramp, plus the land-cover key when that layer is on.
 *
 * The land-cover key is always text-plus-swatch, never swatch alone. Those colours
 * reproduce the published NLCD legend so the layer is recognisable to anyone who has
 * seen NLCD before, but that palette does not clear the usual accessibility gates --
 * forest against medium-intensity developed measures ΔE 3.0 under simulated protanopia,
 * and wetland against open measures 8.2 even with full colour vision. The written label
 * is what actually carries identity here; the colour is a mnemonic.
 */
export function renderLegend(root: HTMLElement, s: AppState): void {
  root.replaceChildren();

  const KPI_TITLES: Record<string, string> = {
    rsl: 'Received level',
    bestRsl: 'Best received level',
    pathLoss: 'Total path loss',
    diffraction: 'Diffraction loss',
    clutter: 'Clutter loss',
    sinr: 'SINR',
    serving: 'Serving site',
    overlap: 'Overlapping sites',
  };

  if (s.showCoverage && s.kpi === 'serving') {
    const title = document.createElement('div');
    title.className = 'legend-title';
    title.textContent = 'Serving site';
    root.append(title);

    // Names, not just swatches. A serving-site map is categorical and any two colours can
    // end up adjacent; past three sites the palette cannot carry identity by itself.
    s.sites.forEach((site, i) => {
      if (!site.enabled) return;
      const row = document.createElement('div');
      row.className = 'legend-row';
      const sw = document.createElement('span');
      sw.className = 'legend-swatch';
      sw.style.background = siteColor(i);
      const label = document.createElement('span');
      label.textContent = `${site.name} · ${site.freqMHz} MHz`;
      row.append(sw, label);
      root.append(row);
    });

    const note = document.createElement('div');
    note.style.marginTop = '5px';
    note.textContent = `Served above ${s.threshold} dBm`;
    root.append(note);
  } else if (s.showCoverage) {
    const title = document.createElement('div');
    title.className = 'legend-title';
    title.textContent = KPI_TITLES[s.kpi] ?? 'Coverage';
    root.append(title);

    const stops: string[] = [];
    for (let i = 0; i <= 10; i++) {
      const [r, g, b] = sampleRamp(s.ramp, i / 10);
      stops.push(`rgb(${r},${g},${b}) ${i * 10}%`);
    }
    const bar = document.createElement('div');
    bar.className = 'legend-bar';
    bar.style.background = `linear-gradient(to right, ${stops.join(',')})`;
    root.append(bar);

    const ticks = document.createElement('div');
    ticks.className = 'legend-ticks';
    const unit = s.kpi === 'rsl' || s.kpi === 'bestRsl' ? 'dBm' : s.kpi === 'overlap' ? 'sites' : 'dB';
    // Loss layers are drawn on their own fixed scale, not the dBm range, so the legend has
    // to say so rather than showing received-level numbers against a loss ramp.
    const isLossLayer = s.kpi === 'diffraction' || s.kpi === 'clutter';
    const enabledCount = Math.max(1, s.sites.filter((x) => x.enabled).length);
    let lo = s.minDbm;
    let hi = s.maxDbm;
    if (isLossLayer) {
      lo = 0;
      hi = LOSS_SCALE_MAX_DB;
    } else if (s.kpi === 'sinr') {
      lo = SINR_SCALE_MIN_DB;
      hi = SINR_SCALE_MAX_DB;
    } else if (s.kpi === 'overlap') {
      lo = 1;
      hi = enabledCount;
    }
    const mid = Math.round((lo + hi) / 2);
    for (const [i, v] of [lo, mid, hi].entries()) {
      const t = document.createElement('span');
      t.textContent = i === 2 ? `${v} ${unit}` : String(v);
      ticks.append(t);
    }
    root.append(ticks);

    if ((s.kpi === 'rsl' || s.kpi === 'bestRsl') && s.threshold > s.minDbm) {
      const note = document.createElement('div');
      note.style.marginTop = '5px';
      note.textContent = `Hidden below ${s.threshold} dBm`;
      root.append(note);
    }
  }

  if (s.showClutter) {
    const title = document.createElement('div');
    title.className = 'legend-title';
    title.style.marginTop = s.showCoverage ? '10px' : '0';
    title.textContent = 'Land cover';
    root.append(title);

    for (const cls of CLUTTER_ORDER) {
      const rgb = CLUTTER_COLORS[cls];
      if (!rgb) continue;
      const row = document.createElement('div');
      row.className = 'legend-row';
      const sw = document.createElement('span');
      sw.className = 'legend-swatch';
      sw.style.background = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
      const label = document.createElement('span');
      label.textContent = CLUTTER_NAMES[cls] ?? String(cls);
      row.append(sw, label);
      root.append(row);
    }
  }
}
