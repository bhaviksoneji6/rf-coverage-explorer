import { RAMP_LABELS, type RampName } from '../render/colormap.js';
import type { Stage, Store } from '../store/store.js';
import type { AppState, KpiName, Site } from '../store/types.js';
import { parseFieldValue } from './parseValue.js';

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
  /** Bounds and step are in model units, not display units. */
  min: number;
  max: number;
  step: number;
  value: number;
  unit: string;
  decimals?: number;
  /** Model -> display, e.g. metres shown as km, or 0..1 opacity shown as a percentage. */
  toDisplay?: (v: number) => number;
  fromDisplay?: (v: number) => number;
  /**
   * 'input' fires continuously while dragging; 'release' waits for the drag to end.
   *
   * Class 0-2 controls are cheap enough to drag live, which is the whole point of the stage
   * table. Class 3 is not: dragging the AOI size would queue a 1.6 s refetch per frame, so
   * it commits on release and the readout tracks the thumb in the meantime.
   */
  commitOn?: 'input' | 'release';
  onInput: (v: number) => void;
}

/**
 * A slider paired with a directly editable readout.
 *
 * The slider is for exploring; the number field is for landing on a specific value. A step
 * coarse enough to drag comfortably (10 MHz) cannot reach 2412 MHz, so typed entry is
 * deliberately NOT snapped to the step grid -- it only has to respect the bounds.
 *
 * Typing commits on Enter or blur rather than per keystroke: the field is used for the
 * expensive Class 2 and Class 3 controls too, and firing a refetch on every digit of "3700"
 * would kick off four of them.
 */
function slider(spec: SliderSpec): { root: HTMLElement; sync: (v: number) => void } {
  const decimals = spec.decimals ?? 0;
  const toDisplay = spec.toDisplay ?? ((v: number) => v);
  const fromDisplay = spec.fromDisplay ?? ((v: number) => v);
  const show = (v: number) => toDisplay(v).toFixed(decimals);

  const root = el('div', 'ctrl');
  const label = el('label');
  label.append(el('span', undefined, spec.label));

  const valWrap = el('span', 'val');
  const num = el('input', 'numval');
  num.type = 'text';
  num.inputMode = 'decimal';
  num.value = show(spec.value);
  num.setAttribute('aria-label', `${spec.label} value in ${spec.unit || 'units'}`);
  valWrap.append(num);
  if (spec.unit) valWrap.append(el('span', 'unit', spec.unit));
  label.append(valWrap);

  const range = el('input');
  range.type = 'range';
  range.min = String(spec.min);
  range.max = String(spec.max);
  range.step = String(spec.step);
  range.value = String(spec.value);
  // The wrapping <label> associates with the number field, so the slider needs its own name.
  range.setAttribute('aria-label', spec.label);

  const live = (spec.commitOn ?? 'input') === 'input';
  range.addEventListener('input', () => {
    const v = Number(range.value);
    num.value = show(v);
    if (live) spec.onInput(v);
  });
  if (!live) {
    range.addEventListener('change', () => spec.onInput(Number(range.value)));
  }

  const commit = (): void => {
    const v = parseFieldValue(num.value, { min: spec.min, max: spec.max, fromDisplay });
    if (v === null) {
      // Unparseable: put the previous value back rather than pushing NaN into the pipeline.
      num.value = show(Number(range.value));
      return;
    }
    range.value = String(v);
    num.value = show(v);
    spec.onInput(v);
  };

  num.addEventListener('change', commit);
  num.addEventListener('focus', () => num.select());
  // Without this the mouse-up that follows focus drops the selection and just places a
  // caret, so "click the number and type" would append instead of replace.
  num.addEventListener('mouseup', (ev) => ev.preventDefault());
  num.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      num.blur();
    } else if (ev.key === 'Escape') {
      num.value = show(Number(range.value));
      num.blur();
    }
  });

  root.append(label, range);
  return {
    root,
    sync: (v: number) => {
      range.value = String(v);
      // The render stage calls sync on every pass. Rewriting the field while it has focus
      // would overwrite whatever is half-typed, so leave it alone until the user is done.
      if (document.activeElement !== num) num.value = show(v);
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
    min: 30,
    max: 6000,
    step: 10,
    value: 3700,
    unit: 'MHz',
    // The 10 MHz step is a comfortable drag; type to land on 2412, 3550, 5925 and friends.
    onInput: (v) => updateSelected({ freqMHz: v }, 'propagation'),
  });
  const txh = slider({
    label: 'TX height',
    min: 1,
    max: 300,
    step: 1,
    value: 30,
    unit: 'm',
    decimals: 1,
    onInput: (v) => updateSelected({ txHeightM: v }, 'propagation'),
  });
  const eirp = slider({
    label: 'EIRP',
    min: -20,
    max: 90,
    step: 0.5,
    value: 55,
    unit: 'dBm',
    decimals: 1,
    // Class 1: path loss is unchanged, only the level derived from it.
    onInput: (v) => updateSelected({ eirpDbm: v }, 'linkBudget'),
  });
  const rxh = slider({
    label: 'RX height',
    min: 0.5,
    max: 100,
    step: 0.5,
    value: s.rxHeightM,
    unit: 'm',
    decimals: 1,
    onInput: (v) => store.set({ rxHeightM: v }),
  });
  txGroup.append(freq.root, txh.root, eirp.root, rxh.root);
  root.append(txGroup);

  // --- Area (Class 3: refetches) ---
  const areaGroup = group('Area', 'refetch');
  const side = slider({
    label: 'AOI size',
    min: 2000,
    max: 100000,
    step: 1000,
    value: s.aoiSideM,
    unit: 'km',
    decimals: 1,
    // Stored in metres, shown in km -- the field edits km and converts back.
    toDisplay: (v) => v / 1000,
    fromDisplay: (v) => v * 1000,
    // Class 3: every commit is a network refetch, so wait for the drag to finish.
    commitOn: 'release',
    onInput: (v) => store.set({ aoiSideM: v }),
  });
  const bin = slider({
    label: 'Bin size',
    min: 10,
    max: 500,
    step: 5,
    value: s.binM,
    unit: 'm',
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
    min: -160,
    max: 0,
    step: 1,
    value: s.threshold,
    unit: 'dBm',
    decimals: 1,
    onInput: (v) => store.set({ threshold: v }),
  });
  const opa = slider({
    label: 'Opacity',
    min: 0,
    max: 1,
    step: 0.05,
    value: s.opacity,
    unit: '%',
    // Stored 0..1, edited as a percentage.
    toDisplay: (v) => v * 100,
    fromDisplay: (v) => v / 100,
    onInput: (v) => store.set({ opacity: v }),
  });
  const lo = slider({
    label: 'Scale min',
    min: -160,
    max: 0,
    step: 1,
    value: s.minDbm,
    unit: 'dBm',
    decimals: 1,
    onInput: (v) => store.set({ minDbm: v }),
  });
  const hi = slider({
    label: 'Scale max',
    min: -160,
    max: 40,
    step: 1,
    value: s.maxDbm,
    unit: 'dBm',
    decimals: 1,
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
