import { formatTimeAndClicks } from "./formatting";
import type { ChallengeOutcomeEntry, ChallengeSummaryEntry } from "./types";

export type ChallengeStateChipKind = "completed" | "dnf" | "new";

export interface ChallengeStateChip {
  kind: ChallengeStateChipKind;
  label: string;
}

/**
 * Browse's per-card state chip (Increment 5, UX redesign spec §Challenges;
 * invariant 2 - "A completion is permanent... precedence `checkmark best` >
 * `DNF` > `NEW`"). The server's bulk outcomes response already resolves this
 * precedence per challenge (one entry, `outcome: "completed" | "dnf"` -
 * `getAccountChallengeOutcomes`'s doc comment: "a completed-eligible run
 * beats a later DNF, permanently") - this function does not re-derive
 * precedence across runs, it just reads the one resolved field. `undefined`
 * (the challenge is absent from the bulk response - no eligible run at all)
 * is the documented default: "NEW".
 */
export function deriveChallengeStateChip(
  outcome: ChallengeOutcomeEntry | undefined,
): ChallengeStateChip {
  if (outcome?.outcome === "completed") {
    return {
      kind: "completed",
      label: outcome.best
        ? `✓ ${formatTimeAndClicks(outcome.best.elapsedMs, outcome.best.clickCount)}`
        : "✓",
    };
  }
  if (outcome?.outcome === "dnf") {
    return { kind: "dnf", label: "DNF" };
  }
  return { kind: "new", label: "NEW" };
}

/**
 * Browse's per-card meta line (spec: "N players · best 0:38 · 5 clk").
 * `undefined` (the challenge is absent from the summary response, or the
 * summary hasn't loaded yet) omits the line entirely rather than showing a
 * fabricated "0 players." `best` is separately nullable even once the
 * summary has loaded ("nobody has finished it yet") - that half is simply
 * dropped, per the spec's "omit best when null."
 */
export function formatChallengeCardMeta(
  summary: ChallengeSummaryEntry | undefined,
): string | null {
  if (!summary) return null;
  const playerLabel = `${summary.playerCount} ${summary.playerCount === 1 ? "player" : "players"}`;
  return summary.best
    ? `${playerLabel} · best ${formatTimeAndClicks(summary.best.elapsedMs, summary.best.clickCount)}`
    : playerLabel;
}
