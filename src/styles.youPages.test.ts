import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// Ambient types for the two Node builtins above: see ./race/node-builtins.d.ts.

/**
 * You's stats layout (owner feedback, 2026-08-15: "this layout is ugly").
 * Two structural facts the fix hinges on, pinned here for the same reason
 * styles.boardsTrendPhoneRestack.test.ts pins its own - jsdom can't
 * evaluate real grid layout or `@media`, so these are assertions against
 * the compiled stylesheet SOURCE. Real-device visual verification happens
 * separately.
 */
describe("You stats layout (styles.css)", () => {
  const css = readFileSync(join(__dirname, "styles.css"), "utf-8");

  function mediaBlockBody(query: string): string {
    const marker = `@media ${query} {`;
    const start = css.indexOf(marker);
    expect(start, `expected to find "${marker}" in styles.css`).toBeGreaterThanOrEqual(0);
    let depth = 0;
    let i = start + marker.length - 1;
    for (; i < css.length; i++) {
      if (css[i] === "{") depth++;
      if (css[i] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    return css.slice(start + marker.length, i);
  }

  /**
   * The full-width span on the last stat tile was written (PKG-09) when
   * You rendered SEVEN tiles: 7 into 3 columns leaves the last one alone
   * on its row, and stretching it read as deliberate. You renders NINE now
   * (QF-09 added Avg speed among others), and 9 tiles into 3 columns fill
   * exactly - so an unconditional `:last-child` span punched a hole in row
   * 3 and stretched a tile that had two perfectly good neighbours. Gating
   * the span on the tile actually BEING the orphan makes the rule survive
   * the next tile-count change instead of needing another hand-edit.
   */
  it("spans the last stat tile only when it is genuinely alone on its row", () => {
    expect(css).toContain(".stat-grid div:last-child:nth-child(3n + 1)");
    // The ungated form is what produced the reported hole - it must be gone.
    expect(css).not.toMatch(/\.stat-grid div:last-child\s*\{/);
  });

  it("re-gates the span for the two-column phone grid, where 9 tiles DO leave an orphan", () => {
    const body = mediaBlockBody("(max-width: 980px)");
    expect(body).toContain(".stat-grid div:last-child:nth-child(2n + 1)");
  });

  /**
   * The reported ugliness: You's two-segment control reused
   * `.board-segment-control`, whose `grid-auto-flow: column` auto tracks
   * absorb free space. That reads as a control at Boards' FIVE segments
   * (~20% each) and as two slabs at You's two (~50% each). You gets its
   * own content-sized control instead of a wider fix, so Boards - shipped,
   * tested, and correct at its own segment count - is not touched.
   */
  it("sizes You's page switch to its content instead of stretching it", () => {
    const start = css.indexOf(".you-pages-switch {");
    expect(start, "expected a .you-pages-switch rule").toBeGreaterThanOrEqual(0);
    const rule = css.slice(start, css.indexOf("}", start));
    expect(rule).toContain("inline-flex");
    expect(rule).not.toContain("grid-auto-flow");
  });

  it("drives the row bar's length from the --fill custom property the component sets", () => {
    const start = css.indexOf(".you-pages-list li::before {");
    expect(start, "expected a .you-pages-list li::before rule").toBeGreaterThanOrEqual(0);
    const rule = css.slice(start, css.indexOf("}", start));
    expect(rule).toContain("var(--fill");
    // The bar sits BEHIND the row's text; a positioned pseudo-element
    // would otherwise paint over its static siblings.
    expect(rule).toContain("z-index: 0");
  });
});
