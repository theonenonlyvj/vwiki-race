import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import Home from "./Home";
import type { HomeHeroSelection } from "../domain/challengeSelection";
import type { Challenge } from "../domain/types";
import type { ChallengeBoardResponse } from "../server/contracts";
import type { VWikiRaceApiClient } from "../services/vwikiRaceApiClient";

const todayCentral = "2026-07-19";

const todaysDaily: Challenge = {
  id: "challenge-daily-0719",
  label: "Daily 2026-07-19",
  mode: "daily",
  start: { title: "Apple" },
  target: { title: "Fruit" },
  ruleset: "ranked_classic",
  source: "curated",
  origin: "daily",
  dailyDate: "2026-07-19",
  dailyFeature: { dailyDate: "2026-07-19", flavor: "hard", selectionSource: "admin" },
};

const yesterdaysDaily: Challenge = {
  id: "challenge-daily-0718",
  label: "Daily 2026-07-18",
  mode: "daily",
  start: { title: "Coffee" },
  target: { title: "Great Molasses Flood" },
  ruleset: "ranked_classic",
  source: "curated",
  origin: "daily",
  dailyDate: "2026-07-18",
  dailyFeature: { dailyDate: "2026-07-18", flavor: "weird", selectionSource: "admin" },
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

function renderHome(overrides: Partial<Parameters<typeof Home>[0]> = {}) {
  const onGoToBoards = vi.fn();
  const onGoToBoardsToday = vi.fn();
  const props = {
    accountStats: null,
    apiClient: mockApiClient(),
    catalogStatus: "ready" as const,
    challenges: [yesterdaysDaily, todaysDaily],
    hero: { challenge: todaysDaily, kind: "today-daily" } as HomeHeroSelection,
    identityAccountId: null as string | null,
    identityToken: null as string | null,
    onGoToBoards,
    onGoToBoardsToday,
    onOpenChallenge: vi.fn(),
    onCreateRandomChallenge: vi.fn(),
    onRaceChallenge: vi.fn(),
    onRetryCatalog: vi.fn(),
    onShowChallenges: vi.fn(),
    playAnotherSuggestion: { status: "loading" as const },
    raceBusy: false,
    randomChallengeBusy: false,
    randomChallengeError: null as string | null,
    sessionDnfChallengeIds: new Set<string>(),
    todayCentral,
    ...overrides,
  };
  render(<Home {...props} />);
  return { onGoToBoards, onGoToBoardsToday };
}

describe("Home: RC-06 (one honest loading/error system) - 'Yesterday's results' board tri-state", () => {
  it("renders a distinct error + Retry when yesterday's board fetch fails - never 'No completed runs yet.'", async () => {
    const apiClient = mockApiClient({
      getChallengeBoard: vi.fn(async (challengeId: string) => {
        if (challengeId === yesterdaysDaily.id) throw new Error("down");
        return { challengeId, placements: [], dnfs: [] };
      }),
    });
    renderHome({ apiClient });

    expect(await screen.findByText(/couldn.t load this board/i)).toBeVisible();
    expect(screen.queryByText("No completed runs yet.")).toBeNull();
    // The "see full board" link (children) still renders alongside the error.
    expect(screen.getByRole("button", { name: /see full board/i })).toBeVisible();
  });

  it("Retry recovers the board in place once the fetch succeeds", async () => {
    const getChallengeBoard = vi.fn<VWikiRaceApiClient["getChallengeBoard"]>(
      async (challengeId: string) => {
        if (challengeId === yesterdaysDaily.id) throw new Error("down");
        return { challengeId, placements: [], dnfs: [] };
      },
    );
    const apiClient = mockApiClient({ getChallengeBoard });
    const user = userEvent.setup();
    renderHome({ apiClient });

    await screen.findByRole("button", { name: /^retry$/i });
    getChallengeBoard.mockImplementation(async (challengeId: string) => ({
      challengeId,
      placements: [
        { accountId: "acc-1", displayName: "FranTheGreat", placement: 1, elapsedMs: 42_000, clickCount: 6 },
      ],
      dnfs: [],
    }));

    await user.click(screen.getByRole("button", { name: /^retry$/i }));

    expect(await screen.findByText("FranTheGreat")).toBeVisible();
    expect(screen.queryByText(/couldn.t load this board/i)).toBeNull();
  });

  it("pre-drop (hero IS yesterday's daily): a failed board fetch still renders an honest error, reusing the hero's own retry - never a silent duplicate fetch", async () => {
    const getChallengeBoard = vi.fn<VWikiRaceApiClient["getChallengeBoard"]>(async () => {
      throw new Error("down");
    });
    const apiClient = mockApiClient({ getChallengeBoard });
    renderHome({
      apiClient,
      challenges: [yesterdaysDaily],
      hero: { challenge: yesterdaysDaily, kind: "yesterday-daily" },
    });

    expect(await screen.findByText(/couldn.t load this board/i)).toBeVisible();
    // Only ONE fetch in flight for the shared hero/yesterday board, not two
    // independent ones (see this file's own `yesterdayIsHero` doc comment).
    expect(getChallengeBoard).toHaveBeenCalledTimes(1);
  });
});

describe("Home: RC-05 part B - heroBoard tri-state skeleton-hold (unblocked by RC-03's shared read-cache)", () => {
  it("holds a neutral skeleton for a signed-in session's genuinely cold board fetch - no pre-play chrome, no premature DONE/DNF - then cross-fades once it resolves", async () => {
    vi.useFakeTimers();
    try {
      // Home fetches TWO boards on mount (the hero's own, and the
      // independent yesterday-recap one) - keyed resolvers so each fetch
      // can be settled independently instead of one clobbering the other.
      const resolvers = new Map<string, (value: ChallengeBoardResponse) => void>();
      const getChallengeBoard = vi.fn(
        (challengeId: string) =>
          new Promise<ChallengeBoardResponse>((resolve) => {
            resolvers.set(challengeId, resolve);
          }),
      );
      const apiClient = mockApiClient({ getChallengeBoard });
      renderHome({ apiClient, identityAccountId: "acc-1" });

      // Nothing pre-play renders while genuinely unresolved: no Race button,
      // no streak row, no yesterday recap link, and (within the first
      // 300ms) not even the skeleton copy itself - StagedLoadingNotice's own
      // "hidden" stage.
      expect(screen.queryByRole("button", { name: /▶ race/i })).toBeNull();
      expect(screen.queryByText(/checking your status/i)).toBeNull();
      expect(screen.queryByText(/see full board/i)).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(screen.getByText(/checking your status/i)).toBeVisible();
      expect(screen.queryByRole("button", { name: /▶ race/i })).toBeNull();

      resolvers.get(todaysDaily.id)?.({ challengeId: todaysDaily.id, placements: [], dnfs: [] });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      // A synchronous `getBy`, not `findBy`: `findBy*`'s internal polling
      // relies on real `setTimeout` ticks, which fake timers freeze - the
      // explicit `act`+`advanceTimersByTimeAsync` flush above is what
      // settles the state update, matching Boards.test.tsx's own staged-
      // loading precedent.
      expect(screen.getByRole("button", { name: /▶ race/i })).toBeVisible();
      expect(screen.queryByText(/checking your status/i)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("anonymous guests keep the instant pre-play render even while the hero board is still loading (Risk note: the hold applies only to a signed-in session)", () => {
    const getChallengeBoard = vi.fn(
      () => new Promise<ChallengeBoardResponse>(() => {}),
    );
    const apiClient = mockApiClient({ getChallengeBoard });
    renderHome({ apiClient, identityAccountId: null });

    expect(screen.getByRole("button", { name: /▶ race/i })).toBeVisible();
  });

  it("a just-ended session DNF resolves the hero to the DNF sub-state immediately, bypassing the skeleton even while the board fetch is still in flight (Judge B amendment 2)", async () => {
    const getChallengeBoard = vi.fn(
      () => new Promise<ChallengeBoardResponse>(() => {}),
    );
    const apiClient = mockApiClient({ getChallengeBoard });
    renderHome({
      apiClient,
      identityAccountId: "acc-1",
      sessionDnfChallengeIds: new Set([todaysDaily.id]),
    });

    expect(await screen.findByText(/last try: dnf/i)).toBeVisible();
    expect(screen.getByRole("button", { name: /try again/i })).toBeVisible();
  });

  it("a failed hero board fetch fails open to the pre-play chrome instead of a stuck skeleton (Judge A amendment 2)", async () => {
    const getChallengeBoard = vi.fn<VWikiRaceApiClient["getChallengeBoard"]>(async () => {
      throw new Error("down");
    });
    const apiClient = mockApiClient({ getChallengeBoard });
    renderHome({ apiClient, identityAccountId: "acc-1" });

    expect(await screen.findByRole("button", { name: /▶ race/i })).toBeVisible();
    expect(screen.queryByText(/checking your status/i)).toBeNull();
  });
});
