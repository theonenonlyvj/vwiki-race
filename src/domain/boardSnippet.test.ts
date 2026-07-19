import { describe, expect, it } from "vitest";
import { boardSnippetRowsForResult, boardSnippetRowsFromBoard } from "./boardSnippet";

const placement = (accountId: string, place: number, displayName: string | null = accountId) => ({
  accountId,
  displayName,
  placement: place,
  elapsedMs: place * 10_000,
  clickCount: place + 2,
});

const dnf = (accountId: string, displayName: string | null = accountId) => ({
  accountId,
  displayName,
  elapsedMs: 8_000,
  clickCount: 1,
});

describe("boardSnippetRowsFromBoard", () => {
  it("renders placements first (by server placement), then DNFs, one row per account", () => {
    const rows = boardSnippetRowsFromBoard(
      { placements: [placement("acc-a", 1), placement("acc-b", 2)], dnfs: [dnf("acc-c")] },
      null,
    );

    expect(rows.map((row) => [row.rankLabel, row.displayName])).toEqual([
      ["#1", "acc-a"],
      ["#2", "acc-b"],
      ["DNF", "acc-c"],
    ]);
    expect(rows.map((row) => row.rank)).toEqual([1, 2, null]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(3);
  });

  it("marks your rows via accountId (placement AND dnf), never anyone else's", () => {
    const rows = boardSnippetRowsFromBoard(
      { placements: [placement("acc-you", 1), placement("acc-other", 2)], dnfs: [dnf("acc-you-dnf")] },
      "acc-you",
    );
    expect(rows.map((row) => row.isYou)).toEqual([true, false, false]);
  });

  it("treats an anonymous viewer (null accountId) as matching nothing", () => {
    const rows = boardSnippetRowsFromBoard(
      { placements: [placement("acc-a", 1)], dnfs: [] },
      null,
    );
    expect(rows[0]?.isYou).toBe(false);
  });

  it("falls back to Unknown for a null displayName (board rows may lack one)", () => {
    const rows = boardSnippetRowsFromBoard(
      { placements: [placement("acc-a", 1, null)], dnfs: [dnf("acc-b", null)] },
      null,
    );
    expect(rows.map((row) => row.displayName)).toEqual(["Unknown", "Unknown"]);
  });
});

describe("boardSnippetRowsForResult", () => {
  it("drops the board's own row for the viewer's account and pins the just-finished run's own rank/time instead", () => {
    const rows = boardSnippetRowsForResult(
      { placements: [placement("acc-you", 1), placement("acc-other", 2)], dnfs: [] },
      "acc-you",
      { rank: 1, displayName: "Vijay", elapsedMs: 1_000, clickCount: 1 },
    );
    // Only one "acc-you" row - the board's own placement for that account
    // never survives alongside the pinned just-finished row (that would be
    // exactly the duplicate-rank bug this package fixes).
    expect(rows.filter((row) => row.isYou)).toHaveLength(1);
    expect(rows.map((row) => [row.rankLabel, row.displayName, row.isYou])).toEqual([
      ["#1", "Vijay", true],
      ["#2", "acc-other", false],
    ]);
  });

  it("merge-inserts the just-finished run at its true sorted position, not always last", () => {
    const rows = boardSnippetRowsForResult(
      { placements: [placement("acc-a", 1), placement("acc-b", 3)], dnfs: [] },
      "acc-you",
      { rank: 2, displayName: "Vijay", elapsedMs: 2_000, clickCount: 2 },
    );
    expect(rows.map((row) => row.rankLabel)).toEqual(["#1", "#2", "#3"]);
    expect(rows[1]).toMatchObject({ isYou: true, displayName: "Vijay" });
  });

  it("still shows the account's own (better) placement row when the just-finished run was a worse repeat, at the run's own rank", () => {
    // A repeat attempt that placed worse than the account's earlier best:
    // the deduped board only ever carries the best attempt, but Results
    // must show THIS run's own true rank/time, one source of truth with
    // the header above it (see the doc comment on `boardSnippetRowsForResult`).
    const rows = boardSnippetRowsForResult(
      { placements: [placement("acc-you", 1), placement("acc-other", 2)], dnfs: [] },
      "acc-you",
      { rank: 3, displayName: "Vijay", elapsedMs: 30_000, clickCount: 6 },
    );
    expect(rows.map((row) => [row.rankLabel, row.displayName])).toEqual([
      ["#2", "acc-other"],
      ["#3", "Vijay"],
    ]);
  });

  it("renders a DNF just-finished run as DNF, appended after every placement", () => {
    const rows = boardSnippetRowsForResult(
      { placements: [placement("acc-a", 1)], dnfs: [dnf("acc-b")] },
      "acc-you",
      { rank: null, displayName: "Vijay", elapsedMs: 8_000, clickCount: 1 },
    );
    expect(rows.map((row) => row.rankLabel)).toEqual(["#1", "DNF", "DNF"]);
    expect(rows[2]).toMatchObject({ isYou: true, displayName: "Vijay" });
  });

  it("returns only the deduped board's rows when there is no just-finished run to pin (e.g. no identified account)", () => {
    const rows = boardSnippetRowsForResult(
      { placements: [placement("acc-a", 1)], dnfs: [] },
      null,
      null,
    );
    expect(rows.map((row) => row.rankLabel)).toEqual(["#1"]);
  });
});
