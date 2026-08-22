import type { PropagationModel } from '../engine/types.js';
import type { RampName } from '../render/colormap.js';
import type { Stage } from './store.js';

export interface Site {
  id: string;
  name: string;
  lon: number;
  lat: number;
  enabled: boolean;
  freqMHz: number;
  eirpDbm: number;
  txHeightM: number;
}

/** Loss layers use their own 0..N dB scale rather than the received-level range. */
export const LOSS_SCALE_MAX_DB = 40;

export type KpiName = 'rsl' | 'pathLoss' | 'diffraction' | 'clutter';

/**
 * Default clutter loss per normalised class, dB, at roughly 1-2 GHz.
 *
 * Empirical starting values, deliberately editable in the UI rather than baked in. The
 * honest limitation is that they carry no frequency dependence -- real clutter loss rises
 * with frequency -- which is what ITU-R P.2108 would fix later.
 */
export const DEFAULT_CLUTTER_LOSS_DB: Record<number, number> = {
  0: 0, // no data
  1: 0, // water
  2: 1, // open / rural
  3: 6, // suburban
  4: 12, // urban
  5: 18, // dense urban
  6: 11, // forest
  7: 4, // wetland
};

export interface AppState {
  /** Multi-site from the start: Pass 1 renders one, but nothing here assumes that. */
  sites: Site[];
  selectedSiteId: string | null;

  /** AOI is shared across all sites and only refetched when a site leaves it. */
  aoiCenter: { lon: number; lat: number } | null;
  aoiSideM: number;
  binM: number;

  rxHeightM: number;
  model: PropagationModel;

  /** Applied per receive bin in the link budget, so editing the table is instant. */
  applyClutter: boolean;
  clutterLossDb: Record<number, number>;

  kpi: KpiName;
  ramp: RampName;
  minDbm: number;
  maxDbm: number;
  threshold: number;
  opacity: number;

  showCoverage: boolean;
  showHillshade: boolean;
  showClutter: boolean;

  status: string;
  busy: boolean;
  lastComputeMs: number | null;
}

export const DEFAULT_STATE: AppState = {
  sites: [],
  selectedSiteId: null,
  aoiCenter: null,
  aoiSideM: 30000,
  binM: 50,
  rxHeightM: 1.5,
  model: 'diffraction',
  applyClutter: true,
  clutterLossDb: { ...DEFAULT_CLUTTER_LOSS_DB },
  kpi: 'rsl',
  ramp: 'signal',
  minDbm: -120,
  maxDbm: -50,
  threshold: -120,
  opacity: 0.8,
  showCoverage: true,
  showHillshade: false,
  showClutter: false,
  status: 'Click the map to place a transmitter.',
  busy: false,
  lastComputeMs: null,
};

/**
 * The cost declaration. This table *is* the latency-class design -- everything the UI does
 * about responsiveness follows from getting these assignments right.
 */
export const STAGE_FOR: Partial<Record<keyof AppState, Stage>> = {
  // Class 3: needs a network round trip.
  aoiCenter: 'data',
  aoiSideM: 'data',

  // Class 2: needs the radial walk re-run.
  sites: 'propagation',
  binM: 'propagation',
  rxHeightM: 'propagation',
  model: 'propagation',

  // Class 1: clutter is a per-bin loss, so the table recombines cached path loss and never
  // re-walks a radial. That is what makes dragging a clutter value feel instant.
  applyClutter: 'linkBudget',
  clutterLossDb: 'linkBudget',

  // Class 1: recombines cached path loss into a received level.
  selectedSiteId: 'linkBudget',

  // Class 0: pure re-colour of an existing grid.
  kpi: 'render',
  ramp: 'render',
  minDbm: 'render',
  maxDbm: 'render',
  threshold: 'render',
  opacity: 'render',
  showCoverage: 'render',
  showHillshade: 'render',
  showClutter: 'render',
  status: 'render',
  busy: 'render',
  lastComputeMs: 'render',
};
