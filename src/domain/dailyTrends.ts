import { centralDateDaysBefore } from "./challengeSelection";

/**
 * Boards' rolling-trend windows (Increment 4, UX redesign spec §Boards -
 * "7d/30d/lifetime" paragraph; §Data requirements - "Rolling avg placement").
 * `windowDays` is `null` for lifetime (no window, all dailies ever played).
 */
export type TrendWindowDays = 7 | 30 | null;

/**
 * Participation guard (spec: "must have played ≥⅓ of the window's dailies
 * to be ranked (7d → ≥3, 30d → ≥10; lifetime → ≥10 total)"). These are fixed
 * thresholds, not `windowDays / 3` of however many dailies actually exist in
 * that window yet - a young catalog with only 5 dailies ever played still
 * requires 10 to rank on 30d/lifetime, exactly as the spec's parenthetical
 * spells out (not a derived fraction of "dailies that exist").
 */
export function dailyTrendGuard(windowDays: TrendWindowDays): number {
  return windowDays === null ? 10 : Math.ceil(windowDays / 3);
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
