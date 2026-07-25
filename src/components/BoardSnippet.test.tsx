import { act, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import BoardSnippet from "./BoardSnippet";
import type { BoardSnippetRow } from "../domain/boardSnippet";

function row(overrides: Partial<BoardSnippetRow> = {}): BoardSnippetRow {
  return {
    key: "row-1",
    rankLabel: "#1",
    rank: 1,
    displayName: "FranTheGreat",
    elapsedMs: 42_000,
    clickCount: 6,
    isYou: false,
    ...overrides,
  };
}

/**
 * QF-04 (council 2026-07-19, owner-proxy ruling): a genuine DNF rank never
 * shares the CTA-teal color a real placement gets - it's the same
 * `.rank`/`.rank-dnf` split now shared by all three DNF-rank renderers
 * (BoardSnippet, Boards' inline Stats DNF section, Challenge Detail's
 * LeaderboardList). The branch is on `rankLabel === "DNF"`, not the
 * nullable `rank` field - a completed-but-unranked run also carries
 * `rank: null` but reads "—", never "DNF" (a completion is never demoted
 * to DNF display).
 */
describe("BoardSnippet: DNF rank color (QF-04)", () => {
  it("marks a genuine DNF row with .rank-dnf, not a real placement", () => {
    render(
      <BoardSnippet
        title="Today's board"
        rows={[
          row({ key: "placement", rankLabel: "#1", rank: 1 }),
          row({ key: "dnf", rankLabel: "DNF", rank: null, displayName: "Loser" }),
        ]}
      />,
    );

    const placementRow = screen.getByText("FranTheGreat").closest("li")!;
    expect(within(placementRow).getByText("#1")).toHaveClass("rank");
    expect(within(placementRow).getByText("#1")).not.toHaveClass("rank-dnf");

    const dnfRow = screen.getByText("Loser").closest("li")!;
    expect(within(dnfRow).getByText("DNF")).toHaveClass("rank", "rank-dnf");
  });

  it("never demotes a completed-but-unranked '—' row to DNF-red - rank: null alone is not DNF", () => {
    render(
      <BoardSnippet
        title="Results board"
        rows={[row({ key: "unranked", rankLabel: "—", rank: null, displayName: "StillFinished" })]}
      />,
    );

    const unrankedRow = screen.getByText("StillFinished").closest("li")!;
    const rankSpan = within(unrankedRow).getByText("—");
    expect(rankSpan).toHaveClass("rank");
    expect(rankSpan).not.toHaveClass("rank-dnf");
  });
});

function rankedRows(count: number, youRank: number | null): BoardSnippetRow[] {
  return Array.from({ length: count }, (_, index) => {
    const rank = index + 1;
    return row({
      key: `row-${rank}`,
      rankLabel: `#${rank}`,
      rank,
      displayName: rank === youRank ? "Vijay" : `Player${rank}`,
      isYou: rank === youRank,
    });
  });
}

/**
 * RC-05 (owner ask: "Today's board lists ALL finishers up to ~6 rows"):
 * `maxRows` widens the shared cap without touching Results'/the yesterday
 * card's existing 3-row default - those callers omit the prop entirely.
 */
describe("BoardSnippet: maxRows (RC-05)", () => {
  it("defaults maxRows to 3, unchanged for Results/yesterday callers", () => {
    render(<BoardSnippet title="Yesterday's results" rows={rankedRows(8, null)} />);

    const list = screen.getByRole("list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(within(list).getByText("Player1")).toBeVisible();
    expect(within(list).getByText("Player3")).toBeVisible();
    expect(within(list).queryByText("Player4")).toBeNull();
  });

  it("BD-1 supersedes the old flat append: outside the 3-row cap now windows instead (top+neighborhood merge, since rank 5 is within radius 2 of the top-2 boundary)", () => {
    render(<BoardSnippet title="Yesterday's results" rows={rankedRows(8, 5)} />);

    const list = screen.getByRole("list");
    // 8 total rows > showAllAt(7): windows. Viewer at rank 5 merges with
    // the top-2 segment (ranks 1-7 render as one contiguous block, see
    // windowBoardRows' own "viewer #5" unit test) - only rank 8 collapses
    // into a trailing "… 1 more" expander.
    expect(within(list).getAllByRole("listitem")).toHaveLength(8);
    expect(within(list).getByText("Player1")).toBeVisible();
    expect(within(list).getByText("Vijay")).toBeVisible();
    expect(within(list).getByText("Player7")).toBeVisible();
    expect(within(list).queryByText("Player8")).toBeNull();
    expect(within(list).getByRole("button", { name: "… 1 more" })).toBeVisible();
  });

  it("renders all 6 rows with maxRows={6} and no append needed when you're inside the cap", () => {
    render(<BoardSnippet title="Today's board" rows={rankedRows(6, 6)} maxRows={6} />);

    const list = screen.getByRole("list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(6);
    expect(within(list).getByText("Vijay")).toBeVisible();
  });

  it("BD-1 supersedes the old flat append: with maxRows={6}, ranked outside it now windows (top 2 + your neighborhood) instead of a flat 6+append", () => {
    render(<BoardSnippet title="Today's board" rows={rankedRows(9, 9)} maxRows={6} />);

    const list = screen.getByRole("list");
    // 9 total rows > showAllAt(7) and rank 9 (last) sits outside the
    // maxRows=6 cap: windowing replaces the plain cap. Top 2 (ranks 1-2),
    // then a "… 4 more" expander collapsing ranks 3-6, then the viewer's
    // own neighborhood (ranks 7-9) - 6 list items total (5 real rows + 1
    // expander), matching windowBoardRows' own "viewer last" unit test.
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(6);
    expect(within(list).getByText("Player1")).toBeVisible();
    expect(within(list).getByText("Player2")).toBeVisible();
    expect(within(list).queryByText("Player3")).toBeNull();
    expect(within(list).queryByText("Player6")).toBeNull();
    expect(within(list).getByText("Player7")).toBeVisible();
    expect(within(list).getByText("Player8")).toBeVisible();
    expect(within(list).getByText("Vijay")).toBeVisible();
    expect(within(list).getByRole("button", { name: "… 4 more" })).toBeVisible();
  });

  it("renders children (the 'see full board' link) in both the populated and empty branches", () => {
    const { rerender } = render(
      <BoardSnippet title="Today's board" rows={rankedRows(6, 6)} maxRows={6}>
        <button type="button">see full board ›</button>
      </BoardSnippet>,
    );
    expect(screen.getByRole("button", { name: /see full board/i })).toBeVisible();

    rerender(
      <BoardSnippet title="Today's board" rows={[]} maxRows={6}>
        <button type="button">see full board ›</button>
      </BoardSnippet>,
    );
    expect(screen.getByRole("button", { name: /see full board/i })).toBeVisible();
  });
});

/**
 * BD-1 ("windowed board snippet: top 2 + your neighborhood + inline
 * expanders") at the component level - the pure windowing matrix itself
 * lives in `boardSnippet.test.ts` (`windowBoardRows`); these tests cover
 * what `boardSnippet.test.ts` can't: actual DOM rendering, the tap-to-
 * expand interaction, and the `.is-you` highlight surviving inside a
 * windowed (not just a plain-capped) segment.
 */
describe("BoardSnippet: BD-1 windowed snippet", () => {
  it("<=7 total rows: shows every row, no windowing/expander, even though the viewer sits outside the plain 3-row cap", () => {
    render(<BoardSnippet title="Yesterday's results" rows={rankedRows(7, 7)} />);

    const list = screen.getByRole("list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(7);
    expect(within(list).getByText("Player1")).toBeVisible();
    expect(within(list).getByText("Vijay")).toBeVisible();
    expect(within(list).queryByRole("button")).toBeNull();
  });

  it("keeps the viewer's row highlighted (.is-you) even when it only appears via the windowed neighborhood, not the plain cap", () => {
    render(<BoardSnippet title="Yesterday's results" rows={rankedRows(8, 5)} />);

    const yourRow = screen.getByText("Vijay").closest("li")!;
    expect(yourRow).toHaveClass("is-you");
    expect(within(yourRow).getByText("(you)")).toBeVisible();
  });

  it("expander reveals its gap's rows in place on tap - one tap, no collapse back", () => {
    render(<BoardSnippet title="Today's board" rows={rankedRows(9, 9)} maxRows={6} />);

    const list = screen.getByRole("list");
    expect(within(list).queryByText("Player3")).toBeNull();
    expect(within(list).queryByText("Player6")).toBeNull();

    const expander = within(list).getByRole("button", { name: "… 4 more" });
    expect(expander).toBeVisible();
    act(() => {
      expander.click();
    });

    // The gap's own rows (ranks 3-6) are now in the DOM, in rank order,
    // between the top-2 segment and the viewer's own neighborhood; the
    // expander button itself is gone (no collapse-back this pass).
    expect(within(list).getByText("Player3")).toBeVisible();
    expect(within(list).getByText("Player4")).toBeVisible();
    expect(within(list).getByText("Player5")).toBeVisible();
    expect(within(list).getByText("Player6")).toBeVisible();
    expect(within(list).queryByRole("button", { name: /more/ })).toBeNull();
    expect(within(list).getAllByRole("listitem")).toHaveLength(9);
  });

  it("only the freshly-revealed rows carry the RC-09 entrance class - rows already visible before the tap never replay it", () => {
    render(<BoardSnippet title="Today's board" rows={rankedRows(9, 9)} maxRows={6} />);

    act(() => {
      screen.getByRole("button", { name: "… 4 more" }).click();
    });

    expect(screen.getByText("Player1").closest("li")).not.toHaveClass("surface-entrance");
    expect(screen.getByText("Player3").closest("li")).toHaveClass("surface-entrance");
    expect(screen.getByText("Player6").closest("li")).toHaveClass("surface-entrance");
    expect(screen.getByText("Player7").closest("li")).not.toHaveClass("surface-entrance");
  });

  it("a viewer already inside maxRows (cap stands) never triggers windowing, even past showAllAt", () => {
    render(<BoardSnippet title="Today's board" rows={rankedRows(9, 2)} maxRows={6} />);

    const list = screen.getByRole("list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(6);
    expect(within(list).queryByRole("button")).toBeNull();
    expect(within(list).getByText("Vijay")).toBeVisible();
    expect(within(list).queryByText("Player7")).toBeNull();
  });
});

describe("BoardSnippet: RC-06 (one honest loading/error system) - status tri-state", () => {
  it("defaults status to 'ready' - a pre-existing caller (e.g. Results) that never passes it is unaffected", () => {
    render(<BoardSnippet title="Today's board" rows={rankedRows(2, null)} />);
    expect(screen.getByText("Player1")).toBeVisible();
  });

  it("'error': renders a distinct error + Retry - never the empty-state copy - and still renders children", () => {
    const onRetry = vi.fn();
    render(
      <BoardSnippet title="Today's board" rows={[]} onRetry={onRetry} status="error">
        <button type="button">see full board ›</button>
      </BoardSnippet>,
    );

    expect(screen.getByText(/couldn.t load this board/i)).toBeVisible();
    expect(screen.queryByText("No completed runs yet.")).toBeNull();
    expect(screen.getByRole("button", { name: /see full board/i })).toBeVisible();

    screen.getByRole("button", { name: /retry/i }).click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("'loading': stages honestly - nothing before 300ms, then 'Loading board…', never the empty-state copy meanwhile", () => {
    vi.useFakeTimers();
    try {
      render(<BoardSnippet title="Today's board" rows={[]} status="loading" />);

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
});
