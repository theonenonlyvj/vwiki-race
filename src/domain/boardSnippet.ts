import type {
  ChallengeBoardDnfRow,
  ChallengeBoardPlacement,
} from "./types";

/**
 * The one display shape `BoardSnippet` renders (desktop pass, FIX 3): both of
 * its data sources - the deduped board endpoint (Home's yesterday/today
 * cards, Results' own snippet, Challenge Detail's leaderboard) - normalize
 * to this before rendering, so the "top-3 with your row appended" logic
 * lives in exactly one place and can't fork per caller.
 *
 * PKG-03 (council 2026-07-19): Results used to read a SEPARATE, per-attempt
 * shape (`boardSnippetRowsFromLeaderboard`, since removed) that highlighted
 * whichever `runId` had just finished. That let the same display name occupy
 * two ranks at once on the same screen (a repeat attempt showing up as both
 * "#1 you" and "#2 you") - the exact duplicate-rank bug this package fixes.
 * Every board surface now reads the server's already-deduped
 * `GET /challenges/{id}/board` (`listChallengePlacements`/
 * `listChallengeDnfs` - "already invariant-2-correct", per their own doc
 * comments) instead of re-deriving a client-side dedup, per the owner-proxy
 * ruling.
 */
export interface BoardSnippetRow {
  key: string;
  /** "#1", "#2", ... for placements; "DNF" for abandoned/DNF rows. */
  rankLabel: string;
  /** Numeric placement, or `null` for a DNF - lets callers merge-insert a
   *  row (Results' own just-finished run, see `boardSnippetRowsForResult`)
   *  at the right sorted position without re-deriving anyone's rank. */
  rank: number | null;
  displayName: string;
  elapsedMs: number;
  clickCount: number;
  /** Drives the highlight + "(you)" suffix + append-below-top-3 behavior. */
  isYou: boolean;
}

/**
 * Rows for a challenge's deduped board (Home's cards, Boards, Challenge
 * Detail's leaderboard) - already one row per canonical account (invariant 2
 * lives server-side), placements first, then DNFs. "You" is an accountId
 * match: board rows carry no runId, and an account-level match is exactly
 * right for a deduped board (the row IS the account's best attempt).
 */
export function boardSnippetRowsFromBoard(
  board: { placements: ChallengeBoardPlacement[]; dnfs: ChallengeBoardDnfRow[] },
  identityAccountId: string | null,
): BoardSnippetRow[] {
  const placements = board.placements.map((row): BoardSnippetRow => ({
    key: `placement-${row.accountId}`,
    rankLabel: `#${row.placement}`,
    rank: row.placement,
    displayName: row.displayName ?? "Unknown",
    elapsedMs: row.elapsedMs,
    clickCount: row.clickCount,
    isYou: identityAccountId !== null && row.accountId === identityAccountId,
  }));
  const dnfs = board.dnfs.map((row): BoardSnippetRow => ({
    key: `dnf-${row.accountId}`,
    rankLabel: "DNF",
    rank: null,
    displayName: row.displayName ?? "Unknown",
    elapsedMs: row.elapsedMs,
    clickCount: row.clickCount,
    isYou: identityAccountId !== null && row.accountId === identityAccountId,
  }));
  return [...placements, ...dnfs];
}

/**
 * The literal run that just ended (Race flow beat 3), described in
 * `BoardSnippetRow` terms - `rank: null` reads as "DNF" (matching
 * `boardSnippetRowsFromBoard`'s own DNF rows), not "unranked", since Results
 * only ever calls this for a run that just genuinely finished or abandoned.
 */
export interface JustFinishedRow {
  rank: number | null;
  displayName: string;
  elapsedMs: number;
  clickCount: number;
}

/**
 * Results' own board snippet (PKG-03): the deduped board's OTHER rows, plus
 * the account's own row pinned to the run that literally just ended - not
 * the board's (possibly different) canonical placement for that account.
 * Matters when the just-finished run isn't a personal best: a repeat
 * attempt that placed worse than an earlier run would otherwise be absent
 * from a plain account-id lookup against the deduped board (which only ever
 * carries the account's BEST attempt) - Results still needs to show this
 * exact run's own time/rank, one source of truth with the header above it
 * (both read `outcome`/`leaderboardContext`, see RaceResults.tsx). Known
 * open question (owner-proxy ruling, 2026-07-19 council, judge B finding 5):
 * a non-personal-best repeat shows its own true rank/time here, which can
 * therefore read as WORSE than another row also labeled with the account's
 * name if a personal-best row existed on this same board - flagged back to
 * design rather than inventing a "not your best" annotation ad hoc.
 */
export function boardSnippetRowsForResult(
  board: { placements: ChallengeBoardPlacement[]; dnfs: ChallengeBoardDnfRow[] },
  identityAccountId: string | null,
  justFinished: JustFinishedRow | null,
): BoardSnippetRow[] {
  const others = boardSnippetRowsFromBoard(board, identityAccountId)
    .filter((row) => !row.isYou);
  if (identityAccountId === null || !justFinished) return others;

  const yourRow: BoardSnippetRow = {
    key: `you-${identityAccountId}`,
    rankLabel: justFinished.rank !== null ? `#${justFinished.rank}` : "DNF",
    rank: justFinished.rank,
    displayName: justFinished.displayName,
    elapsedMs: justFinished.elapsedMs,
    clickCount: justFinished.clickCount,
    isYou: true,
  };
  const sortValue = (row: BoardSnippetRow) => row.rank ?? Number.POSITIVE_INFINITY;
  const insertAt = others.findIndex((row) => sortValue(row) > sortValue(yourRow));
  const merged = [...others];
  merged.splice(insertAt === -1 ? merged.length : insertAt, 0, yourRow);
  return merged;
}
