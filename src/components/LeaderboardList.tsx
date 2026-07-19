import { formatTimeAndClicks } from "../domain/formatting";
import type { ChallengeBoardDnfRow, ChallengeBoardPlacement } from "../domain/types";

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
 * The old per-row "SERVER TRACKED"/"Repeat run" provenance pills and the
 * unconditional "View winning path" link are both gone: the deduped board
 * shape carries no `runId`/`protocolVersion` to hang either on (there is
 * nothing to disclose a path FOR, and "server tracked" was the undifferentiated
 * default, not information) - and neither ever appeared in the ratified
 * design mockup (`mockup-browse-detail`: plain "1  FranTheGreat  1:02 · 8
 * clk" rows). Your own runs' provenance/path disclosure moved to "Your
 * history" instead, where a real per-run `runId`/`protocolVersion` still
 * exists. This mirrors Boards' own inline board markup (`.board-snippet`/
 * `.board-dnf-section`) exactly, so the two screens can't visually drift.
 */
export default function LeaderboardList({
  dnfs,
  identityAccountId,
  placements,
}: {
  dnfs: ChallengeBoardDnfRow[];
  identityAccountId: string | null;
  placements: ChallengeBoardPlacement[];
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
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="muted">No completed runs yet.</p>
        )}
      </section>

      <section className="board-snippet board-dnf-section muted" aria-label="DNF">
        <h3>DNF</h3>
        {dnfs.length ? (
          <ol>
            {dnfs.map((row) => {
              const isYou = identityAccountId !== null && row.accountId === identityAccountId;
              return (
                <li className={isYou ? "is-you" : undefined} key={row.accountId}>
                  <span className="rank">{"—"}</span>
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
