import { describe, expect, it } from "vitest";
import { describeRandomChallengeError, formatSuggestionTitle } from "./playAnother";
import type { Challenge } from "./types";

const challenge: Challenge = {
  id: "challenge-0002",
  label: "Challenge #2",
  mode: "solo",
  start: { title: "Mars" },
  target: { title: "Water" },
  ruleset: "ranked_classic",
  source: "curated",
};

describe("formatSuggestionTitle", () => {
  it("renders the flag, the pair, and player count", () => {
    expect(formatSuggestionTitle(challenge, 4)).toBe("🏁 Mars → Water · 4 players");
  });

  it("singularizes a lone player", () => {
    expect(formatSuggestionTitle(challenge, 1)).toBe("🏁 Mars → Water · 1 player");
  });

  it("omits player count when unknown rather than fabricating 0", () => {
    expect(formatSuggestionTitle(challenge, null)).toBe("🏁 Mars → Water");
  });
});

describe("describeRandomChallengeError", () => {
  it("overrides 503 with the mandated Wikipedia-specific copy", () => {
    expect(describeRandomChallengeError({
      status: 503,
      message: "Could not find a random challenge right now. Try again.",
      retryAfterSeconds: 5,
    })).toBe("Wikipedia wasn't cooperating — try again.");
  });

  it("appends a Retry-After hint (seconds) to the server's 429 message", () => {
    expect(describeRandomChallengeError({
      status: 429,
      message: "A random challenge request is already in progress for this account.",
      retryAfterSeconds: 5,
    })).toBe("A random challenge request is already in progress for this account. (retry in 5s)");
  });

  it("appends a Retry-After hint (minutes) for the hourly quota", () => {
    expect(describeRandomChallengeError({
      status: 429,
      message: "You've reached the hourly limit for random challenges. Try again later.",
      retryAfterSeconds: 3600,
    })).toBe("You've reached the hourly limit for random challenges. Try again later. (retry in 60 minutes)");
  });

  it("uses the server's 429 message as-is when there's no Retry-After", () => {
    expect(describeRandomChallengeError({ status: 429, message: "Too many requests.", retryAfterSeconds: null }))
      .toBe("Too many requests.");
  });

  it("falls back to a generic message for anything else, including a missing message", () => {
    expect(describeRandomChallengeError({ status: 500, message: "", retryAfterSeconds: null }))
      .toBe("Could not create a random challenge. Try again.");
    expect(describeRandomChallengeError({ status: null, message: "Network error.", retryAfterSeconds: null }))
      .toBe("Network error.");
  });
});
