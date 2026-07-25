import { useState, type ReactNode } from "react";
import StagedLoadingNotice from "./StagedLoadingNotice";
import { windowBoardRows, type BoardSnippetRow } from "../domain/boardSnippet";
import { formatTimeAndClicks } from "../domain/formatting";

// BD-1 ("windowed board snippet: top 2 + your neighborhood + inline
// expanders"): the fixed windowing shape shared by every compact snippet
// (Results' own board, Home's yesterday/today cards) - NOT tied to
// `maxRows` below, which is this component's own separate, pre-existing
// plain top-N cap (3 default, 6 for Home's finished-state card, RC-05).
// Both are in play at once, so the precedence between them matters (see
// the comment where they're composed, in the component body below).
const WINDOW_OPTIONS = { topCount: 2, radius: 2, showAllAt: 7 } as const;

/** The shared rank/name/time `<li>` markup (unchanged from pre-BD-1:
 *  DNF-red rank color, `.is-you` tint, "(you)" suffix, invariant-1 time
 *  format) - factored out so both the plain top-N path and BD-1's windowed
 *  path render every row identically. `revealed` opts a row into RC-09's
 *  shared fade+rise entrance - only ever true for rows a tap on an expander
 *  just brought into the DOM (freshly MOUNTED, never rows that were already
 *  visible), so the plain top-N/window rows keep rendering with zero
 *  entrance treatment, exactly as before this feature. */
function BoardSnippetRowItem({ row, revealed }: { row: BoardSnippetRow; revealed: boolean }) {
  return (
    <li
      className={[row.isYou ? "is-you" : null, revealed ? "surface-entrance" : null]
        .filter(Boolean)
        .join(" ") || undefined}
    >
      {/* QF-04: DNF salmon, never CTA teal - `rankLabel` (not the
          nullable `rank`) is the correct DNF proxy, since a
          completed-but-unranked run also carries `rank: null` but
          reads "—", never "DNF" (invariant: a completion is never
          demoted to DNF display). */}
      <span className={row.rankLabel === "DNF" ? "rank rank-dnf" : "rank"}>
        {row.rankLabel}
      </span>
      <span>
        {row.displayName}
        {row.isYou ? <span className="muted"> (you)</span> : null}
      </span>
      <span>{formatTimeAndClicks(row.elapsedMs, row.clickCount)}</span>
    </li>
  );
}

/**
 * Shared "top-3, with your row highlighted (and appended if it's outside the
 * top 3)" board rendering (invariant 1) - used by Results' board snippet and
 * Home's yesterday's-results/today's-board cards (UX redesign spec), so the
 * two screens can never drift on this shape. Renders the neutral
 * `BoardSnippetRow` shape (src/domain/boardSnippet.ts): Home feeds it the
 * DEDUPED board endpoint's rows (one per canonical account - desktop-pass
 * FIX 3; the raw per-attempt leaderboard listed the same account twice),
 * while Results still feeds it per-attempt leaderboard rows highlighting the
 * exact run just finished.
 *
 * RC-06 ("one honest loading/error system"): `status` defaults to "ready" -
 * Results' own snippet (and any other pre-existing caller) never passes it
 * and keeps rendering exactly as before. Home is the one caller that
 * distinguishes "loading"/"error" from a genuine zero-row result.
 */
export default function BoardSnippet({
  title,
  rows,
  emptyLabel = "No completed runs yet.",
  children,
  maxRows = 3,
  onRetry,
  status = "ready",
}: {
  title: string;
  rows: BoardSnippetRow[];
  emptyLabel?: string;
  children?: ReactNode;
  // RC-05: Results' own snippet and the yesterday-recap card keep the
  // original top-3 cap (default unchanged); Home's finished-state
  // "Today's board" widens this to 6 so a signed-in player can see (almost)
  // everyone who raced today, not just the podium.
  maxRows?: number;
  // Only ever consulted from the "error"/"loading" branches below.
  onRetry?: () => void;
  status?: "loading" | "error" | "ready";
}) {
  // BD-1: this hook MUST live above every early return below, not inside a
  // delegate child component gated on `status`/`rows.length` - a prior
  // version of this fix called out to a separate `<BoardSnippetReadyBody>`
  // only from the "ready, rows.length > 0" branch, which meant this
  // component's own returned element type flipped (bare `<section>` for
  // the loading/error/empty branches vs. a `<BoardSnippetReadyBody>`
  // element once rows arrived) across the very re-render where a board
  // goes from 0 rows to N. React treats that as a type change at this
  // component's own root and discards+remounts the whole subtree - a BRAND
  // NEW `<section>` DOM node - rather than updating the existing one in
  // place. Any caller holding an earlier reference to the region (exactly
  // what `within(await screen.findByRole("region", ...))` does, and this
  // component's own tests already exercise via RC-06's loading-to-ready
  // transition) was then querying a stale, detached node forever. Keeping
  // one function component whose JSX root is always its own `<section>`
  // element (this file's pre-BD-1 shape) sidesteps the whole class of bug.
  const [expandedGapIndexes, setExpandedGapIndexes] = useState<ReadonlySet<number>>(new Set());

  if (status === "error") {
    return (
      <section aria-label={title} className="board-snippet board-error">
        <h3>{title}</h3>
        <p className="error-banner" role="alert">Couldn&apos;t load this board.</p>
        {onRetry ? (
          <button onClick={onRetry} type="button">
            Retry
          </button>
        ) : null}
        {children}
      </section>
    );
  }

  if (status === "loading") {
    return (
      <section aria-label={title} className="board-snippet">
        <h3>{title}</h3>
        <StagedLoadingNotice active onRetry={onRetry} pendingLabel="Loading board…" />
        {children}
      </section>
    );
  }

  if (rows.length === 0) {
    return (
      <section aria-label={title} className="board-snippet">
        <h3>{title}</h3>
        <p className="muted">{emptyLabel}</p>
        {children}
      </section>
    );
  }

  /*
   * BD-1: composes the windowing rules with this component's own
   * PRE-EXISTING `maxRows` cap. Both apply to the same `rows`, so
   * precedence between them matters:
   *
   *  - `rows.length <= WINDOW_OPTIONS.showAllAt` (7): windowing's own rule
   *    1 ("a board this short never needs condensing") wins outright,
   *    regardless of `maxRows`/viewer position - the whole board renders
   *    in one segment.
   *  - Otherwise, if the viewer has no row at all, OR their row already
   *    sits inside the plain `maxRows` cap: the plain cap STANDS (unchanged
   *    pre-BD-1 rendering - fewer moving parts for a screen that doesn't
   *    need windowing at all: no viewer to build a neighborhood around, or
   *    one already visible without it).
   *  - Otherwise (the viewer exists but their row would be hidden below the
   *    cap): windowing REPLACES the plain cap - this is the actual BD-1
   *    case, top 2 + the viewer's own neighborhood + inline expanders
   *    instead of a flat truncation.
   *
   * `expandedGapIndexes` (declared above, before the early returns) tracks
   * which `gap` segments the viewer has tapped open - never persisted, no
   * collapse this pass per the brief - keyed by position in the freshly-
   * recomputed `segments` array below, which is stable across re-renders
   * for the same `rows`/`maxRows` (a genuinely new board remounts this
   * component - see the two separate Home.tsx call sites - rather than
   * reusing this instance across challenges).
   */
  const topN = rows.slice(0, maxRows);
  const yourRow = rows.find((row) => row.isYou) ?? null;
  const yourRowInTopN = Boolean(yourRow) && topN.some((row) => row.key === yourRow?.key);

  const segments = rows.length <= WINDOW_OPTIONS.showAllAt
    ? [{ type: "rows" as const, rows }]
    : yourRow && !yourRowInTopN
      ? windowBoardRows(rows, yourRow.key, WINDOW_OPTIONS)
        // Defensive only: `yourRow` (found via `isYou`) guarantees
        // `windowBoardRows` finds the same row internally, so this can't
        // actually happen - keeps the plain pre-existing rendering as the
        // fallback shape rather than an unreachable throw.
        ?? [{ type: "rows" as const, rows: [...topN, yourRow] }]
      : [{ type: "rows" as const, rows: topN }];

  return (
    <section aria-label={title} className="board-snippet">
      <h3>{title}</h3>
      <ol>
        {segments.map((segment, segmentIndex) => {
          if (segment.type === "rows") {
            return segment.rows.map((row) => (
              <BoardSnippetRowItem key={row.key} revealed={false} row={row} />
            ));
          }
          // `segment.type === "gap"` from here down.
          if (!expandedGapIndexes.has(segmentIndex)) {
            return (
              <li key={`gap-${segmentIndex}`}>
                {/* Expand-in-place (BD-1): reveals this gap's own rows with
                    RC-09's shared entrance below, one tap, no collapse this
                    pass - "… N more" text per the brief's own sketch. */}
                <button
                  className="board-snippet-expander"
                  onClick={() =>
                    setExpandedGapIndexes((current) => new Set(current).add(segmentIndex))
                  }
                  type="button"
                >
                  … {segment.count} more
                </button>
              </li>
            );
          }
          return segment.rows.map((row) => (
            <BoardSnippetRowItem key={row.key} revealed row={row} />
          ));
        })}
      </ol>
      {children}
    </section>
  );
}
