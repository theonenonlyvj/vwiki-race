import { describe, expect, it } from "vitest";
import { deriveChallengeStateChip, formatChallengeCardMeta } from "./challengeCard";

describe("deriveChallengeStateChip", () => {
  it("defaults to NEW when the challenge is absent from the bulk outcomes response", () => {
    expect(deriveChallengeStateChip(undefined)).toEqual({ kind: "new", label: "NEW" });
  });

  it("renders DNF for an attempted-never-completed outcome", () => {
    expect(deriveChallengeStateChip({ challengeId: "challenge-0001", outcome: "dnf", best: null }))
      .toEqual({ kind: "dnf", label: "DNF" });
  });

  it("renders the checkmark with time and clicks for a completed outcome (invariant 2: completed beats a later DNF)", () => {
    // The server's bulk outcomes response has already resolved precedence -
    // this fixture models the resolved "completed" entry a challenge with
    // both a completed run AND a later DNF would produce; the client trusts
    // it verbatim rather than re-deriving precedence from raw runs.
    expect(deriveChallengeStateChip({
      challengeId: "challenge-0001",
      outcome: "completed",
      best: { elapsedMs: 42_000, clickCount: 6 },
    })).toEqual({ kind: "completed", label: "✓ 0:42 · 6 clk" });
  });

  it("degrades to a bare checkmark if a completed outcome somehow carries no best (defensive)", () => {
    expect(deriveChallengeStateChip({ challengeId: "challenge-0001", outcome: "completed", best: null }))
      .toEqual({ kind: "completed", label: "✓" });
  });
});

describe("formatChallengeCardMeta", () => {
  it("omits the meta line entirely when the summary hasn't loaded or the challenge is absent", () => {
    expect(formatChallengeCardMeta(undefined)).toBeNull();
  });

  it("renders player count and best time/clicks", () => {
    expect(formatChallengeCardMeta({
      challengeId: "challenge-0001",
      playerCount: 5,
      best: { elapsedMs: 38_000, clickCount: 5 },
    })).toBe("5 players · best 0:38 · 5 clk");
  });

  it("singularizes a lone player", () => {
    expect(formatChallengeCardMeta({ challengeId: "challenge-0001", playerCount: 1, best: null }))
      .toBe("1 player");
  });

  it("omits best when nobody has finished it yet, even with players/DNFs present", () => {
    expect(formatChallengeCardMeta({ challengeId: "challenge-0001", playerCount: 3, best: null }))
      .toBe("3 players");
  });
});
