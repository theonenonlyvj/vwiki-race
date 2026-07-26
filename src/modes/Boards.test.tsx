import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import Boards from "./Boards";
import type { HomeHeroSelection } from "../domain/challengeSelection";
import type { Challenge, ServerPathStep } from "../domain/types";
import type { ChallengeBoardResponse } from "../server/contracts";
import type { VWikiRaceApiClient } from "../services/vwikiRaceApiClient";

const todayCentral = "2026-07-19";

// The exact regression scenario from the council screenshots: a plain,
// non-daily user challenge that the pre-PKG-01 `selectDefaultChallenge`
// fallback silently picked as "today's" whenever no real daily existed yet.
const randomUserChallenge: Challenge = {
  id: "challenge-0001",
  label: "Challenge #1",
  mode: "solo",
  start: { title: "Moon" },
  target: { title: "Gravity" },
  ruleset: "ranked_classic",
  source: "curated",
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
    ...overrides,
  };
}

function renderBoards(overrides: Partial<Parameters<typeof Boards>[0]> = {}) {
  const onRaceChallenge = vi.fn();
  const onDisclosePath = vi.fn();
  const onOpenChallenge = vi.fn();
  const onShowChallenges = vi.fn();
  const props = {
    apiClient: mockApiClient(),
    challenges: [randomUserChallenge, yesterdaysDaily],
    heroSelection: null as HomeHeroSelection | null,
    identityAccountId: null as string | null,
    identityToken: null as string | null,
    onDisclosePath,
    onOpenChallenge,
    onRaceChallenge,
    onShowChallenges,
    raceBusy: false,
    runPaths: {} as Record<string, ServerPathStep[]>,
    todayCentral,
    ...overrides,
  };
  render(<Boards {...props} />);
  return { onDisclosePath, onOpenChallenge, onRaceChallenge, onShowChallenges };
}

describe("Boards: Today shares Home's honest hero selection (PKG-01)", () => {
  it("kind today-daily: renders the ordinary TODAY framing + 'Race today's daily' CTA", async () => {
    const { onRaceChallenge } = renderBoards({
      challenges: [randomUserChallenge, yesterdaysDaily, todaysDaily],
      heroSelection: { challenge: todaysDaily, kind: "today-daily" },
    });

    const header = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(".board-segment-header");
      if (!el) throw new Error("header not rendered yet");
      return el;
    });
    expect(within(header).getByText("Today")).toBeVisible();
    expect(within(header).getByText("Hard")).toBeVisible();
    expect(within(header).getByText(/apple.*fruit/i)).toBeVisible();

    const cta = screen.getByRole("button", { name: /race today's daily/i });
    await userEvent.setup().click(cta);
    expect(onRaceChallenge).toHaveBeenCalledWith(todaysDaily.id);
  });

  it("kind yesterday-daily (pre-drop): Today mirrors Home's honest framing - no unqualified TODAY label, bare 'Race' CTA", async () => {
    renderBoards({
      heroSelection: { challenge: yesterdaysDaily, kind: "yesterday-daily" },
    });

    const header = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(".board-segment-header");
      if (!el) throw new Error("header not rendered yet");
      return el;
    });
    // The honest combined badge, exactly Home's copy - never a bare "Today"
    // kicker alongside it.
    expect(within(header).getByText("Yesterday's daily · Weird")).toBeVisible();
    expect(within(header).queryByText("Today")).toBeNull();

    // CTA downgrades to a bare "Race" - "Race today's daily" would be a lie
    // about a challenge that isn't actually today's.
    expect(screen.getByRole("button", { name: /^▶ race$/i })).toBeVisible();
    expect(screen.queryByRole("button", { name: /race today's daily/i })).toBeNull();
  });

  it("kind default (no daily anywhere): Today shows an explicit empty state, never the arbitrary fallback challenge under TODAY", async () => {
    const apiClient = mockApiClient();
    renderBoards({
      apiClient,
      challenges: [randomUserChallenge],
      heroSelection: { challenge: randomUserChallenge, kind: "default" },
    });

    expect(await screen.findByText(/no daily challenge right now/i)).toBeVisible();
    // The regression this package fixes: Moon -> Gravity (an arbitrary user
    // challenge, no daily badge in Browse) must never render as "today's."
    expect(screen.queryByText(/moon/i)).toBeNull();
    expect(screen.queryByText("TODAY")).toBeNull();
    expect(screen.queryByRole("button", { name: /race/i })).toBeNull();
    await waitFor(() => expect(apiClient.getChallengeBoard).not.toHaveBeenCalled());
  });

  it("the board query follows the honest selection: fetches yesterday's-daily id, not the old activeChallenges[0] fallback", async () => {
    const apiClient = mockApiClient();
    renderBoards({
      apiClient,
      heroSelection: { challenge: yesterdaysDaily, kind: "yesterday-daily" },
    });

    await waitFor(() =>
      // RC-03: "Today" always passes `{ closed: false }` - this is the
      // pre-drop case where the live daily genuinely IS yesterday's, so it
      // must keep the short open-board TTL, not the permanent closed one.
      expect(apiClient.getChallengeBoard).toHaveBeenCalledWith(yesterdaysDaily.id, { closed: false }),
    );
    expect(apiClient.getChallengeBoard).not.toHaveBeenCalledWith(
      randomUserChallenge.id,
      expect.anything(),
    );
  });

  it("Today and Yesterday intentionally render the identical board pre-drop (owner-proxy ruling: accepted duplication, not a bug)", async () => {
    const board: ChallengeBoardResponse = {
      challengeId: yesterdaysDaily.id,
      placements: [
        { accountId: "acc-1", displayName: "FranTheGreat", placement: 1, elapsedMs: 62_000, clickCount: 8 },
      ],
      dnfs: [],
    };
    const apiClient = mockApiClient({
      getChallengeBoard: vi.fn(async () => board),
    });
    const user = userEvent.setup();
    renderBoards({
      apiClient,
      heroSelection: { challenge: yesterdaysDaily, kind: "yesterday-daily" },
    });

    await screen.findByText("FranTheGreat");
    const todayHeader = document.querySelector<HTMLElement>(".board-segment-header")?.textContent;
    expect(todayHeader).toContain("Coffee");

    await user.click(screen.getByRole("tab", { name: "Yesterday" }));

    await screen.findByText("FranTheGreat");
    const yesterdayHeader = document.querySelector<HTMLElement>(".board-segment-header")?.textContent;
    expect(yesterdayHeader).toContain("Coffee");
  });

  it("RC-03 (was QF-02): passes the correct open/closed hint per segment - the api client, not Boards, now owns not-refetching a closed board", async () => {
    // QF-02 originally asserted "no fourth network call" against Boards'
    // OWN component-local `yesterdayBoardCache` (a `useRef` Map). RC-03
    // deleted that ref and moved the actual caching into
    // vwikiRaceApiClient.ts, which this test's hand-built `mockApiClient()`
    // (a bare `vi.fn()` with no caching of its own) never exercises - so
    // "no repeat call" is no longer this component's contract to prove
    // (see vwikiRaceApiClient.test.ts's own closed-board-forever-cached
    // coverage for that). What Boards.tsx DOES still own is computing the
    // right `{ closed }` hint per segment/challenge - that's what this test
    // now checks instead.
    const apiClient = mockApiClient();
    const user = userEvent.setup();
    renderBoards({
      apiClient,
      challenges: [randomUserChallenge, yesterdaysDaily, todaysDaily],
      heroSelection: { challenge: todaysDaily, kind: "today-daily" },
    });

    await waitFor(() => expect(apiClient.getChallengeBoard).toHaveBeenCalledTimes(1));
    expect(apiClient.getChallengeBoard).toHaveBeenLastCalledWith(todaysDaily.id, { closed: false });

    await user.click(screen.getByRole("tab", { name: "Yesterday" }));
    await waitFor(() => expect(apiClient.getChallengeBoard).toHaveBeenCalledTimes(2));
    // Post-drop here (today's real daily differs from yesterday's), so
    // Yesterday genuinely is closed, bygone-day data.
    expect(apiClient.getChallengeBoard).toHaveBeenLastCalledWith(yesterdaysDaily.id, { closed: true });

    await user.click(screen.getByRole("tab", { name: "Today" }));
    await waitFor(() => expect(apiClient.getChallengeBoard).toHaveBeenCalledTimes(3));
    expect(apiClient.getChallengeBoard).toHaveBeenLastCalledWith(todaysDaily.id, { closed: false });

    // Bouncing back to Yesterday a second time still asks THIS mock again
    // (it has no memory) - a real client would serve it from cache, proven
    // separately in vwikiRaceApiClient.test.ts.
    await user.click(screen.getByRole("tab", { name: "Yesterday" }));
    await waitFor(() => expect(apiClient.getChallengeBoard).toHaveBeenCalledTimes(4));
    expect(apiClient.getChallengeBoard).toHaveBeenLastCalledWith(yesterdaysDaily.id, { closed: true });
  });

  it("PKG-07: Today's badge carries the server-computed 'Daily #N' alongside the flavor, once the challenge carries a dailyNumber", async () => {
    const numberedDaily: Challenge = {
      ...todaysDaily,
      dailyFeature: { ...todaysDaily.dailyFeature!, dailyNumber: 7 },
    };
    renderBoards({
      challenges: [randomUserChallenge, yesterdaysDaily, numberedDaily],
      heroSelection: { challenge: numberedDaily, kind: "today-daily" },
    });

    const header = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(".board-segment-header");
      if (!el) throw new Error("header not rendered yet");
      return el;
    });
    expect(within(header).getByText("Today")).toBeVisible();
    expect(within(header).getByText("Hard · Daily #7")).toBeVisible();
  });
});

describe("Boards: RC-06 (one honest loading/error system) - daily board tri-state", () => {
  it("renders a distinct error + Retry when the board fetch fails - never 'No completed runs yet.'", async () => {
    const apiClient = mockApiClient({
      getChallengeBoard: vi.fn(async () => {
        throw new Error("network down");
      }),
    });
    renderBoards({
      apiClient,
      challenges: [randomUserChallenge, yesterdaysDaily, todaysDaily],
      heroSelection: { challenge: todaysDaily, kind: "today-daily" },
    });

    expect(await screen.findByText(/couldn.t load this board/i)).toBeVisible();
    expect(screen.getByRole("button", { name: /retry/i })).toBeVisible();
    expect(screen.queryByText("No completed runs yet.")).toBeNull();
  });

  it("Retry recovers the board in place once the fetch succeeds - no reload, no fresh navigation", async () => {
    const getChallengeBoard = vi.fn<
      VWikiRaceApiClient["getChallengeBoard"]
    >(async () => {
      throw new Error("still down");
    });
    const apiClient = mockApiClient({ getChallengeBoard });
    const user = userEvent.setup();
    renderBoards({
      apiClient,
      challenges: [randomUserChallenge, yesterdaysDaily, todaysDaily],
      heroSelection: { challenge: todaysDaily, kind: "today-daily" },
    });

    await screen.findByRole("button", { name: /retry/i });

    getChallengeBoard.mockImplementation(async (challengeId: string) => ({
      challengeId,
      placements: [
        { accountId: "acc-1", displayName: "FranTheGreat", placement: 1, elapsedMs: 42_000, clickCount: 6 },
      ],
      dnfs: [],
    }));
    await user.click(screen.getByRole("button", { name: /retry/i }));

    expect(await screen.findByText("FranTheGreat")).toBeVisible();
    expect(screen.queryByText(/couldn.t load this board/i)).toBeNull();
  });

  it("scopes the error per segment+challenge (Judge B amend 5) - a Today failure never leaks into Yesterday, and reappears on switching back", async () => {
    const getChallengeBoard = vi.fn(async (challengeId: string) => {
      if (challengeId === todaysDaily.id) throw new Error("today is down");
      return { challengeId, placements: [], dnfs: [] };
    });
    const apiClient = mockApiClient({ getChallengeBoard });
    const user = userEvent.setup();
    renderBoards({
      apiClient,
      challenges: [randomUserChallenge, yesterdaysDaily, todaysDaily],
      heroSelection: { challenge: todaysDaily, kind: "today-daily" },
    });

    expect(await screen.findByText(/couldn.t load this board/i)).toBeVisible();

    await user.click(screen.getByRole("tab", { name: "Yesterday" }));
    expect(await screen.findByText("No completed runs yet.")).toBeVisible();
    expect(screen.queryByText(/couldn.t load this board/i)).toBeNull();

    await user.click(screen.getByRole("tab", { name: "Today" }));
    expect(await screen.findByText(/couldn.t load this board/i)).toBeVisible();
  });

  it("stages the board's own loading copy - nothing before 300ms, honest 'Loading board…' at 300ms, escalates to 'Still working on it…' + Retry at 2000ms", async () => {
    vi.useFakeTimers();
    try {
      let resolveBoard: (value: ChallengeBoardResponse) => void = () => {};
      const getChallengeBoard = vi.fn(
        () =>
          new Promise<ChallengeBoardResponse>((resolve) => {
            resolveBoard = resolve;
          }),
      );
      const apiClient = mockApiClient({ getChallengeBoard });
      renderBoards({
        apiClient,
        challenges: [randomUserChallenge, yesterdaysDaily, todaysDaily],
        heroSelection: { challenge: todaysDaily, kind: "today-daily" },
      });

      expect(screen.queryByText(/loading board/i)).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(screen.getByText(/loading board/i)).toBeVisible();
      expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_700);
      });
      expect(screen.getByText(/still working on it/i)).toBeVisible();
      expect(screen.getByRole("button", { name: /retry/i })).toBeVisible();

      resolveBoard({ challengeId: todaysDaily.id, placements: [], dnfs: [] });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText("No completed runs yet.")).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Boards: zero-finisher board copy (owner incident, 2026-07-26)", () => {
  it("shows 'No one has cracked this one yet.' when a daily has zero completions but a real, counted DNF", async () => {
    const apiClient = mockApiClient({
      getChallengeBoard: vi.fn(async (challengeId: string) => ({
        challengeId,
        placements: [],
        dnfs: [
          { accountId: "acc-1", displayName: "Ari", elapsedMs: 1_716_556, clickCount: 30 },
          { accountId: "acc-2", displayName: "Sam", elapsedMs: 2_169_899, clickCount: 26 },
        ],
      })),
    });
    renderBoards({
      apiClient,
      challenges: [randomUserChallenge, yesterdaysDaily, todaysDaily],
      heroSelection: { challenge: todaysDaily, kind: "today-daily" },
    });

    expect(await screen.findByText("No one has cracked this one yet.")).toBeVisible();
    expect(screen.queryByText("No completed runs yet.")).toBeNull();
    // The DNF rows still render below - this is a "no finishers YET" message
    // for a board full of real attempts, not a "genuinely no one played"
    // claim.
    expect(screen.getByText("Ari")).toBeVisible();
    expect(screen.getByText("Sam")).toBeVisible();
  });

  it("keeps the plain 'No completed runs yet.' when a daily is genuinely untouched (zero placements, zero DNFs)", async () => {
    const apiClient = mockApiClient({
      getChallengeBoard: vi.fn(async (challengeId: string) => ({
        challengeId,
        placements: [],
        dnfs: [],
      })),
    });
    renderBoards({
      apiClient,
      challenges: [randomUserChallenge, yesterdaysDaily, todaysDaily],
      heroSelection: { challenge: todaysDaily, kind: "today-daily" },
    });

    expect(await screen.findByText("No completed runs yet.")).toBeVisible();
    expect(screen.queryByText("No one has cracked this one yet.")).toBeNull();
  });
});

/**
 * Zero-finisher escape hatch (owner ask, 2026-07-26): "on a day when nobody
 * has finished the daily, point players at an easier challenge." Appends a
 * link under the zero-finisher copy above, ONLY on Today's real daily -
 * reuses Increment 5's existing play-another suggestion endpoint rather than
 * any new server logic (`ZeroFinisherSuggestion`'s own test file covers the
 * suggestion/fallback/anonymous copy logic directly; these tests cover the
 * wiring into Boards - fetch trigger, callback plumbing, and the Today-only
 * gate).
 */
describe("Boards: zero-finisher escape hatch link (owner ask, 2026-07-26)", () => {
  const zeroFinisherBoard = {
    placements: [],
    dnfs: [
      { accountId: "acc-1", displayName: "Ari", elapsedMs: 1_716_556, clickCount: 30 },
    ],
  };
  const easierChallenge: Challenge = {
    id: "challenge-easy-01",
    label: "Easier Challenge",
    mode: "solo",
    start: { title: "Cat" },
    target: { title: "Animal" },
    ruleset: "ranked_classic",
    source: "curated",
  };

  it("signed in + a suggestion exists: appends 'Try an easier one ›', opening the suggested challenge's Detail on click", async () => {
    const apiClient = mockApiClient({
      getChallengeBoard: vi.fn(async (challengeId: string) => ({ challengeId, ...zeroFinisherBoard })),
      getPlayAnotherSuggestion: vi.fn(async () => easierChallenge),
    });
    const { onOpenChallenge } = renderBoards({
      apiClient,
      challenges: [randomUserChallenge, yesterdaysDaily, todaysDaily],
      heroSelection: { challenge: todaysDaily, kind: "today-daily" },
      identityAccountId: "acc-me",
      identityToken: "jwt-me",
    });

    expect(await screen.findByText("No one has cracked this one yet.")).toBeVisible();
    const link = await screen.findByRole("button", { name: /try an easier one/i });

    await userEvent.setup().click(link);
    expect(onOpenChallenge).toHaveBeenCalledWith("challenge-easy-01");
  });

  it("signed in but the suggestion is empty (started everything): falls back to 'Browse all challenges ›'", async () => {
    const apiClient = mockApiClient({
      getChallengeBoard: vi.fn(async (challengeId: string) => ({ challengeId, ...zeroFinisherBoard })),
      getPlayAnotherSuggestion: vi.fn(async () => null),
    });
    const { onShowChallenges } = renderBoards({
      apiClient,
      challenges: [randomUserChallenge, yesterdaysDaily, todaysDaily],
      heroSelection: { challenge: todaysDaily, kind: "today-daily" },
      identityAccountId: "acc-me",
      identityToken: "jwt-me",
    });

    expect(await screen.findByText("No one has cracked this one yet.")).toBeVisible();
    const link = await screen.findByRole("button", { name: /browse all challenges/i });
    expect(screen.queryByText(/try an easier one/i)).toBeNull();

    await userEvent.setup().click(link);
    expect(onShowChallenges).toHaveBeenCalledTimes(1);
  });

  it("anonymous viewer: links Browse directly and never calls the suggestion endpoint (it needs an account)", async () => {
    const getPlayAnotherSuggestion = vi.fn(async () => easierChallenge);
    const apiClient = mockApiClient({
      getChallengeBoard: vi.fn(async (challengeId: string) => ({ challengeId, ...zeroFinisherBoard })),
      getPlayAnotherSuggestion,
    });
    const { onShowChallenges } = renderBoards({
      apiClient,
      challenges: [randomUserChallenge, yesterdaysDaily, todaysDaily],
      heroSelection: { challenge: todaysDaily, kind: "today-daily" },
      identityAccountId: null,
      identityToken: null,
    });

    expect(await screen.findByText("No one has cracked this one yet.")).toBeVisible();
    const link = await screen.findByRole("button", { name: /browse all challenges/i });
    expect(screen.queryByText(/try an easier one/i)).toBeNull();

    await userEvent.setup().click(link);
    expect(onShowChallenges).toHaveBeenCalledTimes(1);
    expect(getPlayAnotherSuggestion).not.toHaveBeenCalled();
  });

  it("Yesterday's zero-finisher board (non-daily-today surface) never gets the link, even signed in with a real suggestion", async () => {
    const user = userEvent.setup();
    const apiClient = mockApiClient({
      getChallengeBoard: vi.fn(async (challengeId: string) => ({ challengeId, ...zeroFinisherBoard })),
      getPlayAnotherSuggestion: vi.fn(async () => easierChallenge),
    });
    renderBoards({
      apiClient,
      challenges: [randomUserChallenge, yesterdaysDaily, todaysDaily],
      heroSelection: { challenge: todaysDaily, kind: "today-daily" },
      identityAccountId: "acc-me",
      identityToken: "jwt-me",
    });

    await user.click(screen.getByRole("tab", { name: "Yesterday" }));

    expect(await screen.findByText("No one has cracked this one yet.")).toBeVisible();
    expect(screen.queryByRole("button", { name: /try an easier one/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /browse all challenges/i })).toBeNull();
  });
});

describe("Boards: FB-4 path comparison (council 2026-07-19, owner decision 10)", () => {
  const boardWithRunIds: ChallengeBoardResponse = {
    challengeId: yesterdaysDaily.id,
    placements: [
      { accountId: "acc-1", displayName: "Vijay", placement: 1, elapsedMs: 20_000, clickCount: 3, runId: "run-you" },
      { accountId: "acc-2", displayName: "Ari", placement: 2, elapsedMs: 25_000, clickCount: 4, runId: "run-ari" },
    ],
    dnfs: [{ accountId: "acc-3", displayName: "Sam", elapsedMs: 5_000, clickCount: 1 }],
  };

  it("keeps every placement's path hidden (including a row that carries a runId) until the viewer has finished this board's challenge", async () => {
    const apiClient = mockApiClient({
      getChallengeBoard: vi.fn(async () => ({
        ...boardWithRunIds,
        // The viewer (acc-1) hasn't finished - only Ari's completed row and
        // Sam's DNF are on the board.
        placements: boardWithRunIds.placements.filter((row) => row.accountId !== "acc-1"),
      })),
    });
    renderBoards({
      apiClient,
      identityAccountId: "acc-1",
      heroSelection: { challenge: yesterdaysDaily, kind: "yesterday-daily" },
    });

    await screen.findByText("Ari");
    expect(screen.getByText(/paths hidden until you've played/i)).toBeVisible();
    expect(screen.queryByText(/view path/i)).toBeNull();
  });

  it("discloses any placement's winning path (not just your own), and never a DNF row's, once you've finished this board's challenge", async () => {
    const apiClient = mockApiClient({
      getChallengeBoard: vi.fn(async () => boardWithRunIds),
    });
    const user = userEvent.setup();
    const { onDisclosePath } = renderBoards({
      apiClient,
      identityAccountId: "acc-1",
      heroSelection: { challenge: yesterdaysDaily, kind: "yesterday-daily" },
    });

    expect(await screen.findByText("Ari")).toBeVisible();
    // Invariant 5 stands down once the viewer's own placement row exists.
    expect(screen.queryByText(/paths hidden until you've played/i)).toBeNull();

    const ariRow = screen.getByText("Ari").closest("li");
    expect(ariRow).not.toBeNull();
    await user.click(within(ariRow as HTMLElement).getByText("View path"));
    expect(onDisclosePath).toHaveBeenCalledWith("run-ari");

    // Your own row is disclosable too, off the same board.
    const yourRow = screen.getByText("Vijay").closest("li");
    expect(within(yourRow as HTMLElement).getByText("View path")).toBeVisible();

    // DNF rows never get the affordance - `ChallengeBoardDnfRow` carries no
    // `runId` to disclose.
    const dnfSection = screen.getByRole("region", { name: "DNF" });
    expect(within(dnfSection).getByText("Sam")).toBeVisible();
    expect(within(dnfSection).queryByText(/view path/i)).toBeNull();
  });
});
