import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// Ambient types for the two Node builtins above: see ./race/node-builtins.d.ts.

/**
 * Owner ask (phone leaderboard readability, 2026-08-13): "on phone you
 * can't see usernames and formatting is clunky" on the 7d/30d/lifetime
 * boards - `.trend-row-toggle`'s mobile-default grid (`2.4em minmax(0,1fr)
 * auto`) gives the long, incompressible score column whatever width it
 * needs, collapsing the name track. jsdom can't evaluate real `@media`
 * layout (see styles.dialogFamily.test.ts's own doc comment on why this is
 * a structural assertion against the compiled stylesheet SOURCE, not a
 * rendered-DOM one) - this pins the facts the fix actually hinges on: the
 * restack rules exist, live inside the app's existing phone breakpoint
 * (`@media (max-width: 640px)` - the same one `.board-segment-control`'s
 * own phone-only fix already uses), keep the desktop rule untouched, and
 * never introduce a font-weight above the app's 600 Fredoka ceiling.
 * Real-device/viewport visual verification happens separately.
 */
describe("Boards trend rows: phone restack (styles.css)", () => {
  const css = readFileSync(join(__dirname, "styles.css"), "utf-8");

  function mediaBlockBody(query: string): string {
    const marker = `@media ${query} {`;
    const start = css.indexOf(marker);
    expect(start, `expected to find "${marker}" in styles.css`).toBeGreaterThanOrEqual(0);
    let depth = 0;
    let i = start + marker.length - 1; // position of the opening brace
    for (; i < css.length; i++) {
      if (css[i] === "{") depth++;
      if (css[i] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    return css.slice(start + marker.length, i);
  }

  function rulesIn(body: string, className: string) {
    // Strip CSS comments first - several of this fix's own doc comments
    // mention the very class names being searched for (e.g.
    // "`.trend-row-toggle`'s base 3-column grid..."), which would otherwise
    // get swept into the following rule's captured selector text by the
    // naive regex below (it captures everything since the last "}" up to
    // the next "{", comments included) and break the exact-selector match.
    const withoutComments = body.replace(/\/\*[\s\S]*?\*\//g, "");
    const rules = [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selectorText, ruleBody]) => ({
      selectors: selectorText.split(",").map((selector) => selector.trim()),
      body: ruleBody,
    }));
    return rules.filter((rule) => rule.selectors.includes(className));
  }

  const phoneBlock = mediaBlockBody("(max-width: 640px)");
  const desktopBlock = mediaBlockBody("(min-width: 880px)");

  it("restacks .trend-row-toggle to a 2-column (rank/name) grid inside the phone breakpoint", () => {
    const rules = rulesIn(phoneBlock, ".trend-row-toggle");
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.some((rule) => /grid-template-columns:\s*2\.4em minmax\(0,\s*1fr\)\s*;/.test(rule.body)))
      .toBe(true);
  });

  it("makes .trend-row-score span the full row and indents it to match .board-trend-drilldown's 2.4em convention", () => {
    const rules = rulesIn(phoneBlock, ".trend-row-score");
    expect(rules.length).toBeGreaterThan(0);
    const rule = rules[0]!;
    expect(rule.body).toMatch(/grid-column:\s*1\s*\/\s*-1/);
    expect(rule.body).toMatch(/padding-left:\s*2\.4em/);
  });

  it("restacks the unranked and roster rows to a single column too, sharing the same collapse fix", () => {
    const rules = rulesIn(phoneBlock, ".board-snippet.board-trend-unranked li");
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.some((rule) => /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;/.test(rule.body)))
      .toBe(true);

    const rosterRules = rulesIn(phoneBlock, ".board-snippet.board-roster li");
    expect(rosterRules.length).toBeGreaterThan(0);
  });

  it("never sets a font-weight above the app's 600 Fredoka ceiling in any of the new phone-restack rules", () => {
    for (const className of [
      ".trend-row-toggle",
      ".trend-row-score",
      ".board-snippet.board-trend-unranked li",
      ".board-snippet.board-roster li",
    ]) {
      for (const rule of rulesIn(phoneBlock, className)) {
        const match = rule.body.match(/font-weight:\s*(\d+)/);
        if (match) expect(Number(match[1])).toBeLessThanOrEqual(600);
      }
    }
  });

  it("leaves the desktop (>=880px) .trend-row-toggle layout untouched by this fix", () => {
    const desktopRules = rulesIn(desktopBlock, ".trend-row-toggle");
    expect(desktopRules.length).toBeGreaterThan(0);
    // The pre-existing desktop rule packs rank/name/score adjacent
    // (max-content columns), not the phone restack's 2-column grid.
    expect(desktopRules.some((rule) => /grid-template-columns:\s*2\.4em minmax\(0,\s*max-content\)\s*max-content/.test(rule.body)))
      .toBe(true);
  });
});
