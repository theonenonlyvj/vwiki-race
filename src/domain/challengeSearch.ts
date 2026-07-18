import type { Challenge } from "./types";

/**
 * Browse's search field (Increment 5, UX redesign spec §Challenges - "search
 * field... filters cards live by title match"). Matches against the pair
 * title and the challenge's own label, case-insensitively - a blank query
 * matches everything (the field's resting state).
 */
export function matchesChallengeQuery(challenge: Challenge, query: string): boolean {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return true;
  const haystack = [challenge.label, challenge.start.title, challenge.target.title]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();
  return haystack.includes(trimmed);
}

export function filterChallengesByQuery(challenges: Challenge[], query: string): Challenge[] {
  return challenges.filter((challenge) => matchesChallengeQuery(challenge, query));
}

/**
 * Browse's search field paste support (spec: "accepts a pasted share link or
 * challenge id" - e.g. `https://vwikirace.pages.dev/?challenge=challenge-0003`
 * or bare `challenge-0003`). Resolves to a challenge id already present in
 * the current catalog, or `null` for anything else - including a
 * syntactically plausible id/URL that doesn't match a real challenge - so
 * the caller falls back to title filtering instead of a broken jump.
 */
export function resolveChallengeIdFromSearchInput(
  input: string,
  challenges: readonly Challenge[],
): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const knownIds = new Set(challenges.map((challenge) => challenge.id));
  const fromUrl = extractChallengeIdFromUrlLike(trimmed);
  if (fromUrl && knownIds.has(fromUrl)) return fromUrl;
  return knownIds.has(trimmed) ? trimmed : null;
}

function extractChallengeIdFromUrlLike(value: string): string | null {
  try {
    return new URL(value).searchParams.get("challenge");
  } catch {
    return null;
  }
}
