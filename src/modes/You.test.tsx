import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import You from "./You";
import type { AccountStats, PageStat } from "../domain/types";
import type { VGamesIdentitySession } from "../services/vgamesIdentity";

const NO_DATA = "No data yet.";

const claimedSession: VGamesIdentitySession = {
  accountId: "acc-1",
  displayName: "Vijay",
  token: "token-1",
  status: "claimed",
};

const zeroStats: AccountStats = {
  totals: {
    attempts: 0,
    completed: 0,
    abandoned: 0,
    timedCompleted: 0,
    totalClicks: 0,
    bestClicks: null,
    bestElapsedMs: null,
    averageClicks: 0,
    averageElapsedMs: 0,
    totalDwellMs: 0,
  },
  mostVisited: [],
  mostTimeSpent: [],
  dailyStreak: 0,
  trend30: { ranked: false, avgPlacement: null, beatRate: null, gradedCount: 0, playedCount: 0, guard: 3 },
};

function renderYou(overrides: Partial<Parameters<typeof You>[0]> = {}) {
  const onClaimIdentity = vi.fn();
  const onGoHome = vi.fn();
  const onLogOut = vi.fn();
  const onPlayAsSomeoneElse = vi.fn();
  const onRetryStats = vi.fn();
  const onSwitchAccount = vi.fn();
  const props = {
    identitySession: claimedSession as VGamesIdentitySession | null,
    onClaimIdentity,
    onGoHome,
    onLogOut,
    onPlayAsSomeoneElse,
    onRetryStats,
    onSwitchAccount,
    stats: null as AccountStats | null,
    statsStatus: "ready" as "loading" | "error" | "ready",
    ...overrides,
  };
  render(<You {...props} />);
  return { onClaimIdentity, onGoHome, onLogOut, onPlayAsSomeoneElse, onRetryStats, onSwitchAccount };
}

describe("You: RC-06 (one honest loading/error system) - three visually distinct stats states", () => {
  it("loading: stages honestly - nothing before 300ms, then a muted loading treatment distinct from 'No data yet.'", () => {
    vi.useFakeTimers();
    try {
      renderYou({ stats: null, statsStatus: "loading" });

      expect(screen.queryByText(/loading your stats/i)).toBeNull();
      expect(screen.queryByText("No data yet.")).toBeNull();

      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(screen.getByText(/loading your stats/i)).toBeVisible();
      expect(screen.queryByText("No data yet.")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("error: renders an inline 'Couldn't load your stats' + Retry that bumps statsRefreshVersion via onRetryStats", async () => {
    const user = userEvent.setup();
    const { onRetryStats } = renderYou({ stats: null, statsStatus: "error" });

    expect(screen.getByText(/couldn.t load your stats/i)).toBeVisible();
    expect(screen.queryByText("No data yet.")).toBeNull();

    await user.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRetryStats).toHaveBeenCalledTimes(1);
  });

  it("ready + genuine zero: renders the real '0' totals and 'No data yet.' only for legitimately-null fields - never the loading/error copy", () => {
    renderYou({ stats: zeroStats, statsStatus: "ready" });

    expect(screen.queryByText(/loading your stats/i)).toBeNull();
    expect(screen.queryByText(/couldn.t load your stats/i)).toBeNull();
    // Confirmed-zero totals render as "0", not a placeholder.
    const finished = screen.getByText("of 0 finished").closest("div")!;
    expect(finished).toHaveTextContent("0");
    // bestElapsedMs/bestClicks are legitimately null before a first
    // completion - "No data yet." is correct there even in the ready state.
    const bestSpeedRow = screen.getByText("fastest race").closest("div")!;
    expect(bestSpeedRow).toHaveTextContent(NO_DATA);
  });

  it("the three states are mutually exclusive and distinct on the same identity", () => {
    const { rerender } = render(
      <You
        identitySession={claimedSession}
        onClaimIdentity={vi.fn()}
        onGoHome={vi.fn()}
        onLogOut={vi.fn()}
        onPlayAsSomeoneElse={vi.fn()}
        onRetryStats={vi.fn()}
        onSwitchAccount={vi.fn()}
        stats={null}
        statsStatus="error"
      />,
    );
    expect(screen.getByText(/couldn.t load your stats/i)).toBeVisible();

    rerender(
      <You
        identitySession={claimedSession}
        onClaimIdentity={vi.fn()}
        onGoHome={vi.fn()}
        onLogOut={vi.fn()}
        onPlayAsSomeoneElse={vi.fn()}
        onRetryStats={vi.fn()}
        onSwitchAccount={vi.fn()}
        stats={zeroStats}
        statsStatus="ready"
      />,
    );
    expect(screen.queryByText(/couldn.t load your stats/i)).toBeNull();
    expect(screen.getByText("Your stats")).toBeVisible();
  });

  it("a fully signed-out visitor still gets the never-played empty state regardless of statsStatus", () => {
    renderYou({ identitySession: null, stats: null, statsStatus: "loading" });
    expect(screen.getByText(/play your first race/i)).toBeVisible();
    expect(screen.queryByText(/loading your stats/i)).toBeNull();
  });

  // RC-09 (owner-proxy ruling, Judge B "strongest-evidenced item"): journey6
  // caught a literal instant hard-swap between the empty-state and the
  // freshly-mounted stats panel on login - both sides of that swap now
  // carry the shared `surface-entrance` fade+rise, and the swap must stay a
  // genuine single-mount replace (never both on screen at once).
  it("cross-fades the empty-state/stats-panel swap on login: exactly one surface-entrance element at a time", () => {
    const { rerender } = render(
      <You
        identitySession={null}
        onClaimIdentity={vi.fn()}
        onGoHome={vi.fn()}
        onLogOut={vi.fn()}
        onPlayAsSomeoneElse={vi.fn()}
        onRetryStats={vi.fn()}
        onSwitchAccount={vi.fn()}
        stats={null}
        statsStatus="ready"
      />,
    );
    const emptyState = document.querySelector(".you-empty-state");
    expect(emptyState).toHaveClass("surface-entrance");
    expect(document.querySelectorAll(".surface-entrance")).toHaveLength(1);
    expect(document.querySelector(".stats-panel")).toBeNull();

    rerender(
      <You
        identitySession={claimedSession}
        onClaimIdentity={vi.fn()}
        onGoHome={vi.fn()}
        onLogOut={vi.fn()}
        onPlayAsSomeoneElse={vi.fn()}
        onRetryStats={vi.fn()}
        onSwitchAccount={vi.fn()}
        stats={zeroStats}
        statsStatus="ready"
      />,
    );
    const statsPanel = document.querySelector(".stats-panel");
    expect(statsPanel).toHaveClass("surface-entrance");
    expect(document.querySelectorAll(".surface-entrance")).toHaveLength(1);
    expect(document.querySelector(".you-empty-state")).toBeNull();
  });
});

/**
 * Layout B (owner pick, 2026-08-15). The nine equal bordered tiles are
 * replaced by two FEATURED averages in the display face plus three groups
 * that mean something — how often you turn up, your personal bests, your
 * lifetime totals. The old grid had no hierarchy and spent three tiles
 * (Attempts / Completed / DNFs) restating one fact; "37 of 44" says it
 * once.
 */
describe("You: layout B — featured averages plus meaningful groups", () => {
  const playedStats: AccountStats = {
    ...zeroStats,
    totals: {
      attempts: 44,
      completed: 37,
      abandoned: 7,
      timedCompleted: 37,
      totalClicks: 464,
      bestClicks: 1,
      bestElapsedMs: 8_100,
      averageClicks: 9.6,
      averageElapsedMs: 281_000,
      totalDwellMs: 17_400_000,
    },
    dailyStreak: 32,
  };

  it("features exactly the two averages, in the display face", () => {
    renderYou({ stats: playedStats, statsStatus: "ready" });
    const featured = document.querySelector(".you-featured")!;

    expect(featured.querySelectorAll("div")).toHaveLength(2);
    expect(featured).toHaveTextContent("Average speed");
    expect(featured).toHaveTextContent("4:41");
    expect(featured).toHaveTextContent("Average clicks");
    expect(featured).toHaveTextContent("9.6");
  });

  it("renders an average speed over a minute as m:ss, never as raw seconds", () => {
    renderYou({ stats: playedStats, statsStatus: "ready" });

    // The bug this replaces: the same value shipped as "280.7s".
    expect(screen.getByText("4:41")).toBeVisible();
    expect(screen.queryByText(/^\d{3,}\.\d+s$/)).toBeNull();
  });

  it("folds attempts, completed and DNFs into one honest 'of N finished' line", () => {
    renderYou({ stats: playedStats, statsStatus: "ready" });

    expect(screen.getByText("of 44 finished")).toBeVisible();
    expect(screen.getByText("37")).toBeVisible();
    // The three separate tiles are gone.
    expect(screen.queryByText("Attempts")).toBeNull();
    expect(screen.queryByText("Completed")).toBeNull();
  });

  it("renders total racing time in hours, where m:ss would read as 290:00", () => {
    renderYou({ stats: playedStats, statsStatus: "ready" });

    expect(screen.getByText("4h 50m")).toBeVisible();
    expect(screen.getByText("racing")).toBeVisible();
  });

  it("groups the remaining stats under three headings that mean something", () => {
    renderYou({ stats: playedStats, statsStatus: "ready" });
    const heads = [...document.querySelectorAll(".you-group h3")].map((h) => h.textContent);

    expect(heads).toEqual(["Turning up", "Personal bests", "Totals"]);
  });

  it("keeps a best speed under a minute at tenth-of-a-second precision", () => {
    renderYou({ stats: playedStats, statsStatus: "ready" });

    expect(screen.getByText("8.1s")).toBeVisible();
  });
});

function pageRow(title: string, count: number, totalMs: number | null, avgMs: number | null): PageStat {
  return { title, count, totalMs, avgMs };
}

function pageList(): HTMLOListElement | null {
  return document.querySelector(".you-pages ol");
}

describe("You: single page list (drops Top starts/Top targets)", () => {
  it("renders one list with per-title counts, up to 10 rows, no Top starts/Top targets sections", () => {
    const stats: AccountStats = {
      ...zeroStats,
      mostVisited: [
        pageRow("Cat", 12, 60_000, 5_000),
        pageRow("Dog", 9, null, null),
        pageRow("Bird", 8, null, null),
        pageRow("Fish", 7, null, null),
        pageRow("Ant", 6, null, null),
        pageRow("Bee", 5, null, null),
        pageRow("Owl", 4, null, null),
        pageRow("Fox", 3, null, null),
        pageRow("Bat", 2, null, null),
        pageRow("Elk", 1, null, null),
      ],
    };
    renderYou({ stats, statsStatus: "ready" });

    expect(screen.queryByText("Top starts")).toBeNull();
    expect(screen.queryByText("Top targets")).toBeNull();
    expect(screen.queryByText("Visited pages")).toBeNull();

    expect(screen.getByText("Cat")).toBeVisible();
    expect(screen.getByText("Elk")).toBeVisible();

    expect(pageList()!.querySelectorAll("li")).toHaveLength(10);
  });

  it("caps the list at 10 even when the server sends more rows", () => {
    const stats: AccountStats = {
      ...zeroStats,
      mostVisited: Array.from({ length: 12 }, (_, i) => pageRow(`Page ${i}`, 12 - i, null, null)),
    };
    renderYou({ stats, statsStatus: "ready" });

    expect(pageList()!.querySelectorAll("li")).toHaveLength(10);
    expect(screen.queryByText("Page 10")).toBeNull();
    expect(screen.queryByText("Page 11")).toBeNull();
  });

  it("shows 'No data yet.' when mostVisited is empty", () => {
    renderYou({ stats: zeroStats, statsStatus: "ready" });

    expect(document.querySelector(".you-pages")).toHaveTextContent("No data yet.");
  });
});

/**
 * The "Most time spent" toggle (owner request, 2026-08-15). The one thing
 * these tests exist to pin down is that the two views are two SERVER
 * rankings, not one list re-sorted in the browser - the real data's two
 * top-10s are near-disjoint, so a client-side re-sort would hide exactly
 * the pages the toggle was added to surface.
 */
describe("You: Most visited / Most time spent toggle", () => {
  const togglingStats: AccountStats = {
    ...zeroStats,
    mostVisited: [
      pageRow("Earth", 7, 106_000, 15_143),
      pageRow("Moon", 4, 20_000, 5_000),
      // Only ever reached as a target: visited, never measured.
      pageRow("Gravity", 3, null, null),
    ],
    mostTimeSpent: [
      // Deliberately absent from mostVisited above - only a second server
      // ranking can put it on screen.
      pageRow("Supreme Court of the United States", 2, 791_000, 395_500),
      pageRow("Earth", 7, 106_000, 15_143),
    ],
  };

  it("opens on the visits ranking, each row carrying its count and average time", () => {
    renderYou({ stats: togglingStats, statsStatus: "ready" });

    expect(screen.getByRole("tab", { name: "Most visited" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Earth")).toBeVisible();
    expect(screen.getByText("×7 · 0:15 avg")).toBeVisible();
  });

  it("renders an em dash, not 0:00, for a page the server has no dwell sample for", () => {
    renderYou({ stats: togglingStats, statsStatus: "ready" });

    expect(screen.getByText("×3 · —")).toBeVisible();
  });

  it("switches to the server's time ranking - not a re-sort of the visits list", async () => {
    const user = userEvent.setup();
    renderYou({ stats: togglingStats, statsStatus: "ready" });

    expect(screen.queryByText("Supreme Court of the United States")).toBeNull();

    await user.click(screen.getByRole("tab", { name: "Most time" }));

    expect(screen.getByText("Supreme Court of the United States")).toBeVisible();
    expect(screen.queryByText("Moon")).toBeNull();
  });

  it("leads a time row with the total and keeps the visit count alongside", async () => {
    const user = userEvent.setup();
    renderYou({ stats: togglingStats, statsStatus: "ready" });

    await user.click(screen.getByRole("tab", { name: "Most time" }));

    expect(screen.getByText("13:11 · ×2")).toBeVisible();
  });

  it("moves aria-selected to the active segment, like Boards' period control", async () => {
    const user = userEvent.setup();
    renderYou({ stats: togglingStats, statsStatus: "ready" });

    await user.click(screen.getByRole("tab", { name: "Most time" }));

    expect(screen.getByRole("tab", { name: "Most time" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Most visited" })).toHaveAttribute("aria-selected", "false");
  });

  // Matches Boards' period control (PKG-10, owner-proxy ruling: "keep
  // role=tab/tablist, complete the pattern") - roving tabindex plus
  // arrow-key automatic activation, wrapping at both ends.
  it("activates the other segment on ArrowRight, wrapping, with a roving tabindex", async () => {
    const user = userEvent.setup();
    renderYou({ stats: togglingStats, statsStatus: "ready" });
    const visitedTab = screen.getByRole("tab", { name: "Most visited" });
    const timeTab = screen.getByRole("tab", { name: "Most time" });

    expect(visitedTab).toHaveAttribute("tabindex", "0");
    expect(timeTab).toHaveAttribute("tabindex", "-1");

    visitedTab.focus();
    await user.keyboard("{ArrowRight}");

    expect(timeTab).toHaveAttribute("aria-selected", "true");
    expect(timeTab).toHaveFocus();
    expect(screen.getByText("Supreme Court of the United States")).toBeVisible();

    await user.keyboard("{ArrowRight}");

    expect(visitedTab).toHaveAttribute("aria-selected", "true");
  });

  /**
   * The list is a ranked horizontal bar chart, not a table: each row's bar
   * length encodes the metric the list is CURRENTLY sorted by, so bars
   * never increase as you read down. One measure, one hue - length carries
   * magnitude, colour is constant.
   */
  it("scales each row's bar against the top row of the active ranking", () => {
    renderYou({ stats: togglingStats, statsStatus: "ready" });
    const rows = [...document.querySelectorAll<HTMLLIElement>(".you-pages-list li")];

    // Visits view: bars encode count (7, 4, 3), peak 7.
    expect(rows.map((row) => row.style.getPropertyValue("--fill"))).toEqual([
      "100%",
      "57%",
      "43%",
    ]);
  });

  it("re-scales the bars against the time metric after toggling", async () => {
    const user = userEvent.setup();
    renderYou({ stats: togglingStats, statsStatus: "ready" });

    await user.click(screen.getByRole("tab", { name: "Most time" }));
    const rows = [...document.querySelectorAll<HTMLLIElement>(".you-pages-list li")];

    // Time view: bars encode totalMs (791_000, 106_000), peak 791_000.
    expect(rows.map((row) => row.style.getPropertyValue("--fill"))).toEqual(["100%", "13%"]);
  });

  it("never gives a visited page a zero-length bar just because it has no time", () => {
    // "Gravity" has null time but 3 real visits - in the VISITS ranking the
    // bar encodes count, so a missing dwell sample must not flatten it.
    renderYou({ stats: togglingStats, statsStatus: "ready" });
    const gravityRow = screen.getByText("Gravity").closest("li")!;

    expect(gravityRow.style.getPropertyValue("--fill")).toBe("43%");
  });

  it("numbers the rows and spells the figures out for hover/screen readers", () => {
    renderYou({ stats: togglingStats, statsStatus: "ready" });
    const rows = [...document.querySelectorAll<HTMLLIElement>(".you-pages-list li")];

    expect([...rows[0].querySelectorAll("span")].map((s) => s.textContent)).toContain("1");
    expect(rows[0].title).toBe("Earth — 7 visits, 1:46 total");
  });

  it("shows 'No data yet.' on the time side even when visits exist", async () => {
    const user = userEvent.setup();
    renderYou({
      stats: { ...zeroStats, mostVisited: [pageRow("Earth", 7, null, null)], mostTimeSpent: [] },
      statsStatus: "ready",
    });

    await user.click(screen.getByRole("tab", { name: "Most time" }));

    expect(document.querySelector(".you-pages")).toHaveTextContent("No data yet.");
  });
});
