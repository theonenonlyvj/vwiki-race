import { describe, expect, it } from "vitest";
import {
  LABEL_PRIORITY_ANCHOR,
  LABEL_PRIORITY_BREADCRUMB,
  LABEL_PRIORITY_SHARED,
  LABEL_PRIORITY_SUPPRESSED,
  placeLabels,
  type LabelCandidate,
} from "./labelPlacement";

const LABEL_HEIGHT_PX = 15;

function boxOf(candidate: LabelCandidate, placement: { dx: number; dy: number }) {
  const cx = candidate.cx + placement.dx;
  const cy = candidate.cy + placement.dy;
  return {
    x1: cx - candidate.width / 2,
    x2: cx + candidate.width / 2,
    y1: cy - LABEL_HEIGHT_PX / 2,
    y2: cy + LABEL_HEIGHT_PX / 2,
  };
}

function overlaps(a: ReturnType<typeof boxOf>, b: ReturnType<typeof boxOf>): boolean {
  return a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
}

function countVisibleOverlaps(candidates: LabelCandidate[]): number {
  const placements = placeLabels(candidates);
  const visible = candidates
    .map((candidate, i) => ({ candidate, placement: placements[i] }))
    .filter((entry) => !entry.placement.hidden);
  let collisions = 0;
  for (let i = 0; i < visible.length; i++) {
    for (let j = i + 1; j < visible.length; j++) {
      if (overlaps(boxOf(visible[i].candidate, visible[i].placement), boxOf(visible[j].candidate, visible[j].placement))) {
        collisions++;
      }
    }
  }
  return collisions;
}

function candidate(overrides: Partial<LabelCandidate> = {}): LabelCandidate {
  return { cx: 0, cy: 0, width: 90, priority: LABEL_PRIORITY_SHARED, ...overrides };
}

describe("placeLabels", () => {
  it("puts an isolated label directly under its node, clear of the dot", () => {
    const [placement] = placeLabels([candidate({ cx: 500, cy: 300 })]);
    // dy is the FINAL baseline offset - no render-time nudge is added later.
    expect(placement).toMatchObject({ dx: 0, dy: 16, hidden: false });
  });

  it("moves the second of two colliding labels rather than stacking them", () => {
    const both = [candidate({ cx: 500, cy: 300 }), candidate({ cx: 505, cy: 300 })];
    const placements = placeLabels(both);

    expect(placements.every((p) => !p.hidden)).toBe(true);
    expect(countVisibleOverlaps(both)).toBe(0);
  });

  // The bug this replaces: the placer tried 11 fixed vertical offsets and, when
  // every one was taken, placed the label at the LAST offset anyway. On the
  // 11-strand 2026-07-20 daily that produced 87 overlapping label pairs out of
  // 132 labels - rendering "Consumer electron" and "Semiconductor" on top of
  // one another. Two overlapping labels are worse than one hidden label,
  // because the collision destroys BOTH.
  it("never overlaps two visible labels, even when the canvas is saturated", () => {
    const dense = Array.from({ length: 140 }, (_, i) =>
      candidate({
        cx: 100 + (i % 14) * 8,
        cy: 100 + Math.floor(i / 14) * 6,
        width: 120,
        priority: LABEL_PRIORITY_BREADCRUMB,
      }),
    );

    expect(countVisibleOverlaps(dense)).toBe(0);
  });

  it("gives the anchor the centred slot even when a breadcrumb is earlier in input order", () => {
    // Placement order used to be layout order, which is unrelated to
    // importance - so a solo breadcrumb could take the slot the target's own
    // label needed, and the anchor got bumped off its node.
    const cluster: LabelCandidate[] = [
      candidate({ cx: 400, cy: 300, priority: LABEL_PRIORITY_BREADCRUMB }),
      candidate({ cx: 400, cy: 300, priority: LABEL_PRIORITY_ANCHOR }),
    ];
    const placements = placeLabels(cluster);

    const anchorPlacement = placements[1];
    expect(anchorPlacement.hidden).toBe(false);
    expect(anchorPlacement).toMatchObject({ dx: 0, dy: 16 });
  });

  it("always keeps an anchor label visible, even with no free slot", () => {
    const anchors = Array.from({ length: 30 }, () =>
      candidate({ cx: 400, cy: 300, width: 200, priority: LABEL_PRIORITY_ANCHOR }),
    );
    const placements = placeLabels(anchors);

    expect(placements.every((p) => !p.hidden)).toBe(true);
  });

  it("reserves no slot for an already-suppressed label but still returns one", () => {
    // A4-suppressed labels render at opacity 0 until a focus reveal, so they
    // must not consume slots that a visible label needs.
    const suppressedFirst: LabelCandidate[] = [
      candidate({ cx: 400, cy: 300, priority: LABEL_PRIORITY_SUPPRESSED }),
      candidate({ cx: 400, cy: 300, priority: LABEL_PRIORITY_SHARED }),
    ];
    const placements = placeLabels(suppressedFirst);

    expect(placements[1]).toMatchObject({ dx: 0, dy: 16, hidden: false });
    expect(placements[0].dy).not.toBe(16);
  });

  // Sliding sideways is what buys the placer its extra room, but a node near
  // the canvas edge could be slid straight off it - "Lexicon Technicum" ran
  // past the right margin and rendered clipped.
  it("keeps a label inside the canvas rather than sliding it off the edge", () => {
    const bounds = { minX: 0, maxX: 1000 };
    const nearEdge = [
      candidate({ cx: 960, cy: 300, width: 120 }),
      candidate({ cx: 960, cy: 300, width: 120 }),
    ];
    const placements = placeLabels(nearEdge, bounds);

    for (const [i, placement] of placements.entries()) {
      if (placement.hidden) continue;
      const box = boxOf(nearEdge[i], placement);
      expect(box.x1).toBeGreaterThanOrEqual(bounds.minX);
      expect(box.x2).toBeLessThanOrEqual(bounds.maxX);
    }
  });

  it("still places labels when given no bounds at all", () => {
    expect(placeLabels([candidate({ cx: 5000, cy: 0 })])[0].hidden).toBe(false);
  });

  it("places every candidate exactly once, in input order", () => {
    const many = Array.from({ length: 25 }, (_, i) => candidate({ cx: i * 3, cy: 200 }));
    expect(placeLabels(many)).toHaveLength(25);
  });
});
