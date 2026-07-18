import type { Challenge } from "./types";

/**
 * Home's post-play "Got a few more minutes?" card and Results' Play-another
 * slot (Increment 5, UX redesign spec §Home + §Race flow beat 3) share one
 * suggestion-state shape. `"empty"` is the documented fallback ("`challenge`
 * is `null` once the caller has started every active, non-daily challenge -
 * the client falls back to 'Create a random new one'"); `"error"` is a
 * failed fetch (never silently reused as "empty" - same F6 discipline as
 * Boards' trend fetch).
 */
export type PlayAnotherSuggestionState =
  | { status: "loading" }
  | { status: "ready"; challenge: Challenge; playerCount: number | null }
  | { status: "empty" }
  | { status: "error" };

/**
 * The suggestion card's affordance copy ("🏁 <start> → <target> · <N>
 * players"). `playerCount` is omitted (not "· 0 players") when unknown -
 * same "degrade gracefully, never fabricate" rule as Browse's own meta line.
 */
export function formatSuggestionTitle(challenge: Challenge, playerCount: number | null): string {
  const base = `🏁 ${challenge.start.title} → ${challenge.target.title}`;
  return playerCount !== null
    ? `${base} · ${playerCount} ${playerCount === 1 ? "player" : "players"}`
    : base;
}

/**
 * On-demand random-challenge loading copy (spec: "bounded fun loading state
 * ('Rolling the dice on Wikipedia… can take ~20s') since the server may take
 * ~25s"). One constant so Browse's bottom action and the null-suggestion
 * slot can never drift apart.
 */
export const RANDOM_CHALLENGE_LOADING_COPY = "Rolling the dice on Wikipedia… can take ~20s";

/**
 * Primitives extracted from a caught `ApiRequestError` by the caller (App.tsx)
 * - kept as plain data here, not the error class itself, so this stays a
 * pure domain function with no dependency on src/services (matching every
 * other file in this directory).
 */
export interface RandomChallengeFailure {
  status: number | null;
  message: string;
  retryAfterSeconds: number | null;
}

/**
 * Create-random error copy (spec: "429 (quota/in-progress) → friendly copy
 * respecting Retry-After; 503 → 'Wikipedia wasn't cooperating — try again'").
 * The server already writes friendly, code-specific 429 copy (in-progress vs.
 * hourly-quota) - this reuses it and appends a Retry-After-derived hint
 * rather than duplicating that prose here, where it could drift from the
 * server's actual wording.
 */
export function describeRandomChallengeError(failure: RandomChallengeFailure): string {
  if (failure.status === 503) {
    return "Wikipedia wasn't cooperating — try again.";
  }
  if (failure.status === 429) {
    return failure.retryAfterSeconds !== null
      ? `${failure.message} (retry in ${formatRetryAfter(failure.retryAfterSeconds)})`
      : failure.message;
  }
  return failure.message || "Could not create a random challenge. Try again.";
}

function formatRetryAfter(seconds: number): string {
  if (seconds >= 60) {
    const minutes = Math.max(1, Math.round(seconds / 60));
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  return `${Math.max(1, seconds)}s`;
}
