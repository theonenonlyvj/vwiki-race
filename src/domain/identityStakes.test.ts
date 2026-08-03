import { describe, expect, it } from "vitest";
import { ghostGuardRequired, guestHasStakes } from "./identityStakes";
import type { AccountStats } from "./types";
import type { VGamesIdentitySession } from "../services/vgamesIdentity";

function session(status: "ghost" | "claimed"): VGamesIdentitySession {
  return { accountId: "acc-1", displayName: "Reks", token: "jwt-1", status };
}

function stats(attempts: number, dailyStreak: number): AccountStats {
  return {
    totals: {
      attempts,
      completed: 0,
      abandoned: 0,
      timedCompleted: 0,
      totalClicks: 0,
      bestClicks: null,
      bestElapsedMs: null,
      averageClicks: 0,
      averageElapsedMs: 0,
    },
    topStarts: [],
    topTargets: [],
    mostVisited: [],
    dailyStreak,
    trend30: { avgPlacement: null, beatRate: null, gradedCount: 0, playedCount: 0, ranked: false, guard: 10 },
  };
}

describe("guestHasStakes", () => {
  it("is false for a null session", () => {
    expect(guestHasStakes(null, stats(3, 0))).toBe(false);
  });

  it("is false for a claimed session, regardless of stats", () => {
    expect(guestHasStakes(session("claimed"), stats(3, 2))).toBe(false);
  });

  it("is false for a ghost with unresolved (null) stats - positive knowledge only", () => {
    expect(guestHasStakes(session("ghost"), null)).toBe(false);
  });

  it("is false for a resolved ghost with zero attempts and zero streak", () => {
    expect(guestHasStakes(session("ghost"), stats(0, 0))).toBe(false);
  });

  it("is true for a ghost with attempts > 0", () => {
    expect(guestHasStakes(session("ghost"), stats(1, 0))).toBe(true);
  });

  it("is true for a ghost with dailyStreak > 0 even if attempts is 0", () => {
    expect(guestHasStakes(session("ghost"), stats(0, 1))).toBe(true);
  });
});

describe("ghostGuardRequired", () => {
  it("is false for a null session", () => {
    expect(ghostGuardRequired(null, null)).toBe(false);
  });

  it("is false for a claimed session with null stats", () => {
    expect(ghostGuardRequired(session("claimed"), null)).toBe(false);
  });

  it("is false for a claimed session with stakes-shaped stats", () => {
    expect(ghostGuardRequired(session("claimed"), stats(5, 3))).toBe(false);
  });

  it("fails safe: true for a ghost with unresolved (null) stats", () => {
    expect(ghostGuardRequired(session("ghost"), null)).toBe(true);
  });

  it("is false for a resolved zero-stakes ghost", () => {
    expect(ghostGuardRequired(session("ghost"), stats(0, 0))).toBe(false);
  });

  it("is true for a resolved ghost with real stakes (attempts)", () => {
    expect(ghostGuardRequired(session("ghost"), stats(4, 0))).toBe(true);
  });

  it("is true for a resolved ghost with real stakes (streak only)", () => {
    expect(ghostGuardRequired(session("ghost"), stats(0, 2))).toBe(true);
  });
});
