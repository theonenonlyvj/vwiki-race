import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ChallengeDetail from "./ChallengeDetail";
import type { Challenge, RankedLeaderboardRow, ServerPathStep } from "../../domain/types";
import type { ChallengeBoardResponse } from "../../server/contracts";
import type { VWikiRaceApiClient } from "../../services/vwikiRaceApiClient";

const challenge: Challenge = {
  id: "challenge-0001",
  label: "Challenge #1",
  mode: "solo",
  start: { title: "Moon" },
  target: { title: "Gravity" },
  ruleset: "ranked_classic",
  source: "curated",
};

function mockApiClient(overrides: Partial<VWikiRaceApiClient> = {}): VWikiRaceApiClient {
  return {
    listChallenges: vi.fn(async () => []),
    createChallenge: vi.fn(),
    startRun: vi.fn(),
    getActiveRun: vi.fn(async () => null),
    getActiveRunPath: vi.fn(async () => []),
    recordClick: vi.fn(),
    abandonRun: vi.fn(),
    listLeaderboard: vi.fn(async () => []),
    getChallengeBoard: vi.fn(async (challengeId: string) => ({
      challengeId,
      placements: [],
      dnfs: [],
    })),
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
    ...overrides,
  };
}

function renderDetail(overrides: Partial<Parameters<typeof ChallengeDetail>[0]> = {}) {
  const onBack = vi.fn();
  const onDisclosePath = vi.fn();
  const onRaceThis = vi.fn();
  const onRetryLeaderboard = vi.fn();
  const props = {
    apiClient: mockApiClient(),
    challenge,
    errorReporter: { reportVisibleError: vi.fn() },
    identityAccountId: null as string | null,
    identityToken: null as string | null,
    leaderboard: [] as RankedLeaderboardRow[],
    leaderboardStatus: "ready" as "loading" | "error" | "ready",
    onBack,
    onDisclosePath,
    onRaceThis,
    onRetryLeaderboard,
    raceDisabled: false,
    runPaths: {} as Record<string, ServerPathStep[]>,
    todayCentral: "2026-07-19",
    ...overrides,
  };
  const view = render(<ChallengeDetail {...props} />);
  return { ...view, props, onBack, onDisclosePath, onRaceThis, onRetryLeaderboard };
}

describe("ChallengeDetail: RC-06 (one honest loading/error system)", () => {
  it("Leaderboard panel: renders a distinct error + Retry when its own board fetch fails - never 'No completed runs yet.'", async () => {
    const apiClient = mockApiClient({
      getChallengeBoard: vi.fn(async () => {
        throw new Error("down");
      }),
    });
    const errorReporter = { reportVisibleError: vi.fn() };
    renderDetail({ apiClient, errorReporter });

    expect(await screen.findByText(/couldn.t load the leaderboard/i)).toBeVisible();
    expect(screen.queryByText("No completed runs yet.")).toBeNull();
    // This package: the rendered failure above now beacons through the
    // "challenge-detail-board" surface.
    expect(errorReporter.reportVisibleError).toHaveBeenCalledWith(
      "challenge-detail-board",
      expect.any(String),
      "Couldn't load the leaderboard.",
      expect.anything(),
    );
  });

  it("Leaderboard panel: Retry recovers the board in place via a NEW fetch, without any navigation callback firing", async () => {
    const getChallengeBoard = vi.fn<VWikiRaceApiClient["getChallengeBoard"]>(async () => {
      throw new Error("down");
    });
    const apiClient = mockApiClient({ getChallengeBoard });
    const user = userEvent.setup();
    const { onBack } = renderDetail({ apiClient });

    await screen.findByRole("button", { name: /retry/i });
    getChallengeBoard.mockImplementation(async (challengeId: string) => ({
      challengeId,
      placements: [
        { accountId: "acc-1", displayName: "FranTheGreat", placement: 1, elapsedMs: 42_000, clickCount: 6 },
      ],
      dnfs: [],
    }));

    const retryButtons = screen.getAllByRole("button", { name: /retry/i });
    await user.click(retryButtons[0]!);

    expect(await screen.findByText("FranTheGreat")).toBeVisible();
    expect(onBack).not.toHaveBeenCalled();
  });

  it("'Your history': renders a distinct error + Retry (not 'You haven't tried this one yet.') when leaderboardStatus is 'error'", async () => {
    renderDetail({ leaderboardStatus: "error" });

    expect(await screen.findByText(/couldn.t load your history/i)).toBeVisible();
    expect(screen.queryByText(/you haven.t tried this one yet/i)).toBeNull();
  });

  it("'Your history': Retry calls onRetryLeaderboard directly - no onBack / fresh navigation", async () => {
    const user = userEvent.setup();
    const { onBack, onRetryLeaderboard } = renderDetail({ leaderboardStatus: "error" });

    // Only "Your history" is in error here - the Leaderboard panel's own
    // board fetch (the default mock) resolves fine, so exactly one Retry
    // button is on screen.
    await user.click(await screen.findByRole("button", { name: /retry/i }));

    expect(onRetryLeaderboard).toHaveBeenCalledTimes(1);
    expect(onBack).not.toHaveBeenCalled();
  });

  it("'Your history': stages 'loading' honestly and never shows the false empty state meanwhile", () => {
    vi.useFakeTimers();
    try {
      renderDetail({ leaderboardStatus: "loading" });

      expect(screen.queryByText(/loading your history/i)).toBeNull();
      expect(screen.queryByText(/you haven.t tried this one yet/i)).toBeNull();

      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(screen.getByText(/loading your history/i)).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });

  it("'Your history': a genuine empty result ('ready' + zero rows) still reads as 'You haven't tried this one yet.'", () => {
    renderDetail({ leaderboardStatus: "ready", leaderboard: [] });
    expect(screen.getByText(/you haven.t tried this one yet/i)).toBeVisible();
  });

  it("board fetch: stages its own loading copy distinctly from the Leaderboard panel's error/ready states", async () => {
    vi.useFakeTimers();
    try {
      let resolveBoard: (value: ChallengeBoardResponse) => void = () => {};
      const getChallengeBoard = vi.fn<VWikiRaceApiClient["getChallengeBoard"]>(
        () =>
          new Promise((resolve) => {
            resolveBoard = resolve;
          }),
      );
      const apiClient = mockApiClient({ getChallengeBoard });
      renderDetail({ apiClient });

      expect(screen.queryByText(/loading board/i)).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(screen.getByText(/loading board/i)).toBeVisible();

      resolveBoard({ challengeId: challenge.id, placements: [], dnfs: [] });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText("No completed runs yet.")).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });
});

function leaderboardRow(overrides: Partial<RankedLeaderboardRow> = {}): RankedLeaderboardRow {
  return {
    rank: 1,
    runId: "run-1",
    challengeId: challenge.id,
    accountId: "acc-1",
    displayName: "Vijay",
    status: "completed",
    isRepeatRun: false,
    startedAt: "2026-07-14T01:00:00.000Z",
    elapsedMs: 42_000,
    clickCount: 6,
    completedAt: "2026-07-14T01:00:42.000Z",
    protocolVersion: 2,
    ...overrides,
  };
}

/**
 * Pre-finish spoiler mask (owner ask, 2026-08-13): "before I finish the
 * race, just like I can't view the graph, I shouldn't be able to see how
 * long or # clicks on the leaderboard - just rankings and usernames."
 * Extends the SAME `pathsUnlocked` gate (invariant 5) that already controls
 * "View path"/"View graph" to the time/clicks column - both the main
 * Leaderboard panel (via `LeaderboardList`, covered directly in its own
 * test file) and "Your history" below, which this file owns directly.
 */
describe("ChallengeDetail: pre-finish spoiler mask (time/clicks)", () => {
  it("locked (no completed row, not peeked): 'Your history' shows personal time/clicks for a DNF-only account", async () => {
    renderDetail({
      identityAccountId: "acc-1",
      leaderboard: [
        leaderboardRow({ runId: "run-1", status: "abandoned", elapsedMs: 8_000, clickCount: 2 }),
      ],
    });

    expect(await screen.findByText("DNF")).toBeVisible();
    expect(screen.getByText("0:08 · 2 clk")).toBeVisible();
    const historyPanel = screen.getByRole("region", { name: "Your history" });
    expect(within(historyPanel).queryByText("View path")).toBeNull();
    expect(screen.getByText(/other players.*times and clicks, and all paths, stay hidden until you finish or confirm a reveal/i))
      .toBeVisible();
  });

  it("unlocked (a completed row exists): 'Your history' shows time/clicks normally", async () => {
    renderDetail({
      identityAccountId: "acc-1",
      leaderboard: [
        leaderboardRow({ runId: "run-1", status: "completed", elapsedMs: 42_000, clickCount: 6 }),
        leaderboardRow({ runId: "run-2", status: "abandoned", elapsedMs: 8_000, clickCount: 2 }),
      ],
    });

    expect(await screen.findByText("0:42 · 6 clk")).toBeVisible();
    expect(screen.getByText("0:08 · 2 clk")).toBeVisible();
    expect(screen.queryByText(/hidden until you've played/i)).toBeNull();
  });
});

describe("\"I gave up\" affordance + solution view (owner spec, 2026-08-02)", () => {
  it("renders nothing when signed out - the affordance requires a real identity", () => {
    renderDetail({ identityToken: null, identityAccountId: null });
    expect(screen.queryByText(/show me the answers/i)).toBeNull();
  });

  it("offers an explanation when the account has no qualifying DNF on this challenge", async () => {
    const getAccountChallengeOutcomes = vi.fn(async () => [
      { challengeId: challenge.id, outcome: "dnf" as const, best: null },
    ]);
    renderDetail({
      identityToken: "jwt-1",
      identityAccountId: "acc-1",
      apiClient: mockApiClient({ getAccountChallengeOutcomes }),
    });

    await waitFor(() => expect(getAccountChallengeOutcomes).toHaveBeenCalled());
    await userEvent.setup().click(await screen.findByRole("button", { name: "Show me the answers" }));
    expect(screen.getByRole("dialog", { name: "Answers are still locked" })).toBeVisible();
    expect(screen.getByText(/None of your attempts with at least 2 clicks has met/)).toBeVisible();
  });

  it("renders nothing once the account has finished the challenge (giveUpEligible is never set for a completed outcome)", async () => {
    const getAccountChallengeOutcomes = vi.fn(async () => [
      { challengeId: challenge.id, outcome: "completed" as const, best: { elapsedMs: 4000, clickCount: 3 } },
    ]);
    renderDetail({
      identityToken: "jwt-1",
      identityAccountId: "acc-1",
      apiClient: mockApiClient({ getAccountChallengeOutcomes }),
    });

    await waitFor(() => expect(getAccountChallengeOutcomes).toHaveBeenCalled());
    expect(screen.queryByText(/show me the answers/i)).toBeNull();
  });

  it("shows the muted 'I give up' link when eligible and not yet peeked, with the confirm copy behind it", async () => {
    const user = userEvent.setup();
    const getAccountChallengeOutcomes = vi.fn(async () => [
      { challengeId: challenge.id, outcome: "dnf" as const, best: null, giveUpEligible: true },
    ]);
    renderDetail({
      identityToken: "jwt-1",
      identityAccountId: "acc-1",
      apiClient: mockApiClient({ getAccountChallengeOutcomes }),
    });

    const giveUpButton = await screen.findByRole("button", { name: /show me the answers/i });
    await user.click(giveUpButton);

    expect(screen.getByText(/future attempts on this challenge/i)).toBeVisible();
    expect(screen.getByRole("button", { name: /yes, show me/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeVisible();
  });

  it("hides the give-up link and shows 'The solution' once the account has already peeked", async () => {
    const getAccountChallengeOutcomes = vi.fn(async () => [
      { challengeId: challenge.id, outcome: "dnf" as const, best: null, giveUpEligible: true, peeked: true },
    ]);
    const getChallengePaths = vi.fn(async () => ({ runs: [], totalRuns: 0, referencePath: null }));
    renderDetail({
      identityToken: "jwt-1",
      identityAccountId: "acc-1",
      apiClient: mockApiClient({ getAccountChallengeOutcomes, getChallengePaths }),
    });

    await screen.findByRole("heading", { name: /the solution/i });
    expect(screen.queryByText(/^show me the answers/i)).toBeNull();
  });

  it("confirming give-up calls the API and re-fetches outcomes", async () => {
    const user = userEvent.setup();
    const giveUpChallenge = vi.fn(async () => ({ challengeId: challenge.id, peeked: true as const }));
    const getAccountChallengeOutcomes = vi.fn(async () => [
      { challengeId: challenge.id, outcome: "dnf" as const, best: null, giveUpEligible: true },
    ]);
    renderDetail({
      identityToken: "jwt-1",
      identityAccountId: "acc-1",
      apiClient: mockApiClient({ getAccountChallengeOutcomes, giveUpChallenge }),
    });

    await user.click(await screen.findByRole("button", { name: /show me the answers/i }));
    await user.click(screen.getByRole("button", { name: /yes, show me/i }));

    await waitFor(() => expect(giveUpChallenge).toHaveBeenCalledWith(challenge.id, "jwt-1"));
    await waitFor(() => expect(getAccountChallengeOutcomes).toHaveBeenCalledTimes(2));
  });

  describe("\"The solution\" panel", () => {
    function peekedOutcomes() {
      return vi.fn(async () => [
        { challengeId: challenge.id, outcome: "dnf" as const, best: null, giveUpEligible: true, peeked: true },
      ]);
    }

    it("case (a): shows the best finisher's real path when one exists", async () => {
      const getChallengePaths = vi.fn(async () => ({
        runs: [{
          player: "Fast Runner",
          status: "completed" as const,
          elapsedMs: 3_000,
          clicks: 2,
          steps: [
            { n: 1, from: "Moon", to: "Orbit" },
            { n: 2, from: "Orbit", to: "Gravity" },
          ],
        }],
        totalRuns: 1,
      }));
      renderDetail({
        identityToken: "jwt-1",
        identityAccountId: "acc-1",
        apiClient: mockApiClient({ getAccountChallengeOutcomes: peekedOutcomes(), getChallengePaths }),
      });

      await screen.findByRole("heading", { name: /the solution/i });
      const panel = within(screen.getByLabelText("The solution"));
      expect(await panel.findByText("Moon")).toBeVisible();
      expect(panel.getByText(/Orbit/)).toBeVisible();
      expect(panel.getByText(/Gravity/)).toBeVisible();
      expect(panel.queryByText(/no one.*cracked/i)).toBeNull();
      expect(panel.queryByText(/reference route/i)).toBeNull();
    });

    it("case (b): labels the stored reference path 'Reference route' when nobody has finished it", async () => {
      const getChallengePaths = vi.fn(async () => ({
        runs: [],
        totalRuns: 0,
        referencePath: ["Moon", "Orbit", "Gravity"],
      }));
      renderDetail({
        identityToken: "jwt-1",
        identityAccountId: "acc-1",
        apiClient: mockApiClient({ getAccountChallengeOutcomes: peekedOutcomes(), getChallengePaths }),
      });

      await screen.findByRole("heading", { name: /the solution/i });
      const panel = within(screen.getByLabelText("The solution"));
      expect(await panel.findByText(/reference route/i)).toBeVisible();
      expect(panel.getByText("Moon")).toBeVisible();
      expect(panel.getByText(/Gravity/)).toBeVisible();
      expect(panel.queryByText(/no one.*cracked/i)).toBeNull();
    });

    it("case (c): shows the honest 'no one has cracked it' copy when neither a finisher nor a reference path exists", async () => {
      const getChallengePaths = vi.fn(async () => ({ runs: [], totalRuns: 0, referencePath: null }));
      renderDetail({
        identityToken: "jwt-1",
        identityAccountId: "acc-1",
        apiClient: mockApiClient({ getAccountChallengeOutcomes: peekedOutcomes(), getChallengePaths }),
      });

      await screen.findByRole("heading", { name: /the solution/i });
      expect(await screen.findByText(/no one.*human or machine.*cracked this one yet/i)).toBeVisible();
    });
  });
});

describe("Challenge landing intent", () => {
  it("invites an unplayed visitor to start through the existing briefing", async () => {
    const { onRaceThis } = renderDetail();
    expect(screen.queryByText("Find your way there.")).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: /^▶ Race$/i }));
    expect(onRaceThis).toHaveBeenCalledOnce();
  });
  it("keeps graph access and finished status alongside the shared race entry", async () => {
    renderDetail({ identityAccountId: "me", identityToken: "token", apiClient: mockApiClient({
      getAccountChallengeOutcomes: vi.fn(async () => [{ challengeId: challenge.id, outcome: "completed" as const, best: { elapsedMs: 20000, clickCount: 3 } }]),
    }) });
    expect(await screen.findByText(/^Finished/)).toBeVisible();
    expect(screen.getByRole("button", { name: /view graph/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /^▶ Race$/i })).toHaveClass("race-preview-button");
  });
  it("acknowledges DNF and preserves the explicit reveal confirmation", async () => {
    renderDetail({ identityAccountId: "me", identityToken: "token", apiClient: mockApiClient({
      getAccountChallengeOutcomes: vi.fn(async () => [{ challengeId: challenge.id, outcome: "dnf" as const, best: null, giveUpEligible: true }]),
    }) });
    expect(await screen.findByText("Last try: DNF")).toBeVisible();
    expect(screen.getByRole("button", { name: /^▶ Race$/i })).toBeVisible();
    await userEvent.setup().click(screen.getByRole("button", { name: /show me the answers/i }));
    expect(screen.getByRole("dialog", { name: /show me the answers/i })).toBeVisible();
  });
});

describe("Challenge progress isolation", () => {
  it("drops revealed-route access immediately on an account switch", async () => {
    const apiClient = mockApiClient({ getAccountChallengeOutcomes: vi.fn(async token => token === "first" ? [{ challengeId: challenge.id, outcome: "dnf" as const, best: null, peeked: true }] : []) });
    const view = renderDetail({ identityToken: "first", identityAccountId: "first", apiClient });
    expect(await screen.findByRole("button", { name: "View graph" })).toBeVisible();
    view.rerender(<ChallengeDetail {...view.props} identityToken="second" identityAccountId="second" />);
    expect(screen.queryByRole("button", { name: "View graph" })).toBeNull();
    expect(screen.queryByText("The routes are open.")).toBeNull();
    expect(await screen.findByRole("button", { name: "▶ Race" })).toBeVisible();
  });
  it("offers explicitly unranked practice after a reveal", async () => {
    const { onRaceThis } = renderDetail({ identityToken: "first", identityAccountId: "first", apiClient: mockApiClient({
      getAccountChallengeOutcomes: vi.fn(async () => [{ challengeId: challenge.id, outcome: "dnf" as const, best: null, peeked: true }]),
    }) });
    await userEvent.setup().click(await screen.findByRole("button", { name: "▶ Race" }));
    expect(screen.getByText(/unranked practice/i)).toBeVisible();
    expect(onRaceThis).toHaveBeenCalledOnce();
  });
});

it("explains the short-history DNF even when it has no counted outcome", async () => {
  const giveUpChallenge = vi.fn();
  const view = renderDetail({ identityToken: "token", identityAccountId: "acc-1",
    leaderboard: [leaderboardRow({ status: "abandoned", clickCount: 1 })],
    apiClient: mockApiClient({ giveUpChallenge, getAccountChallengeOutcomes: vi.fn(async () => []) }) });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Show me the answers" }));
  const dialog = screen.getByRole("dialog", { name: "Answers are still locked" });
  expect(within(dialog).getByText(/this attempt recorded 1 accepted click/i)).toBeVisible();
  await user.click(within(dialog).getByRole("button", { name: "▶ Race" }));
  expect(view.onRaceThis).toHaveBeenCalledOnce();
  expect(giveUpChallenge).not.toHaveBeenCalled();
});

it("does not call a failed eligibility lookup an ineligible attempt", async () => {
  renderDetail({ identityToken: "token", identityAccountId: "acc-1",
    leaderboard: [leaderboardRow({ status: "abandoned", clickCount: 1 })],
    apiClient: mockApiClient({ getAccountChallengeOutcomes: vi.fn(async () => { throw new Error("offline"); }) }) });
  await screen.findByText("Your progress is unavailable.");
  expect(screen.queryByRole("button", { name: "Show me the answers" })).toBeNull();
});

it.each([true, false])("keeps an outcome-confirmed DNF action available when the leaderboard fails (eligible: %s)", async (eligible) => {
  renderDetail({ identityToken: "token", identityAccountId: "acc-1", leaderboardStatus: "error",
    apiClient: mockApiClient({ getAccountChallengeOutcomes: vi.fn(async () => [
      { challengeId: challenge.id, outcome: "dnf" as const, best: null, giveUpEligible: eligible },
    ]) }) });
  await userEvent.setup().click(await screen.findByRole("button", { name: "Show me the answers" }));
  expect(screen.getByRole("dialog", { name: eligible ? "Show me the answers?" : "Answers are still locked" })).toBeVisible();
});
