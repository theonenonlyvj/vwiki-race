import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// Ambient types for the two Node builtins above: see ./node-builtins.d.ts.

/**
 * HD-1 regression guard: two live-DOM-caught CSS bugs jsdom can't see on its
 * own (no real layout/paint), locked in here as raw-source assertions the
 * same way raceHudScrollMargin.test.ts guards the scroll-margin-top fix.
 *
 * 1) Popover right-anchor (owner report - Target chip moved flush right in
 *    the one-row HUD; brief: "popover anchoring must still work from the
 *    right edge... anchor right or clamp"). `.target-preview-popover` was
 *    `left: 0` (fine when the target chip hugged the Run chip's left side,
 *    pre-HD-1) - now anchored `right: 0` instead, so it lines up under the
 *    Target chip rather than opening far away from it on a wide viewport.
 *    `width: min(420px, 100%)` (unchanged) caps it at `.race-hud`'s own
 *    padding-box width regardless of which edge it grows from, so anchoring
 *    right can't reopen a left-edge overflow - verified with Playwright at
 *    320/390px (hd1-after-*-popover.png), no jsdom substitute for that part.
 *
 * 2) race-hud/path-strip stacking order (pre-existing since RC-1, HD-1
 *    surfaced it): `.path-strip` is a CSS Grid item of `.race-mode`, so its
 *    `z-index` is honored even though `.race-mode .path-strip` forces
 *    `position: static` (the same grid/flex-item carve-out that lets
 *    z-index apply without `position` being non-static). With `.race-hud`
 *    previously at z-index 5 and `.path-strip` at 15, the popover - an
 *    absolutely-positioned child confined to `.race-hud`'s own (lower)
 *    stacking context - rendered partially or fully hidden behind
 *    `.path-strip` any time they visually overlapped (which they do: the
 *    popover opens directly under the Target chip, right next to where
 *    path-strip sits). `.race-hud`'s z-index must stay above
 *    `.path-strip`'s for the popover to actually be visible.
 */
describe("race HUD popover anchoring + stacking (HD-1 regression guard)", () => {
  const css = readFileSync(join(__dirname, "..", "styles.css"), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  function ruleBody(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
    if (!match) {
      throw new Error(`expected to find a \`${selector} { ... }\` rule`);
    }
    return match[1];
  }

  function zIndexIn(source: string): number {
    const match = source.match(/z-index:\s*(-?\d+)/);
    if (!match) {
      throw new Error("expected a z-index: <n> declaration");
    }
    return Number(match[1]);
  }

  it("anchors the target-preview popover to the right edge, not the left", () => {
    const popoverRule = ruleBody(".target-preview-popover");
    expect(popoverRule).toMatch(/right:\s*0/);
    expect(popoverRule).not.toMatch(/left:\s*0/);
    // Still clamped to race-hud's own width either way - the actual
    // no-overflow guarantee (verified live: hd1-after-*-popover.png).
    expect(popoverRule).toMatch(/width:\s*min\(420px,\s*100%\)/);
  });

  it("keeps race-hud stacked above path-strip so the popover isn't hidden behind it", () => {
    const raceHudZ = zIndexIn(ruleBody(".race-hud"));
    const pathStripZ = zIndexIn(ruleBody(".path-strip"));
    expect(raceHudZ).toBeGreaterThan(pathStripZ);
  });
});
