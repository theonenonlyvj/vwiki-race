import { centralDateDaysBefore, centralDateKey } from "./challengeSelection";
import { centralWallClockEpoch } from "./dailyCountdown";

/**
 * Boards' rolling-trend windows (Increment 4, UX redesign spec §Boards -
 * "7d/30d/lifetime" paragraph; §Data requirements - "Rolling avg placement").
 * `windowDays` is `null` for lifetime (no window, all challenges ever
 * played). FB-10 (owner ruling, 2026-07-20) generalized these windows from
 * daily-only to every challenge - see `partitionChallengesByTrendWindow`.
 */
export type TrendWindowDays = 7 | 30 | null;

/**
 * Participation guard cap - the ceiling `dailyTrendGuard` clamps to once the
 * catalog has produced enough challenges (spec: 7d → 3, 30d/lifetime → 10).
 */
function dailyTrendGuardCap(windowDays: TrendWindowDays): number {
  return windowDays === 7 ? 3 : 10;
}

/**
 * PKG-14 (owner-proxy ruling, 2026-07-19 - direct owner feedback overriding
 * round-1 council materials): the original fixed guards (7d always 3, 30d/
 * lifetime always 10) assumed a mature catalog. In real prod use, only 4
 * dailies had EVER existed - nobody, including the owner (4/4 played), could
 * ever clear a flat 10-daily lifetime guard. The guard now scales to how
 * many challenges actually exist in the window: `ceil(challengesAvailable /
 * 3)`, clamped to [1, cap] - so a young catalog ranks its earliest players
 * immediately instead of gatekeeping everyone until an arbitrary, unreachable
 * total. With today's 4 dailies the lifetime guard is `ceil(4/3) = 2`; once
 * the catalog has produced enough challenges the clamp keeps the guard from
 * exceeding the spec's original steady-state cap (3 for 7d, 10 for 30d/
 * lifetime). FB-10 (owner ruling, 2026-07-20): `challengesAvailable` now
 * counts every ACTIVE challenge created in the window (not just
 * `daily_features` rows) - see `listDailyTrends` and
 * `partitionChallengesByTrendWindow`'s `activeCount`.
 *
 * SUPERSEDED for `listDailyTrends`'s own ranked/unranked split (owner
 * ruling, 2026-07-25 - "metric-independent ranking changes"): reality-scaling
 * turned out to be the wrong axis entirely - it scaled off catalog SIZE, not
 * whether an account had actually finished anything, so a padded `playedCount`
 * (DNFs counted alongside finishes, see the old `dnf_days`/`played_days`
 * CTEs `listDailyTrends` used to build) could clear a guard of 1 or 2 without
 * a single completed race. `listDailyTrends` now uses the flat
 * `DAILY_TREND_INCLUSION_FLOOR` below instead, gated on COMPLETIONS only.
 * This function and its cap are kept exactly as they were (still fully
 * tested by `dailyTrends.test.ts`) since nothing here was wrong on its own
 * terms - they're simply unused by `listDailyTrends` now. Do not wire this
 * back in without another explicit owner ruling.
 */
export function dailyTrendGuard(windowDays: TrendWindowDays, challengesAvailable: number): number {
  const cap = dailyTrendGuardCap(windowDays);
  return Math.min(cap, Math.max(1, Math.ceil(challengesAvailable / 3)));
}

/**
 * Owner ruling, 2026-07-25 ("metric-independent ranking changes"): replaces
 * `dailyTrendGuard`'s reality-scaled formula for `listDailyTrends`'s own
 * ranked/unranked split with a flat, constant floor - ranked = an account
 * with at least this many COUNTED COMPLETIONS in the window (completed +
 * `board_excluded = 0`, best attempt per challenge - the same dedup
 * `listDailyTrends`'s own `placements` CTE already applies). Deliberately
 * NOT scaled by catalog size and deliberately NOT the same "played"
 * definition `listChallengeDnfs`/`listAllPlayersRoster`/
 * `getAccountDailyStreak` still use elsewhere (a board-visible DNF still
 * counts toward "played" everywhere else, per FB-7) - a DNF no longer helps
 * an account clear THIS guard at all, only a genuine finish does. Still
 * server-echoed on `BoardsTrendsResponse.guard`/`AccountStats.trend30.guard`
 * exactly like the old reality-scaled value was - the client never
 * hardcodes it (F5).
 */
export const DAILY_TREND_INCLUSION_FLOOR = 2;

/**
 * Owner-directed copy for an account below `DAILY_TREND_INCLUSION_FLOOR`
 * (Boards' "not yet ranked" runway list, and Home's below-guard streak/trend
 * chip - both read off the exact same `listDailyTrends` numbers and must
 * never drift apart). Replaces the old "{playedCount}/{guard} challenges"
 * progress framing (a played-OR-DNF count against a reality-scaled guard)
 * now that the guard is flat and purely completion-based:
 *
 * - Zero completions yet: the plain instruction ("Finish 2 races to rank") -
 *   there's no personal progress to acknowledge.
 * - At least one completion: "Finish {remaining} more race(s) to rank" - the
 *   "more" acknowledges the completions already banked.
 *
 * `completedCount` is expected to be `< guard` (ranked accounts don't call
 * this) but the remaining-count math degrades gracefully (clamped to >= 0)
 * if it's ever called with a cleared count.
 */
export function trendGuardProgressCopy(completedCount: number, guard: number): string {
  const remaining = Math.max(0, guard - completedCount);
  const races = `race${remaining === 1 ? "" : "s"}`;
  return completedCount > 0
    ? `Finish ${remaining} more ${races} to rank`
    : `Finish ${remaining} ${races} to rank`;
}

/**
 * The inclusive Central-date start of a fixed-size trend window ending at
 * `todayCentral` - e.g. a 7-day window ending today covers today and the 6
 * days before it. Lifetime (`windowDays: null`) has no start boundary and
 * shouldn't call this.
 */
export function dailyTrendWindowStart(todayCentral: string, windowDays: 7 | 30): string {
  return centralDateDaysBefore(todayCentral, windowDays - 1);
}

/**
 * F3 (trend arrows): the Central-date end of the trend window immediately
 * preceding the one ending at `todayCentral` - spec: "7d: [t-13,t-7]; 30d:
 * [t-59,t-30]". Feeding this back in as the `todayCentral` argument to a
 * second `listDailyTrends(windowDays, ...)` call reproduces exactly that
 * prior window, because a `windowDays`-length window ending `windowDays`
 * days before today starts the calendar day immediately after the current
 * window's own start (`dailyTrendWindowStart`) - e.g. 7d: current window is
 * [t-6,t], so ending the previous window at t-7 gives [t-13,t-7], matching
 * the spec exactly. Lifetime has no "previous window" (spec: no arrow on
 * lifetime) and shouldn't call this.
 */
export function dailyTrendPreviousWindowEnd(todayCentral: string, windowDays: 7 | 30): string {
  return centralDateDaysBefore(todayCentral, windowDays);
}

/** The minimal shape `partitionChallengesByTrendWindow` needs off a `challenges` row. */
export interface TrendChallengeCandidate {
  id: string;
  /** ISO `created_at` timestamp, as stored on `challenges.created_at`. */
  createdAt: string;
  isActive: boolean;
}

/**
 * FB-10 (owner ruling, 2026-07-20 - "stats - lifetime is all challenges, not
 * just daily, same with 7 days - all challenges that a user did that were
 * made in the lagging 7 days"): partitions the full challenge catalog into
 * "belongs to this trend window" by the CHALLENGE'S OWN creation date
 * (Central-date of `created_at`), not `daily_features.daily_date` - this is
 * what generalizes `listDailyTrends` from daily-only to every challenge.
 * `windowDays: null` (lifetime) has no bound at all - every challenge ever
 * is in scope. For dailies, `created_at` is stamped at the ~5:00 AM Central
 * drop (see `d1TrackingRepository.ts`'s daily-feature acceptance), so its
 * Central date is the same calendar day as `daily_date` in the overwhelming
 * common case - this generalizes the pre-FB-10 behavior rather than
 * replacing it.
 *
 * `activeCount` is separately restricted to `isActive` challenges - the
 * guard's denominator (a retired/deactivated challenge, however recently
 * created, never inflates it). `ids` deliberately does NOT filter by
 * `isActive`: a challenge a user played before it was later deactivated
 * must still count toward that user's `playedCount` NUMERATOR (owner
 * ruling) - only the guard denominator is active-gated, never a played
 * count.
 */
export function partitionChallengesByTrendWindow(
  challenges: TrendChallengeCandidate[],
  windowDays: TrendWindowDays,
  todayCentral: string,
): { ids: string[]; activeCount: number } {
  const inWindow = windowDays === null
    ? challenges
    : challenges.filter((challenge) => {
        const createdCentral = centralDateKey(new Date(challenge.createdAt));
        return createdCentral >= dailyTrendWindowStart(todayCentral, windowDays) &&
          createdCentral <= todayCentral;
      });
  return {
    ids: inWindow.map((challenge) => challenge.id),
    activeCount: inWindow.filter((challenge) => challenge.isActive).length,
  };
}

/**
 * The UTC-instant bounds of a 7d/30d trend window's Central-date range,
 * expressed as `created_at`-comparable ISO timestamp strings (FB-10 fixer
 * pass, code review finding: `listDailyTrends` used to filter its main query
 * with a per-challenge `IN (?,?,...)` bind list built from `windowedIds` -
 * the exact "F1 hard fuse" bug class `getAccountDailyStreak` already hit
 * once, since D1 caps bound parameters at ~100/statement and Miniflare
 * doesn't enforce that locally. `created_at` is always a
 * `Date#toISOString()` string (see `d1TrackingRepository.ts`'s
 * `timestamp()`), so it's lexicographically chronological - a challenge
 * belongs to the window iff `start <= created_at < end` for the two bounds
 * this returns, exactly matching `partitionChallengesByTrendWindow`'s
 * Central-date filter (`createdCentral >= windowStart && createdCentral <=
 * todayCentral`) without ever building a per-row bind list. `start` is the
 * UTC instant of Central midnight on the window's first day (inclusive);
 * `end` is the UTC instant of Central midnight on the day AFTER
 * `todayCentral` (exclusive), both resolved once via `centralWallClockEpoch`
 * so DST is handled the same DST-correct way as everywhere else in this
 * app - never a wall-clock-delta calculation. Not used for lifetime
 * (`windowDays: null`), which has no bound at all.
 */
export function dailyTrendWindowCreatedAtBounds(
  todayCentral: string,
  windowDays: 7 | 30,
): { start: string; end: string } {
  const windowStart = dailyTrendWindowStart(todayCentral, windowDays);
  const windowEndExclusiveDate = centralDateDaysBefore(todayCentral, -1);
  return {
    start: new Date(centralWallClockEpoch(windowStart, 0)).toISOString(),
    end: new Date(centralWallClockEpoch(windowEndExclusiveDate, 0)).toISOString(),
  };
}
