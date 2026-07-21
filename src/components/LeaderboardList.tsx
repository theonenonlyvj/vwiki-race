import WinningPathChain from "./WinningPathChain";
import { formatTimeAndClicks } from "../domain/formatting";
import { pathStepsToChain } from "../domain/winningPath";
import type { ChallengeBoardDnfRow, ChallengeBoardPlacement, ServerPathStep } from "../domain/types";

/**
 * Challenge Detail's own leaderboard (Invariant 1: "Time AND clicks,
 * always... `0:38 · 5 clk`"). PKG-03 (council 2026-07-19): now reads the
 * SAME deduped `GET /challenges/{id}/board` shape Boards and Home already
 * render (`ChallengeBoardPlacement`/`ChallengeBoardDnfRow` - one row per
 * canonical account, invariant-2-correct server-side) instead of the raw
 * per-attempt leaderboard - a repeat attempt used to show the same display
 * name at two ranks at once ("#1 theonenonlyvj / #2 theonenonlyvj"), the
 * duplicate-rank bug this package fixes. Repeat attempts still live in
 * Challenge Detail's own "Your history" strip (see ChallengeDetail.tsx),
 * which keeps every attempt on purpose.
 *
 * The old per-row "SERVER TRACKED"/"Repeat run" provenance pills are gone
 * for good: "server tracked" was the undifferentiated default, not
 * information, and neither ever appeared in the ratified design mockup
 * (`mockup-browse-detail`: plain "1  FranTheGreat  1:02 · 8 clk" rows).
 *
 * "View winning path" (PKG-03 remainder fix, 2026-07-19): spec invariant 5
 * is "paths stay hidden until YOU'VE played," not "until each row's own
 * player has played" - once `pathsUnlocked` (the viewer has a completed run
 * on this challenge), every placement row's winning path becomes
 * disclosable, not just the viewer's own. `ChallengeBoardPlacement.runId`
 * (added this fix) carries the surviving best attempt's run id so this can
 * hang off the same public `GET /runs/{runId}/path` endpoint "Your history"
 * already uses - `row.runId` is optional (older/cached responses may lack
 * it), so the disclosure simply doesn't render for a row that has none
 * rather than erroring. This mirrors Boards' own inline board markup
 * (`.board-snippet`/`.board-dnf-section`) exactly, so the two screens can't
 * visually drift.
 */
export default function LeaderboardList({
  dnfs,
  identityAccountId,
  onDisclosePath,
  pathsUnlocked,
  placements,
  runPaths,
}: {
  dnfs: ChallengeBoardDnfRow[];
  identityAccountId: string | null;
  onDisclosePath: (runId: string) => void;
  pathsUnlocked: boolean;
  placements: ChallengeBoardPlacement[];
  runPaths: Record<string, ServerPathStep[]>;
}) {
  return (
    <>
      <section className="board-snippet" aria-label="Leaderboard placements">
        {placements.length ? (
          <ol>
            {placements.map((row) => {
              const isYou = identityAccountId !== null && row.accountId === identityAccountId;
              return (
                <li className={isYou ? "is-you" : undefined} key={row.accountId}>
                  <span className="rank">#{row.placement}</span>
                  <span>
                    {row.displayName ?? "Unknown"}
                    {isYou ? <span className="muted"> (you)</span> : null}
                  </span>
                  <span>{formatTimeAndClicks(row.elapsedMs, row.clickCount)}</span>
                  {pathsUnlocked && row.runId ? (
                    <details
                      className="path-disclosure"
                      onToggle={(event) => {
                        if (event.currentTarget.open) onDisclosePath(row.runId!);
                      }}
                    >
                      <summary>View winning path</summary>
                      {runPaths[row.runId] ? (
                        <WinningPathChain titles={pathStepsToChain(runPaths[row.runId])} />
                      ) : <p>Loading path...</p>}
                    </details>
                  ) : null}
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="muted">No completed runs yet.</p>
        )}
      </section>

      <section className="board-snippet board-dnf-section muted" aria-label="DNF">
        {/* QF-05: spelled out - "DNF" alone is jargon to a first-time
            player, and RaceResults' own kicker already expands it
            identically ("DNF — Did not finish"). */}
        <h3>DNF — Did not finish</h3>
        {dnfs.length ? (
          <ol>
            {dnfs.map((row) => {
              const isYou = identityAccountId !== null && row.accountId === identityAccountId;
              return (
                <li className={isYou ? "is-you" : undefined} key={row.accountId}>
                  {/* QF-04: every row here is a genuine DNF (sourced from
                      `dnfs`, never merged with completed-unranked rows), so
                      `.rank-dnf` applies unconditionally - salmon, never CTA
                      teal. */}
                  <span className="rank rank-dnf">{"—"}</span>
                  <span>
                    {row.displayName ?? "Unknown"}
                    {isYou ? <span className="muted"> (you)</span> : null}
                  </span>
                  <span>{formatTimeAndClicks(row.elapsedMs, row.clickCount)}</span>
                </li>
              );
            })}
          </ol>
        ) : (
          <p>No DNFs.</p>
        )}
      </section>
    </>
  );
}
