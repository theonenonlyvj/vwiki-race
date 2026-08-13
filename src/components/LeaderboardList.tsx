import StagedLoadingNotice from "./StagedLoadingNotice";
import WinningPathChain from "./WinningPathChain";
import { formatTimeAndClicks } from "../domain/formatting";
import { pathStepsToChain } from "../domain/winningPath";
import type { ChallengeBoardDnfRow, ChallengeBoardPlacement, ServerPathStep } from "../domain/types";

/** RC-06 ("one honest loading/error system"): the board fetch that feeds
 * this list, tri-stated by the caller (ChallengeDetail.tsx) - "ready" is the
 * only state where `placements`/`dnfs` are trustworthy enough to render
 * (including the genuine "No completed runs yet." empty case). Defaults to
 * "ready" so this stays source-compatible with any future caller that has
 * no reason to distinguish loading/error. */
export type LeaderboardListStatus = "loading" | "error" | "ready";

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
 * "View path" (PKG-03 remainder fix, 2026-07-19; renamed from "View winning
 * path" per DT-1, 2026-07-20 owner feedback: "'winning' not necessary"):
 * spec invariant 5 is "paths stay hidden until YOU'VE played," not "until
 * each row's own player has played" - once `pathsUnlocked` (the viewer has a
 * completed run on this challenge), every placement row's winning path
 * becomes disclosable, not just the viewer's own. `ChallengeBoardPlacement.
 * runId` (added this fix) carries the surviving best attempt's run id so
 * this can hang off the same public `GET /runs/{runId}/path` endpoint "Your
 * history" already uses - `row.runId` is optional (older/cached responses
 * may lack it), so the disclosure simply doesn't render for a row that has
 * none rather than erroring. This mirrors Boards' own inline board markup
 * (`.board-snippet`/`.board-dnf-section`) exactly, so the two screens can't
 * visually drift.
 */
export default function LeaderboardList({
  dnfs,
  identityAccountId,
  onDisclosePath,
  onRetry,
  pathsUnlocked,
  placements,
  runPaths,
  status = "ready",
}: {
  dnfs: ChallengeBoardDnfRow[];
  identityAccountId: string | null;
  onDisclosePath: (runId: string) => void;
  // Only ever invoked from the "error" branch below - undefined is fine for
  // any caller that never passes a non-"ready" status.
  onRetry?: () => void;
  pathsUnlocked: boolean;
  placements: ChallengeBoardPlacement[];
  runPaths: Record<string, ServerPathStep[]>;
  status?: LeaderboardListStatus;
}) {
  if (status === "error") {
    // RC-06: an honest error + Retry - never "No completed runs yet.",
    // which is reserved for a genuinely-resolved empty board (same F6 rule
    // Boards.tsx's own inline board markup follows).
    return (
      <section className="board-snippet board-error" aria-label="Leaderboard placements">
        <p className="error-banner" role="alert">Couldn&apos;t load the leaderboard.</p>
        {onRetry ? (
          <button onClick={onRetry} type="button">
            Retry
          </button>
        ) : null}
      </section>
    );
  }

  return (
    <>
      <section className="board-snippet" aria-label="Leaderboard placements">
        {status === "loading" ? (
          <StagedLoadingNotice active onRetry={onRetry} pendingLabel="Loading board…" />
        ) : placements.length ? (
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
                  {/* Pre-finish spoiler mask (owner ask): "before I finish
                      the race... I shouldn't be able to see how long or #
                      clicks on the leaderboard - just rankings and
                      usernames" - the SAME `pathsUnlocked` gate already
                      controlling "View path" just below, extended to this
                      column. */}
                  <span>
                    {pathsUnlocked
                      ? formatTimeAndClicks(row.elapsedMs, row.clickCount)
                      : <span className="muted">—</span>}
                  </span>
                  {pathsUnlocked && row.runId ? (
                    <details
                      className="path-disclosure"
                      onToggle={(event) => {
                        if (event.currentTarget.open) onDisclosePath(row.runId!);
                      }}
                    >
                      <summary>View path</summary>
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

      {/* DT-1 (owner feedback): "DNF should be hidden unless there's
          actually an entry?" - the whole section (heading included) renders
          nothing for a zero-DNF board rather than a heading over a lone "No
          DNFs." line. Same rule applied to Boards' own inline Today/
          Yesterday DNF section (Boards.tsx) so the two can't drift. */}
      {dnfs.length ? (
        <section className="board-snippet board-dnf-section muted" aria-label="DNF">
          {/* QF-05: spelled out - "DNF" alone is jargon to a first-time
              player, and RaceResults' own kicker already expands it
              identically ("DNF — Did not finish"). */}
          <h3>DNF — Did not finish</h3>
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
                  {/* Pre-finish spoiler mask (owner ask): same gate as the
                      placements column above - a DNF row's time/clicks are
                      no less of a spoiler. */}
                  <span>
                    {pathsUnlocked
                      ? formatTimeAndClicks(row.elapsedMs, row.clickCount)
                      : <span className="muted">—</span>}
                  </span>
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}
    </>
  );
}
