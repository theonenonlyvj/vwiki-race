import { describe, expect, it } from "vitest";
import {
  aggregateBeatRate,
  BEAT_RATE_DROP_WORST_THRESHOLD,
  beatRateForPlacement,
  DAILY_TREND_INCLUSION_FLOOR,
  dailyTrendGuard,
  dailyTrendPreviousWindowEnd,
  dailyTrendWindowCreatedAtBounds,
  dailyTrendWindowStart,
  partitionChallengesByTrendWindow,
  trendGuardProgressCopy,
  trendUnrankedProgressCopy,
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

describe("DAILY_TREND_INCLUSION_FLOOR (owner ruling, 2026-07-25: flat, not reality-scaled)", () => {
  it("is a flat 2, unaffected by catalog size", () => {
    expect(DAILY_TREND_INCLUSION_FLOOR).toBe(2);
  });
});

describe("trendGuardProgressCopy (owner ruling, 2026-07-25: replaces the old N/M-challenges fraction)", () => {
  it("gives the plain instruction with no personal progress at zero completions", () => {
    expect(trendGuardProgressCopy(0, DAILY_TREND_INCLUSION_FLOOR)).toBe("Finish 2 races to rank");
  });

  it("acknowledges banked progress with 'more' once at least one completion counts", () => {
    expect(trendGuardProgressCopy(1, DAILY_TREND_INCLUSION_FLOOR)).toBe("Finish 1 more race to rank");
  });

  it("singularizes 'race' when exactly one remains, in either phrasing", () => {
    expect(trendGuardProgressCopy(0, 1)).toBe("Finish 1 race to rank");
    expect(trendGuardProgressCopy(1, 2)).toBe("Finish 1 more race to rank");
  });

  it("pluralizes 'races' when more than one remains", () => {
    expect(trendGuardProgressCopy(0, 3)).toBe("Finish 3 races to rank");
    expect(trendGuardProgressCopy(1, 3)).toBe("Finish 2 more races to rank");
  });

  it("clamps to zero remaining rather than going negative if ever called past the guard", () => {
    expect(trendGuardProgressCopy(5, 2)).toBe("Finish 0 more races to rank");
  });
});

describe("beatRateForPlacement (ranking council, owner-picked Option 2, 2026-08-02: beat-rate ranking)", () => {
  it("grades a solo (field-of-one) finish as null - nobody to beat", () => {
    expect(beatRateForPlacement(1, 1)).toBeNull();
  });

  it("grades a 2-player board to exactly 1.0 (won) or 0.0 (lost) - the ruling's own worked example", () => {
    expect(beatRateForPlacement(1, 2)).toBe(1);
    expect(beatRateForPlacement(2, 2)).toBe(0);
  });

  it("grades the share of OTHER finishers beaten in a larger field", () => {
    // Field of 4: 1st beats all 3 others (1.0); 2nd beats 2 of 3 (0.667);
    // 3rd beats 1 of 3 (0.333); last beats none (0.0).
    expect(beatRateForPlacement(1, 4)).toBe(1);
    expect(beatRateForPlacement(2, 4)).toBeCloseTo(2 / 3);
    expect(beatRateForPlacement(3, 4)).toBeCloseTo(1 / 3);
    expect(beatRateForPlacement(4, 4)).toBe(0);
  });
});

describe("aggregateBeatRate (ranking council, 2026-08-02)", () => {
  it("returns null for zero graded races - an all-solo account needs >= 1 graded race to rank", () => {
    expect(aggregateBeatRate([])).toBeNull();
  });

  it("averages every graded beat when below the drop-worst threshold", () => {
    expect(aggregateBeatRate([1, 0])).toEqual({ beatRate: 0.5, gradedCount: 2, worstDropped: false });
    expect(aggregateBeatRate([1, 1, 0.5])).toEqual({
      beatRate: 0.8333,
      gradedCount: 3,
      worstDropped: false,
    });
  });

  it("does NOT drop the worst race at exactly one below the threshold (3 graded)", () => {
    expect(BEAT_RATE_DROP_WORST_THRESHOLD).toBe(4);
    // Mean of all three: (1+1+0)/3 = 0.6666... -> rounds to 0.6667.
    expect(aggregateBeatRate([1, 1, 0])).toEqual({ beatRate: 0.6667, gradedCount: 3, worstDropped: false });
  });

  it("drops the single worst race at exactly the threshold (4 graded) - 'exactly-4-graded triggers drop-worst'", () => {
    // Worst is the 0; mean of the remaining three 1.0s is 1.0.
    expect(aggregateBeatRate([1, 1, 1, 0])).toEqual({ beatRate: 1, gradedCount: 4, worstDropped: true });
  });

  it("keeps dropping only the single worst race well past the threshold", () => {
    // Worst is 0.2; mean of the remaining four is (1+0.8+0.6+0.4)/4 = 0.7.
    expect(aggregateBeatRate([1, 0.8, 0.6, 0.4, 0.2])).toEqual({
      beatRate: 0.7,
      gradedCount: 5,
      worstDropped: true,
    });
  });

  it("drops exactly one instance on a tie for worst - the mean is unaffected either way since the tied values are equal", () => {
    // Two races tie at 0 (the worst); dropping either one leaves the same
    // remaining set {1, 1, 0} -> mean (1+1+0)/3 = 0.6666... -> rounds to 0.6667.
    expect(aggregateBeatRate([1, 1, 0, 0])).toEqual({ beatRate: 0.6667, gradedCount: 4, worstDropped: true });
  });

  it("rounds the mean to 4 decimal places, not a long floating-point tail", () => {
    // (1 + 1 + 0) / 3 = 0.6666666... - the raw JS division has a long tail.
    const raw = (1 + 1 + 0) / 3;
    expect(String(raw).length).toBeGreaterThan(10);
    expect(aggregateBeatRate([1, 1, 0])?.beatRate).toBe(0.6667);
  });

  it("recomputes fresh from whatever beats are passed in - a previously dropped worst race never 'resurrects' by construction (stateless, no memory across calls)", () => {
    // A 5-race window that drops its worst race...
    const fiveRaceWindow = aggregateBeatRate([1, 0.8, 0.6, 0.4, 0.2]);
    expect(fiveRaceWindow).toMatchObject({ worstDropped: true, gradedCount: 5 });
    // ...shifts down to a 4-race window (the oldest race - the 0.2 worst
    // race - fell out of scope entirely, not "restored"): still >= the
    // threshold, drops whatever's now the worst of the remaining four.
    const fourRaceWindow = aggregateBeatRate([1, 0.8, 0.6, 0.4]);
    expect(fourRaceWindow).toEqual({ beatRate: 0.8, gradedCount: 4, worstDropped: true });
    // ...shifts down again to a 3-race window: now below the threshold, so
    // nothing is dropped at all - every graded race counts.
    const threeRaceWindow = aggregateBeatRate([1, 0.8, 0.6]);
    expect(threeRaceWindow).toEqual({ beatRate: 0.8, gradedCount: 3, worstDropped: false });
  });
});

describe("trendUnrankedProgressCopy (ranking council, 2026-08-02: extends trendGuardProgressCopy for the beat-rate ruling's second gate)", () => {
  it("falls back to the ordinary completion-count copy below the inclusion floor", () => {
    expect(trendUnrankedProgressCopy({ playedCount: 0, gradedCount: 0 }, 2)).toBe("Finish 2 races to rank");
    expect(trendUnrankedProgressCopy({ playedCount: 1, gradedCount: 0 }, 2)).toBe("Finish 1 more race to rank");
  });

  it("gives the head-to-head copy once the floor is cleared but zero races are graded (an all-solo account)", () => {
    expect(trendUnrankedProgressCopy({ playedCount: 2, gradedCount: 0 }, 2)).toBe(
      "Race someone head-to-head to rank",
    );
    expect(trendUnrankedProgressCopy({ playedCount: 5, gradedCount: 0 }, 2)).toBe(
      "Race someone head-to-head to rank",
    );
  });

  it("falls back to the ordinary copy once at least one race is graded, even below the floor (a genuine below-floor account can still have a graded race)", () => {
    // Below the floor (1 < 2) but that 1 completion was graded - the floor
    // message takes priority since finishing more races is the actual next
    // step either way (this account isn't unranked BECAUSE of grading).
    expect(trendUnrankedProgressCopy({ playedCount: 1, gradedCount: 1 }, 2)).toBe(
      "Finish 1 more race to rank",
    );
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
