/** Axis-aligned bounding box in projected (UTM) metres. */
export interface BBox {
  minE: number;
  minN: number;
  maxE: number;
  maxN: number;
}

export interface GridSize {
  width: number;
  height: number;
}

/** ArcGIS/WMS `bbox=` parameter order is minX,minY,maxX,maxY for both services. */
export function bboxParam(b: BBox): string {
  return `${b.minE},${b.minN},${b.maxE},${b.maxN}`;
}
