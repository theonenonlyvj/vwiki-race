import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import RaceResults, { type RaceResultOutcome } from "./RaceResults";
import type { GameSession } from "../domain/gameSession";
import type { Challenge } from "../domain/types";
import type { VWikiRaceApiClient } from "../services/vwikiRaceApiClient";

const challenge: Challenge = {
  id: "challenge-0001",
  label: "Challenge #1",
  mode: "solo",
  start: { title: "Moon" },
  target: { title: "Gravity" },
  ruleset: "ranked_classic",
  source: "curated",
};

function dnfOutcome(overrides: Partial<Extract<RaceResultOutcome, { status: "dnf" }>> = {}): RaceResultOutcome {
  return {
    status: "dnf",
    challenge,
    clicks: 12,
    elapsedMs: 30_000,
    runId: "run-1",
    ...overrides,
  };
}

function mockApiClient(overrides: Partial<VWikiRaceApiClient> = {}): VWikiRaceApiClient {
  return {
    getChallengeBoard: vi.fn(async (challengeId: string) => ({ challengeId, placements: [], dnfs: [] })),
    getAccountChallengeOutcomes: vi.fn(async () => []),
    giveUpChallenge: vi.fn(),
    ...overrides,
  } as unknown as VWikiRaceApiClient;
}

function renderResults(overrides: Partial<Parameters<typeof RaceResults>[0]> = {}) {
  const onOpenChallenge = vi.fn();
  const props = {
    apiClient: mockApiClient(),
    article: null,
    errorReporter: { reportVisibleError: vi.fn() },
    outcome: dnfOutcome(),
    identityAccountId: "acc-1",
    identityToken: "jwt-1" as string | null,
    todayCentral: "2026-07-19",
    identityStatus: "claimed" as const,
    identityDisplayName: "Casey",
    preRaceCompletions: 1,
    playAgainDisabled: false,
    playAnotherSuggestion: { status: "empty" as const },
    randomChallengeBusy: false,
    randomChallengeError: null,
    onCreateRandomChallenge: vi.fn(),
    onOpenChallenge,
    onPlayAgain: vi.fn(),
    onShowLeaderboard: vi.fn(),
    onShowChallenges: vi.fn(),
    onClaimIdentity: vi.fn(),
    onGoHome: vi.fn(),
    handleArticleClick: vi.fn(),
    handleArticlePrewarm: vi.fn(),
    ...overrides,
  };
  render(<RaceResults {...props} />);
  return { onOpenChallenge };
}

describe("RaceResults: \"I gave up\" affordance (owner spec, 2026-08-02)", () => {
  it("never fetches outcomes or shows the affordance for a completed outcome", async () => {
    const getAccountChallengeOutcomes = vi.fn(async () => [
      { challengeId: challenge.id, outcome: "dnf" as const, best: null, giveUpEligible: true },
    ]);
    const session: GameSession = {
      challenge,
      status: "completed",
      startedAt: 0,
      completedAt: 4_000,
      clicks: 3,
      currentPage: { pageId: 38579, canonicalTitle: "Gravity" },
      path: [],
    };
    renderResults({
      outcome: {
        status: "completed",
        session,
        elapsedMs: 4_000,
        leaderboardContext: null,
        runId: "run-1",
      },
      apiClient: mockApiClient({ getAccountChallengeOutcomes }),
    });

    await waitFor(() => expect(screen.queryByText(/no completed runs yet/i)).not.toBeNull());
    expect(getAccountChallengeOutcomes).not.toHaveBeenCalled();
    expect(screen.queryByText(/i give up/i)).toBeNull();
  });

  it("does not show the affordance when the account has no qualifying DNF on this challenge", async () => {
    const getAccountChallengeOutcomes = vi.fn(async () => [
      { challengeId: challenge.id, outcome: "dnf" as const, best: null },
    ]);
    renderResults({ apiClient: mockApiClient({ getAccountChallengeOutcomes }) });

    await waitFor(() => expect(getAccountChallengeOutcomes).toHaveBeenCalled());
    expect(screen.queryByText(/i give up/i)).toBeNull();
  });

  it("shows the affordance on a DNF Results screen once a qualifying DNF exists - even if THIS run's own outcome was trivial (\"any attempt\")", async () => {
    const getAccountChallengeOutcomes = vi.fn(async () => [
      { challengeId: challenge.id, outcome: "dnf" as const, best: null, giveUpEligible: true },
    ]);
    renderResults({
      outcome: dnfOutcome({ clicks: 1, elapsedMs: 800 }),
      apiClient: mockApiClient({ getAccountChallengeOutcomes }),
    });

    expect(await screen.findByRole("button", { name: /i give up/i })).toBeVisible();
  });

  it("does not show the affordance once already peeked", async () => {
    const getAccountChallengeOutcomes = vi.fn(async () => [
      { challengeId: challenge.id, outcome: "dnf" as const, best: null, giveUpEligible: true, peeked: true },
    ]);
    renderResults({ apiClient: mockApiClient({ getAccountChallengeOutcomes }) });

    await waitFor(() => expect(getAccountChallengeOutcomes).toHaveBeenCalled());
    expect(screen.queryByText(/i give up/i)).toBeNull();
  });

  it("confirming give-up navigates to Challenge Detail (the solution view itself is Detail-only)", async () => {
    const getAccountChallengeOutcomes = vi.fn(async () => [
      { challengeId: challenge.id, outcome: "dnf" as const, best: null, giveUpEligible: true },
    ]);
    const giveUpChallenge = vi.fn(async () => ({ challengeId: challenge.id, peeked: true as const }));
    const user = userEvent.setup();
    const { onOpenChallenge } = renderResults({
      apiClient: mockApiClient({ getAccountChallengeOutcomes, giveUpChallenge }),
    });

    await user.click(await screen.findByRole("button", { name: /i give up/i }));
    await user.click(screen.getByRole("button", { name: /yes, show me/i }));

    await waitFor(() => expect(giveUpChallenge).toHaveBeenCalledWith(challenge.id, "jwt-1"));
    await waitFor(() => expect(onOpenChallenge).toHaveBeenCalledWith(challenge.id));
  });
});
