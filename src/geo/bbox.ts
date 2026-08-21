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

export function bboxWidth(b: BBox): number {
  return b.maxE - b.minE;
}

export function bboxHeight(b: BBox): number {
  return b.maxN - b.minN;
}

export function bboxContains(b: BBox, e: number, n: number): boolean {
  return e >= b.minE && e <= b.maxE && n >= b.minN && n <= b.maxN;
}

/** True if `inner` lies entirely inside `outer`. Used to decide whether a moved site needs a refetch. */
export function bboxCovers(outer: BBox, inner: BBox): boolean {
  return (
    outer.minE <= inner.minE &&
    outer.minN <= inner.minN &&
    outer.maxE >= inner.maxE &&
    outer.maxN >= inner.maxN
  );
}

/** ArcGIS/WMS `bbox=` parameter order is minX,minY,maxX,maxY for both services. */
export function bboxParam(b: BBox): string {
  return `${b.minE},${b.minN},${b.maxE},${b.maxN}`;
}
