import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PlayerName, PlayerProfiles } from "./PlayerProfiles";
import BoardSnippet from "./BoardSnippet";
import LeaderboardList from "./LeaderboardList";
import { boardSnippetRowsFromBoard } from "../domain/boardSnippet";
import type { BoardsTrendsResponse } from "../server/contracts";

const publicStats: BoardsTrendsResponse = {
  window: "lifetime", guard: 3, ranked: [], unranked: [],
  roster: [
    { accountId: "a", displayName: "Alex", racesStarted: 12, finishes: 8, wins: 2 },
    { accountId: "b", displayName: "Alex", racesStarted: 4, finishes: 1, wins: 0 },
  ],
};

function setup(getBoardsTrends = vi.fn(async () => publicStats)) {
  render(<PlayerProfiles apiClient={{ getBoardsTrends }}>
    <PlayerName accountId="a" displayName="Alex" />
    <PlayerName accountId="b" displayName="Alex" />
  </PlayerProfiles>);
  return { getBoardsTrends };
}

describe("Public player profiles", () => {
  it("opens the selected canonical account's public totals and returns focus on Escape", async () => {
    const user = userEvent.setup();
    const { getBoardsTrends } = setup();
    const trigger = screen.getAllByRole("button", { name: "View Alex's profile" })[1];
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Alex" });
    expect(await within(dialog).findByText("4")).toBeVisible();
    expect(within(dialog).getByText("Races started")).toBeVisible();
    expect(within(dialog).getByText("Finishes")).toBeVisible();
    expect(within(dialog).getByText("Wins")).toBeVisible();
    expect(within(dialog).queryByText("12")).not.toBeInTheDocument();
    expect(getBoardsTrends).toHaveBeenCalledWith("lifetime");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("reuses a recent public roster while comparing players", async () => {
    const user = userEvent.setup();
    const { getBoardsTrends } = setup();
    await user.click(screen.getAllByRole("button", { name: "View Alex's profile" })[0]);
    await screen.findByText("12");
    await user.click(screen.getByRole("button", { name: "Close player profile" }));
    await user.click(screen.getAllByRole("button", { name: "View Alex's profile" })[1]);
    expect(await screen.findByText("4")).toBeVisible();
    expect(getBoardsTrends).toHaveBeenCalledTimes(1);
  });

  it("offers Retry after an unavailable response instead of inventing zero totals", async () => {
    const user = userEvent.setup();
    const getBoardsTrends = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(publicStats);
    setup(getBoardsTrends);
    await user.click(screen.getAllByRole("button", { name: "View Alex's profile" })[0]);
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load this player's stats.");
    expect(screen.queryByText("Races started")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("12")).toBeVisible();
  });

  it("reports missing public stats honestly and allows closing", async () => {
    const user = userEvent.setup();
    setup(vi.fn(async () => ({ ...publicStats, roster: [] })));
    await user.click(screen.getAllByRole("button", { name: "View Alex's profile" })[0]);
    expect(await screen.findByText("No public stats are available for this player yet.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Close player profile" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("ignores a dismissed profile's late response when a different player opens", async () => {
    const user = userEvent.setup();
    let resolveFirst!: (value: BoardsTrendsResponse) => void;
    const getBoardsTrends = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(publicStats);
    setup(getBoardsTrends);
    await user.click(screen.getAllByRole("button", { name: "View Alex's profile" })[0]);
    await user.click(screen.getByRole("button", { name: "Close player profile" }));
    await user.click(screen.getAllByRole("button", { name: "View Alex's profile" })[1]);
    expect(await screen.findByText("4")).toBeVisible();
    resolveFirst({ ...publicStats, roster: [{ accountId: "a", displayName: "Stale", racesStarted: 99, finishes: 99, wins: 99 }] });
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Alex" })).toBeVisible());
    expect(screen.queryByText("Stale")).not.toBeInTheDocument();
  });

  it("makes Home/results snippet names navigable while preserving locked challenge metrics", async () => {
    const user = userEvent.setup();
    const board = { placements: [{ accountId: "a", displayName: "Alex", placement: 1, elapsedMs: 9000, clickCount: 5 }], dnfs: [] };
    render(<PlayerProfiles apiClient={{ getBoardsTrends: vi.fn(async () => publicStats) }}>
      <BoardSnippet title="Yesterday's results" rows={boardSnippetRowsFromBoard(board, null)} unlocked={false} />
    </PlayerProfiles>);
    await user.click(screen.getByRole("button", { name: "View Alex's profile" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("12")).toBeVisible();
    expect(within(dialog).queryByText(/clk|path|0:09/i)).not.toBeInTheDocument();
  });

  it("makes challenge-detail DNF names navigable before the viewer finishes", async () => {
    const user = userEvent.setup();
    render(<PlayerProfiles apiClient={{ getBoardsTrends: vi.fn(async () => publicStats) }}>
      <LeaderboardList dnfs={[{ accountId: "a", displayName: "Alex", elapsedMs: 9000, clickCount: 5 }]}
        placements={[]} identityAccountId={null} onDisclosePath={vi.fn()} pathsUnlocked={false} runPaths={{}} />
    </PlayerProfiles>);
    await user.click(screen.getByRole("button", { name: "View Alex's profile" }));
    expect(await screen.findByRole("dialog", { name: "Alex" })).toBeVisible();
    expect(screen.queryByText(/0:09/)).not.toBeInTheDocument();
  });
});
