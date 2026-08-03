import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import You from "./You";
import type { AccountStats } from "../domain/types";
import type { VGamesIdentitySession } from "../services/vgamesIdentity";

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
  },
  topStarts: [],
  topTargets: [],
  mostVisited: [],
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
    const attemptsRow = screen.getByText("Attempts").closest("div")!;
    expect(attemptsRow).toHaveTextContent("0");
    // bestElapsedMs/bestClicks are legitimately null before a first
    // completion - "No data yet." is correct there even in the ready state.
    const bestSpeedRow = screen.getByText("Best speed").closest("div")!;
    expect(bestSpeedRow).toHaveTextContent("No data yet.");
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
