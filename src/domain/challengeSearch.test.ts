import { describe, expect, it } from "vitest";
import {
  filterChallengesByQuery,
  matchesChallengeQuery,
  resolveChallengeIdFromSearchInput,
} from "./challengeSearch";
import type { Challenge } from "./types";

function challenge(overrides: Partial<Challenge> = {}): Challenge {
  return {
    id: "challenge-0001",
    label: "Challenge #1",
    mode: "daily",
    start: { title: "Apple" },
    target: { title: "Fruit" },
    ruleset: "ranked_classic",
    source: "curated",
    ...overrides,
  };
}

describe("matchesChallengeQuery / filterChallengesByQuery", () => {
  it("matches everything on a blank query", () => {
    expect(matchesChallengeQuery(challenge(), "  ")).toBe(true);
  });

  it("matches start title, target title, or label case-insensitively", () => {
    expect(matchesChallengeQuery(challenge(), "apple")).toBe(true);
    expect(matchesChallengeQuery(challenge(), "FRUIT")).toBe(true);
    expect(matchesChallengeQuery(challenge(), "challenge #1")).toBe(true);
    expect(matchesChallengeQuery(challenge(), "mars")).toBe(false);
  });

  it("filters a list down to matching challenges only", () => {
    const challenges = [
      challenge({ id: "challenge-0001", start: { title: "Apple" }, target: { title: "Fruit" } }),
      challenge({ id: "challenge-0002", label: "Challenge #2", start: { title: "Mars" }, target: { title: "Water" } }),
    ];
    expect(filterChallengesByQuery(challenges, "water").map((c) => c.id)).toEqual(["challenge-0002"]);
  });
});

describe("resolveChallengeIdFromSearchInput", () => {
  const challenges = [challenge({ id: "challenge-0001" }), challenge({ id: "challenge-0002", label: "Challenge #2" })];

  it("resolves a pasted share link's ?challenge= id when it's known", () => {
    expect(
      resolveChallengeIdFromSearchInput(
        "https://vwikirace.pages.dev/?challenge=challenge-0002",
        challenges,
      ),
    ).toBe("challenge-0002");
  });

  it("resolves a bare known challenge id", () => {
    expect(resolveChallengeIdFromSearchInput("challenge-0001", challenges)).toBe("challenge-0001");
  });

  it("ignores surrounding whitespace", () => {
    expect(resolveChallengeIdFromSearchInput("  challenge-0001  ", challenges)).toBe("challenge-0001");
  });

  it("returns null for a share link whose id isn't in the current catalog", () => {
    expect(
      resolveChallengeIdFromSearchInput(
        "https://vwikirace.pages.dev/?challenge=challenge-9999",
        challenges,
      ),
    ).toBeNull();
  });

  it("returns null for an unrelated URL, a title query, or an unknown bare id", () => {
    expect(resolveChallengeIdFromSearchInput("https://en.wikipedia.org/wiki/Apple", challenges)).toBeNull();
    expect(resolveChallengeIdFromSearchInput("apple", challenges)).toBeNull();
    expect(resolveChallengeIdFromSearchInput("challenge-9999", challenges)).toBeNull();
    expect(resolveChallengeIdFromSearchInput("", challenges)).toBeNull();
  });
});
