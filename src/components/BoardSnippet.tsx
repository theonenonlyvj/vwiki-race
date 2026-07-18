import type { ReactNode } from "react";
import { formatTimeAndClicks } from "../domain/formatting";
import type { RankedLeaderboardRow } from "../domain/types";

/**
 * Shared "top-3, with your row highlighted (and appended if it's outside the
 * top 3)" board rendering (invariant 1) - used by Results' board snippet and
 * Home's yesterday's-results/today's-board cards (UX redesign spec), so the
 * two screens can never drift on this shape. Originally private to
 * RaceResults.tsx; extracted here once Home needed the identical rendering.
 */
export default function BoardSnippet({
  title,
  leaderboard,
  highlightRunId,
  emptyLabel = "No completed runs yet.",
  children,
}: {
  title: string;
  leaderboard: RankedLeaderboardRow[];
  highlightRunId: string | null;
  emptyLabel?: string;
  children?: ReactNode;
}) {
  if (leaderboard.length === 0) {
    return (
      <section aria-label={title} className="board-snippet">
        <h3>{title}</h3>
        <p className="muted">{emptyLabel}</p>
        {children}
      </section>
    );
  }

  const top3 = leaderboard.slice(0, 3);
  const highlightedRow = highlightRunId
    ? leaderboard.find((row) => row.runId === highlightRunId) ?? null
    : null;
  const highlightedInTop3 = Boolean(highlightedRow) &&
    top3.some((row) => row.runId === highlightedRow?.runId);
  const visibleRows = highlightedRow && !highlightedInTop3 ? [...top3, highlightedRow] : top3;

  return (
    <section aria-label={title} className="board-snippet">
      <h3>{title}</h3>
      <ol>
        {visibleRows.map((row) => {
          const isYou = row.runId === highlightRunId;
          return (
            <li className={isYou ? "is-you" : undefined} key={row.runId}>
              <span className="rank">{row.status === "abandoned" ? "DNF" : `#${row.rank}`}</span>
              <span>
                {row.displayName}
                {isYou ? <span className="muted"> (you)</span> : null}
              </span>
              <span>{formatTimeAndClicks(row.elapsedMs, row.clickCount)}</span>
            </li>
          );
        })}
      </ol>
      {children}
    </section>
  );
}
