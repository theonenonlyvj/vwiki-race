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
 * Owner incident, 2026-07-26: today's HARD daily (List of mosques in Morocco
 * -> Southern Television broadcast interruption, 23 inbound links - see
 * dailyCandidateEvaluator.ts's inbound-link floor fix) drew two genuine DNFs
 * and zero finishers. "No completed runs yet." reads as if nobody even
 * tried, which is actively discouraging on a board that's full of real
 * attempts. Boards.tsx's own Today/Yesterday board (inline markup, gated on
 * `placements.length` directly) and Home's BoardSnippet cards (fed
 * pre-merge `placements`/`dnfs` counts before they're folded into one `rows`
 * array below) both need this exact same copy decision, so it lives here -
 * one function, not three independently-typed literals that could drift.
 */
export const NO_ATTEMPTS_LABEL = "No completed runs yet.";
export const ZERO_FINISHER_LABEL = "No one has cracked this one yet.";

/**
 * `countedDnfs` is expected to already be server-filtered to
 * `MIN_COUNTED_DNF_CLICKS` (`board.dnfs`/`ChallengeBoardDnfRow[]` already are
 * - see `listChallengeDnfs` in d1TrackingRepository.ts) - a stray 0-1-click
 * abandon (page load, immediate back button) never flips this to the
 * zero-finisher copy on its own.
 */
export function emptyPlacementsLabel(completions: number, countedDnfs: number): string {
  return completions === 0 && countedDnfs > 0 ? ZERO_FINISHER_LABEL : NO_ATTEMPTS_LABEL;
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
 * `BoardSnippetRow` terms. `rank: null` is ambiguous on its own - it means
 * "DNF" for an abandoned run, but for a COMPLETED run it means "finished,
 * but excluded from this board's ranked CTE" (board_excluded, containment
 * flagging, or a stale/omitted leaderboardContext) - the run still reached
 * the target, so `status` disambiguates the two so a completed run is never
 * mislabeled "DNF" (Wave 1 fix, spec invariant 2: a completion is never
 * demoted to DNF display).
 */
export interface JustFinishedRow {
  status: "completed" | "dnf";
  rank: number | null;
  displayName: string;
  elapsedMs: number;
  clickCount: number;
}

/**
 * Results' own board snippet (PKG-03, rank-universe fix 2026-07-19 remainder
 * pass): the deduped board's OTHER rows, plus the account's own row pinned
 * to the run that literally just ended - not the board's (possibly
 * different) canonical placement for that account. Matters when the
 * just-finished run isn't a personal best: a repeat attempt that placed
 * worse than an earlier run would otherwise be absent from a plain
 * account-id lookup against the deduped board (which only ever carries the
 * account's BEST attempt) - Results still needs to show this exact run's own
 * time/rank, one source of truth with the header above it (both read
 * `outcome`/`leaderboardContext`, see RaceResults.tsx).
 *
 * The pinned row's rank is derived from the deduped board itself (count
 * every placement - across ALL accounts, including this one's own canonical
 * placement if it differs from the just-finished run - strictly better than
 * the just-finished run's own elapsed/clicks, +1), NOT from the server's raw
 * per-attempt `challenge_rank` (`leaderboardContext.rank`, a row_number over
 * every eligible RUN, not per-account). Those are two different rank
 * universes: the raw one counts a rival's repeat attempts as separate slots
 * ("rival's two runs occupy raw #1/#2, so your first-ever run is raw #3"),
 * while every surrounding row on this same screen (and every row on
 * Boards/Home/Detail) is per-account. Mixing them let the same numeric label
 * appear on two different rows and made Results disagree with Boards for
 * the exact same run. See `dedupedRankForJustFinished` below.
 *
 * Known remaining open question (owner-proxy ruling, 2026-07-19 council,
 * judge B finding 5), narrower now that the rank-universe bug is fixed: a
 * non-personal-best repeat's pinned row has no REAL counterpart on the
 * current board (the account's one real slot is held by its better run,
 * which itself counts against this run when computing its rank) - so what's
 * shown is "where this exact run's time would have placed," not an entry
 * that actually exists on the board. Whether that deserves a "not your
 * best - your best is #X" annotation is still a product call, flagged to
 * design rather than invented ad hoc.
 */
export function boardSnippetRowsForResult(
  board: { placements: ChallengeBoardPlacement[]; dnfs: ChallengeBoardDnfRow[] },
  identityAccountId: string | null,
  justFinished: JustFinishedRow | null,
): BoardSnippetRow[] {
  const others = boardSnippetRowsFromBoard(board, identityAccountId)
    .filter((row) => !row.isYou);
  if (identityAccountId === null || !justFinished) return others;

  const dedupedRank = dedupedRankForJustFinished(board.placements, justFinished);
  const yourRow: BoardSnippetRow = {
    key: `you-${identityAccountId}`,
    // "DNF" is reserved for genuinely abandoned runs. A completed run with
    // no rank (excluded from the board's ranked CTE - containment-flagged,
    // ranked_eligible=0, or an older response with no leaderboardContext at
    // all) still reached the target, so it reads "—", never "DNF".
    rankLabel: dedupedRank !== null
      ? `#${dedupedRank}`
      : justFinished.status === "completed" ? "—" : "DNF",
    rank: dedupedRank,
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

/**
 * The just-finished run's rank in the deduped board's own universe: count
 * every placement (any account, including this one's own canonical
 * placement if it isn't this exact run) strictly better on the ranking order
 * (elapsed ASC, then clicks ASC - same tie-break as `listChallengePlacements`
 * server-side, minus its final `completed_at`/`id` tie-break this function
 * has no way to see), then +1. `null` in, `null` out for a DNF or a
 * genuinely unranked completion (containment-flagged etc.) - never invents a
 * numeric rank for either.
 *
 * Exported so RaceResults.tsx can resolve this ONE number once and feed it
 * to every consumer that displays the just-finished run's rank (the header
 * kicker, the board snippet's pinned row, the share-text button) - otherwise
 * the header could keep showing the stale raw `challenge_rank` while only
 * the board row got the fix, trading a Results-vs-Boards mismatch for a
 * new Results-header-vs-Results-board-row one. Calling it twice (here and
 * again inside `boardSnippetRowsForResult`, which also takes a raw
 * `JustFinishedRow` directly in its own unit tests) is safe: it's a pure
 * function of `placements`/`justFinished`'s elapsed/clicks, never the
 * `rank` field's own numeric value, so re-deriving is idempotent.
 */
export function dedupedRankForJustFinished(
  placements: ChallengeBoardPlacement[],
  justFinished: JustFinishedRow,
): number | null {
  if (justFinished.status !== "completed" || justFinished.rank === null) {
    return justFinished.rank;
  }
  const better = placements.filter((row) =>
    row.elapsedMs < justFinished.elapsedMs ||
    (row.elapsedMs === justFinished.elapsedMs && row.clickCount < justFinished.clickCount)
  ).length;
  return better + 1;
}

/**
 * BD-1: a displayable chunk of a windowed board - either a contiguous run
 * of rows to render as-is, or a collapsed span the UI shows as a single
 * "… N more" expander until tapped. `rows` on a "gap" segment is the actual
 * content to reveal in place (BoardSnippet.tsx's own local expand-in-place
 * state, not this module) - `windowBoardRows` itself is a pure description
 * of the fully-collapsed window, no expansion state of its own.
 */
export type BoardWindowSegment =
  | { type: "rows"; rows: BoardSnippetRow[] }
  | { type: "gap"; count: number; rows: BoardSnippetRow[] };

export interface WindowBoardRowsOptions {
  /** How many top-ranked rows always show, regardless of the viewer's own
   *  position (the owner sketch's "top players"). */
  topCount: number;
  /** How many rows show on EACH side of the viewer's own row (the owner
   *  sketch's "the two on either side of YOUR finish... you... two
   *  below"). */
  radius: number;
  /** At or under this many total rows, windowing would save nothing - the
   *  whole point is condensing a board too long to show in full, so a
   *  board this short renders in full instead (rule 1 below). */
  showAllAt: number;
}

/**
 * BD-1 ("windowed board snippet: top 2 + your neighborhood + inline
 * expanders"): reduces a compact board snippet's rows to "top `topCount` +
 * your own neighborhood", collapsing everyone in between (or trailing after
 * it) into `gap` segments instead of either showing the whole board or
 * silently truncating it at a plain N-row cap. Three rules, checked in
 * order - exactly the brief's own ordering:
 *
 *  1. `rows.length <= showAllAt`: windowing has nothing to save - return
 *     every row as one `rows` segment (today's typical few-finisher board
 *     never windows at all, unaffected by this feature).
 *  2. The viewer is on the board (see the `viewerAccountId` note below) and
 *     `rows.length > showAllAt`: `[0, topCount)`, then
 *     `[viewerIndex - radius, viewerIndex + radius]` (clamped to the array),
 *     collapsing whatever's strictly between the two windows - or trailing
 *     after the second - into `gap` segments. The two windows MERGE into
 *     one contiguous `rows` segment (no leading gap at all) the instant
 *     they touch or overlap: a viewer close enough to the top that there's
 *     nothing to collapse there (e.g. rank 4 of topCount 2/radius 2 - top
 *     ends at rank 2, the neighborhood starts at rank 2 - contiguous, not
 *     just close) must never render a "… 0 more" expander for a gap that
 *     doesn't exist.
 *  3. The viewer isn't identifiable on the board at all: `null`. There's no
 *     position to window around, so the caller falls back to its own
 *     pre-existing plain top-N cap (BoardSnippet.tsx's `maxRows`) unchanged
 *     - this function has nothing useful to add.
 *
 * `viewerAccountId` only ever gates null-vs-not-null (rule 3's "or
 * anonymous"): `BoardSnippetRow` carries no accountId of its own - `isYou`
 * is already the accountId match, resolved once upstream in
 * `boardSnippetRowsFromBoard`/`boardSnippetRowsForResult` - so the viewer's
 * actual ROW is always located via `row.isYou`, never by comparing this id
 * against anything on a row. A non-null id whose rows happen to carry no
 * `isYou` match still correctly falls through to rule 3 (`viewerIndex`
 * stays `-1` either way).
 */
export function windowBoardRows(
  rows: BoardSnippetRow[],
  viewerAccountId: string | null,
  { topCount, radius, showAllAt }: WindowBoardRowsOptions,
): BoardWindowSegment[] | null {
  if (rows.length <= showAllAt) {
    return [{ type: "rows", rows }];
  }

  const viewerIndex = viewerAccountId === null ? -1 : rows.findIndex((row) => row.isYou);
  if (viewerIndex === -1) {
    return null;
  }

  const topEnd = Math.min(topCount, rows.length);
  const windowStart = Math.max(0, viewerIndex - radius);
  const windowEnd = Math.min(rows.length - 1, viewerIndex + radius);

  const segments: BoardWindowSegment[] = [];
  if (windowStart <= topEnd) {
    // Touching (zero rows between them) or overlapping - one contiguous
    // block, no leading expander (see rule 2's doc above).
    const mergedEnd = Math.max(topEnd, windowEnd + 1);
    segments.push({ type: "rows", rows: rows.slice(0, mergedEnd) });
  } else {
    segments.push({ type: "rows", rows: rows.slice(0, topEnd) });
    segments.push({
      type: "gap",
      count: windowStart - topEnd,
      rows: rows.slice(topEnd, windowStart),
    });
    segments.push({ type: "rows", rows: rows.slice(windowStart, windowEnd + 1) });
  }

  if (windowEnd < rows.length - 1) {
    segments.push({
      type: "gap",
      count: rows.length - 1 - windowEnd,
      rows: rows.slice(windowEnd + 1),
    });
  }

  return segments;
}
