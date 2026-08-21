import { RAMP_LABELS, type RampName } from '../render/colormap.js';
import type { Stage, Store } from '../store/store.js';
import type { AppState, KpiName, Site } from '../store/types.js';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

interface SliderSpec {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format: (v: number) => string;
  onInput: (v: number) => void;
}

/**
 * Sliders, not number fields.
 *
 * Every control here re-enters the pipeline at a stage cheap enough to survive being
 * dragged continuously -- that is the point of the stage table in `store/types.ts`. A
 * control that needed a submit button would be a sign something is mis-classified.
 */
function slider(spec: SliderSpec): { root: HTMLElement; sync: (v: number) => void } {
  const root = el('div', 'ctrl');
  const label = el('label');
  const name = el('span', undefined, spec.label);
  const val = el('span', 'val', spec.format(spec.value));
  label.append(name, val);

  const input = el('input');
  input.type = 'range';
  input.min = String(spec.min);
  input.max = String(spec.max);
  input.step = String(spec.step);
  input.value = String(spec.value);
  input.addEventListener('input', () => {
    const v = Number(input.value);
    val.textContent = spec.format(v);
    spec.onInput(v);
  });

  root.append(label, input);
  return {
    root,
    sync: (v: number) => {
      input.value = String(v);
      val.textContent = spec.format(v);
    },
  };
}

function group(title: string, cost: string): HTMLElement {
  const g = el('div', 'group');
  const h = el('h2');
  h.append(el('span', undefined, title), el('span', 'cost', cost));
  g.append(h);
  return g;
}

function toggle(label: string, checked: boolean, onChange: (v: boolean) => void): HTMLElement {
  const wrap = el('label', 'toggle');
  const input = el('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  wrap.append(input, el('span', undefined, label));
  return wrap;
}

function select<T extends string>(
  options: { value: T; label: string }[],
  value: T,
  onChange: (v: T) => void,
): HTMLElement {
  const sel = el('select');
  for (const o of options) {
    const opt = el('option', undefined, o.label);
    opt.value = o.value;
    sel.append(opt);
  }
  sel.value = value;
  sel.addEventListener('change', () => onChange(sel.value as T));
  return sel;
}

export interface ControlsHandle {
  syncSite(site: Site | null): void;
  setStatus(text: string, kind?: 'info' | 'busy' | 'error'): void;
}

export function buildControls(root: HTMLElement, store: Store<AppState>): ControlsHandle {
  const s = store.get();
  root.replaceChildren();

  root.append(el('h1', undefined, 'RF Coverage Explorer'));
  root.append(
    el(
      'p',
      'sub',
      'Click the map to place a transmitter. Terrain and land cover are fetched once per area; everything else recomputes locally.',
    ),
  );

  // --- Transmitter (Class 2: re-runs the radial walk) ---
  const txGroup = group('Transmitter', 'recompute');
  const freq = slider({
    label: 'Frequency',
    min: 100,
    max: 6000,
    step: 10,
    value: 3700,
    format: (v) => `${v} MHz`,
    onInput: (v) => updateSelected({ freqMHz: v }, 'propagation'),
  });
  const txh = slider({
    label: 'TX height',
    min: 3,
    max: 150,
    step: 1,
    value: 30,
    format: (v) => `${v} m`,
    onInput: (v) => updateSelected({ txHeightM: v }, 'propagation'),
  });
  const eirp = slider({
    label: 'EIRP',
    min: 0,
    max: 80,
    step: 0.5,
    value: 55,
    format: (v) => `${v.toFixed(1)} dBm`,
    // Class 1: path loss is unchanged, only the level derived from it.
    onInput: (v) => updateSelected({ eirpDbm: v }, 'linkBudget'),
  });
  const rxh = slider({
    label: 'RX height',
    min: 1,
    max: 50,
    step: 0.5,
    value: s.rxHeightM,
    format: (v) => `${v.toFixed(1)} m`,
    onInput: (v) => store.set({ rxHeightM: v }),
  });
  txGroup.append(freq.root, txh.root, eirp.root, rxh.root);
  root.append(txGroup);

  // --- Area (Class 3: refetches) ---
  const areaGroup = group('Area', 'refetch');
  const side = slider({
    label: 'AOI size',
    min: 10000,
    max: 60000,
    step: 5000,
    value: s.aoiSideM,
    format: (v) => `${v / 1000} km`,
    onInput: (v) => store.set({ aoiSideM: v }),
  });
  const bin = slider({
    label: 'Bin size',
    min: 25,
    max: 200,
    step: 25,
    value: s.binM,
    format: (v) => `${v} m`,
    onInput: (v) => store.set({ binM: v }),
  });
  areaGroup.append(side.root, bin.root);
  root.append(areaGroup);

  // --- Display (Class 0: pure re-colour) ---
  const dispGroup = group('Display', 'instant');
  dispGroup.append(
    select<KpiName>(
      [
        { value: 'rsl', label: 'Received level (dBm)' },
        { value: 'pathLoss', label: 'Path loss (dB)' },
      ],
      s.kpi,
      (v) => store.set({ kpi: v }),
    ),
  );
  const rampSel = select<RampName>(
    (Object.keys(RAMP_LABELS) as RampName[]).map((v) => ({ value: v, label: RAMP_LABELS[v] })),
    s.ramp,
    (v) => store.set({ ramp: v }),
  );
  rampSel.style.marginTop = '8px';
  dispGroup.append(rampSel);

  const thr = slider({
    label: 'Threshold',
    min: -140,
    max: -40,
    step: 1,
    value: s.threshold,
    format: (v) => `${v} dBm`,
    onInput: (v) => store.set({ threshold: v }),
  });
  const opa = slider({
    label: 'Opacity',
    min: 0,
    max: 1,
    step: 0.05,
    value: s.opacity,
    format: (v) => `${Math.round(v * 100)}%`,
    onInput: (v) => store.set({ opacity: v }),
  });
  const lo = slider({
    label: 'Scale min',
    min: -150,
    max: -60,
    step: 1,
    value: s.minDbm,
    format: (v) => `${v}`,
    onInput: (v) => store.set({ minDbm: v }),
  });
  const hi = slider({
    label: 'Scale max',
    min: -110,
    max: 0,
    step: 1,
    value: s.maxDbm,
    format: (v) => `${v}`,
    onInput: (v) => store.set({ maxDbm: v }),
  });
  const spacer = el('div');
  spacer.style.height = '8px';
  dispGroup.append(spacer, thr.root, opa.root, lo.root, hi.root);

  dispGroup.append(
    toggle('Coverage', s.showCoverage, (v) => store.set({ showCoverage: v })),
    toggle('Hillshade (terrain check)', s.showHillshade, (v) => store.set({ showHillshade: v })),
    toggle('Land cover (clutter check)', s.showClutter, (v) => store.set({ showClutter: v })),
  );
  root.append(dispGroup);

  const status = el('div');
  status.id = 'status';
  status.textContent = s.status;
  root.append(status);

  const attrib = el('div', 'attrib');
  attrib.innerHTML =
    'Elevation: USGS 3DEP (public domain). Land cover: NLCD 2021 (USGS/MRLC).<br />' +
    'Basemap &copy; OpenFreeMap, &copy; OpenStreetMap contributors.';
  root.append(attrib);

  /**
   * `stage` is explicit here because `sites` is a single state key covering fields of very
   * different cost: frequency and mast height need the radial walk re-run, EIRP only needs
   * the received level recombined from cached path loss.
   */
  function updateSelected(patch: Partial<Site>, stage: Stage): void {
    const st = store.get();
    if (!st.selectedSiteId) return;
    store.set(
      {
        sites: st.sites.map((site) =>
          site.id === st.selectedSiteId ? { ...site, ...patch } : site,
        ),
      },
      stage,
    );
  }

  return {
    syncSite(site: Site | null): void {
      if (!site) return;
      freq.sync(site.freqMHz);
      txh.sync(site.txHeightM);
      eirp.sync(site.eirpDbm);
    },
    setStatus(text: string, kind: 'info' | 'busy' | 'error' = 'info'): void {
      status.textContent = text;
      status.className = kind === 'info' ? '' : kind;
    },
  };
}
