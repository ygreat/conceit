import { allObjects } from "./doc";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Nearest position to `center` where a w×h object doesn't overlap existing
 * objects (and `extra` rects), searched in rings outward. Falls back to the center.
 */
export function freeSpotNear(
  center: { x: number; y: number },
  w: number,
  h: number,
  extra: Rect[] = [],
  /** Cards to treat as gone (e.g. the ones being moved). */
  ignore?: Set<string>,
) {
  const GAP = 24, STEP = 40, MAX_RING = 30;
  const rects: Rect[] = [
    ...allObjects()
      .filter((o) => !ignore?.has(o.id))
      .map((o) => ({ x: o.position.x, y: o.position.y, w: o.width, h: o.height })),
    ...extra,
  ];
  const free = (x: number, y: number) =>
    rects.every(
      (r) => x + w + GAP <= r.x || r.x + r.w + GAP <= x || y + h + GAP <= r.y || r.y + r.h + GAP <= y,
    );
  const x0 = center.x - w / 2, y0 = center.y - h / 2;
  for (let ring = 0; ring <= MAX_RING; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue; // ring edge only
        const x = x0 + dx * STEP, y = y0 + dy * STEP;
        if (free(x, y)) return { x, y };
      }
    }
  }
  return { x: x0, y: y0 };
}
