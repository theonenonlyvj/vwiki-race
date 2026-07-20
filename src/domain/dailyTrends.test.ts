import { describe, expect, it } from "vitest";
import {
  dailyTrendGuard,
  dailyTrendPreviousWindowEnd,
  dailyTrendWindowCreatedAtBounds,
  dailyTrendWindowStart,
  partitionChallengesByTrendWindow,
  type TrendChallengeCandidate,
} from "./dailyTrends";

describe("dailyTrendGuard (PKG-14: reality-scaled, not a flat threshold)", () => {
  it("scales lifetime to ceil(dailiesAvailable / 3): 4 dailies -> guard 2 (the exact prod scenario)", () => {
    expect(dailyTrendGuard(null, 4)).toBe(2);
  });

  it("floors every window at 1 - a single daily ever played still ranks its player", () => {
    expect(dailyTrendGuard(7, 1)).toBe(1);
    expect(dailyTrendGuard(30, 1)).toBe(1);
    expect(dailyTrendGuard(null, 1)).toBe(1);
  });

  it("floors at 1 even with zero dailies available (never divides down to 0)", () => {
    expect(dailyTrendGuard(7, 0)).toBe(1);
    expect(dailyTrendGuard(30, 0)).toBe(1);
    expect(dailyTrendGuard(null, 0)).toBe(1);
  });

  it("caps the 7-day window at 3 once its (at most 7) dailies would ceil past it", () => {
    expect(dailyTrendGuard(7, 7)).toBe(3);
    // A 7d window can never exceed 7 daily_features rows, but the cap still
    // holds defensively if it somehow did.
    expect(dailyTrendGuard(7, 21)).toBe(3);
  });

  it("caps the 30-day window at 10 once 30 dailies have run", () => {
    expect(dailyTrendGuard(30, 30)).toBe(10);
  });

  it("caps lifetime at 10 once the catalog reaches 30 dailies", () => {
    expect(dailyTrendGuard(null, 30)).toBe(10);
  });

  it("scales the middle of the range too, not just the floor/cap ends", () => {
    expect(dailyTrendGuard(30, 15)).toBe(5);
    expect(dailyTrendGuard(null, 9)).toBe(3);
  });
});

describe("dailyTrendWindowStart", () => {
  it("computes the 7-day window's inclusive start (6 days before today)", () => {
    expect(dailyTrendWindowStart("2026-07-18", 7)).toBe("2026-07-12");
  });

  it("computes the 30-day window's inclusive start (29 days before today)", () => {
    expect(dailyTrendWindowStart("2026-07-18", 30)).toBe("2026-06-19");
  });

  it("carries a 7-day window across a month/year boundary", () => {
    expect(dailyTrendWindowStart("2026-01-03", 7)).toBe("2025-12-28");
  });
});

describe("partitionChallengesByTrendWindow (FB-10: all challenges, not just dailies)", () => {
  const candidate = (
    id: string,
    createdAt: string,
    isActive = true,
  ): TrendChallengeCandidate => ({ id, createdAt, isActive });

  it("lifetime includes every challenge ever, regardless of creation date", () => {
    const challenges = [
      candidate("old", "2020-01-01T12:00:00.000Z"),
      candidate("new", "2026-07-18T12:00:00.000Z"),
    ];
    const { ids, activeCount } = partitionChallengesByTrendWindow(challenges, null, "2026-07-18");
    expect(ids.sort()).toEqual(["new", "old"]);
    expect(activeCount).toBe(2);
  });

  it("a 7d window includes a challenge created exactly at the window's inclusive start", () => {
    // dailyTrendWindowStart("2026-07-18", 7) === "2026-07-12".
    const challenges = [candidate("boundary", "2026-07-12T12:00:00.000Z")];
    const { ids, activeCount } = partitionChallengesByTrendWindow(challenges, 7, "2026-07-18");
    expect(ids).toEqual(["boundary"]);
    expect(activeCount).toBe(1);
  });

  it("excludes a challenge created one calendar day before the 7d window starts", () => {
    const challenges = [candidate("just-outside", "2026-07-11T12:00:00.000Z")];
    const { ids, activeCount } = partitionChallengesByTrendWindow(challenges, 7, "2026-07-18");
    expect(ids).toEqual([]);
    expect(activeCount).toBe(0);
  });

  it("includes a challenge created today (the window's inclusive end)", () => {
    const challenges = [candidate("today", "2026-07-18T12:00:00.000Z")];
    const { ids } = partitionChallengesByTrendWindow(challenges, 7, "2026-07-18");
    expect(ids).toEqual(["today"]);
  });

  it("converts created_at to Central date (not raw UTC date) - a UTC-midnight timestamp falls on the PREVIOUS Central calendar day in July (CDT, UTC-5)", () => {
    // '2026-07-14T00:00:00.000Z' is 2026-07-13T19:00 in Central time.
    const challenges = [candidate("utc-midnight", "2026-07-14T00:00:00.000Z")];
    expect(partitionChallengesByTrendWindow(challenges, 7, "2026-07-13").ids).toEqual(["utc-midnight"]);
    expect(partitionChallengesByTrendWindow(challenges, 7, "2026-07-14").ids).toEqual(["utc-midnight"]);
    // Window ending 2026-07-12 doesn't reach back far enough to cover
    // 2026-07-13, so the Central-date-13 challenge stays out.
    expect(partitionChallengesByTrendWindow(challenges, 7, "2026-07-12").ids).toEqual([]);
  });

  it("a deactivated in-window challenge stays in `ids` (played numerator) but drops out of `activeCount` (guard denominator)", () => {
    const challenges = [
      candidate("active", "2026-07-15T12:00:00.000Z", true),
      candidate("retired", "2026-07-16T12:00:00.000Z", false),
    ];
    const { ids, activeCount } = partitionChallengesByTrendWindow(challenges, 7, "2026-07-18");
    expect(ids.sort()).toEqual(["active", "retired"]);
    expect(activeCount).toBe(1);
  });

  it("an out-of-window challenge is excluded even if active", () => {
    const challenges = [candidate("stale", "2026-06-01T12:00:00.000Z", true)];
    const { ids, activeCount } = partitionChallengesByTrendWindow(challenges, 30, "2026-07-18");
    expect(ids).toEqual([]);
    expect(activeCount).toBe(0);
  });

  it("returns empty when the catalog has no challenges at all", () => {
    expect(partitionChallengesByTrendWindow([], 7, "2026-07-18")).toEqual({ ids: [], activeCount: 0 });
    expect(partitionChallengesByTrendWindow([], null, "2026-07-18")).toEqual({ ids: [], activeCount: 0 });
  });
});

describe("dailyTrendWindowCreatedAtBounds (FB-10 fixer pass: fixed 2-bind `created_at` range, no per-challenge IN list)", () => {
  it("bounds a 7d window at Central midnight of the window start (inclusive) through Central midnight the day after today (exclusive) - July is CDT, UTC-5, so Central midnight is 05:00 UTC", () => {
    // dailyTrendWindowStart("2026-07-18", 7) === "2026-07-12" (asserted above).
    expect(dailyTrendWindowCreatedAtBounds("2026-07-18", 7)).toEqual({
      start: "2026-07-12T05:00:00.000Z",
      end: "2026-07-19T05:00:00.000Z",
    });
  });

  it("bounds a 30d window the same way", () => {
    // dailyTrendWindowStart("2026-07-18", 30) === "2026-06-19" (asserted above).
    expect(dailyTrendWindowCreatedAtBounds("2026-07-18", 30)).toEqual({
      start: "2026-06-19T05:00:00.000Z",
      end: "2026-07-19T05:00:00.000Z",
    });
  });

  it("carries the exclusive end across a month/year boundary (today = Dec 31)", () => {
    const { end } = dailyTrendWindowCreatedAtBounds("2026-12-31", 7);
    expect(end).toBe("2027-01-01T06:00:00.000Z"); // December is CST (UTC-6).
  });

  it("matches partitionChallengesByTrendWindow's own inclusion boundaries exactly - a challenge at the window's inclusive Central-date start is IN, one Central calendar day earlier is OUT", () => {
    const { start } = dailyTrendWindowCreatedAtBounds("2026-07-18", 7);
    const boundaryChallenge: TrendChallengeCandidate = {
      id: "boundary",
      createdAt: "2026-07-12T12:00:00.000Z",
      isActive: true,
    };
    const justOutsideChallenge: TrendChallengeCandidate = {
      id: "just-outside",
      createdAt: "2026-07-11T12:00:00.000Z",
      isActive: true,
    };
    expect(boundaryChallenge.createdAt >= start).toBe(true);
    expect(justOutsideChallenge.createdAt >= start).toBe(false);
    expect(partitionChallengesByTrendWindow([boundaryChallenge], 7, "2026-07-18").ids).toEqual(["boundary"]);
    expect(partitionChallengesByTrendWindow([justOutsideChallenge], 7, "2026-07-18").ids).toEqual([]);
  });

  it("the exclusive end excludes a challenge created exactly at the boundary instant and includes the instant just before it", () => {
    const { end } = dailyTrendWindowCreatedAtBounds("2026-07-18", 7);
    expect(end).toBe("2026-07-19T05:00:00.000Z");
    const justBefore = "2026-07-19T04:59:59.999Z";
    const atBoundary = "2026-07-19T05:00:00.000Z";
    expect(justBefore < end).toBe(true);
    expect(atBoundary < end).toBe(false);
  });
});

describe("dailyTrendPreviousWindowEnd", () => {
  it("computes the 7d previous window as [t-13,t-7]", () => {
    const previousEnd = dailyTrendPreviousWindowEnd("2026-07-18", 7);
    expect(previousEnd).toBe("2026-07-11");
    expect(dailyTrendWindowStart(previousEnd, 7)).toBe("2026-07-05");
  });

  it("computes the 30d previous window as [t-59,t-30]", () => {
    const previousEnd = dailyTrendPreviousWindowEnd("2026-07-18", 30);
    expect(previousEnd).toBe("2026-06-18");
    expect(dailyTrendWindowStart(previousEnd, 30)).toBe("2026-05-20");
  });
});
