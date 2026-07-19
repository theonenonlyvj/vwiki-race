import type { Challenge } from "./types";

export interface ChallengeSelectionOptions {
  activeChallengeId?: string | null;
  requestedChallengeId?: string | null;
  todayUtc: string;
}

const CENTRAL_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function centralDateKey(value: Date): string {
  if (!Number.isFinite(value.getTime())) {
    throw new Error("A valid date is required.");
  }
  const parts = Object.fromEntries(
    CENTRAL_DATE_FORMATTER.formatToParts(value)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function dailyBadgeLabel(challenge: Challenge, todayCentral: string): string | null {
  const dailyDate = dailyDateForChallenge(challenge);
  if (!dailyDate) return null;
  if (dailyDate === todayCentral) return "Today";
  const [, month, day] = dailyDate.split("-");
  return month && day
    ? `Daily ${Number(month)}/${Number(day)}`
    : "Daily";
}

export function selectDefaultChallenge(
  challenges: Challenge[],
  options: ChallengeSelectionOptions,
): Challenge | null {
  const activeChallenges = challenges.filter((challenge) => challenge.isActive !== false);
  const findById = (id: string | null | undefined) =>
    id ? activeChallenges.find((challenge) => challenge.id === id) ?? null : null;

  return findById(options.activeChallengeId) ??
    findById(options.requestedChallengeId) ??
    activeChallenges.find((challenge) =>
      dailyDateForChallenge(challenge) === options.todayUtc
    ) ??
    activeChallenges[0] ??
    null;
}

export type HomeHeroKind = "today-daily" | "yesterday-daily" | "default";

export interface HomeHeroSelection {
  challenge: Challenge;
  kind: HomeHeroKind;
}

/**
 * Home's hero challenge + how it should be framed (desktop pass, FIX 4 -
 * the pre-drop bug: before the 5:00 AM Central drop, or after a generation
 * failure, `selectDefaultChallenge` silently fell back to the first active
 * challenge and Home presented it as if it were the daily - no badge, no
 * explanation). Order:
 *   1. today's real daily -> "today-daily" (unchanged post-drop behavior);
 *   2. else YESTERDAY's daily when still in the catalog -> "yesterday-daily"
 *      (it's still playable; Home badges it honestly and says when the new
 *      one drops);
 *   3. else the pre-redesign default-challenge fallback -> "default"
 *      (e.g. a catalog with no dailies at all - many test fixtures).
 * Home-only: `selectDefaultChallenge`'s other consumers (Boards' Today
 * segment, App's selection routing) deliberately keep their existing
 * behavior.
 */
export function selectHomeHeroChallenge(
  challenges: Challenge[],
  todayCentral: string,
): HomeHeroSelection | null {
  const activeChallenges = challenges.filter((challenge) => challenge.isActive !== false);
  const todaysDaily = activeChallenges.find((challenge) =>
    dailyDateForChallenge(challenge) === todayCentral
  );
  if (todaysDaily) return { challenge: todaysDaily, kind: "today-daily" };

  const yesterdaysDaily = activeChallenges.find((challenge) =>
    dailyDateForChallenge(challenge) === previousCentralDate(todayCentral)
  );
  if (yesterdaysDaily) return { challenge: yesterdaysDaily, kind: "yesterday-daily" };

  const fallback = selectDefaultChallenge(challenges, { todayUtc: todayCentral });
  return fallback ? { challenge: fallback, kind: "default" } : null;
}

export function dailyDateForChallenge(challenge: Challenge): string | null {
  if (challenge.dailyFeature) return challenge.dailyFeature.dailyDate;
  return challenge.origin === "daily" ? challenge.dailyDate ?? null : null;
}

/**
 * Whether `challenge` is genuinely today's actual daily - not merely "the
 * challenge currently on screen" or a fallback Boards/Home happen to be
 * showing. The one condition that distinguishes "today"/"Today's board"
 * copy (RaceResults' header/board-snippet title) from "on this board"/
 * "Leaderboard" for anything else (an older daily, a custom challenge), and
 * (PKG-05, council 2026-07-19) whether Results' "View leaderboard" exit
 * should land on global Boards or on that challenge's own Challenge Detail
 * leaderboard. One function so RaceResults.tsx and App.tsx's exit routing
 * can't independently drift on the same calculation.
 */
export function isDailyToday(challenge: Challenge, todayCentral: string): boolean {
  return dailyDateForChallenge(challenge) === todayCentral;
}

/**
 * The calendar day immediately before a Central date key (Home's "yesterday's
 * results" recap card - UX redesign spec, Home §Pre-play). Pure calendar-date
 * arithmetic on the "YYYY-MM-DD" string itself, not a real-timezone
 * computation - `dateKey` is already the Central date key produced by
 * `centralDateKey`, so this only ever needs to walk the calendar back one
 * day, correctly across month/year boundaries.
 */
export function previousCentralDate(dateKey: string): string {
  return centralDateDaysBefore(dateKey, 1);
}

/**
 * Boards/Home rolling-trend windows (Increment 4, UX redesign spec §Boards
 * - "7d/30d/lifetime" and §Data requirements - "Rolling avg placement"): the
 * Central date `days` calendar-days before `dateKey`, same pure
 * calendar-date arithmetic as `previousCentralDate` (which is just this with
 * `days = 1`). Used to compute a window's inclusive start date - e.g. a 7-day
 * window ending at `todayCentral` starts at `centralDateDaysBefore(todayCentral, 6)`.
 */
export function centralDateDaysBefore(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}
