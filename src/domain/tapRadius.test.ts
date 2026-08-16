import { describe, expect, it } from "vitest";
import { MAX_TAP_RADIUS, MIN_TAP_RADIUS, tapRadiusFor, type TapPoint } from "./tapRadius";

function overlappingPairs(points: TapPoint[], radius: number): number {
  let count = 0;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const gap = Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y);
      if (gap < radius * 2 - 1e-6) count++;
    }
  }
  return count;
}

describe("tapRadiusFor", () => {
  it("uses the full target when the nodes are far apart", () => {
    expect(tapRadiusFor([{ x: 0, y: 0 }, { x: 400, y: 0 }])).toBe(MAX_TAP_RADIUS);
  });

  it("keeps the full target for a lone node", () => {
    expect(tapRadiusFor([{ x: 10, y: 10 }])).toBe(MAX_TAP_RADIUS);
  });

  it("returns the full target for no nodes at all", () => {
    expect(tapRadiusFor([])).toBe(MAX_TAP_RADIUS);
  });

  // The real portrait numbers: ~14.5 units between hops on a 37-hop path and
  // ~25 across 11 lanes. A flat 22 makes every one of these overlap, and the
  // node later in progress order silently wins the tap.
  it("shrinks below the spacing of a dense portrait path", () => {
    const hops = Array.from({ length: 37 }, (_, i) => ({ x: 160, y: 40 + i * 14.5 }));
    const radius = tapRadiusFor(hops);

    expect(radius).toBeLessThan(MAX_TAP_RADIUS);
    expect(overlappingPairs(hops, radius)).toBe(0);
    expect(overlappingPairs(hops, MAX_TAP_RADIUS)).toBeGreaterThan(0);
  });

  it("shrinks below the lane spacing of a full field", () => {
    const lanes = Array.from({ length: 11 }, (_, i) => ({ x: 10 + i * 25, y: 300 }));
    const radius = tapRadiusFor(lanes);

    expect(overlappingPairs(lanes, radius)).toBe(0);
    expect(overlappingPairs(lanes, MAX_TAP_RADIUS)).toBeGreaterThan(0);
  });

  it("never shrinks so far that the target is smaller than the dot", () => {
    // Two nodes almost on top of each other: honouring half the gap literally
    // would produce a sub-pixel target nobody could hit.
    expect(tapRadiusFor([{ x: 100, y: 100 }, { x: 100.4, y: 100 }])).toBe(MIN_TAP_RADIUS);
  });

  it("ignores coincident nodes rather than collapsing to zero", () => {
    // Two nodes at the identical point cannot be separated by any radius, so
    // they must not drag every other target down with them.
    expect(tapRadiusFor([{ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 500, y: 500 }])).toBe(
      MAX_TAP_RADIUS,
    );
  });
});
