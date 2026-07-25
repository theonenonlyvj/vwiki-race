import { describe, expect, it } from "vitest";
import {
  boardSnippetRowsForResult,
  boardSnippetRowsFromBoard,
  windowBoardRows,
  type BoardSnippetRow,
} from "./boardSnippet";

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
      { status: "completed", rank: 1, displayName: "Vijay", elapsedMs: 1_000, clickCount: 1 },
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

  it("merge-inserts the just-finished run at its true sorted position (deduped rank derived from elapsed/clicks, not the raw per-attempt rank), not always last", () => {
    const rows = boardSnippetRowsForResult(
      { placements: [placement("acc-a", 1), placement("acc-b", 3)], dnfs: [] },
      "acc-you",
      // rank: 5 is a deliberately bogus raw per-attempt value (the server's
      // challenge_rank universe) - the function must ignore it and derive
      // #2 from elapsedMs/clickCount against the deduped board instead.
      { status: "completed", rank: 5, displayName: "Vijay", elapsedMs: 20_000, clickCount: 4 },
    );
    expect(rows.map((row) => row.rankLabel)).toEqual(["#1", "#2", "#3"]);
    expect(rows[1]).toMatchObject({ isYou: true, displayName: "Vijay", rank: 2 });
  });

  it("derives the pinned rank from the deduped board, not the server's raw per-attempt challenge_rank (PKG-03 remainder fix)", () => {
    // The rank-universe mixing bug: a rival with two completed attempts
    // occupies raw challenge_rank #1 and #2 (a row_number over every
    // eligible RUN); the viewer's own first-ever run is raw challenge_rank
    // #3 in that same all-runs universe, but the DEDUPED board - one row per
    // account - only ever has ONE rival row, so the viewer's true placement
    // is #2. Results must agree with Boards/Home/Detail: #2, not the raw #3.
    const rows = boardSnippetRowsForResult(
      { placements: [placement("acc-rival", 1)], dnfs: [] },
      "acc-you",
      { status: "completed", rank: 3, displayName: "Vijay", elapsedMs: 15_000, clickCount: 4 },
    );
    const yourRow = rows.find((row) => row.isYou);
    expect(yourRow).toMatchObject({ rankLabel: "#2", rank: 2 });
  });

  it("still shows the account's own true rank/time when the just-finished run was a worse repeat - but the account's better board row is NOT shown alongside it", () => {
    // A repeat attempt that placed worse than the account's earlier best:
    // the deduped board only ever carries the best attempt, but Results
    // must show THIS run's own true rank/time, one source of truth with
    // the header above it (see the doc comment on `boardSnippetRowsForResult`).
    // The account's own (better) placement row from the board is dropped
    // entirely (filtered via `!row.isYou`) - it never appears alongside the
    // pinned just-finished row (that would be the duplicate-rank bug this
    // package fixes). The deduped rank (#3) counts BOTH the account's real
    // better placement (elapsedMs 10_000) and acc-other's (20_000) as
    // strictly better than this 30_000ms repeat.
    const rows = boardSnippetRowsForResult(
      { placements: [placement("acc-you", 1), placement("acc-other", 2)], dnfs: [] },
      "acc-you",
      { status: "completed", rank: 3, displayName: "Vijay", elapsedMs: 30_000, clickCount: 6 },
    );
    expect(rows.filter((row) => row.isYou)).toHaveLength(1);
    expect(rows.map((row) => [row.rankLabel, row.displayName])).toEqual([
      ["#2", "acc-other"],
      ["#3", "Vijay"],
    ]);
  });

  it("renders a DNF just-finished run as DNF, appended after every placement", () => {
    const rows = boardSnippetRowsForResult(
      { placements: [placement("acc-a", 1)], dnfs: [dnf("acc-b")] },
      "acc-you",
      { status: "dnf", rank: null, displayName: "Vijay", elapsedMs: 8_000, clickCount: 1 },
    );
    expect(rows.map((row) => row.rankLabel)).toEqual(["#1", "DNF", "DNF"]);
    expect(rows[2]).toMatchObject({ isYou: true, displayName: "Vijay" });
  });

  it("never labels a completed-but-unranked just-finished run as DNF (Wave 1 fix)", () => {
    // A completed run can land with rank: null when it's excluded from the
    // board's ranked CTE (containment flag, ranked_eligible=0, or a stale
    // leaderboardContext) - the run still reached the target, so it must
    // never render as "DNF" (spec invariant 2: completion is never demoted).
    const rows = boardSnippetRowsForResult(
      { placements: [placement("acc-a", 1)], dnfs: [dnf("acc-b")] },
      "acc-you",
      { status: "completed", rank: null, displayName: "Vijay", elapsedMs: 38_000, clickCount: 5 },
    );
    const yourRow = rows.find((row) => row.isYou);
    expect(yourRow?.rankLabel).not.toBe("DNF");
    expect(yourRow).toMatchObject({ rankLabel: "—", rank: null, displayName: "Vijay" });
    // Sorts after every ranked placement.
    expect(rows.map((row) => row.rankLabel).indexOf("—")).toBeGreaterThan(
      rows.map((row) => row.rankLabel).indexOf("#1"),
    );
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

/**
 * BD-1 ("windowed board snippet: top 2 + your neighborhood + inline
 * expanders"): the pure windowing function BoardSnippet.tsx composes with
 * its own pre-existing `maxRows` cap (see that file's own precedence
 * comment). `WINDOW_OPTIONS` mirrors the brief's own literal call shape.
 */
const WINDOW_OPTIONS = { topCount: 2, radius: 2, showAllAt: 7 };

function windowRows(count: number, youRank: number | null): BoardSnippetRow[] {
  return Array.from({ length: count }, (_, index) => {
    const rank = index + 1;
    return {
      key: `row-${rank}`,
      rankLabel: `#${rank}`,
      rank,
      displayName: rank === youRank ? "Vijay" : `Player${rank}`,
      elapsedMs: rank * 10_000,
      clickCount: rank,
      isYou: rank === youRank,
    };
  });
}

function ranks(segments: ReturnType<typeof windowBoardRows>): (number | null)[][] {
  return (segments ?? []).map((segment) => segment.rows.map((row) => row.rank));
}

describe("windowBoardRows (BD-1)", () => {
  it("rule 1: shows every row as one segment when total <= showAllAt, viewer or no viewer", () => {
    expect(windowBoardRows(windowRows(7, 7), "acc-you", WINDOW_OPTIONS)).toEqual([
      { type: "rows", rows: windowRows(7, 7) },
    ]);
    // Unconditional - a viewer-less board this short still shows in full,
    // never null (that's reserved for the ">showAllAt AND no viewer" case).
    expect(windowBoardRows(windowRows(7, null), null, WINDOW_OPTIONS)).toEqual([
      { type: "rows", rows: windowRows(7, null) },
    ]);
  });

  it("boundary: exactly 8 rows windows (a trailing gap appears) where 7 didn't", () => {
    const sevenSegments = windowBoardRows(windowRows(7, 1), "acc-you", WINDOW_OPTIONS);
    expect(sevenSegments).toHaveLength(1);
    expect(sevenSegments?.[0]).toMatchObject({ type: "rows" });

    const eightSegments = windowBoardRows(windowRows(8, 1), "acc-you", WINDOW_OPTIONS);
    expect(eightSegments?.map((segment) => segment.type)).toEqual(["rows", "gap"]);
    expect(ranks(eightSegments)).toEqual([[1, 2, 3], [4, 5, 6, 7, 8]]);
    expect(eightSegments?.[1]).toMatchObject({ type: "gap", count: 5 });
  });

  it("viewer #1: merges top+neighborhood into ranks 1-3, trailing gap for the rest", () => {
    const segments = windowBoardRows(windowRows(10, 1), "acc-you", WINDOW_OPTIONS);
    expect(segments?.map((segment) => segment.type)).toEqual(["rows", "gap"]);
    expect(ranks(segments)).toEqual([[1, 2, 3], [4, 5, 6, 7, 8, 9, 10]]);
    expect(segments?.[1]).toMatchObject({ type: "gap", count: 7 });
  });

  it("viewer #3: merges top+neighborhood into ranks 1-5, trailing gap for the rest", () => {
    const segments = windowBoardRows(windowRows(10, 3), "acc-you", WINDOW_OPTIONS);
    expect(segments?.map((segment) => segment.type)).toEqual(["rows", "gap"]);
    expect(ranks(segments)).toEqual([[1, 2, 3, 4, 5], [6, 7, 8, 9, 10]]);
  });

  it("viewer #4 (owner sketch's explicit merge example): contiguous 1..viewer+2, no first expander", () => {
    const segments = windowBoardRows(windowRows(10, 4), "acc-you", WINDOW_OPTIONS);
    expect(segments?.map((segment) => segment.type)).toEqual(["rows", "gap"]);
    expect(ranks(segments)).toEqual([[1, 2, 3, 4, 5, 6], [7, 8, 9, 10]]);
  });

  it("viewer #5: top and neighborhood exactly touch (zero-row gap) - still merges, never a '... 0 more' expander", () => {
    const segments = windowBoardRows(windowRows(10, 5), "acc-you", WINDOW_OPTIONS);
    expect(segments?.map((segment) => segment.type)).toEqual(["rows", "gap"]);
    expect(ranks(segments)).toEqual([[1, 2, 3, 4, 5, 6, 7], [8, 9, 10]]);
  });

  it("viewer #6: one rank past the merge boundary - a real (1-row) leading gap appears", () => {
    const segments = windowBoardRows(windowRows(10, 6), "acc-you", WINDOW_OPTIONS);
    expect(segments?.map((segment) => segment.type)).toEqual(["rows", "gap", "rows", "gap"]);
    expect(ranks(segments)).toEqual([[1, 2], [3], [4, 5, 6, 7, 8], [9, 10]]);
    expect(segments?.[1]).toMatchObject({ type: "gap", count: 1 });
    expect(segments?.[3]).toMatchObject({ type: "gap", count: 2 });
  });

  it("viewer last: leading gap only, no trailing gap (window already ends the array)", () => {
    const segments = windowBoardRows(windowRows(8, 8), "acc-you", WINDOW_OPTIONS);
    expect(segments?.map((segment) => segment.type)).toEqual(["rows", "gap", "rows"]);
    expect(ranks(segments)).toEqual([[1, 2], [3, 4, 5], [6, 7, 8]]);
  });

  it("viewer second-to-last: the clamp swallows the would-be 1-row trailing gap into the window itself", () => {
    const segments = windowBoardRows(windowRows(8, 7), "acc-you", WINDOW_OPTIONS);
    expect(segments?.map((segment) => segment.type)).toEqual(["rows", "gap", "rows"]);
    // Un-clamped, radius 2 would give a 5-row window (ranks 5-9, out of
    // range) - clamped to the real array, the window absorbs rank 8 too,
    // so there is no leftover trailing gap at all.
    expect(ranks(segments)).toEqual([[1, 2], [3, 4], [5, 6, 7, 8]]);
  });

  it("viewer absent: null (anonymous viewerAccountId) - caller falls back to its own plain cap", () => {
    expect(windowBoardRows(windowRows(10, null), null, WINDOW_OPTIONS)).toBeNull();
  });

  it("viewer absent: null even with a non-null viewerAccountId if no row is actually marked isYou", () => {
    expect(windowBoardRows(windowRows(10, null), "acc-you", WINDOW_OPTIONS)).toBeNull();
  });
});
