import type { MouseEvent, ReactNode } from "react";
import type { GameSession } from "../domain/gameSession";
import type { Article, Challenge, LeaderboardContext } from "../domain/types";
import type { RacePhase } from "../hooks/useRaceController";
import type { TargetPreviewState } from "../hooks/useTargetPreview";
import type { ActiveRunRecord } from "../server/trackingRepository";
import PreRacePreview from "./PreRacePreview";
import RaceMode from "./RaceMode";
import RaceResults from "./RaceResults";

/**
 * Full-screen, zero-chrome takeover for the race flow (preview -> race ->
 * results), plus the active-run recovery gate. App.tsx renders this in
 * place of the app header/tabbar/content-shell whenever the race flow is
 * engaged - see the `raceEngaged` computation there. Only routing/layout
 * lives here; all business logic (starting, ending, retrying, exiting)
 * stays in App.tsx and is passed down as callbacks, per the "extract, don't
 * rewrite" brief for this increment.
 */
export default function RaceFlow({
  phase,
  recoveryRun,
  showPreview,
  previewChallenge,
  targetPreview,
  session,
  article,
  elapsedMs,
  pendingNavigationTitle,
  pendingRetry,
  leaderboardContext,
  error,
  authBusy,
  endRunIsBlocked,
  onRetryPending,
  onRetryRecovery,
  onRequestEndRun,
  onBackFromPreview,
  onSeeOtherChallengesFromPreview,
  onStartFromPreview,
  onPlayAgain,
  onShowLeaderboard,
  onShowChallenges,
  handleArticleClick,
  handleArticlePrewarm,
}: {
  phase: RacePhase;
  recoveryRun: ActiveRunRecord | null;
  showPreview: boolean;
  previewChallenge: Challenge | null;
  targetPreview: TargetPreviewState;
  session: GameSession | null;
  article: Article | null;
  elapsedMs: number;
  pendingNavigationTitle: string | null;
  pendingRetry: { title: string; anchorText: string } | null;
  leaderboardContext: LeaderboardContext | null;
  error: string | null;
  authBusy: boolean;
  endRunIsBlocked: boolean;
  onRetryPending: () => void;
  onRetryRecovery: () => void;
  onRequestEndRun: (event: MouseEvent<HTMLElement>) => void;
  onBackFromPreview: () => void;
  onSeeOtherChallengesFromPreview: () => void;
  onStartFromPreview: () => void;
  onPlayAgain: () => void;
  onShowLeaderboard: () => void;
  onShowChallenges: () => void;
  handleArticleClick: (event: MouseEvent<HTMLElement>) => void;
  handleArticlePrewarm: (target: EventTarget | null) => void;
}) {
  let body: ReactNode = null;

  if (recoveryRun) {
    body = (
      <RecoveryNotice
        recoveryRun={recoveryRun}
        phase={phase}
        endRunDisabled={endRunIsBlocked || phase === "preparing" || phase === "abandoning"}
        onRetryResume={onRetryRecovery}
        onRequestEndRun={onRequestEndRun}
      />
    );
  } else if (
    phase === "preparing" || phase === "active" || phase === "syncing" || phase === "abandoning"
  ) {
    body = (
      <RaceMode
        article={article}
        session={session}
        elapsedMs={elapsedMs}
        pendingNavigationTitle={pendingNavigationTitle}
        pendingRetry={pendingRetry}
        onRetryPending={onRetryPending}
        targetPreview={targetPreview}
        endRunDisabled={endRunIsBlocked || phase === "preparing" || phase === "abandoning"}
        onRequestEndRun={onRequestEndRun}
        handleArticleClick={handleArticleClick}
        handleArticlePrewarm={handleArticlePrewarm}
      />
    );
  } else if (phase === "completed" && session) {
    body = (
      <RaceResults
        article={article}
        session={session}
        elapsedMs={elapsedMs}
        leaderboardContext={leaderboardContext}
        playAgainDisabled={authBusy}
        onPlayAgain={onPlayAgain}
        onShowLeaderboard={onShowLeaderboard}
        onShowChallenges={onShowChallenges}
        handleArticleClick={handleArticleClick}
        handleArticlePrewarm={handleArticlePrewarm}
      />
    );
  } else if (showPreview) {
    body = previewChallenge ? (
      <PreRacePreview
        challenge={previewChallenge}
        targetPreview={targetPreview}
        startDisabled={authBusy}
        onBack={onBackFromPreview}
        onSeeOtherChallenges={onSeeOtherChallengesFromPreview}
        onStart={onStartFromPreview}
      />
    ) : (
      <p className="loading-text">Loading challenge...</p>
    );
  }

  return (
    <div className="race-takeover">
      {error ? <p className="error-banner" role="alert">{error}</p> : null}
      {body}
    </div>
  );
}

function RecoveryNotice({
  recoveryRun,
  phase,
  endRunDisabled,
  onRetryResume,
  onRequestEndRun,
}: {
  recoveryRun: ActiveRunRecord;
  phase: RacePhase;
  endRunDisabled: boolean;
  onRetryResume: () => void;
  onRequestEndRun: (event: MouseEvent<HTMLElement>) => void;
}) {
  return (
    <section aria-label="Resume previous run" className="recovery-notice">
      <h2>Resume your previous run</h2>
      {recoveryRun.protocolVersion === 2 ? (
        <button disabled={phase !== "idle"} type="button" onClick={onRetryResume}>
          Retry Resume
        </button>
      ) : null}
      <button
        className="end-run-button"
        disabled={endRunDisabled}
        type="button"
        onClick={onRequestEndRun}
      >
        End Old Run
      </button>
    </section>
  );
}
