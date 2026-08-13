import { act, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import LeaderboardList from "./LeaderboardList";
import type { ChallengeBoardDnfRow, ChallengeBoardPlacement } from "../domain/types";

function placement(overrides: Partial<ChallengeBoardPlacement> = {}): ChallengeBoardPlacement {
  return {
    accountId: "acc-1",
    displayName: "FranTheGreat",
    placement: 1,
    elapsedMs: 42_000,
    clickCount: 6,
    ...overrides,
  };
}

const noDnfs: ChallengeBoardDnfRow[] = [];

describe("LeaderboardList: RC-06 tri-state", () => {
  it("defaults to 'ready' when status is omitted, unchanged for any pre-existing caller", () => {
    render(
      <LeaderboardList
        dnfs={noDnfs}
        identityAccountId={null}
        onDisclosePath={vi.fn()}
        pathsUnlocked={false}
        placements={[placement()]}
        runPaths={{}}
      />,
    );
    expect(screen.getByText("FranTheGreat")).toBeVisible();
  });

  it("renders a distinct error + Retry - never 'No completed runs yet.' - and wires Retry through", async () => {
    const onRetry = vi.fn();
    render(
      <LeaderboardList
        dnfs={noDnfs}
        identityAccountId={null}
        onDisclosePath={vi.fn()}
        onRetry={onRetry}
        pathsUnlocked={false}
        placements={[]}
        runPaths={{}}
        status="error"
      />,
    );

    expect(screen.getByText(/couldn.t load the leaderboard/i)).toBeVisible();
    expect(screen.queryByText("No completed runs yet.")).toBeNull();
    screen.getByRole("button", { name: /retry/i }).click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("renders the genuine empty state only once 'ready' resolves with zero placements", () => {
    render(
      <LeaderboardList
        dnfs={noDnfs}
        identityAccountId={null}
        onDisclosePath={vi.fn()}
        pathsUnlocked={false}
        placements={[]}
        runPaths={{}}
        status="ready"
      />,
    );
    expect(screen.getByText("No completed runs yet.")).toBeVisible();
  });

  it("stages 'loading' honestly - nothing before 300ms, 'Loading board…' at 300ms, never 'No completed runs yet.' meanwhile", () => {
    vi.useFakeTimers();
    try {
      render(
        <LeaderboardList
          dnfs={noDnfs}
          identityAccountId={null}
          onDisclosePath={vi.fn()}
          pathsUnlocked={false}
          placements={[]}
          runPaths={{}}
          status="loading"
        />,
      );
      expect(screen.queryByText(/loading board/i)).toBeNull();
      expect(screen.queryByText("No completed runs yet.")).toBeNull();

      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(screen.getByText(/loading board/i)).toBeVisible();
      expect(screen.queryByText("No completed runs yet.")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("hides the DNF section entirely while loading (empty placeholder dnfs), matching the zero-DNF rule", () => {
    render(
      <LeaderboardList
        dnfs={[]}
        identityAccountId={null}
        onDisclosePath={vi.fn()}
        pathsUnlocked={false}
        placements={[]}
        runPaths={{}}
        status="loading"
      />,
    );
    expect(screen.queryByRole("region", { name: "DNF" })).toBeNull();
  });
});

/**
 * Pre-finish spoiler mask (owner ask, 2026-08-13): "before I finish the
 * race, just like I can't view the graph, I shouldn't be able to see how
 * long or # clicks on the leaderboard - just rankings and usernames."
 * Extends the SAME `pathsUnlocked` gate that already controls "View path"
 * disclosure to the time/clicks column, on both placement and DNF rows.
 */
describe("LeaderboardList: pre-finish spoiler mask (time/clicks)", () => {
  function dnf(overrides: Partial<ChallengeBoardDnfRow> = {}): ChallengeBoardDnfRow {
    return {
      accountId: "acc-2",
      displayName: "Ari",
      elapsedMs: 8_000,
      clickCount: 2,
      ...overrides,
    };
  }

  it("locked (pathsUnlocked=false): shows rank + name only - no time/clicks - for both a placement and a DNF row", () => {
    render(
      <LeaderboardList
        dnfs={[dnf()]}
        identityAccountId={null}
        onDisclosePath={vi.fn()}
        pathsUnlocked={false}
        placements={[placement()]}
        runPaths={{}}
      />,
    );

    expect(screen.getByText("FranTheGreat")).toBeVisible();
    expect(screen.getByText("Ari")).toBeVisible();
    expect(screen.queryByText("0:42 · 6 clk")).toBeNull();
    expect(screen.queryByText("0:08 · 2 clk")).toBeNull();

    // Both rows carry a masked placeholder in the time column - distinct
    // from the DNF row's own `.rank-dnf` dash.
    const placementRow = screen.getByText("FranTheGreat").closest("li")!;
    expect(within(placementRow).getByText("—")).toHaveClass("muted");
    const dnfRow = screen.getByText("Ari").closest("li")!;
    const dnfDashes = within(dnfRow).getAllByText("—");
    expect(dnfDashes).toHaveLength(2);
    expect(dnfDashes.some((el) => el.className === "muted")).toBe(true);
  });

  it("locked: never renders 'View path', even for a placement row carrying a runId", () => {
    render(
      <LeaderboardList
        dnfs={[]}
        identityAccountId={null}
        onDisclosePath={vi.fn()}
        pathsUnlocked={false}
        placements={[placement({ runId: "run-1" })]}
        runPaths={{}}
      />,
    );
    expect(screen.queryByText(/view path/i)).toBeNull();
  });

  it("unlocked (pathsUnlocked=true): shows time/clicks for both a placement and a DNF row", () => {
    render(
      <LeaderboardList
        dnfs={[dnf()]}
        identityAccountId={null}
        onDisclosePath={vi.fn()}
        pathsUnlocked
        placements={[placement()]}
        runPaths={{}}
      />,
    );

    expect(screen.getByText("0:42 · 6 clk")).toBeVisible();
    expect(screen.getByText("0:08 · 2 clk")).toBeVisible();
  });
});
