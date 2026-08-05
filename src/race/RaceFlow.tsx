import type { MouseEvent, ReactNode } from "react";
import StagedLoadingNotice from "../components/StagedLoadingNotice";
import type { GameSession } from "../domain/gameSession";
import type { Article, Challenge, LeaderboardContext } from "../domain/types";
import type { DnfResultSnapshot, RacePhase } from "../hooks/useRaceController";
import type { TargetPreviewState } from "../hooks/useTargetPreview";
import type { PlayAnotherSuggestionState } from "../domain/playAnother";
import type { ErrorReporter } from "../services/errorReporting";
import type { VGamesIdentityStatus } from "../services/vgamesIdentity";
import type { VWikiRaceApiClient } from "../services/vwikiRaceApiClient";
import type { ActiveRunRecord } from "../server/trackingRepository";
import { assertNever, type RaceScreen } from "./deriveScreen";
import PreRacePreview from "./PreRacePreview";
import RaceMode from "./RaceMode";
import RaceRecoveryInterstitial from "./RaceRecoveryInterstitial";
import RaceResults from "./RaceResults";

// RC-07 Step 2: DnfResultSnapshot now lives in useRaceController.ts (the
// hook owns/constructs it) - re-exported here so existing importers of
// "./race/RaceFlow" (this component's own public surface before this
// refactor) don't need to change their import path.
export type { DnfResultSnapshot };

/**
 * Full-screen, zero-chrome takeover for the race flow (preview -> race ->
 * results), plus the active-run recovery gate. App.tsx renders this in
 * place of the app header/tabbar/content-shell whenever `deriveScreen`
 * (../race/deriveScreen.ts) resolves to anything other than "shell" - see
 * its own doc comment for the full precedence table. Only routing/layout
 * lives here; all business logic (starting, ending, retrying, exiting)
 * stays in App.tsx and is passed down as callbacks, per the "extract, don't
 * rewrite" brief for this increment.
 *
 * RC-07 Step 1: `screen` is computed ONCE per App render by the shared
 * `deriveScreen` function and switched on here - this component no longer
 * independently re-derives "which branch am I in" from raw
 * phase/recoveryRun/dnfResult/etc. props (the old 7-branch if/else-if
 * ladder), it just renders whatever `screen.kind` says. The `default:
 * assertNever(screen)` case is what makes the "TS exhaustiveness" guarantee
 * real - see deriveScreen.ts's own doc comment.
 *
 * Recovery-first routing (spec: "Race flow" lead paragraph): App.tsx keeps
 * the shell unmounted until recoverActiveRun has actually resolved for a
 * known session (see `recoveryPending` there, folded into `screen.kind ===
 * "race-recovery-pending"`).
 */
export default function RaceFlow({
  screen,
  apiClient,
  errorReporter,
  phase,
  raceChallenge,
  recoveryRun,
  previewChallenge,
  targetPreview,
  session,
  article,
  elapsedMs,
  redirectedFrom,
  pendingNavigationTitle,
  navigationRetrying,
  pendingRetry,
  leaderboardContext,
  runId,
  dnfResult,
  todayCentral,
  identityStatus,
  identityAccountId,
  identityToken,
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
  onGoHome,
  handleArticleClick,
  handleArticlePrewarm,
}: {
  // RC-07 Step 1: precomputed once per App render by deriveScreen - see
  // this component's own doc comment above.
  screen: RaceScreen;
  // PKG-03: Results self-fetches its own deduped board (see RaceResults.tsx)
  // instead of reading the app shell's raw per-attempt leaderboard.
  apiClient: VWikiRaceApiClient;
  // This package: threaded to RaceResults for GiveUpAffordance/
  // ChallengePathGraphButton's own self-fetched failures - never used
  // directly by this file (useRaceController.ts already beacons `error`
  // below through the SAME reporter, via App.tsx's own options.errorReporter
  // wiring).
  errorReporter: Pick<ErrorReporter, "reportVisibleError">;
  phase: RacePhase;
  // The race hook's own current challenge - null throughout
  // recoverActiveRun's initial "preparing" tick (see checkingActiveRun
  // below), but set immediately (alongside phase) whenever a fresh
  // challenge start kicks off preparing instead.
  raceChallenge: Challenge | null;
  recoveryRun: ActiveRunRecord | null;
  previewChallenge: Challenge | null;
  targetPreview: TargetPreviewState;
  session: GameSession | null;
  article: Article | null;
  elapsedMs: number;
  // LK-1: threaded straight from useRaceController's own field of the same
  // name - see its doc comment there.
  redirectedFrom: string | null;
  pendingNavigationTitle: string | null;
  // MB-1 Part 2: true while pendingNavigationTitle's fetch (article or
  // click-POST) is on its automatic retry - see useRaceController's own
  // field of the same name.
  navigationRetrying: boolean;
  pendingRetry: { title: string; anchorText: string } | null;
  leaderboardContext: LeaderboardContext | null;
  runId: string | null;
  dnfResult: DnfResultSnapshot | null;
  todayCentral: string;
  identityStatus: VGamesIdentityStatus | null;
  identityAccountId: string | null;
  // GR-1 ("View graph"): the bearer token RaceResults' `ChallengePathGraphButton` needs.
  identityToken: string | null;
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
  // PKG-05: Results' low-emphasis Home exit link (see RaceResults' own
  // onGoHome doc comment).
  onGoHome: () => void;
  handleArticleClick: (event: MouseEvent<HTMLElement>) => void;
  handleArticlePrewarm: (target: EventTarget | null) => void;
}) {
  let body: ReactNode = null;

  switch (screen.kind) {
    case "race-recovery-interstitial": {
      // recoveryRun is guaranteed non-null whenever deriveScreen resolves
      // to this kind (that's the ENTIRE gate) - the `recoveryRun &&` guard
      // just satisfies TypeScript, which can't see across the two separate
      // props to know that.
      body = recoveryRun ? (
        <RaceRecoveryInterstitial
          recoveryRun={recoveryRun}
          phase={phase}
          endRunDisabled={endRunIsBlocked || phase === "preparing" || phase === "abandoning"}
          onRetryResume={onRetryRecovery}
          onRequestEndRun={onRequestEndRun}
        />
      ) : null;
      break;
    }
    case "race-active": {
      body = (
        <RaceMode
          article={article}
          session={session}
          elapsedMs={elapsedMs}
          redirectedFrom={redirectedFrom}
          pendingNavigationTitle={pendingNavigationTitle}
          navigationRetrying={navigationRetrying}
          pendingRetry={pendingRetry}
          onRetryPending={onRetryPending}
          targetPreview={targetPreview}
          endRunDisabled={endRunIsBlocked || phase === "preparing" || phase === "abandoning"}
          onRequestEndRun={onRequestEndRun}
          // recoverActiveRun sets phase "preparing" before it even knows
          // whether there's anything to recover, without ever assigning
          // raceChallenge (unlike a fresh start, which sets it in the same
          // commitState call as the phase flip) - so !raceChallenge here
          // means this preparing tick is boot recovery checking, not an
          // article load.
          checkingActiveRun={phase === "preparing" && !raceChallenge}
          handleArticleClick={handleArticleClick}
          handleArticlePrewarm={handleArticlePrewarm}
        />
      );
      break;
    }
    case "race-results": {
      // session is guaranteed non-null whenever deriveScreen resolves to
      // this kind - see its own doc comment's precedence table.
      body = session ? (
        <RaceResults
          apiClient={apiClient}
          errorReporter={errorReporter}
          article={article}
          outcome={{ status: "completed", session, elapsedMs, leaderboardContext, runId }}
          identityAccountId={identityAccountId}
          identityToken={identityToken}
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
          onGoHome={onGoHome}
          handleArticleClick={handleArticleClick}
          handleArticlePrewarm={handleArticlePrewarm}
        />
      ) : null;
      break;
    }
    case "race-dnf": {
      // dnfResult is guaranteed non-null whenever deriveScreen resolves to
      // this kind - see its own doc comment's precedence table.
      body = dnfResult ? (
        <RaceResults
          apiClient={apiClient}
          errorReporter={errorReporter}
          article={null}
          outcome={{
            status: "dnf",
            challenge: dnfResult.challenge,
            clicks: dnfResult.clicks,
            elapsedMs: dnfResult.elapsedMs,
            runId: dnfResult.runId,
          }}
          identityAccountId={identityAccountId}
          identityToken={identityToken}
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
          onGoHome={onGoHome}
          handleArticleClick={handleArticleClick}
          handleArticlePrewarm={handleArticlePrewarm}
        />
      ) : null;
      break;
    }
    case "race-preview": {
      // RC-06 ("one honest loading/error system", Judge A amendment 2/3):
      // this is the ONE genuinely retry-less interstitial in this file - a
      // stuck `!previewChallenge` (the catalog never resolving the selected
      // challenge, e.g. a failed/stale catalog load) had no manual way out
      // at all before this package. Staged, not instant - a fast catalog
      // resolve never even reaches the 300ms "Loading challenge…" copy;
      // Retry itself only appears once truly stalled (>=2000ms), reusing
      // the same catalog-refetch callback the sibling
      // "race-recovery-pending" branch below already uses. Deliberately
      // NOT applied to that sibling branch - it ships an immediate,
      // unstaged Retry by deliberate design (see its own comment: a
      // stalled, not errored, catalog fetch needing a manual escape from an
      // indefinite hang) - see this package's report for why the two aren't
      // templated identically.
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
        <StagedLoadingNotice
          active
          className="loading-text"
          onRetry={onRetryCatalog}
          pendingLabel="Loading challenge..."
        />
      );
      break;
    }
    case "race-recovery-pending": {
      // Spec: "On load, recovery takes priority over everything else" -
      // App.tsx keeps this takeover engaged from the very first render
      // whenever a cached identity might have an active run, before the
      // catalog has even loaded enough to call recoverActiveRun. Nothing to
      // show yet but zero chrome - no Home/nav flash while we wait. A
      // stalled (rather than errored) catalog fetch has no exception to
      // release the gate on its own, so Retry gives the user a manual way
      // out instead of leaving them stuck here indefinitely. RC-06 (Judge A
      // amendment 2): deliberately kept IMMEDIATE/unstaged, unlike the
      // "race-preview" branch above - staging this would delay the one
      // manual escape hatch for an indefinite hang.
      body = (
        <>
          <p className="loading-text">Checking for an active run...</p>
          <button type="button" onClick={onRetryCatalog}>Retry</button>
        </>
      );
      break;
    }
    default:
      return assertNever(screen);
  }

  return (
    <div className="race-takeover">
      {error ? <p className="error-banner" role="alert">{error}</p> : null}
      {body}
    </div>
  );
}
