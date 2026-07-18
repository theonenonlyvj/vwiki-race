import { describe, expect, it } from "vitest";
import { shouldShowTeachingGate } from "./teachingGate";
import type { AccountStats } from "./types";

function stats(completed: number): AccountStats {
  return {
    totals: {
      attempts: completed + 1,
      completed,
      abandoned: 1,
      timedCompleted: completed,
      totalClicks: 4,
      bestClicks: 2,
      bestElapsedMs: 1_500,
      averageClicks: 2,
      averageElapsedMs: 1_500,
    },
    topStarts: [],
    topTargets: [],
    mostVisited: [],
    dailyStreak: 0,
    trend30: { avgPlacement: null, playedCount: 0, ranked: false },
  };
}

describe("shouldShowTeachingGate", () => {
  it("shows the gate for a guest with no identified session at all (nothing to fetch)", () => {
    expect(shouldShowTeachingGate({ hasIdentifiedSession: false, stats: null })).toBe(true);
  });

  it("still shows the gate for a guest even if a stray stats value were present", () => {
    // Shouldn't happen in practice (no session -> nothing to fetch), but
    // "no identified session" alone must be sufficient to show, regardless
    // of stats.
    expect(shouldShowTeachingGate({ hasIdentifiedSession: false, stats: stats(5) })).toBe(true);
  });

  it("M1: hides the gate for an identified session whose stats are still pending (null) - no veteran flash", () => {
    expect(shouldShowTeachingGate({ hasIdentifiedSession: true, stats: null })).toBe(false);
  });

  it("M1: hides the gate for an identified session whose stats fetch errored (null) - not stuck showing forever", () => {
    // Errors and in-flight fetches are indistinguishable at this layer (both
    // surface as stats: null) - both must hide, not just one of them.
    expect(shouldShowTeachingGate({ hasIdentifiedSession: true, stats: null })).toBe(false);
  });

  it("shows the gate once an identified session's stats have loaded and completed is zero", () => {
    expect(shouldShowTeachingGate({ hasIdentifiedSession: true, stats: stats(0) })).toBe(true);
  });

  it("hides the gate once an identified session's loaded stats show at least one completed race", () => {
    expect(shouldShowTeachingGate({ hasIdentifiedSession: true, stats: stats(1) })).toBe(false);
    expect(shouldShowTeachingGate({ hasIdentifiedSession: true, stats: stats(5) })).toBe(false);
  });
});
