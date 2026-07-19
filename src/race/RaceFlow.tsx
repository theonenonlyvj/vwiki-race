import type { MouseEvent, ReactNode } from "react";
import type { GameSession } from "../domain/gameSession";
import type { Article, Challenge, LeaderboardContext } from "../domain/types";
import type { RacePhase } from "../hooks/useRaceController";
import type { TargetPreviewState } from "../hooks/useTargetPreview";
import type { PlayAnotherSuggestionState } from "../domain/playAnother";
import type { VGamesIdentityStatus } from "../services/vgamesIdentity";
import type { VWikiRaceApiClient } from "../services/vwikiRaceApiClient";
import type { ActiveRunRecord } from "../server/trackingRepository";
import PreRacePreview from "./PreRacePreview";
import RaceMode from "./RaceMode";
import RaceRecoveryInterstitial from "./RaceRecoveryInterstitial";
import RaceResults from "./RaceResults";

export interface DnfResultSnapshot {
  challenge: Challenge;
  clicks: number;
  elapsedMs: number;
  runId: string | null;
}

/**
 * Full-screen, zero-chrome takeover for the race flow (preview -> race ->
 * results), plus the active-run recovery gate. App.tsx renders this in
 * place of the app header/tabbar/content-shell whenever the race flow is
 * engaged - see the `raceEngaged` computation there. Only routing/layout
 * lives here; all business logic (starting, ending, retrying, exiting)
 * stays in App.tsx and is passed down as callbacks, per the "extract, don't
 * rewrite" brief for this increment.
 *
 * Recovery-first routing (spec: "Race flow" lead paragraph): App.tsx keeps
 * the shell unmounted until recoverActiveRun has actually resolved for a
 * known session (see `recoveryPending` there). Once recoverActiveRun runs,
 * this component routes purely off its outcome: `recoveryRun` set ->
 * RaceRecoveryInterstitial; phase active-ish -> RaceMode; nothing to
 * recover -> App.tsx drops raceEngaged and the shell takes over.
 */
export default function RaceFlow({
  apiClient,
  phase,
  raceChallenge,
  recoveryRun,
  recoveryPending,
  showPreview,
  previewChallenge,
  targetPreview,
  session,
  article,
  elapsedMs,
  pendingNavigationTitle,
  pendingRetry,
  leaderboardContext,
  runId,
  dnfResult,
  todayCentral,
  identityStatus,
  identityAccountId,
  identityDisplayName,
  preRaceCompletions,
  playAnotherSuggestion,
  randomChallengeBusy,
  randomChallengeError,
  error,
  authBusy,
  endRunIsBlocked,
  onCreateRandomChallenge,
  onOpenChallenge,
  onRetryPending,
  onRetryRecovery,
  onRetryCatalog,
  onRequestEndRun,
  onBackFromPreview,
  onSeeOtherChallengesFromPreview,
  onStartFromPreview,
  onPlayAgain,
  onShowLeaderboard,
  onShowChallenges,
  onClaimIdentity,
  handleArticleClick,
  handleArticlePrewarm,
}: {
  // PKG-03: Results self-fetches its own deduped board (see RaceResults.tsx)
  // instead of reading the app shell's raw per-attempt leaderboard.
  apiClient: VWikiRaceApiClient;
  phase: RacePhase;
  // The race hook's own current challenge - null throughout
  // recoverActiveRun's initial "preparing" tick (see checkingActiveRun
  // below), but set immediately (alongside phase) whenever a fresh
  // challenge start kicks off preparing instead.
  raceChallenge: Challenge | null;
  recoveryRun: ActiveRunRecord | null;
  recoveryPending: boolean;
  showPreview: boolean;
  previewChallenge: Challenge | null;
  targetPreview: TargetPreviewState;
  session: GameSession | null;
  article: Article | null;
  elapsedMs: number;
  pendingNavigationTitle: string | null;
  pendingRetry: { title: string; anchorText: string } | null;
  leaderboardContext: LeaderboardContext | null;
  runId: string | null;
  dnfResult: DnfResultSnapshot | null;
  todayCentral: string;
  identityStatus: VGamesIdentityStatus | null;
  identityAccountId: string | null;
  identityDisplayName: string;
  // See RaceResults' preRaceCompletions doc comment (M2 fix): a snapshot,
  // not live accountStats.
  preRaceCompletions: number | null;
  // Increment 5: App.tsx owns this centrally (like accountStats) so Home and
  // Results can never suggest different challenges in the same session.
  playAnotherSuggestion: PlayAnotherSuggestionState;
  randomChallengeBusy: boolean;
  randomChallengeError: string | null;
  error: string | null;
  authBusy: boolean;
  endRunIsBlocked: boolean;
  onCreateRandomChallenge: () => void;
  // Play-another's suggestion opens Challenge Detail, same as Browse's own
  // cards - this exits the race takeover AND navigates, unlike
  // onShowChallenges (which only lands on Browse's root).
  onOpenChallenge: (challengeId: string) => void;
  onRetryPending: () => void;
  onRetryRecovery: () => void;
  onRetryCatalog: () => void;
  onRequestEndRun: (event: MouseEvent<HTMLElement>) => void;
  onBackFromPreview: () => void;
  onSeeOtherChallengesFromPreview: () => void;
  onStartFromPreview: () => void;
  onPlayAgain: () => void;
  onShowLeaderboard: () => void;
  onShowChallenges: () => void;
  onClaimIdentity: (mode: "create" | "login") => void;
  handleArticleClick: (event: MouseEvent<HTMLElement>) => void;
  handleArticlePrewarm: (target: EventTarget | null) => void;
}) {
  let body: ReactNode = null;

  if (recoveryRun) {
    body = (
      <RaceRecoveryInterstitial
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
        // recoverActiveRun sets phase "preparing" before it even knows
        // whether there's anything to recover, without ever assigning
        // raceChallenge (unlike a fresh start, which sets it in the same
        // commitState call as the phase flip) - so !raceChallenge here means
        // this preparing tick is boot recovery checking, not an article load.
        checkingActiveRun={phase === "preparing" && !raceChallenge}
        handleArticleClick={handleArticleClick}
        handleArticlePrewarm={handleArticlePrewarm}
      />
    );
  } else if (phase === "completed" && session) {
    body = (
      <RaceResults
        apiClient={apiClient}
        article={article}
        outcome={{ status: "completed", session, elapsedMs, leaderboardContext, runId }}
        identityAccountId={identityAccountId}
        todayCentral={todayCentral}
        identityStatus={identityStatus}
        identityDisplayName={identityDisplayName}
        preRaceCompletions={preRaceCompletions}
        playAgainDisabled={authBusy}
        playAnotherSuggestion={playAnotherSuggestion}
        randomChallengeBusy={randomChallengeBusy}
        randomChallengeError={randomChallengeError}
        onCreateRandomChallenge={onCreateRandomChallenge}
        onOpenChallenge={onOpenChallenge}
        onPlayAgain={onPlayAgain}
        onShowLeaderboard={onShowLeaderboard}
        onShowChallenges={onShowChallenges}
        onClaimIdentity={onClaimIdentity}
        handleArticleClick={handleArticleClick}
        handleArticlePrewarm={handleArticlePrewarm}
      />
    );
  } else if (dnfResult) {
    body = (
      <RaceResults
        apiClient={apiClient}
        article={null}
        outcome={{
          status: "dnf",
          challenge: dnfResult.challenge,
          clicks: dnfResult.clicks,
          elapsedMs: dnfResult.elapsedMs,
          runId: dnfResult.runId,
        }}
        identityAccountId={identityAccountId}
        todayCentral={todayCentral}
        identityStatus={identityStatus}
        identityDisplayName={identityDisplayName}
        preRaceCompletions={preRaceCompletions}
        playAgainDisabled={authBusy}
        playAnotherSuggestion={playAnotherSuggestion}
        randomChallengeBusy={randomChallengeBusy}
        randomChallengeError={randomChallengeError}
        onCreateRandomChallenge={onCreateRandomChallenge}
        onOpenChallenge={onOpenChallenge}
        onPlayAgain={onPlayAgain}
        onShowLeaderboard={onShowLeaderboard}
        onShowChallenges={onShowChallenges}
        onClaimIdentity={onClaimIdentity}
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
  } else if (recoveryPending) {
    // Spec: "On load, recovery takes priority over everything else" - App.tsx
    // keeps this takeover engaged (raceEngaged) from the very first render
    // whenever a cached identity might have an active run, before the
    // catalog has even loaded enough to call recoverActiveRun. Nothing to
    // show yet but zero chrome - no Home/nav flash while we wait. A stalled
    // (rather than errored) catalog fetch has no exception to release the
    // gate on its own, so Retry gives the user a manual way out instead of
    // leaving them stuck here indefinitely.
    body = (
      <>
        <p className="loading-text">Checking for an active run...</p>
        <button type="button" onClick={onRetryCatalog}>Retry</button>
      </>
    );
  }

  return (
    <div className="race-takeover">
      {error ? <p className="error-banner" role="alert">{error}</p> : null}
      {body}
    </div>
  );
}
