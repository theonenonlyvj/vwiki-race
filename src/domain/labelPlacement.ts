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
/** How far a forced anchor label sits from its own node's baseline. */
const FORCED_CLEARANCE_PX = 26;
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
  /**
   * Rendered box height. Defaults to LABEL_HEIGHT_PX, which is right for the
   * 12px body labels but ~3px short for a 14px anchor title - and a placer
   * that clears a box smaller than the text it is clearing room for produces
   * exactly the overlap it exists to prevent. Same doctrine as CHAR_WIDTH_PX
   * in ChallengePathGraph.tsx: over-estimating leaves slack, under-estimating
   * is a visible bug.
   */
  height?: number;
  priority: number;
  /**
   * Which flank to try first. Portrait puts labels beside their nodes, and
   * without a preference every one of them lands on the same side: the empty
   * margin on the other flank goes unused while the crowded side truncates
   * harder. Callers set this to the side AWAY from the canvas centre so labels
   * spread outward. Ignored by slot lists that only move vertically.
   */
  preferSide?: "left" | "right";
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
 * A candidate position, resolved against the label's own width:
 * `dx = dxFraction * width + dxPx`.
 *
 * Offsets are the FINAL offset from the node centre, clearance included. The
 * prototype kept a separate render-time nudge (`dy >= 0 ? +16 : -10`) applied
 * after collision detection, so the boxes the placer reasoned about were never
 * the boxes that got painted - every label ended up 10-16px from where it had
 * been cleared. That alone guaranteed collisions the placer believed it had
 * avoided. Nothing may be added to these at render time.
 */
export interface LabelSlot {
  dxFraction: number;
  dxPx: number;
  dyPx: number;
}

const VERTICAL_OFFSETS = [
  16, -12, 34, -30, 52, -48, 70, -66, 88, -84, 106, -102, 124, -120,
];
/** Fractions of the label's own width to slide sideways by. */
const HORIZONTAL_FRACTIONS = [0, 0.55, -0.55, 1.05, -1.05];

/**
 * Landscape: progress runs along x, so successive hops are far apart
 * horizontally and the cheap room is VERTICAL. Try directly under the node
 * first, then ring outward, sliding sideways only within each ring.
 */
export const LANDSCAPE_SLOTS: LabelSlot[] = VERTICAL_OFFSETS.flatMap((dyPx) =>
  HORIZONTAL_FRACTIONS.map((dxFraction) => ({ dxFraction, dxPx: 0, dyPx })),
);

/**
 * Portrait: progress runs DOWN, so successive hops are only ~20px apart
 * vertically and stacking labels above/below would collide immediately. The
 * cheap room is sideways - a label sits beside its node, left or right, and
 * only nudges vertically once both flanks at that height are taken.
 *
 * Deliberately SHORT. A wider ladder does fit more labels (58 rather than 30
 * on the 11-strand daily) but they land far from their nodes, so the reader
 * cannot tell which dot a title belongs to and the titles cover the strands
 * they are supposed to explain. Staying near the node means crowding shows up
 * as a hidden label - honest, and recoverable by tapping the player - instead
 * of as a misattributed one.
 */
export const PORTRAIT_SLOTS: LabelSlot[] = [0, 7, -7, 15, -15, 23, -23].flatMap((dyPx) =>
  [
    { dxFraction: 0.5, dxPx: 12 }, // to the right of the node
    { dxFraction: -0.5, dxPx: -12 }, // to the left of the node
  ].map((side) => ({ ...side, dyPx })),
);

/**
 * 0 when the slot sits on the wanted flank, 1 otherwise. A stable sort by this
 * keeps each flank's own near-to-far ordering intact.
 */
function sideRank(slot: LabelSlot, side: "left" | "right"): number {
  const offset = slot.dxFraction + slot.dxPx;
  const onLeft = offset < 0;
  return (side === "left") === onLeft ? 0 : 1;
}

function boxesOverlap(a: Box, b: Box): boolean {
  return a.x1 < b.x2 + LABEL_GAP_PX && b.x1 < a.x2 + LABEL_GAP_PX && a.y1 < b.y2 && b.y1 < a.y2;
}

function boxFor(candidate: LabelCandidate, dx: number, dy: number): Box {
  const cx = candidate.cx + dx;
  const cy = candidate.cy + dy;
  const half = candidate.width / 2;
  const halfHeight = (candidate.height ?? LABEL_HEIGHT_PX) / 2;
  return {
    x1: cx - half,
    x2: cx + half,
    y1: cy - halfHeight,
    y2: cy + halfHeight,
  };
}

export interface LabelBounds {
  minX: number;
  maxX: number;
  /** Optional: portrait puts the start anchor within 40px of the top edge. */
  minY?: number;
  maxY?: number;
}

/**
 * Last resort for a label that must render. Collisions are ignored; the canvas
 * edge is not. `dx` is clamped so the box stays on canvas rather than being
 * abandoned, and rungs that leave the node's own baseline clear are tried
 * before the flush ones.
 */
function forcedSlot(
  candidate: LabelCandidate,
  slots: LabelSlot[],
  bounds?: LabelBounds,
): { dx: number; dy: number } {
  const half = candidate.width / 2;
  const clampDx = (dx: number): number => {
    if (!bounds) return dx;
    const min = bounds.minX + half - candidate.cx;
    const max = bounds.maxX - half - candidate.cx;
    return max < min ? dx : Math.min(Math.max(dx, min), max);
  };
  const verticallyInside = (dy: number): boolean => {
    if (!bounds) return true;
    const halfHeight = (candidate.height ?? LABEL_HEIGHT_PX) / 2;
    const top = candidate.cy + dy - halfHeight;
    const bottom = candidate.cy + dy + halfHeight;
    if (bounds.minY !== undefined && top < bounds.minY) return false;
    if (bounds.maxY !== undefined && bottom > bounds.maxY) return false;
    return true;
  };

  // A node near the top of the canvas gets its forced label BELOW it and one
  // near the bottom gets it above, so the offset is always into open canvas.
  const midY =
    bounds && bounds.minY !== undefined && bounds.maxY !== undefined
      ? (bounds.minY + bounds.maxY) / 2
      : candidate.cy;
  const away = candidate.cy <= midY ? 1 : -1;
  const clearing = [away * FORCED_CLEARANCE_PX, -away * FORCED_CLEARANCE_PX];

  for (const dy of clearing) {
    if (verticallyInside(dy)) return { dx: clampDx(0), dy };
  }
  for (const slot of slots) {
    if (verticallyInside(slot.dyPx)) {
      return { dx: clampDx(slot.dxFraction * candidate.width + slot.dxPx), dy: slot.dyPx };
    }
  }
  return { dx: clampDx(0), dy: 0 };
}

/**
 * The slot that overlaps the least ink, for labels with no collision-free
 * option. Ties break toward the earlier (nearer) slot, so a label still sits as
 * close to its own node as the crowding allows.
 */
function leastCollidingSlot(
  candidate: LabelCandidate,
  slots: LabelSlot[],
  taken: Box[],
  bounds?: LabelBounds,
): { dx: number; dy: number } {
  let best: { dx: number; dy: number } | null = null;
  let bestArea = Infinity;
  for (const slot of slots) {
    const dx = slot.dxFraction * candidate.width + slot.dxPx;
    const box = boxFor(candidate, dx, slot.dyPx);
    if (bounds) {
      if (box.x1 < bounds.minX || box.x2 > bounds.maxX) continue;
      if (bounds.minY !== undefined && box.y1 < bounds.minY) continue;
      if (bounds.maxY !== undefined && box.y2 > bounds.maxY) continue;
    }
    let area = 0;
    for (const placed of taken) {
      const overlapX = Math.min(box.x2, placed.x2) - Math.max(box.x1, placed.x1);
      const overlapY = Math.min(box.y2, placed.y2) - Math.max(box.y1, placed.y1);
      if (overlapX > 0 && overlapY > 0) area += overlapX * overlapY;
    }
    if (area < bestArea) {
      bestArea = area;
      best = { dx, dy: slot.dyPx };
    }
    if (area === 0) break;
  }
  if (best) return best;
  const last = slots[slots.length - 1];
  return { dx: last.dxFraction * candidate.width + last.dxPx, dy: last.dyPx };
}

export function placeLabels(
  candidates: LabelCandidate[],
  bounds?: LabelBounds,
  slots: LabelSlot[] = LANDSCAPE_SLOTS,
): LabelPlacement[] {
  const withinBounds = (box: Box): boolean => {
    if (!bounds) return true;
    if (box.x1 < bounds.minX || box.x2 > bounds.maxX) return false;
    if (bounds.minY !== undefined && box.y1 < bounds.minY) return false;
    if (bounds.maxY !== undefined && box.y2 > bounds.maxY) return false;
    return true;
  };

  const order = candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => a.candidate.priority - b.candidate.priority || a.index - b.index);

  const placements = new Array<LabelPlacement>(candidates.length);
  // Two reservation sets, because suppressed labels have to satisfy two rules
  // that pull opposite ways. They must not crowd out a label that renders by
  // default - so default-visible labels are only ever checked against `taken`.
  // But a focus reveal pops a WHOLE solo stretch in at once, so they must also
  // avoid each other, or every one of them takes the same nearest free slot
  // and they stack into unreadable text. Suppressed labels are placed last
  // (priority order), so by then `takenAll` already holds every visible box.
  const taken: Box[] = [];
  const takenAll: Box[] = [];

  for (const { candidate, index } of order) {
    // Nearest slot wins: walk vertical rings outward, and within each ring try
    // centred first, then progressively further to either side. That keeps a
    // label as close to its own node as the crowding allows.
    // Reorder, never filter: the far flank stays available as a fallback, so a
    // preference costs nothing when the preferred side is full.
    const ordered =
      candidate.preferSide === "left"
        ? [...slots].sort((a, b) => sideRank(a, "left") - sideRank(b, "left"))
        : candidate.preferSide === "right"
          ? [...slots].sort((a, b) => sideRank(a, "right") - sideRank(b, "right"))
          : slots;

    const mustShowEarly = candidate.priority === LABEL_PRIORITY_ANCHOR;
    const suppressed = candidate.priority === LABEL_PRIORITY_SUPPRESSED;
    const against = suppressed ? takenAll : taken;

    let chosen: { dx: number; dy: number } | null = null;
    for (const slot of ordered) {
      const dx = slot.dxFraction * candidate.width + slot.dxPx;
      const box = boxFor(candidate, dx, slot.dyPx);
      // Sliding sideways is where the extra room comes from, but a node near
      // the margin must not be slid off the canvas - a clipped label is as
      // unreadable as an overlapping one.
      if (!withinBounds(box)) continue;
      if (!against.some((placed) => boxesOverlap(placed, box))) {
        chosen = { dx, dy: slot.dyPx };
        break;
      }
    }

    if (chosen) {
      placements[index] = { ...chosen, hidden: suppressed };
      const box = boxFor(candidate, chosen.dx, chosen.dy);
      if (!suppressed) taken.push(box);
      takenAll.push(box);
      continue;
    }

    if (mustShowEarly) {
      // Anchors are the frame of reference and never hide, so when every slot
      // is taken one has to be forced. It must NOT be forced to {0, 0}: that
      // puts the baseline dead on the node's own centre, and the label's ink
      // halo then erases the node and the strands converging on it. In portrait
      // that was the guaranteed outcome for any anchor title of ~18 characters
      // or more, because the start node always sits at the exact plot centre
      // (every player visits it) and the side slots need width + 12 of clear
      // room on one flank, which a ~320-unit phone canvas does not have.
      //
      // So: walk the ladder again ignoring collisions, but keep the box on
      // canvas by clamping dx, and prefer the rungs that clear the node. A
      // forced anchor may overlap a neighbour - that is the trade - but it is
      // never illegible on top of itself.
      const forced = forcedSlot(candidate, ordered, bounds);
      placements[index] = { ...forced, hidden: false };
      const box = boxFor(candidate, forced.dx, forced.dy);
      taken.push(box);
      takenAll.push(box);
      continue;
    }

    // Exhausted every slot. Take the LEAST BAD one rather than a fixed one, and
    // reserve it. These are hidden now, but a focus reveal pops a whole solo
    // stretch in AT ONCE - and if every label that reached this branch used the
    // same offset they would stack into unreadable text at the moment they
    // become visible, which is the exact failure the two reservation sets exist
    // to prevent, displaced into the fallback.
    const fallbackPlacement = leastCollidingSlot(candidate, ordered, takenAll, bounds);
    placements[index] = { ...fallbackPlacement, hidden: true };
    takenAll.push(boxFor(candidate, fallbackPlacement.dx, fallbackPlacement.dy));
  }

  return placements;
}
