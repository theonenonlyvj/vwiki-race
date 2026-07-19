const CENTRAL_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  hour12: false,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/**
 * Milliseconds from `now` until the next `dropHour:00:00` Central-time
 * instant at/after it (Home pre-play's "time left today" readout - PKG-07,
 * council 2026-07-19, owner-proxy ruling: "live countdown to 5:00 AM
 * Central... using the existing Central-date domain helpers"). Defaults to
 * 5 AM, the daily drop's real schedule (see wrangler.api.toml's dual UTC
 * crons for the same instant).
 *
 * DST-safe by construction: this only ever reasons about Central WALL-CLOCK
 * hour/minute/second, read via `Intl` exactly the way `centralDateKey`'s
 * sibling `CENTRAL_DATE_FORMATTER` already does in challengeSelection.ts -
 * never by adding/subtracting a raw UTC offset across a transition (the
 * bug class that would silently drift by an hour on the two US DST
 * transition days each year). A wall-clock 5:00 AM is unambiguous on both
 * transition days - the spring-forward/fall-back jump always lands at 2 AM
 * Central, never 5 AM - so simple "seconds since Central midnight" integer
 * arithmetic is exact without any timezone-offset math at all.
 */
export function msUntilNextCentralDrop(now: Date, dropHour = 5): number {
  if (!Number.isFinite(now.getTime())) {
    throw new Error("A valid date is required.");
  }

  const parts = Object.fromEntries(
    CENTRAL_TIME_FORMATTER.formatToParts(now)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  ) as { hour: number; minute: number; second: number };

  const secondsSinceCentralMidnight = parts.hour * 3600 + parts.minute * 60 + parts.second;
  const dropSeconds = dropHour * 3600;
  const secondsUntilDrop = secondsSinceCentralMidnight < dropSeconds
    ? dropSeconds - secondsSinceCentralMidnight
    : dropSeconds + 24 * 3600 - secondsSinceCentralMidnight;
  return secondsUntilDrop * 1000;
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
