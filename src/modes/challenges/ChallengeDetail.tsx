import { useEffect, useState } from "react";
import LeaderboardList from "../../components/LeaderboardList";
import { dailyBadgeLabel } from "../../domain/challengeSelection";
import { formatTimeAndClicks } from "../../domain/formatting";
import type { Challenge, RankedLeaderboardRow, ServerPathStep } from "../../domain/types";
import type { ChallengeBoardResponse } from "../../server/contracts";
import type { VWikiRaceApiClient } from "../../services/vwikiRaceApiClient";
import { ChallengeShareButton } from "../../race/shared";

function emptyBoard(challengeId: string): ChallengeBoardResponse {
  return { challengeId, placements: [], dnfs: [] };
}

/**
 * Challenge Detail (new this task - today's browser has no detail view).
 * Reached via a challenge share link (?challenge=<id>) or a browser
 * back/forward step that lands on one - see App.tsx's catalog-load routing
 * and popstate handler.
 *
 * PKG-03 (council 2026-07-19): the main "Leaderboard" panel now self-fetches
 * the deduped `GET /challenges/{id}/board` endpoint - the same one
 * Home/Boards already call - keyed on `challenge.id`, mirroring Boards.tsx's
 * own board-fetch effect exactly (reset-then-refetch-then-cancel-guard) so
 * switching between two Detail challenges (a back/forward step, or a fresh
 * share link) can't leak a stale board across the switch. The raw
 * per-attempt `leaderboard` prop the app shell already fetches is kept for
 * "Your history" only, which legitimately needs every attempt (repeat runs
 * included) rather than the account's single best.
 */
export default function ChallengeDetail({
  apiClient,
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
  apiClient: VWikiRaceApiClient;
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
  const [board, setBoard] = useState<ChallengeBoardResponse>(() => emptyBoard(challenge.id));

  useEffect(() => {
    let cancelled = false;
    setBoard(emptyBoard(challenge.id));
    void apiClient.getChallengeBoard(challenge.id)
      .then((response) => {
        if (!cancelled) setBoard(response);
      })
      .catch(() => {
        if (!cancelled) setBoard(emptyBoard(challenge.id));
      });
    return () => {
      cancelled = true;
    };
  }, [apiClient, challenge.id]);

  const yourRows = identityAccountId
    ? leaderboard.filter((row) => row.accountId === identityAccountId)
    : [];
  // Invariant 5 ("paths stay hidden until you've played... 'played' means
  // finished, not merely started/DNF'd"): a DNF-only history still keeps
  // the anti-spoiler copy up - only a completed row unlocks disclosure.
  const pathsUnlocked = yourRows.some((row) => row.status === "completed");
  const dailyBadge = dailyBadgeLabel(challenge, todayCentral);

  return (
    <section className="challenge-detail" aria-label="Challenge detail">
      <button type="button" className="back-link" onClick={onBack}>
        ← Challenges
      </button>

      {/* PKG-09: title block + Race CTA co-wrapped in one `.route-header`
          grid parent (mirroring Home's `.daily-hero` + `.daily-hero-copy`
          structure) - before this, the two were bare siblings, so the CTA
          had nothing to dock beside and just floated in dead space below
          the title at desktop widths. */}
      <div className="route-header">
        <div className="challenge-route" aria-label="Current challenge">
          <div className="challenge-meta">
            <span>{challenge.label ?? challenge.id}</span>
            {dailyBadge ? <span className="daily-badge">{dailyBadge}</span> : null}
          </div>
          <strong>
            {challenge.start.title} {"→"} {challenge.target.title}
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
            {"▶"} Race
          </button>
        </div>
      </div>

      {/* PKG-04: was the only mode screen with no card chrome - now wrapped
          in the same `.leaderboard-panel` group Boards/Browse/You use
          (styles.css:1431-1442 area), as two panels matching mockup-browse-
          detail's leaderboard box + your-history box. */}
      <section className="leaderboard-panel" aria-label="Challenge leaderboard">
        <h2>Leaderboard</h2>
        <LeaderboardList
          dnfs={board.dnfs}
          identityAccountId={identityAccountId}
          placements={board.placements}
        />
        {!pathsUnlocked ? (
          <p className="muted board-footnote">Paths hidden until you&apos;ve played.</p>
        ) : null}
      </section>

      <section className="leaderboard-panel" aria-label="Your history">
        <h3>Your history</h3>
        {yourRows.length ? (
          <ol className="leaderboard">
            {yourRows.map((row) => (
              <li className={row.status === "abandoned" ? "dnf" : undefined} key={row.runId}>
                <span className="rank">
                  {row.status === "abandoned" ? "DNF" : `#${row.rank}`}
                </span>
                <span className="leaderboard-player">
                  <span>{formatTimeAndClicks(row.elapsedMs, row.clickCount)}</span>
                  {row.protocolVersion === 1 ? (
                    // PKG-03: a tap-to-reveal explanation (mobile has no
                    // hover) replaces the old hover-only `title` attribute -
                    // "Server tracked" is gone entirely (it was the default,
                    // not information; only the pre-migration exception is
                    // still worth flagging).
                    <details className="provenance-disclosure">
                      <summary className="provenance-badge historical">Historical</summary>
                      <p className="muted">Recorded before the server-tracked race protocol.</p>
                    </details>
                  ) : null}
                </span>
                {pathsUnlocked ? (
                  <details
                    className="path-disclosure"
                    onToggle={(event) => {
                      if (event.currentTarget.open) onDisclosePath(row.runId);
                    }}
                  >
                    <summary>
                      {row.status === "abandoned" ? "View path" : "View winning path"}
                    </summary>
                    {runPaths[row.runId] ? (
                      <ol className="winning-path">
                        {runPaths[row.runId].map((step) => (
                          <li key={step.stepNumber}>{step.sourceTitle} {"→"} {step.destinationTitle}</li>
                        ))}
                      </ol>
                    ) : <p>Loading path...</p>}
                  </details>
                ) : null}
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
