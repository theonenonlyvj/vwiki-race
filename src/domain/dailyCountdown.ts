import { centralDateKey } from "./challengeSelection";

const CENTRAL_DATETIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

interface CentralWallClockParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function centralWallClockParts(epochMs: number): CentralWallClockParts {
  const parts = Object.fromEntries(
    CENTRAL_DATETIME_FORMATTER.formatToParts(epochMs)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return parts as unknown as CentralWallClockParts;
}

/**
 * Central's UTC offset (in minutes - e.g. -360 for CST, -300 for CDT) in
 * effect AT `epochMs`. Derived, not hardcoded: reinterpreting the Central
 * wall-clock reading at that instant as if it were itself a UTC instant
 * gives a second epoch, and the gap between the two IS the offset. Reads
 * off the same `Intl` timezone database as every other Central-time helper
 * in this file/`challengeSelection.ts` - no DST transition dates/rules are
 * ever encoded here.
 */
function centralUtcOffsetMinutesAt(epochMs: number): number {
  const parts = centralWallClockParts(epochMs);
  const asIfUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((asIfUtc - epochMs) / 60_000);
}

/**
 * The real epoch instant (ms) whose America/Chicago wall clock reads exactly
 * `dateKey hour:00:00`. This is the load-bearing fix (2026-07-19 remainder
 * pass): NOT a wall-clock-delta calculation - `msUntilNextCentralDrop` used
 * to compute "seconds since Central midnight" via `Intl` and subtract that
 * from the drop's own "seconds since midnight," on the assumption that a
 * wall-clock delta IS a real duration. It isn't, across a DST transition:
 * the wall clock skips an hour (spring forward) or repeats one (fall back),
 * so the same subtraction is off by exactly one hour on both US transition
 * days each year, for the whole window between local midnight and the
 * transition. This function instead solves for the true UTC epoch: a first
 * guess (the target's own numbers reinterpreted as UTC, corrected by the
 * offset AT that guess) can land on the wrong side of a transition when the
 * transition falls between `now` and the target (exactly today's/tonight's
 * failure case) - re-probing the offset AT that first guess and re-solving
 * converges on the true instant. One correction round always suffices:
 * America/Chicago's UTC offset only ever takes one of two values, and the
 * first guess is already within a few hours of the true instant (nowhere
 * near a THIRD offset region to worry about).
 *
 * Exported (FB-10 fixer pass, `dailyTrends.ts`'s
 * `dailyTrendWindowCreatedAtBounds`): the same DST-correct Central-date ->
 * UTC-instant conversion is also what turns a trend window's Central-date
 * boundaries into `created_at`-comparable ISO bounds, instead of
 * `listDailyTrends` binding one SQL param per in-window challenge (the "F1
 * hard fuse" bind-cap bug class - see that function's own comment).
 */
export function centralWallClockEpoch(dateKey: string, hour: number): number {
  const [year, month, day] = dateKey.split("-").map(Number);
  const targetAsIfUtc = Date.UTC(year, month - 1, day, hour, 0, 0);
  const firstGuessOffset = centralUtcOffsetMinutesAt(targetAsIfUtc);
  const firstGuessEpoch = targetAsIfUtc - firstGuessOffset * 60_000;
  const correctedOffset = centralUtcOffsetMinutesAt(firstGuessEpoch);
  return targetAsIfUtc - correctedOffset * 60_000;
}

/**
 * Pure calendar-date arithmetic (like `challengeSelection.ts`'s
 * `centralDateDaysBefore`, just +1 instead of -N) - not a real-timezone
 * computation. `dateKey` is already a Central date key, so this only ever
 * needs to walk the calendar forward one day, correctly across month/year
 * boundaries.
 */
function nextCentralCalendarDate(dateKey: string): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/**
 * Milliseconds from `now` until the next `dropHour:00:00` Central-time
 * instant at/after it (Home pre-play's "time left today" readout - PKG-07,
 * council 2026-07-19, owner-proxy ruling: "live countdown to 5:00 AM
 * Central... using the existing Central-date domain helpers"). Defaults to
 * 5 AM, the daily drop's real schedule (see wrangler.api.toml's dual UTC
 * crons for the same instant).
 *
 * DST-safe by construction, but not via wall-clock-delta arithmetic (see
 * `centralWallClockEpoch`'s doc comment for the 2026-07-19 fix - the
 * previous version of this comment claimed "seconds since Central midnight
 * integer arithmetic is exact," which was wrong): determining WHICH
 * calendar day the next drop falls on is a same-face wall-clock comparison
 * ("is 1:00 before 5:00"), which stays unambiguous regardless of DST - a
 * reading of the clock face doesn't care how many actual seconds separate
 * two readings. But the actual COUNTDOWN is computed against the real UTC
 * epoch of that target instant, never a wall-clock subtraction.
 */
export function msUntilNextCentralDrop(now: Date, dropHour = 5): number {
  if (!Number.isFinite(now.getTime())) {
    throw new Error("A valid date is required.");
  }

  const parts = centralWallClockParts(now.getTime());
  const secondsSinceCentralMidnight = parts.hour * 3600 + parts.minute * 60 + parts.second;
  const dropSeconds = dropHour * 3600;
  const todayCentral = centralDateKey(now);
  const targetDateKey = secondsSinceCentralMidnight < dropSeconds
    ? todayCentral
    : nextCentralCalendarDate(todayCentral);

  const dropEpoch = centralWallClockEpoch(targetDateKey, dropHour);
  return dropEpoch - now.getTime();
}

/**
 * "Time left today" copy for `msUntilNextCentralDrop`'s output (mockup-
 * home-stateful-v2/mockup-target-preview: "1:23 left today"). Sub-hour
 * remainders drop the leading hour segment entirely (matching the mockup's
 * own two-segment example) rather than padding a permanent "0:" prefix;
 * once an hour or more remains the full H:MM:SS shows so the readout never
 * implies false sub-minute precision this early in the countdown.
 */
export function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)} left today`
    : `${minutes}:${pad(seconds)} left today`;
}
