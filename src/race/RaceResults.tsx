import { useCallback, useRef, type FocusEvent, type MouseEvent, type PointerEvent } from "react";
import type { GameSession } from "../domain/gameSession";
import type { Article, LeaderboardContext } from "../domain/types";
import { WikipediaArticlePanel } from "./RaceMode";
import { ChallengeShareButton, formatElapsed } from "./shared";

/**
 * Beat 3 of the race flow, for this increment: the existing completion
 * panel content moved unchanged (result + Play Again/leaderboard/share/
 * choose-another links) plus the frozen article surface beneath it, same as
 * today. Full Results redesign (board snippet, claim CTA, path recap) is
 * the next task.
 */
export default function RaceResults({
  article,
  session,
  elapsedMs,
  leaderboardContext,
  playAgainDisabled,
  onPlayAgain,
  onShowLeaderboard,
  onShowChallenges,
  handleArticleClick,
  handleArticlePrewarm,
}: {
  article: Article | null;
  session: GameSession;
  elapsedMs: number;
  leaderboardContext: LeaderboardContext | null;
  playAgainDisabled: boolean;
  onPlayAgain: () => void;
  onShowLeaderboard: () => void;
  onShowChallenges: () => void;
  handleArticleClick: (event: MouseEvent<HTMLElement>) => void;
  handleArticlePrewarm: (target: EventTarget | null) => void;
}) {
  const articleClickRef = useRef(handleArticleClick);
  articleClickRef.current = handleArticleClick;
  const stableArticleClick = useCallback((event: MouseEvent<HTMLElement>) => {
    articleClickRef.current(event);
  }, []);
  const articlePrewarmRef = useRef(handleArticlePrewarm);
  articlePrewarmRef.current = handleArticlePrewarm;
  const stableArticlePrewarm = useCallback((target: EventTarget | null) => {
    articlePrewarmRef.current(target);
  }, []);
  const stableArticleFocus = useCallback((event: FocusEvent<HTMLElement>) => {
    stableArticlePrewarm(event.target);
  }, [stableArticlePrewarm]);
  const stableArticlePointerDown = useCallback((event: PointerEvent<HTMLElement>) => {
    stableArticlePrewarm(event.target);
  }, [stableArticlePrewarm]);

  return (
    <section className="race-results">
      <aside aria-live="polite" className="result-panel">
        <span className="result-kicker">Finished</span>
        <h2>Target reached</h2>
        <p className="result-score">
          {session.clicks} {session.clicks === 1 ? "click" : "clicks"} in{" "}
          {formatElapsed(elapsedMs)}
        </p>
        {leaderboardContext === null ? (
          <p className="result-standing">Run already completed on the server</p>
        ) : leaderboardContext.isPersonalBest ? (
          <p className="result-standing">
            Personal best
            {leaderboardContext.rank !== null ? ` / Rank #${leaderboardContext.rank}` : ""}
          </p>
        ) : (
          <p className="result-standing">Not a personal best</p>
        )}
        {session.challenge.origin === "daily" ? (
          <p className="result-standing">Next daily arrives at 5:00 AM Central.</p>
        ) : null}
        <div className="result-actions">
          <button disabled={playAgainDisabled} type="button" onClick={onPlayAgain}>
            Play Again
          </button>
          <button type="button" onClick={onShowLeaderboard}>
            View leaderboard
          </button>
          <ChallengeShareButton challengeId={session.challenge.id} />
          <button
            className="secondary-button"
            type="button"
            onClick={onShowChallenges}
          >
            Choose another challenge
          </button>
        </div>
      </aside>

      {article ? (
        <WikipediaArticlePanel
          article={article}
          challengeLabel={session.challenge.label ?? session.challenge.mode}
          acceptedPageId={session.currentPage.pageId}
          onClick={stableArticleClick}
          onFocus={stableArticleFocus}
          onPointerDown={stableArticlePointerDown}
          pendingNavigationTitle={null}
        />
      ) : null}
    </section>
  );
}
