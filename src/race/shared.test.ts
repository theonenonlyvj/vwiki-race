import { describe, expect, it } from "vitest";
import type { Challenge } from "../domain/types";
import { composeShareText } from "./shared";

/**
 * FB-5 (owner decision 9, "emoji-grid share text, whatever's sexy, keep
 * small") unit coverage for the click-trail line composeShareText appends
 * under the label/score line. App.test.tsx exercises the full composed
 * string end to end (through the Share result button); these tests isolate
 * just the trail's win/DNF/overflow shapes without a full render.
 */

function challenge(overrides: Partial<Challenge> = {}): Challenge {
  return {
    id: "challenge-0001",
    label: "Challenge #1",
    mode: "solo",
    start: { title: "Apple" },
    target: { title: "Fruit" },
    ruleset: "ranked_classic",
    source: "curated",
    ...overrides,
  };
}

describe("composeShareText click trail (FB-5, owner decision 9)", () => {
  it("draws one 🟦 per click ending in 🏁 for a completed run", () => {
    const text = composeShareText(challenge(), {
      elapsedMs: 42_000,
      clicks: 6,
      rank: 3,
      status: "completed",
    });

    expect(text).toBe(
      `VWiki Race — Challenge #1 — #3 · 0:42 · 6 clk\n🟦🟦🟦🟦🟦🟦🏁\n${window.location.origin}/?challenge=challenge-0001`,
    );
  });

  it("ends the trail in 🟥 DNF instead of 🏁 for a DNF", () => {
    const text = composeShareText(challenge(), {
      elapsedMs: 8_000,
      clicks: 1,
      rank: null,
      status: "dnf",
    });

    expect(text).toBe(
      `VWiki Race — Challenge #1 — DNF · 0:08 · 1 clk — beat that\n🟦🟥 DNF\n${window.location.origin}/?challenge=challenge-0001`,
    );
  });

  it("switches to a compact 🟦×N form once clicks exceed the 10-square cap", () => {
    const text = composeShareText(challenge(), {
      elapsedMs: 65_000,
      clicks: 14,
      rank: 1,
      status: "completed",
    });

    expect(text).toBe(
      `VWiki Race — Challenge #1 — #1 · 1:05 · 14 clk\n🟦×14🏁\n${window.location.origin}/?challenge=challenge-0001`,
    );
  });

  it("keeps the overflow form for an over-cap DNF too", () => {
    const text = composeShareText(challenge(), {
      elapsedMs: 90_000,
      clicks: 40,
      rank: null,
      status: "dnf",
    });

    expect(text).toBe(
      `VWiki Race — Challenge #1 — DNF · 1:30 · 40 clk — beat that\n🟦×40🟥 DNF\n${window.location.origin}/?challenge=challenge-0001`,
    );
  });

  it("draws exactly 10 squares at the cap boundary (no overflow form yet)", () => {
    const text = composeShareText(challenge(), {
      elapsedMs: 20_000,
      clicks: 10,
      rank: 2,
      status: "completed",
    });

    expect(text).toBe(
      `VWiki Race — Challenge #1 — #2 · 0:20 · 10 clk\n🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🏁\n${window.location.origin}/?challenge=challenge-0001`,
    );
  });

  it("keeps the URL as the final line, after the trail", () => {
    const text = composeShareText(challenge(), {
      elapsedMs: 1_000,
      clicks: 1,
      rank: 1,
      status: "completed",
    });
    const lines = text.split("\n");

    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe(`${window.location.origin}/?challenge=challenge-0001`);
  });
});
