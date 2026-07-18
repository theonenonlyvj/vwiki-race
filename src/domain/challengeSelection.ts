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

export function dailyDateForChallenge(challenge: Challenge): string | null {
  if (challenge.dailyFeature) return challenge.dailyFeature.dailyDate;
  return challenge.origin === "daily" ? challenge.dailyDate ?? null : null;
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
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}
