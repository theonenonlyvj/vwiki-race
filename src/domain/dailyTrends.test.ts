import { describe, expect, it } from "vitest";
import {
  aggregateBeatRate,
  GOAT_INCLUSION_FLOOR,
  racersBeatenForPlacement,
  scoreForMetric,
  trendFloorForMetric,
  trendMetricForWindow,
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

/**
 * The three windows answer three different questions (owner framing,
 * 2026-08-15), so each ranks by a different aggregation of the same
 * per-race primitive. Drop-worst is GONE everywhere - measured against
 * production as regressive (worth ~7 points to a 4-race player, 1.8 to a
 * 30-race one) while moving only 4 of 16 board positions, each by one
 * place.
 */
describe("aggregateBeatRate (per-window metrics, 2026-08-15)", () => {
  it("returns null for zero graded races - an all-solo account needs >= 1 graded race to rank", () => {
    expect(aggregateBeatRate([], [], "hot")).toBeNull();
  });

  it("averages every graded race, with no race forgiven at any count", () => {
    expect(aggregateBeatRate([1, 0], [1, 0], "hot")).toMatchObject({ beatRate: 0.5, gradedCount: 2 });
    // The old rule dropped the worst at exactly 4 and would have scored
    // this 1.0; every race counts now.
    expect(aggregateBeatRate([1, 1, 1, 0], [3, 3, 3, 0], "hot")).toMatchObject({
      beatRate: 0.75,
      gradedCount: 4,
    });
    // ...and at 5, where the old rule scored 0.7.
    expect(aggregateBeatRate([1, 0.8, 0.6, 0.4, 0.2], [5, 4, 3, 2, 1], "hot")).toMatchObject({
      beatRate: 0.6,
      gradedCount: 5,
    });
  });

  it("rounds the mean to 4 decimal places, not a long floating-point tail", () => {
    const raw = (1 + 1 + 0) / 3;
    expect(String(raw).length).toBeGreaterThan(10);
    expect(aggregateBeatRate([1, 1, 0], [2, 2, 0], "hot")?.beatRate).toBe(0.6667);
  });

  it("sums racers beaten across the window, independent of the share", () => {
    // Beating 4 of 5 once and 1 of 2 once: shares 1.0 and 1.0, but very
    // different numbers of actual humans.
    expect(aggregateBeatRate([1, 1], [4, 1], "showing-up")).toMatchObject({
      beatRate: 1,
      racersBeaten: 5,
    });
  });
});

describe("scoreForMetric - one primitive, three readings", () => {
  it("hot (7d) ranks on the plain rate, because a short window is where a streak lives", () => {
    expect(scoreForMetric("hot", 0.85, 5, 23)).toBe(0.85);
    expect(scoreForMetric("hot", 0.54, 30, 64)).toBe(0.54);
  });

  it("showing-up (30d) ranks on racers beaten, so 30 races outranks a hot 4", () => {
    const regular = scoreForMetric("showing-up", 0.54, 30, 64);
    const hotStreak = scoreForMetric("showing-up", 0.85, 5, 23);
    expect(regular).toBe(64);
    expect(hotStreak).toBe(23);
    expect(regular).toBeGreaterThan(hotStreak);
  });

  it("goat (lifetime) regresses a short record toward the middle", () => {
    // 5 races at 85% is discounted hard; 33 races at 54% barely moves.
    expect(scoreForMetric("goat", 0.85, 5, 23)).toBeCloseTo(0.6167, 3);
    expect(scoreForMetric("goat", 0.54, 33, 70)).toBeCloseTo(0.5307, 3);
  });

  /**
   * The floor and the shrinkage do DIFFERENT jobs, and this pins which is
   * which - because it is tempting to assume shrinkage alone handles the
   * one-lucky-race case, and it does not. Measured: one race at 100%
   * shrinks to 0.5455, which still beats a 33-race record at 54% (0.5307).
   * Cranking the prior high enough to fix that (K ~= 50) would crush every
   * real player into a 0.49-0.52 band and make the board meaningless. So
   * `GOAT_INCLUSION_FLOOR` excludes the one-race account outright, and
   * shrinkage only calibrates belief among those already eligible.
   */
  it("goat: shrinkage does NOT demote a lucky one-race account - the floor is what excludes it", () => {
    const oneLuckyRace = scoreForMetric("goat", 1, 1, 3);
    const longRecord = scoreForMetric("goat", 0.54, 33, 70);
    expect(oneLuckyRace).toBeGreaterThan(longRecord);
    // ...which is precisely why it never reaches the board.
    expect(1).toBeLessThan(trendFloorForMetric("goat"));
  });

  it("goat: among ELIGIBLE records, shrinkage discounts the shorter one", () => {
    // 5 races at 85% is real evidence and still leads - but it is scored at
    // 62%, not 85%, so it has to keep being earned.
    const short = scoreForMetric("goat", 0.85, 5, 23);
    expect(short).toBeLessThan(0.85);
    expect(short).toBeGreaterThan(scoreForMetric("goat", 0.54, 33, 70));
  });
});

describe("trendMetricForWindow / trendFloorForMetric", () => {
  it("maps each window to the question it answers", () => {
    expect(trendMetricForWindow(7)).toBe("hot");
    expect(trendMetricForWindow(30)).toBe("showing-up");
    expect(trendMetricForWindow(null)).toBe("goat");
  });

  it("gives the showing-up board NO floor - hiding people who turned up would defeat it", () => {
    expect(trendFloorForMetric("showing-up")).toBe(0);
  });

  it("requires a couple of races for a rate, and a body of work for a career rate", () => {
    expect(trendFloorForMetric("hot")).toBe(DAILY_TREND_INCLUSION_FLOOR);
    expect(trendFloorForMetric("goat")).toBe(GOAT_INCLUSION_FLOOR);
    expect(GOAT_INCLUSION_FLOOR).toBeGreaterThan(DAILY_TREND_INCLUSION_FLOOR);
  });
});

describe("racersBeatenForPlacement", () => {
  it("counts the humans finished ahead of, not a share", () => {
    expect(racersBeatenForPlacement(1, 5)).toBe(4);
    expect(racersBeatenForPlacement(3, 5)).toBe(2);
    expect(racersBeatenForPlacement(5, 5)).toBe(0);
  });

  it("is zero for a solo finish - nobody to beat", () => {
    expect(racersBeatenForPlacement(1, 1)).toBe(0);
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
