import { describe, expect, it } from "vitest";
import {
  contrastOnInk,
  STRAND_HUES,
  strandStyleForIndex,
  strandStyleKey,
} from "./strandStyle";

// The server caps a challenge's graph at CHALLENGE_PATHS_LIMIT (12) strands.
// Every one of those 12 has to be visually distinct from the other 11 - the
// bug this replaces cycled a 6-hue palette, so an 11-player challenge painted
// 5 pairs of players the SAME color and the legend chip couldn't tell them
// apart.
const SERVED_STRAND_CAP = 12;

describe("strand hue contrast", () => {
  // Solo node titles are painted in their owner's hue on the #061014 ink.
  // They were drawn at alpha 0.65 for visual recession, which put bronze at
  // 2.69:1 and violet at 3.16:1 against the 4.5:1 AA floor for 12px text.
  it("clears WCAG AA for 12px text at full opacity, for every hue", () => {
    for (const hue of STRAND_HUES) {
      expect(contrastOnInk(hue)).toBeGreaterThanOrEqual(4.5);
    }
  });

  // Guards the trap that hid this: compositing rgba() in LINEAR space reports
  // bronze at 3.5:1 rather than its true 2.69:1, which reads as "marginal"
  // instead of "fails". Browsers composite in gamma-encoded sRGB.
  it("composites alpha the way a browser does, not in linear space", () => {
    expect(contrastOnInk("#9f7b00", 0.65)).toBeLessThan(3);
  });
});

describe("strand styles", () => {
  it("gives every hue a distinct value", () => {
    expect(new Set(STRAND_HUES).size).toBe(STRAND_HUES.length);
  });

  it("paints the first strands with plain hues, no dash", () => {
    for (let i = 0; i < STRAND_HUES.length; i++) {
      expect(strandStyleForIndex(i)).toEqual({ color: STRAND_HUES[i], dash: null });
    }
  });

  it("reuses a hue only once it has a dash to tell it apart", () => {
    const first = strandStyleForIndex(0);
    const wrapped = strandStyleForIndex(STRAND_HUES.length);
    expect(wrapped.color).toBe(first.color);
    expect(wrapped.dash).not.toBeNull();
  });

  it("never repeats a (color, dash) pair across every strand the server can serve", () => {
    const keys = Array.from({ length: SERVED_STRAND_CAP }, (_, i) =>
      strandStyleKey(strandStyleForIndex(i)),
    );
    expect(new Set(keys).size).toBe(SERVED_STRAND_CAP);
  });

  it("stays defined well past the served cap rather than returning undefined", () => {
    // Defensive: `runs.length` is server-capped, but a caller that ever grows
    // the cap should get a real style, not `undefined.color` at render time.
    for (let i = 0; i < 60; i++) {
      const style = strandStyleForIndex(i);
      expect(style.color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("treats a negative or fractional index as the first strand", () => {
    expect(strandStyleForIndex(-1)).toEqual(strandStyleForIndex(0));
    expect(strandStyleForIndex(Number.NaN)).toEqual(strandStyleForIndex(0));
  });
});
