import LeaderboardList from "../../components/LeaderboardList";
import { dailyBadgeLabel } from "../../domain/challengeSelection";
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
  todayCentral,
}: {
  challenge: Challenge;
  identityAccountId: string | null;
  leaderboard: RankedLeaderboardRow[];
  onBack: () => void;
  onDisclosePath: (runId: string) => void;
  onRaceThis: () => void;
  raceDisabled: boolean;
  runPaths: Record<string, ServerPathStep[]>;
  todayCentral: string;
}) {
  const yourRows = identityAccountId
    ? leaderboard.filter((row) => row.accountId === identityAccountId)
    : [];
  const dailyBadge = dailyBadgeLabel(challenge, todayCentral);

  return (
    <section className="challenge-detail" aria-label="Challenge detail">
      <button type="button" className="back-link" onClick={onBack}>
        ← Challenges
      </button>

      <div className="challenge-route" aria-label="Current challenge">
        <div className="challenge-meta">
          <span>{challenge.label ?? challenge.id}</span>
          {dailyBadge ? <span className="daily-badge">{dailyBadge}</span> : null}
        </div>
        <strong>
          {challenge.start.title} {"->"} {challenge.target.title}
        </strong>
        {challenge.createdBy ? (
          <em>Created by {challenge.createdBy.displayName}</em>
        ) : null}
      </div>

      <div className="player-gate">
        {/* PKG-04 (owner-proxy ruling): opening the preview is non-committal
            (invariant 3 - no run exists until Start), same action Home's
            hero and Boards' CTA trigger (App.tsx's openRacePreviewFor) - so
            it shares their teal `.race-preview-button` class, never coral. */}
        <button
          className="race-preview-button"
          type="button"
          disabled={raceDisabled}
          onClick={onRaceThis}
        >
          Race this
        </button>
      </div>

      {/* PKG-04: was the only mode screen with no card chrome - now wrapped
          in the same `.leaderboard-panel` group Boards/Browse/You use
          (styles.css:1431-1442 area), as two panels matching mockup-browse-
          detail's leaderboard box + your-history box. */}
      <section className="leaderboard-panel" aria-label="Challenge leaderboard">
        <h2>Leaderboard</h2>
        <LeaderboardList
          leaderboard={leaderboard}
          onDisclosePath={onDisclosePath}
          runPaths={runPaths}
        />
      </section>

      <section className="leaderboard-panel" aria-label="Your history">
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
