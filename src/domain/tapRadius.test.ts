import { describe, expect, it } from "vitest";
import { MAX_TAP_RADIUS, tapRadiiFor, type TapPoint } from "./tapRadius";

const worstRadius = (points: TapPoint[]) => Math.min(...tapRadiiFor(points));

function overlappingPairs(points: TapPoint[], radii: number[]): number {
  let count = 0;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const gap = Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y);
      if (gap < radii[i] + radii[j] - 1e-6) count++;
    }
  }
  return count;
}

describe("tapRadiusFor", () => {
  it("uses the full target when the nodes are far apart", () => {
    expect(worstRadius([{ x: 0, y: 0 }, { x: 400, y: 0 }])).toBe(MAX_TAP_RADIUS);
  });

  it("keeps the full target for a lone node", () => {
    expect(worstRadius([{ x: 10, y: 10 }])).toBe(MAX_TAP_RADIUS);
  });

  it("returns nothing for no nodes at all", () => {
    expect(tapRadiiFor([])).toEqual([]);
  });

  // The real portrait numbers: ~14.5 units between hops on a 37-hop path and
  // ~25 across 11 lanes. A flat 22 makes every one of these overlap, and the
  // node later in progress order silently wins the tap.
  it("shrinks below the spacing of a dense portrait path", () => {
    const hops = Array.from({ length: 37 }, (_, i) => ({ x: 160, y: 40 + i * 14.5 }));
    const radii = tapRadiiFor(hops);

    expect(Math.max(...radii)).toBeLessThan(MAX_TAP_RADIUS);
    expect(overlappingPairs(hops, radii)).toBe(0);
    expect(overlappingPairs(hops, hops.map(() => MAX_TAP_RADIUS))).toBeGreaterThan(0);
  });

  it("shrinks below the lane spacing of a full field", () => {
    const lanes = Array.from({ length: 11 }, (_, i) => ({ x: 10 + i * 25, y: 300 }));
    const radii = tapRadiiFor(lanes);

    expect(overlappingPairs(lanes, radii)).toBe(0);
    expect(overlappingPairs(lanes, lanes.map(() => MAX_TAP_RADIUS))).toBeGreaterThan(0);
  });

  // A floor was tried here and it re-created the bug this module exists to
  // prevent: it overrode the half-gap rule for every pair closer than twice
  // the floor, which on a real portrait daily is the FIRST node of nearly
  // every solo stretch. A target that is hard to hit beats one that reliably
  // opens the wrong article.
  it("honours the half-gap rule even for nodes almost on top of each other", () => {
    const radii = tapRadiiFor([{ x: 100, y: 100 }, { x: 100.4, y: 100 }]);
    expect(radii[0]).toBeCloseTo(0.2, 6);
    expect(radii[1]).toBeCloseTo(0.2, 6);
    expect(overlappingPairs([{ x: 100, y: 100 }, { x: 100.4, y: 100 }], radii)).toBe(0);
  });

  it("ignores coincident nodes rather than collapsing to zero", () => {
    // Two nodes at the identical point cannot be separated by any radius.
    expect(tapRadiiFor([{ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 500, y: 500 }])).toEqual([
      MAX_TAP_RADIUS,
      MAX_TAP_RADIUS,
      MAX_TAP_RADIUS,
    ]);
  });

  // One tight pair deep in a solo stretch must not shrink the anchors, which
  // sit in open canvas. A single global minimum did exactly that.
  it("shrinks only the crowded nodes, not the whole graph", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 600, y: 600 },
      { x: 900, y: 900 },
    ];
    const radii = tapRadiiFor(points);

    expect(radii[0]).toBe(2);
    expect(radii[1]).toBe(2);
    expect(radii[2]).toBe(MAX_TAP_RADIUS);
    expect(radii[3]).toBe(MAX_TAP_RADIUS);
    expect(overlappingPairs(points, radii)).toBe(0);
  });

  // The real portrait geometry that the floor was breaking: MIN_GAP_FRAC puts
  // consecutive solo nodes ~5.9 units apart, and a 7-unit floor there covered
  // each node's own centre with its neighbour's target.
  it("never lets a node's own centre fall inside a neighbour's target", () => {
    const stretch = Array.from({ length: 20 }, (_, i) => ({ x: 160, y: 60 + i * 5.9 }));
    const radii = tapRadiiFor(stretch);

    let stolen = 0;
    for (let i = 0; i < stretch.length; i++) {
      for (let j = 0; j < stretch.length; j++) {
        if (i === j) continue;
        const d = Math.hypot(stretch[i].x - stretch[j].x, stretch[i].y - stretch[j].y);
        if (d < radii[j]) stolen++;
      }
    }
    expect(stolen).toBe(0);
  });
});
