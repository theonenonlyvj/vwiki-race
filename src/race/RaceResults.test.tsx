import { render, screen, waitFor, within } from "@testing-library/react";
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

function completedOutcome(
  overrides: Partial<Extract<RaceResultOutcome, { status: "completed" }>> = {},
): RaceResultOutcome {
  const session: GameSession = {
    challenge,
    status: "completed",
    startedAt: 0,
    completedAt: 4_000,
    clicks: 3,
    currentPage: { pageId: 38579, canonicalTitle: "Gravity" },
    path: [],
  };
  return {
    status: "completed",
    session,
    elapsedMs: 4_000,
    leaderboardContext: null,
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

describe("RaceResults: saved result, guest continuity, and sharing hierarchy", () => {
  it("shows a persisted-account receipt and makes the existing result share the friend challenge action", () => {
    renderResults({ outcome: completedOutcome() });

    expect(screen.getByText("Result saved to your VGames account.")).toBeVisible();
    const invitation = screen.getByRole("region", { name: "Challenge a friend" });
    expect(within(invitation).getByText(/share your result and the challenge link/i)).toBeVisible();
    expect(within(invitation).getByRole("button", { name: "Share result" })).toBeVisible();
    expect(screen.queryByRole("region", { name: /keep your name and stats/i })).toBeNull();
  });

  it("does not claim persistence when the result has no persisted run id", () => {
    renderResults({ outcome: completedOutcome({ runId: null }) });

    expect(screen.queryByText(/result saved/i)).toBeNull();
  });

  it("offers one guest continuity nudge with account creation and existing-account login kept distinct", async () => {
    const onClaimIdentity = vi.fn();
    const user = userEvent.setup();
    renderResults({
      outcome: completedOutcome(),
      identityStatus: "ghost",
      identityDisplayName: "Guest-42",
      onClaimIdentity,
    });

    expect(screen.getByText("Result saved to this guest profile on this device.")).toBeVisible();
    const claimCta = screen.getByRole("region", { name: /keep your name and stats/i });
    expect(within(claimCta).getByRole("heading", { name: "Keep your name and stats" })).toBeVisible();
    expect(within(claimCta).getByText(/create a VGames account to keep Guest-42 and this result/i)).toBeVisible();
    expect(within(claimCta).getByText(/already have a VGames account/i)).toBeVisible();
    expect(screen.getAllByRole("region", { name: /keep your name and stats/i })).toHaveLength(1);

    await user.click(within(claimCta).getByRole("button", { name: "Create account" }));
    await user.click(within(claimCta).getByRole("button", { name: "Log in" }));
    expect(onClaimIdentity.mock.calls).toEqual([["create"], ["login"]]);
  });

  it("keeps board metrics behind the existing finish-or-give-up gate on a DNF result", async () => {
    renderResults({
      outcome: dnfOutcome(),
      apiClient: mockApiClient({
        getChallengeBoard: vi.fn(async () => ({
          challengeId: challenge.id,
          placements: [{
            accountId: "acc-rival",
            displayName: "Rival",
            placement: 1,
            elapsedMs: 18_000,
            clickCount: 4,
          }],
          dnfs: [],
        })),
      }),
    });

    const board = await screen.findByRole("region", { name: "Leaderboard" });
    expect(within(board).getByText("Times and clicks unlock after you finish or give up.")).toBeVisible();
    expect(within(board).queryByText("0:18 · 4 clk")).toBeNull();
  });

  it("shows board metrics when the existing outcome source says the player already gave up", async () => {
    renderResults({
      outcome: dnfOutcome(),
      apiClient: mockApiClient({
        getChallengeBoard: vi.fn(async () => ({
          challengeId: challenge.id,
          placements: [{
            accountId: "acc-rival",
            displayName: "Rival",
            placement: 1,
            elapsedMs: 18_000,
            clickCount: 4,
          }],
          dnfs: [],
        })),
        getAccountChallengeOutcomes: vi.fn(async () => [{
          challengeId: challenge.id,
          outcome: "dnf" as const,
          best: null,
          giveUpEligible: true,
          peeked: true,
        }]),
      }),
    });

    const board = await screen.findByRole("region", { name: "Leaderboard" });
    expect(await within(board).findByText("0:18 · 4 clk")).toBeVisible();
    expect(within(board).queryByText(/times and clicks unlock/i)).toBeNull();
  });
});

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
