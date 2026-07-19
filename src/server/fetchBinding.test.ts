import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Regression guard for the 2026-07-18/19 daily-drop outage: passing the bare
 * global `fetch` into a factory options object and later invoking it as
 * `options.fetchImpl(...)` binds `this` to the options object, and workerd
 * throws "TypeError: Illegal invocation" on EVERY request (empirically
 * reproduced against compatibility_date 2026-07-08; direct and detached
 * calls succeed). jsdom/vitest fetch is not `this`-sensitive, so only this
 * source-shape check can catch the pattern in CI.
 *
 * Rule: never hand a factory the bare global — wrap it:
 *   fetchImpl: (input, init) => fetch(input, init)
 * (or detach to a local const before calling, as createWikimediaBudget does).
 */
describe("workerd fetch binding", () => {
  it("no factory receives the bare global fetch as fetchImpl", () => {
    for (const file of ["worker.ts", "dailyCandidateEvaluator.ts", "editorialTargetPools.ts", "wikipediaChallengeValidator.ts", "vgamesIdentityClient.ts"]) {
      const source = readFileSync(join(__dirname, file), "utf-8");
      expect(source, `${file} passes the bare global fetch as fetchImpl`).not.toMatch(/fetchImpl:\s*fetch\s*[,}]/);
    }
  });

  it("createWikimediaBudget never calls fetchImpl as a method of its options", () => {
    const source = readFileSync(join(__dirname, "dailyCandidateEvaluator.ts"), "utf-8");
    expect(source).not.toMatch(/options\.fetchImpl\(/);
  });
});
