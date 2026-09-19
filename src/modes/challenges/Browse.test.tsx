import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ChallengeBrowser from "./Browse";
import type { HomeHeroSelection } from "../../domain/challengeSelection";
import type { Challenge, ChallengeOutcomeEntry } from "../../domain/types";
import type { VWikiRaceApiClient } from "../../services/vwikiRaceApiClient";

const todayCentral = "2026-07-18";

const challengeOne: Challenge = {
  id: "challenge-0001",
  label: "Challenge #1",
  mode: "solo",
  start: { title: "Apple" },
  target: { title: "Fruit" },
  ruleset: "ranked_classic",
  source: "curated",
};

const challengeTwo: Challenge = {
  id: "challenge-0002",
  label: "Challenge #2",
  mode: "solo",
  start: { title: "Mars" },
  target: { title: "Water" },
  ruleset: "ranked_classic",
  source: "curated",
};

function pastDaily(
  id: string,
  dailyDate: string,
  startTitle: string,
  targetTitle: string,
): Challenge {
  return {
    id,
    label: `Daily ${dailyDate}`,
    mode: "daily",
    origin: "daily",
    dailyDate,
    start: { title: startTitle },
    target: { title: targetTitle },
    ruleset: "ranked_classic",
    source: "curated",
  };
}

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
    getChallengeBoard: vi.fn(async () => ({ challengeId: "", placements: [], dnfs: [] })),
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

function renderBrowse(overrides: Partial<Parameters<typeof ChallengeBrowser>[0]> = {}) {
  const onCreateChallenge = vi.fn(async () => undefined);
  const onCreateRandomChallenge = vi.fn();
  const onGoHome = vi.fn();
  const onOpenChallenge = vi.fn();
  const props = {
    apiClient: mockApiClient(),
    canNominateForDaily: false,
    challenges: [challengeOne, challengeTwo],
    // PKG-01: no pin by default - most of this suite doesn't care about the
    // daily pin, so it stays absent (`null` heroSelection) unless a test
    // opts in.
    heroSelection: null as HomeHeroSelection | null,
    identityToken: null as string | null,
    onCreateChallenge,
    onCreateRandomChallenge,
    onGoHome,
    onOpenChallenge,
    randomChallengeBusy: false,
    randomChallengeError: null as string | null,
    selectedChallengeId: null,
    todayCentral,
    ...overrides,
  };
  render(<ChallengeBrowser {...props} />);
  return { onCreateChallenge, onCreateRandomChallenge, onGoHome, onOpenChallenge };
}

describe("Browse: full card spec (Increment 5)", () => {
  it("labels each route endpoint so challenge cards scan as start to target", async () => {
    renderBrowse();

    const card = await screen.findByRole("button", { name: /challenge #1/i });
    expect(within(card).getByText("Start")).toBeVisible();
    expect(within(card).getByText("Apple")).toBeVisible();
    expect(within(card).getByText("Target")).toBeVisible();
    expect(within(card).getByText("Fruit")).toBeVisible();
    expect(card).toHaveAccessibleName(/start article: apple → fruit, the target article/i);
  });

  it("hides best metrics until the viewer has finished or given up", async () => {
    const apiClient = mockApiClient({
      getChallengesSummary: vi.fn(async () => [
        { challengeId: "challenge-0001", playerCount: 5, best: { elapsedMs: 38_000, clickCount: 5 } },
        { challengeId: "challenge-0002", playerCount: 2, best: null },
      ]),
    });
    renderBrowse({ apiClient });

    const cardOne = await screen.findByRole("button", { name: /challenge #1/i });
    expect(within(cardOne).getByText("5 players")).toBeVisible();
    expect(within(cardOne).queryByText(/best 0:38/i)).toBeNull();
    const cardTwo = screen.getByRole("button", { name: /challenge #2/i });
    expect(within(cardTwo).getByText("2 players")).toBeVisible();
  });

  it.each([
    ["completed", { challengeId: "challenge-0001", outcome: "completed" as const, best: { elapsedMs: 42_000, clickCount: 6 } }],
    ["given up", { challengeId: "challenge-0001", outcome: "dnf" as const, best: null, peeked: true }],
  ])("shows best metrics after the viewer has %s", async (_label, outcome) => {
    const apiClient = mockApiClient({
      getChallengesSummary: vi.fn(async () => [
        { challengeId: "challenge-0001", playerCount: 5, best: { elapsedMs: 38_000, clickCount: 5 } },
      ]),
      getAccountChallengeOutcomes: vi.fn(async () => [outcome]),
    });
    renderBrowse({ apiClient, identityToken: "jwt-claimed" });

    const cardOne = await screen.findByRole("button", { name: /challenge #1/i });
    expect(within(cardOne).getByText("5 players · best 0:38 · 5 clk")).toBeVisible();
  });

  it("keeps best metrics hidden for an unfinished viewer who has not given up", async () => {
    const apiClient = mockApiClient({
      getChallengesSummary: vi.fn(async () => [
        { challengeId: "challenge-0001", playerCount: 5, best: { elapsedMs: 38_000, clickCount: 5 } },
      ]),
      getAccountChallengeOutcomes: vi.fn(async () => [
        { challengeId: "challenge-0001", outcome: "dnf" as const, best: null, peeked: false },
      ]),
    });
    renderBrowse({ apiClient, identityToken: "jwt-claimed" });

    const cardOne = await screen.findByRole("button", { name: /challenge #1/i });
    expect(within(cardOne).getByText("5 players")).toBeVisible();
    expect(within(cardOne).queryByText(/best 0:38/i)).toBeNull();
  });

  it("shows no meta line for a challenge absent from the summary response", async () => {
    renderBrowse();
    const cardOne = await screen.findByRole("button", { name: /challenge #1/i });
    expect(within(cardOne).queryByText(/players/i)).toBeNull();
  });

  it("renders the correct state chip per the outcomes fixture, including completed-beats-later-DNF", async () => {
    const apiClient = mockApiClient({
      getAccountChallengeOutcomes: vi.fn(async () => [
        // The server has already resolved precedence for this entry - a
        // completed run that happened before a later abandoned retry still
        // surfaces as "completed" here (invariant 2: "a completion is
        // permanent"). The client trusts this field, it doesn't re-derive it.
        { challengeId: "challenge-0001", outcome: "completed" as const, best: { elapsedMs: 42_000, clickCount: 6 } },
      ]),
    });
    renderBrowse({ apiClient, identityToken: "jwt-claimed" });

    const cardOne = await screen.findByRole("button", { name: /challenge #1/i });
    expect(within(cardOne).getByText("✓ 0:42 · 6 clk")).toBeVisible();
    // challenge-0002 has no outcomes entry at all -> default NEW.
    const cardTwo = screen.getByRole("button", { name: /challenge #2/i });
    expect(within(cardTwo).getByText("NEW")).toBeVisible();
  });

  it("renders DNF for an attempted-never-completed outcome", async () => {
    const apiClient = mockApiClient({
      getAccountChallengeOutcomes: vi.fn(async () => [
        { challengeId: "challenge-0002", outcome: "dnf" as const, best: null },
      ]),
    });
    renderBrowse({ apiClient, identityToken: "jwt-claimed" });

    const cardTwo = await screen.findByRole("button", { name: /challenge #2/i });
    expect(within(cardTwo).getByText("DNF")).toBeVisible();
  });

  it("shows no chips at all for an anonymous visitor, and never calls the outcomes endpoint", async () => {
    const outcomes = vi.fn(async () => [
      { challengeId: "challenge-0001", outcome: "completed" as const, best: { elapsedMs: 1, clickCount: 1 } },
    ]);
    const apiClient = mockApiClient({ getAccountChallengeOutcomes: outcomes });
    renderBrowse({ apiClient, identityToken: null });

    const cardOne = await screen.findByRole("button", { name: /challenge #1/i });
    expect(within(cardOne).queryByText(/new|dnf|✓/i)).toBeNull();
    expect(outcomes).not.toHaveBeenCalled();
  });

  it("does not show one account's outcomes while a newly selected account is loading", async () => {
    let resolveSecondAccount!: (entries: ChallengeOutcomeEntry[]) => void;
    const secondAccount = new Promise<ChallengeOutcomeEntry[]>((resolve) => {
      resolveSecondAccount = resolve;
    });
    const outcomes = vi.fn((token: string) => token === "token-a"
      ? Promise.resolve([
          {
            challengeId: challengeOne.id,
            outcome: "completed" as const,
            best: { elapsedMs: 42_000, clickCount: 6 },
          },
        ])
      : secondAccount);
    const apiClient = mockApiClient({
      getChallengesSummary: vi.fn(async () => [
        {
          challengeId: challengeOne.id,
          playerCount: 5,
          best: { elapsedMs: 38_000, clickCount: 5 },
        },
      ]),
      getAccountChallengeOutcomes: outcomes,
    });
    const props = {
      apiClient,
      canNominateForDaily: false,
      challenges: [challengeOne, challengeTwo],
      heroSelection: null,
      identityToken: "token-a" as string | null,
      onCreateChallenge: vi.fn(async () => undefined),
      onCreateRandomChallenge: vi.fn(),
      onGoHome: vi.fn(),
      onOpenChallenge: vi.fn(),
      randomChallengeBusy: false,
      randomChallengeError: null,
      selectedChallengeId: null,
      todayCentral,
    };
    const view = render(<ChallengeBrowser {...props} />);

    const firstAccountCard = await screen.findByRole("button", { name: /challenge #1/i });
    expect(within(firstAccountCard).getByText("✓ 0:42 · 6 clk")).toBeVisible();
    expect(within(firstAccountCard).getByText("5 players · best 0:38 · 5 clk")).toBeVisible();

    view.rerender(<ChallengeBrowser {...props} identityToken="token-b" />);

    const secondAccountCard = screen.getByRole("button", { name: /challenge #1/i });
    expect(within(secondAccountCard).queryByText(/✓|NEW|DNF/)).toBeNull();
    expect(within(secondAccountCard).queryByText(/best 0:38/i)).toBeNull();
    expect(within(secondAccountCard).getByText("5 players")).toBeVisible();

    resolveSecondAccount([]);
    await waitFor(() => expect(within(secondAccountCard).getByText("NEW")).toBeVisible());
    expect(outcomes).toHaveBeenCalledWith("token-b");
  });

  it("reports unavailable history without inventing new or not-played states", async () => {
    const oldDaily = pastDaily("daily-0717-history-error", "2026-07-17", "Moon", "Tide");
    const apiClient = mockApiClient({
      getChallengesSummary: vi.fn(async () => [
        {
          challengeId: challengeOne.id,
          playerCount: 5,
          best: { elapsedMs: 38_000, clickCount: 5 },
        },
      ]),
      getAccountChallengeOutcomes: vi.fn(async () => {
        throw new Error("history unavailable");
      }),
    });
    const user = userEvent.setup();
    renderBrowse({
      apiClient,
      challenges: [challengeOne, oldDaily],
      identityToken: "token-a",
    });

    expect(await screen.findByRole("status")).toHaveTextContent(/history is unavailable/i);
    const card = screen.getByRole("button", { name: /challenge #1/i });
    expect(within(card).queryByText(/✓|NEW|DNF/)).toBeNull();
    expect(within(card).queryByText(/best 0:38/i)).toBeNull();
    expect(within(card).getByText("5 players")).toBeVisible();

    await user.click(screen.getByRole("button", { name: /^past dailies$/i }));
    const archive = screen.getByRole("region", { name: /past daily archive/i });
    expect(within(archive).queryByText(/not played|unfinished|completed/i)).toBeNull();
  });

  it("fetches the summary once per view and reuses it for every card (no per-card calls)", async () => {
    const summary = vi.fn(async () => []);
    renderBrowse({ apiClient: mockApiClient({ getChallengesSummary: summary }) });

    await waitFor(() => expect(summary).toHaveBeenCalledTimes(1));
  });

  it("filters cards live by title match", async () => {
    const user = userEvent.setup();
    renderBrowse();

    await screen.findByRole("button", { name: /challenge #1/i });
    await user.type(screen.getByRole("searchbox", { name: /search challenges/i }), "water");

    expect(screen.queryByRole("button", { name: /challenge #1/i })).toBeNull();
    expect(screen.getByRole("button", { name: /challenge #2/i })).toBeVisible();
  });

  it("jumps to Detail when a pasted share link resolves to a known challenge", async () => {
    const user = userEvent.setup();
    const { onOpenChallenge } = renderBrowse();

    await screen.findByRole("button", { name: /challenge #1/i });
    await user.type(
      screen.getByRole("searchbox", { name: /search challenges/i }),
      "https://vwikirace.pages.dev/?challenge=challenge-0002",
    );

    expect(onOpenChallenge).toHaveBeenCalledWith("challenge-0002");
  });

  it("jumps to Detail when a bare challenge id is pasted", async () => {
    const user = userEvent.setup();
    const { onOpenChallenge } = renderBrowse();

    await screen.findByRole("button", { name: /challenge #1/i });
    await user.type(screen.getByRole("searchbox", { name: /search challenges/i }), "challenge-0002");

    expect(onOpenChallenge).toHaveBeenCalledWith("challenge-0002");
  });

  it("does not jump for a title query that happens to be typed, only for a resolved id/link", async () => {
    const user = userEvent.setup();
    const { onOpenChallenge } = renderBrowse();

    await screen.findByRole("button", { name: /challenge #1/i });
    await user.type(screen.getByRole("searchbox", { name: /search challenges/i }), "mars");

    expect(onOpenChallenge).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /challenge #2/i })).toBeVisible();
  });

  it("wraps the search field in the svh-safe container (dvh/svh input rule)", async () => {
    renderBrowse();
    await screen.findByRole("button", { name: /challenge #1/i });
    expect(document.querySelector(".browse-search-svh-safe")).not.toBeNull();
    expect(
      document.querySelector(".browse-search-svh-safe")?.contains(
        screen.getByRole("searchbox", { name: /search challenges/i }),
      ),
    ).toBe(true);
  });

  it("offers create-random beside the create-challenge form, wired to the shared App-level callback", async () => {
    const user = userEvent.setup();
    const { onCreateRandomChallenge } = renderBrowse();

    await screen.findByRole("button", { name: /challenge #1/i });
    await user.click(screen.getByRole("button", { name: /^create a challenge$/i }));
    const randomButton = screen.getByRole("button", { name: /create a random new one/i });
    await user.click(randomButton);
    expect(onCreateRandomChallenge).toHaveBeenCalledTimes(1);
  });

  it("shows the bounded loading copy and disables the random-challenge button while busy (no double-fire)", async () => {
    const user = userEvent.setup();
    const { onCreateRandomChallenge } = renderBrowse({ randomChallengeBusy: true });

    await user.click(screen.getByRole("button", { name: /^create a challenge$/i }));
    const button = screen.getByRole("button", { name: /rolling the dice on wikipedia/i });
    expect(button).toBeDisabled();
    await user.click(button);
    expect(onCreateRandomChallenge).not.toHaveBeenCalled();
  });

  it("shows a random-challenge error message when the caller supplies one", async () => {
    renderBrowse({ randomChallengeError: "Wikipedia wasn't cooperating — try again." });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Wikipedia wasn't cooperating — try again.",
    );
  });

  it("keeps creation discoverable at the top while its form starts collapsed", async () => {
    const user = userEvent.setup();
    renderBrowse();

    const toggle = screen.getByRole("button", { name: /^create a challenge$/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText(/start article/i)).toBeNull();

    await user.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText(/start article/i)).toBeVisible();
    expect(screen.getByLabelText(/target article/i)).toBeVisible();
    const search = screen.getByRole("searchbox", { name: /search challenges/i });
    expect(toggle.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // QF-07: `submitChallenge` only gated on `isCreating` (an async state
  // setter, with a real window before re-render for a second Enter/submit
  // to fire a second request) - not the same lock as App.tsx's
  // `challengeLockRef` (that one gates "is a run currently active," not a
  // same-tick double submit).
  it("locks duplicate create-challenge submissions (no double-fire)", async () => {
    let resolveCreate!: () => void;
    const onCreateChallenge = vi.fn(
      () => new Promise<void>((resolve) => { resolveCreate = resolve; }),
    );
    render(
      <ChallengeBrowser
        apiClient={mockApiClient()}
        canNominateForDaily={false}
        challenges={[challengeOne, challengeTwo]}
        heroSelection={null}
        identityToken={null}
        onCreateChallenge={onCreateChallenge}
        onCreateRandomChallenge={vi.fn()}
        onGoHome={vi.fn()}
        onOpenChallenge={vi.fn()}
        randomChallengeBusy={false}
        randomChallengeError={null}
        selectedChallengeId={null}
        todayCentral={todayCentral}
      />,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^create a challenge$/i }));
    await user.type(screen.getByLabelText(/start article/i), "Mars");
    await user.type(screen.getByLabelText(/target article/i), "Water");
    const form = screen.getByLabelText(/start article/i).closest("form") as HTMLFormElement;

    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(onCreateChallenge).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /create challenge/i })).toBeDisabled();

    // Resolving clears the form fields on success (existing behavior) - the
    // button staying disabled afterward reflects the now-empty `canCreate`
    // gate, not a stuck lock, so assert completion via the cleared field
    // instead of the button's disabled state.
    resolveCreate();
    await waitFor(() => expect(screen.getByLabelText(/start article/i)).toHaveValue(""));
    expect(onCreateChallenge).toHaveBeenCalledTimes(1);
  });
});

describe("Browse: past daily archive", () => {
  const july15 = pastDaily("daily-0715", "2026-07-15", "Saturn", "Rings");
  const july16 = pastDaily("daily-0716", "2026-07-16", "Oak", "Forest");
  const july17 = pastDaily("daily-0717", "2026-07-17", "Moon", "Tide");
  const today = pastDaily("daily-0718", "2026-07-18", "Coffee", "Flood");

  it("shows only past dailies newest-first and navigates to a selected date", async () => {
    const user = userEvent.setup();
    renderBrowse({
      challenges: [july15, challengeOne, today, july17, july16],
      heroSelection: { challenge: today, kind: "today-daily" },
    });

    await user.click(screen.getByRole("button", { name: /^past dailies$/i }));

    const archive = screen.getByRole("region", { name: /past daily archive/i });
    expect(within(archive).getByText("Pick a date to race or revisit.")).toBeVisible();
    const cards = within(archive).getAllByRole("button", { name: /→/ });
    expect(cards.map((card) => card.textContent)).toEqual([
      expect.stringContaining("Moon"),
      expect.stringContaining("Oak"),
      expect.stringContaining("Saturn"),
    ]);
    expect(within(archive).queryByText("Coffee")).toBeNull();
    expect(within(archive).queryByText("Apple")).toBeNull();

    await user.selectOptions(screen.getByRole("combobox", { name: /past daily date/i }), "2026-07-15");
    expect(within(archive).getByRole("button", { name: /saturn.*rings/i })).toBeVisible();
    expect(within(archive).queryByRole("button", { name: /moon.*tide/i })).toBeNull();
  });

  it("uses explicit completed, unfinished, and not-played states", async () => {
    const user = userEvent.setup();
    const apiClient = mockApiClient({
      getAccountChallengeOutcomes: vi.fn(async () => [
        { challengeId: july17.id, outcome: "completed" as const, best: { elapsedMs: 42_000, clickCount: 6 } },
        { challengeId: july16.id, outcome: "dnf" as const, best: null },
      ]),
    });
    renderBrowse({
      apiClient,
      challenges: [july15, july16, july17],
      identityToken: "jwt-claimed",
    });

    await user.click(screen.getByRole("button", { name: /^past dailies$/i }));

    expect(await screen.findByText("Completed · 0:42 · 6 clk")).toBeVisible();
    expect(screen.getByText("Unfinished")).toBeVisible();
    expect(screen.getByText("Not played")).toBeVisible();
  });

  it("opens an archived daily through the ordinary challenge-detail callback", async () => {
    const user = userEvent.setup();
    const { onOpenChallenge } = renderBrowse({ challenges: [july17] });

    await user.click(screen.getByRole("button", { name: /^past dailies$/i }));
    await user.click(screen.getByRole("button", { name: /moon.*tide/i }));

    expect(onOpenChallenge).toHaveBeenCalledWith(july17.id);
  });
});

describe("Browse: pinned daily row (PKG-01 - one source of truth for 'today's daily')", () => {
  const pinnedChallenge: Challenge = {
    id: "challenge-daily-01",
    label: "Daily 2026-07-18",
    mode: "daily",
    start: { title: "Coffee" },
    target: { title: "Great Molasses Flood" },
    ruleset: "ranked_classic",
    source: "curated",
    origin: "daily",
    dailyDate: "2026-07-18",
  };

  it("pins the shared hero selection above the catalog, routing to Home (not Detail)", async () => {
    const user = userEvent.setup();
    const { onGoHome, onOpenChallenge } = renderBrowse({
      heroSelection: { challenge: pinnedChallenge, kind: "today-daily" },
    });

    const pinned = await screen.findByRole("button", { name: /coffee.*great molasses flood/i });
    expect(pinned.querySelector(".daily-badge")?.textContent).toBe("⭐ Today");

    await user.click(pinned);
    expect(onGoHome).toHaveBeenCalledTimes(1);
    expect(onOpenChallenge).not.toHaveBeenCalled();
  });

  it("labels a pre-drop yesterday's-daily pin honestly (never 'Today'), still routing Home", async () => {
    const user = userEvent.setup();
    const { onGoHome } = renderBrowse({
      heroSelection: { challenge: pinnedChallenge, kind: "yesterday-daily" },
      todayCentral: "2026-07-19",
    });

    const pinned = await screen.findByRole("button", { name: /coffee.*great molasses flood/i });
    expect(pinned.querySelector(".daily-badge")?.textContent).toBe("⭐ Daily 7/18");

    await user.click(pinned);
    expect(onGoHome).toHaveBeenCalledTimes(1);
  });

  it("shows the pin's state chip from the same outcomes source as ordinary cards", async () => {
    const apiClient = mockApiClient({
      getAccountChallengeOutcomes: vi.fn(async () => [
        {
          challengeId: pinnedChallenge.id,
          outcome: "completed" as const,
          best: { elapsedMs: 42_000, clickCount: 6 },
        },
      ]),
    });
    renderBrowse({
      apiClient,
      heroSelection: { challenge: pinnedChallenge, kind: "today-daily" },
      identityToken: "jwt-claimed",
    });

    const pinned = await screen.findByRole("button", { name: /coffee.*great molasses flood/i });
    expect(within(pinned).getByText("✓ 0:42 · 6 clk")).toBeVisible();
  });

  // FB-9 Part 2 (owner ruling, 2026-07-20): the pin is standing chrome
  // (its own block, structurally rendered above `.challenge-list`'s
  // catalog `<ol>` regardless of data) - never affected by catalog
  // ordering either way. Browse itself never sorts `challenges` (that's
  // `getSortedChallenges`'s job upstream - see domain/challenges.test.ts
  // and App.test.tsx's create-flow coverage); this just proves Browse
  // renders whatever order it's handed, with the pin unmoved even when it
  // has the OLDEST sortOrder of the three (never "the newest," which would
  // have hidden a real ordering bug here).
  it("keeps the pin above the catalog regardless of its own sortOrder relative to the (now newest-first) catalog order", async () => {
    renderBrowse({
      challenges: [challengeTwo, challengeOne],
      heroSelection: { challenge: { ...pinnedChallenge, sortOrder: 1 }, kind: "today-daily" },
    });

    const cardButtons = await screen.findAllByRole("button", { name: /→/ });
    const names = cardButtons.map((button) => button.textContent ?? "");
    expect(names).toEqual([
      expect.stringContaining("Coffee"),
      expect.stringContaining("Mars"),
      expect.stringContaining("Apple"),
    ]);
  });

  it("shows no pinned row while the hero selection hasn't resolved yet", () => {
    renderBrowse({ heroSelection: null });
    expect(screen.queryByLabelText("Today's daily")).toBeNull();
  });

  it("shows no pinned row for the 'default' fallback kind - never disguises a random challenge as the daily", async () => {
    renderBrowse({
      heroSelection: { challenge: challengeOne, kind: "default" },
    });

    // challengeOne is a real catalog card (no daily fields at all), so it
    // still renders as an ordinary card below - just never a second time,
    // starred, as if it were the daily.
    await screen.findByRole("button", { name: /challenge #1/i });
    expect(screen.queryByLabelText("Today's daily")).toBeNull();
  });

  it("QF-03: never lists today's pinned daily a second time in All challenges", async () => {
    renderBrowse({
      // The pinned challenge IS a member of `challenges` here (unlike this
      // suite's other fixtures) - the exact shape that reproduced the
      // shipped duplicate-listing bug: without the id-exclusion fix, this
      // same card renders both as the pinned row above and as an ordinary
      // catalog row below.
      challenges: [pinnedChallenge, challengeOne],
      heroSelection: { challenge: pinnedChallenge, kind: "today-daily" },
    });

    await screen.findByLabelText("Today's daily");
    const matches = await screen.findAllByRole("button", {
      name: /coffee.*great molasses flood/i,
    });
    expect(matches).toHaveLength(1);

    // The rest of the catalog is unaffected - challengeOne still shows.
    expect(screen.getByRole("button", { name: /challenge #1/i })).toBeVisible();
  });

  it("QF-03: routes the pinned card's badge through the flavor+number format", async () => {
    const dailyFeatureChallenge: Challenge = {
      ...pinnedChallenge,
      dailyFeature: { dailyDate: "2026-07-18", flavor: "hard", selectionSource: "automatic", dailyNumber: 7 },
    };

    renderBrowse({
      heroSelection: { challenge: dailyFeatureChallenge, kind: "today-daily" },
    });
    const pinned = await screen.findByRole("button", { name: /coffee.*great molasses flood/i });
    expect(pinned.querySelector(".daily-badge")?.textContent).toBe("⭐ Hard · Daily #7");
  });

  it("QF-03: honors pre-drop yesterday framing on the pinned card's flavor badge, matching Home/Boards", async () => {
    const dailyFeatureChallenge: Challenge = {
      ...pinnedChallenge,
      dailyFeature: { dailyDate: "2026-07-18", flavor: "hard", selectionSource: "automatic", dailyNumber: 7 },
    };

    renderBrowse({
      heroSelection: { challenge: dailyFeatureChallenge, kind: "yesterday-daily" },
    });
    const pinned = await screen.findByRole("button", { name: /coffee.*great molasses flood/i });
    expect(pinned.querySelector(".daily-badge")?.textContent).toBe(
      "⭐ Yesterday's daily · Hard · Daily #7",
    );
  });
});
