import LeaderboardList from "../../components/LeaderboardList";
import { formatTimeAndClicks } from "../../domain/formatting";
import type { Challenge, RankedLeaderboardRow, ServerPathStep } from "../../domain/types";
import { ChallengeShareButton } from "../../race/shared";

/**
 * Challenge Detail (new this task - today's browser has no detail view).
 * Reached via a challenge share link (?challenge=<id>) or a browser
 * back/forward step that lands on one - see App.tsx's catalog-load routing
 * and popstate handler. Built entirely on data the shell already fetches
 * (the same `leaderboard`/`runPaths` Boards uses) - no new endpoint.
 */
export default function ChallengeDetail({
  challenge,
  identityAccountId,
  leaderboard,
  onBack,
  onDisclosePath,
  onRaceThis,
  raceDisabled,
  runPaths,
}: {
  challenge: Challenge;
  identityAccountId: string | null;
  leaderboard: RankedLeaderboardRow[];
  onBack: () => void;
  onDisclosePath: (runId: string) => void;
  onRaceThis: () => void;
  raceDisabled: boolean;
  runPaths: Record<string, ServerPathStep[]>;
}) {
  const yourRows = identityAccountId
    ? leaderboard.filter((row) => row.accountId === identityAccountId)
    : [];

  return (
    <section className="challenge-detail" aria-label="Challenge detail">
      <button type="button" className="back-link" onClick={onBack}>
        ← Challenges
      </button>

      <div className="challenge-route" aria-label="Current challenge">
        <div className="challenge-meta">
          <span>{challenge.label ?? challenge.id}</span>
        </div>
        <strong>
          {challenge.start.title} {"->"} {challenge.target.title}
        </strong>
        {challenge.createdBy ? (
          <em>Created by {challenge.createdBy.displayName}</em>
        ) : null}
      </div>

      <div className="player-gate">
        <button type="button" disabled={raceDisabled} onClick={onRaceThis}>
          Race this
        </button>
      </div>

      <section aria-label="Challenge leaderboard">
        <h2>Leaderboard</h2>
        <LeaderboardList
          leaderboard={leaderboard}
          onDisclosePath={onDisclosePath}
          runPaths={runPaths}
        />
      </section>

      <section aria-label="Your history">
        <h3>Your history</h3>
        {yourRows.length ? (
          <ol className="compact-list">
            {yourRows.map((row) => (
              <li key={row.runId}>
                <span>
                  {row.status === "abandoned" ? "DNF" : `#${row.rank}`} ·{" "}
                  {formatTimeAndClicks(row.elapsedMs, row.clickCount)}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">You haven&apos;t tried this one yet.</p>
        )}
      </section>

      <ChallengeShareButton challengeId={challenge.id} />
    </section>
  );
}
