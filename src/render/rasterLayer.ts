import type { Map as MlMap, CanvasSource, CanvasSourceSpecification } from 'maplibre-gl';
import type { BBox } from '../geo/bbox.js';
import { toLonLat, type UtmZone } from '../geo/utm.js';

export type Corners = [
  [number, number],
  [number, number],
  [number, number],
  [number, number],
];

/**
 * Corner coordinates for a UTM-aligned AOI, in MapLibre's order: TL, TR, BR, BL.
 *
 * MapLibre applies a projective transform between these four points. A UTM rectangle is
 * very slightly rotated and curved in lon/lat -- grid convergence varies by about 0.15deg
 * across a 30km AOI at this latitude, so the residual after the projective fit is on the
 * order of tens of metres, well under one 100m bin. Fine for visualisation; it would not
 * be fine if we were reading coordinates back off the rendered image.
 */
export function aoiCorners(bbox: BBox, zone: UtmZone): Corners {
  const p = (e: number, n: number): [number, number] => {
    const ll = toLonLat({ e, n }, zone);
    return [ll.lon, ll.lat];
  };
  return [
    p(bbox.minE, bbox.maxN),
    p(bbox.maxE, bbox.maxN),
    p(bbox.maxE, bbox.minN),
    p(bbox.minE, bbox.minN),
  ];
}

export interface RasterOverlayOptions {
  /** Categorical rasters must not be interpolated between classes. */
  resampling?: 'linear' | 'nearest';
  beforeId?: string;
}

/**
 * A pixel-buffer overlay backed by a MapLibre CanvasSource.
 *
 * CanvasSource rather than ImageSource because ImageSource.updateImage() only accepts a
 * URL, which would mean PNG-encoding the grid on every update. Encoding a 601x601 buffer
 * costs several milliseconds and is async -- unaffordable for a control the user drags.
 * Writing straight into a canvas hands the bytes to the GPU with no codec in between.
 */
export class RasterOverlay {
  readonly id: string;
  private map: MlMap;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private added = false;
  private resampling: 'linear' | 'nearest';
  private beforeId: string | undefined;

  constructor(map: MlMap, id: string, opts: RasterOverlayOptions = {}) {
    this.map = map;
    this.id = id;
    this.resampling = opts.resampling ?? 'linear';
    this.beforeId = opts.beforeId;
    this.canvas = document.createElement('canvas');
    this.canvas.width = 1;
    this.canvas.height = 1;
    const ctx = this.canvas.getContext('2d', { willReadFrequently: false });
    if (!ctx) throw new Error(`RasterOverlay ${id}: no 2D context`);
    this.ctx = ctx;
  }

  update(rgba: Uint8ClampedArray<ArrayBuffer>, width: number, height: number, corners: Corners): void {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      // Dimensions changed, so the existing source is stale -- rebuild it.
      this.teardown();
    }
    this.ctx.putImageData(new ImageData(rgba, width, height), 0, 0);

    if (!this.added) {
      const spec: CanvasSourceSpecification = {
        type: 'canvas',
        canvas: this.canvas,
        coordinates: corners,
        animate: false,
      };
      this.map.addSource(this.id, spec);
      this.map.addLayer(
        {
          id: this.id,
          type: 'raster',
          source: this.id,
          paint: { 'raster-opacity': 1, 'raster-resampling': this.resampling },
        },
        this.beforeId,
      );
      this.added = true;
    } else {
      (this.map.getSource(this.id) as CanvasSource | undefined)?.setCoordinates(corners);
    }

    // animate:false means the canvas is copied only on demand. play() schedules a copy;
    // pausing on the next frame keeps this to one texture upload per update instead of a
    // permanent render loop.
    const src = this.map.getSource(this.id) as CanvasSource | undefined;
    src?.play();
    requestAnimationFrame(() => src?.pause());
  }

  setVisible(visible: boolean): void {
    if (!this.added) return;
    this.map.setLayoutProperty(this.id, 'visibility', visible ? 'visible' : 'none');
  }

  private teardown(): void {
    if (!this.added) return;
    if (this.map.getLayer(this.id)) this.map.removeLayer(this.id);
    if (this.map.getSource(this.id)) this.map.removeSource(this.id);
    this.added = false;
  }

  remove(): void {
    this.teardown();
  }
}
