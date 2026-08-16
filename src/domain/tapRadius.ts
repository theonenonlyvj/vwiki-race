/**
 * GR-2: how large a node's tap target may be before it starts stealing taps
 * from its neighbours.
 *
 * The graph gave every node a flat 44-unit-wide target (A6c's "44px tap
 * target"). In landscape one viewBox unit is small against the 868-unit
 * progress axis, so targets rarely met. Portrait puts the DENSE axis on the
 * height and maps the viewBox roughly 1:1 to CSS pixels, where real spacing is
 * ~14.5 units along a 37-hop path and ~25 across 11 lanes - both well under 44.
 *
 * Overlapping targets are not a near-miss problem. SVG hit-testing gives the
 * tap to whichever element painted last, and nodes are emitted in progress
 * order, so the node LATER in the path wins every time: tapping a dot
 * deterministically opened the next article's callout, and where the winner sat
 * in a different lane it also focused the wrong player. On a touch device the
 * callout is the only way to read a title the placer had to crowd out - there
 * is no hover, so the <title> tooltip never fires.
 */

/** A6c asked for 44-unit targets; that is the ceiling, not a guarantee. */
export const MAX_TAP_RADIUS = 22;
/** Below this a target is smaller than the dot it covers and stops being useful. */
export const MIN_TAP_RADIUS = 7;

export interface TapPoint {
  x: number;
  y: number;
}

/**
 * Half the closest gap between any two nodes, clamped. Half, because two
 * neighbouring targets of that radius meet exactly rather than overlapping.
 *
 * O(n^2) over up to ~140 nodes, run once per layout - about 10k distance
 * checks, which is cheaper than the label placer that runs beside it.
 */
export function tapRadiusFor(points: TapPoint[]): number {
  let closest = Infinity;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const gap = Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y);
      if (gap > 0 && gap < closest) closest = gap;
    }
  }
  if (!Number.isFinite(closest)) return MAX_TAP_RADIUS;
  return Math.max(MIN_TAP_RADIUS, Math.min(MAX_TAP_RADIUS, closest / 2));
}
