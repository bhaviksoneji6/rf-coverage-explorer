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

/** SINR display range. Below -5 dB nothing decodes; above 30 dB the extra is not useful. */
export const SINR_SCALE_MIN_DB = -5;
export const SINR_SCALE_MAX_DB = 30;

/** Layers that describe one selected site. */
export type SiteKpi = 'rsl' | 'pathLoss' | 'diffraction' | 'clutter';
/** Layers that describe the network as a whole. */
export type NetworkKpi = 'bestRsl' | 'serving' | 'sinr' | 'overlap';
export type KpiName = SiteKpi | NetworkKpi;

export const NETWORK_KPIS: readonly KpiName[] = ['bestRsl', 'serving', 'sinr', 'overlap'];

export function isNetworkKpi(k: KpiName): boolean {
  return NETWORK_KPIS.includes(k);
}

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

  /** Receiver channel, used for the noise floor and for the co-channel test. */
  bandwidthMHz: number;
  noiseFigureDb: number;

  /** True while the map is waiting for a click to place a new site. */
  placing: boolean;

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
  bandwidthMHz: 20,
  noiseFigureDb: 7,
  placing: false,
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
  bandwidthMHz: 'linkBudget',
  noiseFigureDb: 'linkBudget',

  // Class 1: recombines cached path loss into a received level.
  selectedSiteId: 'linkBudget',

  // Class 0: pure re-colour of an existing grid.
  kpi: 'render',
  ramp: 'render',
  minDbm: 'render',
  maxDbm: 'render',
  // The display threshold doubles as the service threshold, so overlap counts change with it.
  threshold: 'linkBudget',
  opacity: 'render',
  showCoverage: 'render',
  showHillshade: 'render',
  showClutter: 'render',
  placing: 'render',
  status: 'render',
  busy: 'render',
  lastComputeMs: 'render',
};
