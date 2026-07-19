import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import Boards from "./Boards";
import type { HomeHeroSelection } from "../domain/challengeSelection";
import type { Challenge } from "../domain/types";
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
  const props = {
    apiClient: mockApiClient(),
    challenges: [randomUserChallenge, yesterdaysDaily],
    heroSelection: null as HomeHeroSelection | null,
    identityAccountId: null as string | null,
    onRaceChallenge,
    raceBusy: false,
    todayCentral,
    ...overrides,
  };
  render(<Boards {...props} />);
  return { onRaceChallenge };
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
      expect(apiClient.getChallengeBoard).toHaveBeenCalledWith(yesterdaysDaily.id),
    );
    expect(apiClient.getChallengeBoard).not.toHaveBeenCalledWith(randomUserChallenge.id);
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

  it("QF-02: bouncing Today -> Yesterday -> Today issues no repeat network call for the closed Yesterday board", async () => {
    const apiClient = mockApiClient();
    const user = userEvent.setup();
    renderBoards({
      apiClient,
      challenges: [randomUserChallenge, yesterdaysDaily, todaysDaily],
      heroSelection: { challenge: todaysDaily, kind: "today-daily" },
    });

    await waitFor(() => expect(apiClient.getChallengeBoard).toHaveBeenCalledTimes(1));
    expect(apiClient.getChallengeBoard).toHaveBeenCalledWith(todaysDaily.id);

    await user.click(screen.getByRole("tab", { name: "Yesterday" }));
    await waitFor(() => expect(apiClient.getChallengeBoard).toHaveBeenCalledTimes(2));
    expect(apiClient.getChallengeBoard).toHaveBeenLastCalledWith(yesterdaysDaily.id);

    await user.click(screen.getByRole("tab", { name: "Today" }));
    await waitFor(() => expect(apiClient.getChallengeBoard).toHaveBeenCalledTimes(3));

    // Bounce back to the closed Yesterday board a second time - cached,
    // no fourth network call.
    await user.click(screen.getByRole("tab", { name: "Yesterday" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(apiClient.getChallengeBoard).toHaveBeenCalledTimes(3);
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
