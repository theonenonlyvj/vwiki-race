import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Home route readability (styles.css)", () => {
  const css = readFileSync(join(__dirname, "styles.css"), "utf-8");

  function ruleBody(selector: string, source = css): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
  }

  it("keeps Start and Target labels readable", () => {
    expect(ruleBody(".daily-route .daily-route-label")).toMatch(/font-size:\s*0\.75rem/);
  });

  it("stacks long route endpoints at the app's narrowest phone breakpoint", () => {
    const narrowStart = css.indexOf("@media (max-width: 350px)");
    const narrowEnd = css.indexOf("@media (min-width: 880px)", narrowStart);
    const narrow = css.slice(narrowStart, narrowEnd);

    expect(narrowStart).toBeGreaterThanOrEqual(0);
    expect(ruleBody(".daily-route", narrow)).toMatch(
      /grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    );
    expect(ruleBody(".daily-route .route-arrow", narrow)).toMatch(/transform:\s*rotate\(90deg\)/);
  });
});
