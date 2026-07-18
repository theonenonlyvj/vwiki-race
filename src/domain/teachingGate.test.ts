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
  };
}

describe("shouldShowTeachingGate", () => {
  it("shows the gate when stats haven't loaded yet (null - includes brand-new guests with no account)", () => {
    expect(shouldShowTeachingGate(null)).toBe(true);
  });

  it("shows the gate when the account has zero completed races", () => {
    expect(shouldShowTeachingGate(stats(0))).toBe(true);
  });

  it("hides the gate once the account has at least one completed race", () => {
    expect(shouldShowTeachingGate(stats(1))).toBe(false);
    expect(shouldShowTeachingGate(stats(5))).toBe(false);
  });
});
