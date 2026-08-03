import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import RaceFlow from "./RaceFlow";
import type { Challenge } from "../domain/types";
import type { VWikiRaceApiClient } from "../services/vwikiRaceApiClient";

const previewChallenge: Challenge = {
  id: "challenge-0001",
  label: "Challenge #1",
  mode: "solo",
  start: { title: "Moon" },
  target: { title: "Gravity" },
  ruleset: "ranked_classic",
  source: "curated",
};

function mockApiClient(): VWikiRaceApiClient {
  return {
    listChallenges: vi.fn(async () => []),
    createChallenge: vi.fn(),
    startRun: vi.fn(),
    getActiveRun: vi.fn(async () => null),
    getActiveRunPath: vi.fn(async () => []),
    recordClick: vi.fn(),
    abandonRun: vi.fn(),
    listLeaderboard: vi.fn(async () => []),
    getChallengeBoard: vi.fn(async (challengeId: string) => ({ challengeId, placements: [], dnfs: [] })),
    getChallengePaths: vi.fn(async () => ({ runs: [], totalRuns: 0 })),
    getBoardsTrends: vi.fn(async () => ({ window: "7" as const, guard: 3, ranked: [], unranked: [] })),
    getRunPath: vi.fn(async () => []),
    getAccountStats: vi.fn(),
    getChallengesSummary: vi.fn(async () => []),
    getAccountChallengeOutcomes: vi.fn(async () => []),
    getPlayAnotherSuggestion: vi.fn(async () => null),
    createRandomChallenge: vi.fn(),
    getCapabilities: vi.fn(async () => ({ canManageDailies: false })),
    getDailyAdminState: vi.fn(async () => ({ nominations: [], queueEntries: [] })),
    approveDailyNomination: vi.fn(),
    declineDailyNomination: vi.fn(),
    queueDailyChallenge: vi.fn(),
    removeDailyQueueEntry: vi.fn(),
    giveUpChallenge: vi.fn(),
  };
}

function renderRaceFlow(overrides: Partial<Parameters<typeof RaceFlow>[0]> = {}) {
  const props = buildProps(overrides);
  render(<RaceFlow {...props} />);
  return { onRetryCatalog: props.onRetryCatalog, onRetryRecovery: props.onRetryRecovery };
}

describe("RaceFlow: RC-06 (one honest loading/error system)", () => {
  describe("'race-preview' with no previewChallenge yet (Judge A: the ONE genuinely retry-less interstitial)", () => {
    it("shows nothing before 300ms, honest 'Loading challenge...' at 300ms, and no Retry before stalling", () => {
      vi.useFakeTimers();
      try {
        renderRaceFlow({ screen: { kind: "race-preview" }, previewChallenge: null });

        expect(screen.queryByText(/loading challenge/i)).toBeNull();

        act(() => {
          vi.advanceTimersByTime(300);
        });
        expect(screen.getByText(/loading challenge/i)).toBeVisible();
        expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("escalates to a Retry after 2000ms, wired to onRetryCatalog - never a dead end", () => {
      vi.useFakeTimers();
      try {
        const { onRetryCatalog } = renderRaceFlow({
          screen: { kind: "race-preview" },
          previewChallenge: null,
        });

        act(() => {
          vi.advanceTimersByTime(2_000);
        });
        const retryButton = screen.getByRole("button", { name: /retry/i });
        expect(retryButton).toBeVisible();

        act(() => {
          retryButton.click();
        });
        expect(onRetryCatalog).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("never shows 'Loading challenge...' at all once previewChallenge resolves quickly", () => {
      const { rerender } = render(<RaceFlow {...buildProps({ screen: { kind: "race-preview" }, previewChallenge: null })} />);
      expect(screen.queryByText(/loading challenge/i)).toBeNull();
      rerender(<RaceFlow {...buildProps({ screen: { kind: "race-preview" }, previewChallenge })} />);
      expect(screen.queryByText(/loading challenge/i)).toBeNull();
      expect(screen.getByRole("button", { name: /start race/i })).toBeVisible();
    });
  });

  describe("'race-recovery-pending' (Judge A: keep the existing IMMEDIATE, unstaged Retry - do not stage this one)", () => {
    it("shows 'Checking for an active run...' and an immediate Retry at 0ms - no staging delay", () => {
      const { onRetryCatalog } = renderRaceFlow({ screen: { kind: "race-recovery-pending" } });

      expect(screen.getByText(/checking for an active run/i)).toBeVisible();
      const retryButton = screen.getByRole("button", { name: /retry/i });
      expect(retryButton).toBeVisible();

      retryButton.click();
      expect(onRetryCatalog).toHaveBeenCalledTimes(1);
    });
  });
});

function buildProps(overrides: Partial<Parameters<typeof RaceFlow>[0]>): Parameters<typeof RaceFlow>[0] {
  return {
    screen: { kind: "race-preview" },
    apiClient: mockApiClient(),
    phase: "idle",
    raceChallenge: null,
    recoveryRun: null,
    previewChallenge: null,
    targetPreview: { status: "idle" },
    session: null,
    article: null,
    elapsedMs: 0,
    redirectedFrom: null,
    pendingNavigationTitle: null,
    navigationRetrying: false,
    pendingRetry: null,
    leaderboardContext: null,
    runId: null,
    dnfResult: null,
    todayCentral: "2026-07-19",
    identityStatus: null,
    identityAccountId: null,
    identityToken: null,
    identityDisplayName: "",
    preRaceCompletions: null,
    playAnotherSuggestion: { status: "loading" },
    randomChallengeBusy: false,
    randomChallengeError: null,
    error: null,
    authBusy: false,
    endRunIsBlocked: false,
    onCreateRandomChallenge: vi.fn(),
    onOpenChallenge: vi.fn(),
    onRetryPending: vi.fn(),
    onRetryRecovery: vi.fn(),
    onRetryCatalog: vi.fn(),
    onRequestEndRun: vi.fn(),
    onBackFromPreview: vi.fn(),
    onSeeOtherChallengesFromPreview: vi.fn(),
    onStartFromPreview: vi.fn(),
    onPlayAgain: vi.fn(),
    onShowLeaderboard: vi.fn(),
    onShowChallenges: vi.fn(),
    onClaimIdentity: vi.fn(),
    onGoHome: vi.fn(),
    handleArticleClick: vi.fn(),
    handleArticlePrewarm: vi.fn(),
    ...overrides,
  };
}
