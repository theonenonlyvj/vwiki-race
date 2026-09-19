import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Browse responsive archive styles", () => {
  const stylesheet = join(__dirname, "Browse.css");

  it("provides a dedicated responsive layout for the archive and create controls", () => {
    const css = readFileSync(stylesheet, "utf-8");
    expect(css).toMatch(/\.browse-toolbar\s*\{/);
    expect(css).toMatch(/\.browse-filter-control\s*\{/);
    expect(css).toMatch(/@media\s*\(max-width:\s*640px\)/);
    expect(css).toMatch(/\.browse-create-panel[\s\S]*grid-template-columns:\s*1fr/);
  });
});
