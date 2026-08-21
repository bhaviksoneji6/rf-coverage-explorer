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

export type KpiName = 'rsl' | 'pathLoss';

export interface AppState {
  /** Multi-site from the start: Pass 1 renders one, but nothing here assumes that. */
  sites: Site[];
  selectedSiteId: string | null;

  /** AOI is shared across all sites and only refetched when a site leaves it. */
  aoiCenter: { lon: number; lat: number } | null;
  aoiSideM: number;
  binM: number;

  rxHeightM: number;

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
