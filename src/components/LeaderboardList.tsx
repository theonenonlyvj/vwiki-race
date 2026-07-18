import { formatTimeAndClicks } from "../domain/formatting";
import type { RankedLeaderboardRow, ServerPathStep } from "../domain/types";

/**
 * Invariant 1 ("Time AND clicks, always... `0:38 · 5 clk`") row rendering,
 * shared by Boards (the ported LeaderboardPanel) and Challenge Detail's own
 * board - both need the identical rank/DNF, provenance-badge, and path-
 * disclosure treatment. Previously this JSX lived only in App.tsx's
 * LeaderboardPanel with a separate elapsed/click-count pair of spans; this
 * extraction also folds those two spans into the single formatTimeAndClicks
 * string per the redesign's invariant 1.
 */
export default function LeaderboardList({
  leaderboard,
  onDisclosePath,
  runPaths,
}: {
  leaderboard: RankedLeaderboardRow[];
  onDisclosePath: (runId: string) => void;
  runPaths: Record<string, ServerPathStep[]>;
}) {
  if (!leaderboard.length) {
    return <p className="muted">No completed runs yet.</p>;
  }

  return (
    <ol className="leaderboard">
      {leaderboard.map((row) => (
        <li className={row.status === "abandoned" ? "dnf" : undefined} key={row.runId}>
          <span className="rank">
            {row.status === "abandoned" ? "DNF" : `#${row.rank}`}
          </span>
          <span className="leaderboard-player">
            <span>{row.displayName}</span>
            <span
              className={`provenance-badge ${
                row.protocolVersion === 1 ? "historical" : "verified"
              }`}
              title={row.protocolVersion === 1
                ? "Recorded before server-tracked race protocol"
                : "Identity, timing, and path continuity tracked by the server"}
            >
              {row.protocolVersion === 1 ? "Historical" : "Server tracked"}
            </span>
            {row.isRepeatRun ? (
              <span className="provenance-badge repeat">Repeat run</span>
            ) : null}
          </span>
          <span>{formatTimeAndClicks(row.elapsedMs, row.clickCount)}</span>
          <details onToggle={(event) => {
            if (event.currentTarget.open) onDisclosePath(row.runId);
          }}>
            <summary>
              {row.status === "abandoned" ? "View path" : "View winning path"}
            </summary>
            {runPaths[row.runId] ? (
              <ol className="winning-path">
                {runPaths[row.runId].map((step) => (
                  <li key={step.stepNumber}>{step.sourceTitle} {"->"} {step.destinationTitle}</li>
                ))}
              </ol>
            ) : <p>Loading path...</p>}
          </details>
        </li>
      ))}
    </ol>
  );
}
