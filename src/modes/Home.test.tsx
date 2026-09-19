import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import Home from "./Home";
import type { HomeHeroSelection } from "../domain/challengeSelection";
import type { Challenge } from "../domain/types";
import type { ChallengeBoardResponse } from "../server/contracts";
import type { VWikiRaceApiClient } from "../services/vwikiRaceApiClient";
import type { VGamesIdentitySession } from "../services/vgamesIdentity";

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
  const onRaceChallenge = vi.fn();
  const props = {
    accountStats: null,
    apiClient: mockApiClient(),
    catalogStatus: "ready" as const,
    challenges: [yesterdaysDaily, todaysDaily],
    errorReporter: { reportVisibleError: vi.fn() },
    hero: { challenge: todaysDaily, kind: "today-daily" } as HomeHeroSelection,
    identitySession: null as VGamesIdentitySession | null,
    identityAccountId: null as string | null,
    identityToken: null as string | null,
    onGoToBoards,
    onGoToBoardsToday,
    onOpenChallenge: vi.fn(),
    onCreateRandomChallenge: vi.fn(),
    onRaceChallenge,
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
  return { onGoToBoards, onGoToBoardsToday, onRaceChallenge };
}

describe("Home: inviting daily overview", () => {
  it("makes the current claimed identity visible beside the daily race", () => {
    renderHome({
      identityAccountId: "acc-1",
      identitySession: {
        accountId: "acc-1",
        displayName: "Vijay",
        token: "jwt-claimed",
        status: "claimed",
      },
    });

    expect(screen.getByText("Playing as Vijay")).toBeVisible();
  });

  it("labels named guest play and the signed-out starting state honestly", () => {
    const { rerender } = render(
      <Home
        {...{
          accountStats: null,
          apiClient: mockApiClient(),
          catalogStatus: "ready" as const,
          challenges: [yesterdaysDaily, todaysDaily],
          errorReporter: { reportVisibleError: vi.fn() },
          hero: { challenge: todaysDaily, kind: "today-daily" } as HomeHeroSelection,
          identityAccountId: "guest-1",
          identitySession: {
            accountId: "guest-1",
            displayName: "River",
            token: "jwt-guest",
            status: "ghost" as const,
          },
          identityToken: "jwt-guest",
          onGoToBoards: vi.fn(),
          onGoToBoardsToday: vi.fn(),
          onOpenChallenge: vi.fn(),
          onCreateRandomChallenge: vi.fn(),
          onRaceChallenge: vi.fn(),
          onRetryCatalog: vi.fn(),
          onShowChallenges: vi.fn(),
          playAnotherSuggestion: { status: "loading" as const },
          raceBusy: false,
          randomChallengeBusy: false,
          randomChallengeError: null,
          sessionDnfChallengeIds: new Set<string>(),
          todayCentral,
        }}
      />,
    );

    expect(screen.getByText("Playing as River · Guest")).toBeVisible();

    rerender(
      <Home
        {...{
          accountStats: null,
          apiClient: mockApiClient(),
          catalogStatus: "ready" as const,
          challenges: [yesterdaysDaily, todaysDaily],
          errorReporter: { reportVisibleError: vi.fn() },
          hero: { challenge: todaysDaily, kind: "today-daily" } as HomeHeroSelection,
          identityAccountId: null,
          identitySession: null,
          identityToken: null,
          onGoToBoards: vi.fn(),
          onGoToBoardsToday: vi.fn(),
          onOpenChallenge: vi.fn(),
          onCreateRandomChallenge: vi.fn(),
          onRaceChallenge: vi.fn(),
          onRetryCatalog: vi.fn(),
          onShowChallenges: vi.fn(),
          playAnotherSuggestion: { status: "loading" as const },
          raceBusy: false,
          randomChallengeBusy: false,
          randomChallengeError: null,
          sessionDnfChallengeIds: new Set<string>(),
          todayCentral,
        }}
      />,
    );

    expect(screen.getByText("Ready when you are. No account needed to start.")).toBeVisible();
  });

  it("labels the route, explains the race in three compact steps, and preserves the daily action", async () => {
    const user = userEvent.setup();
    const { onRaceChallenge } = renderHome();

    const daily = screen.getByLabelText("Today's daily");
    expect(within(daily).getByText("Start")).toBeVisible();
    expect(within(daily).getByText("Apple")).toBeVisible();
    expect(within(daily).getByText("Target")).toBeVisible();
    expect(within(daily).getByText("Fruit")).toBeVisible();
    expect(within(daily).getByText("Find your path, one Wikipedia link at a time.")).toBeVisible();
    const howToRace = within(daily).getByRole("list", { name: /how to race/i });
    expect(within(howToRace).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Follow Wikipedia links",
      "Reach the target article",
      "The clock stops when you arrive",
    ]);

    const raceButton = within(daily).getByRole("button", { name: /race today.s challenge/i });
    await user.click(raceButton);
    expect(onRaceChallenge).toHaveBeenCalledWith(todaysDaily.id);
  });

  it("summarizes yesterday's finish and DNF counts without exposing spoiler metrics", async () => {
    const apiClient = mockApiClient({
      getChallengeBoard: vi.fn(async (challengeId: string) => challengeId === yesterdaysDaily.id
        ? {
            challengeId,
            placements: [
              { accountId: "acc-1", displayName: "Ari", placement: 1, elapsedMs: 20_000, clickCount: 3 },
              { accountId: "acc-2", displayName: "Bo", placement: 2, elapsedMs: 25_000, clickCount: 4 },
            ],
            dnfs: [
              { accountId: "acc-3", displayName: "Cam", elapsedMs: 30_000, clickCount: 5 },
            ],
          }
        : { challengeId, placements: [], dnfs: [] }),
    });

    renderHome({ apiClient });

    expect(await screen.findByText("2 finished · 1 did not finish")).toBeVisible();
  });
});

describe("Home: RC-06 (one honest loading/error system) - 'Yesterday's results' board tri-state", () => {
  it("renders a distinct error + Retry when yesterday's board fetch fails - never 'No completed runs yet.'", async () => {
    const apiClient = mockApiClient({
      getChallengeBoard: vi.fn(async (challengeId: string) => {
        if (challengeId === yesterdaysDaily.id) throw new Error("down");
        return { challengeId, placements: [], dnfs: [] };
      }),
    });
    const errorReporter = { reportVisibleError: vi.fn() };
    renderHome({ apiClient, errorReporter });

    expect(await screen.findByText(/couldn.t load this board/i)).toBeVisible();
    expect(screen.queryByText("No completed runs yet.")).toBeNull();
    // The "see full board" link (children) still renders alongside the error.
    expect(screen.getByRole("button", { name: /see full board/i })).toBeVisible();
    // This package: the rendered failure above beacons through the
    // "home-yesterday-board" surface.
    expect(errorReporter.reportVisibleError).toHaveBeenCalledWith(
      "home-yesterday-board",
      expect.any(String),
      "Couldn't load this board.",
      expect.anything(),
    );
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

/**
 * Pre-finish spoiler mask (owner ask, 2026-08-13): "before I finish the
 * race, just like I can't view the graph, I shouldn't be able to see how
 * long or # clicks on the leaderboard - just rankings and usernames." The
 * pre-play "Yesterday's results" card shows OTHER players' results before
 * the viewer has necessarily played yesterday's still-open daily - it must
 * mirror the exact same "has the viewer placed on THIS board" signal
 * (`yesterdayPathsUnlocked`) already computed for that card's own graph
 * button.
 */
describe("Home: pre-finish spoiler mask on 'Yesterday's results' (owner ask, 2026-08-13)", () => {
  it("locked: the viewer has no placement on yesterday's board - shows names, masks time/clicks", async () => {
    const apiClient = mockApiClient({
      getChallengeBoard: vi.fn(async (challengeId: string) => {
        if (challengeId === yesterdaysDaily.id) {
          return {
            challengeId,
            placements: [
              { accountId: "acc-other", displayName: "Ari", placement: 1, elapsedMs: 20_000, clickCount: 3 },
            ],
            dnfs: [],
          };
        }
        return { challengeId, placements: [], dnfs: [] };
      }),
    });
    renderHome({ apiClient, identityAccountId: "acc-1" });

    expect(await screen.findByText("Ari")).toBeVisible();
    expect(screen.queryByText("0:20 · 3 clk")).toBeNull();
    expect(screen.queryByText("—")).toBeNull();
    expect(screen.getByText("Times and clicks unlock after you finish or give up.")).toBeVisible();
  });

  it("unlocked: the viewer already has a placement on yesterday's board - shows time/clicks normally", async () => {
    const apiClient = mockApiClient({
      getChallengeBoard: vi.fn(async (challengeId: string) => {
        if (challengeId === yesterdaysDaily.id) {
          return {
            challengeId,
            placements: [
              { accountId: "acc-1", displayName: "Vijay", placement: 1, elapsedMs: 20_000, clickCount: 3 },
              { accountId: "acc-other", displayName: "Ari", placement: 2, elapsedMs: 25_000, clickCount: 4 },
            ],
            dnfs: [],
          };
        }
        return { challengeId, placements: [], dnfs: [] };
      }),
    });
    renderHome({ apiClient, identityAccountId: "acc-1" });

    expect(await screen.findByText("0:20 · 3 clk")).toBeVisible();
    expect(screen.getByText("0:25 · 4 clk")).toBeVisible();
  });

  it("anonymous viewer (no identityAccountId): always locked - never has a placement to unlock with", async () => {
    const apiClient = mockApiClient({
      getChallengeBoard: vi.fn(async (challengeId: string) => {
        if (challengeId === yesterdaysDaily.id) {
          return {
            challengeId,
            placements: [
              { accountId: "acc-other", displayName: "Ari", placement: 1, elapsedMs: 20_000, clickCount: 3 },
            ],
            dnfs: [],
          };
        }
        return { challengeId, placements: [], dnfs: [] };
      }),
    });
    renderHome({ apiClient, identityAccountId: null });

    expect(await screen.findByText("Ari")).toBeVisible();
    expect(screen.queryByText("0:20 · 3 clk")).toBeNull();
  });
});


describe("Home: temporary weekday update", () => {
  it.each(["2026-09-19", "2026-09-25"])("shows the apology on %s", (todayCentral) => {
    renderHome({ todayCentral });
    expect(screen.getByRole("note", { name: "Daily picks update" })).toHaveTextContent(
      "Sorry about the tough Thursday and Friday races—we’ve fixed the daily picks.",
    );
  });

  it.each(["2026-09-18", "2026-09-26", "2027-09-19"])("hides the apology on %s", (todayCentral) => {
    renderHome({ todayCentral });
    expect(screen.queryByRole("note", { name: "Daily picks update" })).toBeNull();
  });

  it("shows the notice while the daily is loading", () => {
    renderHome({ todayCentral: "2026-09-19", hero: null, catalogStatus: "loading" });
    expect(screen.getByRole("note", { name: "Daily picks update" })).toBeVisible();
  });
});
