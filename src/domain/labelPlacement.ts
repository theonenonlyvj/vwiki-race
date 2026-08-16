/**
 * GR-2: where each node's title sits on the "Everyone's path" graph.
 *
 * The prototype's placer walked the nodes in layout order, tried 11 fixed
 * vertical offsets (0, +-18 ... +-90) and, when every one of them was taken,
 * placed the label at the LAST offset ANYWAY. On the 11-strand 2026-07-20
 * daily that produced 87 overlapping label pairs out of 132 labels, rendering
 * "Consumer electron" and "Semiconductor" on top of each other.
 *
 * Three things changed:
 *
 *  1. PRIORITY ORDER. Placement now runs highest-priority first, so an anchor
 *     or merge point claims a slot before a breadcrumb can take it. The old
 *     order was the layout's node order, which is unrelated to importance -
 *     a solo breadcrumb could and did evict the target's own label.
 *
 *  2. HORIZONTAL FREEDOM. A label may sit centred, or shifted to either side
 *     of its node. The graph spreads nodes along x, so sliding sideways is
 *     both natural and roughly triples the search space; the old placer only
 *     ever moved labels up and down.
 *
 *  3. SUPPRESSION INSTEAD OF COLLISION. If nothing is free, a non-anchor
 *     label hides rather than overprinting. Two overlapping labels are worse
 *     than one hidden label, because the collision destroys BOTH - and the
 *     title stays reachable through the node's native <title> tooltip and the
 *     A6 focus reveal. Anchors (start/target) never hide; they are the frame
 *     of reference for everything else.
 *
 * Suppressed labels (A4's long-solo-stretch breadcrumbs) are placed LAST and
 * reserve nothing, so they can never crowd out a label that actually renders,
 * but they still get a collision-aware slot for the moment a focus reveal pops
 * a whole stretch in at once.
 */

export const LABEL_HEIGHT_PX = 15;
export const LABEL_GAP_PX = 8;

/** Lower sorts first and wins contested slots. */
export const LABEL_PRIORITY_ANCHOR = 0; // start / target - never hidden
export const LABEL_PRIORITY_SHARED = 1; // merge points, DNF terminals
export const LABEL_PRIORITY_BREADCRUMB = 2; // A4-selected solo breadcrumbs
export const LABEL_PRIORITY_SUPPRESSED = 3; // hidden until a focus reveal

export interface LabelCandidate {
  cx: number;
  cy: number;
  width: number;
  priority: number;
}

export interface LabelPlacement {
  dx: number;
  dy: number;
  /** True when no free slot existed and the label must not render by default. */
  hidden: boolean;
}

interface Box {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

/**
 * Offsets are the FINAL text baseline offset from the node centre, clearance
 * included. The prototype kept a separate render-time nudge (`dy >= 0 ? +16 :
 * -10`) applied after collision detection, so the boxes the placer reasoned
 * about were never the boxes that got painted - every label was 10-16px away
 * from where it had been checked. That alone guaranteed collisions the placer
 * believed it had avoided. Nothing may be added to these at render time.
 */
const VERTICAL_OFFSETS = [
  16, -12, 34, -30, 52, -48, 70, -66, 88, -84, 106, -102, 124, -120,
];
/** Fractions of the label's own width to slide sideways by. */
const HORIZONTAL_FRACTIONS = [0, 0.55, -0.55, 1.05, -1.05];

function boxesOverlap(a: Box, b: Box): boolean {
  return a.x1 < b.x2 + LABEL_GAP_PX && b.x1 < a.x2 + LABEL_GAP_PX && a.y1 < b.y2 && b.y1 < a.y2;
}

function boxFor(candidate: LabelCandidate, dx: number, dy: number): Box {
  const cx = candidate.cx + dx;
  const cy = candidate.cy + dy;
  const half = candidate.width / 2;
  return {
    x1: cx - half,
    x2: cx + half,
    y1: cy - LABEL_HEIGHT_PX / 2,
    y2: cy + LABEL_HEIGHT_PX / 2,
  };
}

export interface LabelBounds {
  minX: number;
  maxX: number;
}

export function placeLabels(
  candidates: LabelCandidate[],
  bounds?: LabelBounds,
): LabelPlacement[] {
  const withinBounds = (box: Box): boolean =>
    !bounds || (box.x1 >= bounds.minX && box.x2 <= bounds.maxX);

  const order = candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => a.candidate.priority - b.candidate.priority || a.index - b.index);

  const placements = new Array<LabelPlacement>(candidates.length);
  const taken: Box[] = [];

  for (const { candidate, index } of order) {
    // Nearest slot wins: walk vertical rings outward, and within each ring try
    // centred first, then progressively further to either side. That keeps a
    // label as close to its own node as the crowding allows.
    let chosen: { dx: number; dy: number } | null = null;
    outer: for (const dy of VERTICAL_OFFSETS) {
      for (const fraction of HORIZONTAL_FRACTIONS) {
        const dx = fraction * candidate.width;
        const box = boxFor(candidate, dx, dy);
        // Sliding sideways is where the extra room comes from, but a node near
        // the margin must not be slid off the canvas - a clipped label is as
        // unreadable as an overlapping one.
        if (!withinBounds(box)) continue;
        if (!taken.some((placed) => boxesOverlap(placed, box))) {
          chosen = { dx, dy };
          break outer;
        }
      }
    }

    const mustShow = candidate.priority === LABEL_PRIORITY_ANCHOR;
    const alreadySuppressed = candidate.priority === LABEL_PRIORITY_SUPPRESSED;

    if (chosen) {
      placements[index] = { ...chosen, hidden: alreadySuppressed };
      // An already-suppressed label renders at opacity 0, so it reserves
      // nothing - otherwise it would crowd out labels that do render.
      if (!alreadySuppressed) taken.push(boxFor(candidate, chosen.dx, chosen.dy));
      continue;
    }

    if (mustShow) {
      // Anchors are the frame of reference; show it and accept the collision.
      placements[index] = { dx: 0, dy: 0, hidden: false };
      taken.push(boxFor(candidate, 0, 0));
      continue;
    }

    placements[index] = { dx: 0, dy: VERTICAL_OFFSETS[VERTICAL_OFFSETS.length - 1], hidden: true };
  }

  return placements;
}
