import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import BoardSnippet from "../components/BoardSnippet";
import { boardSnippetRowsForResult } from "../domain/boardSnippet";
import PlayAnotherCard from "../components/PlayAnotherCard";
import { isDailyToday as isChallengeDailyToday } from "../domain/challengeSelection";
import { compressPathForStrip } from "../domain/pathCompression";
import { formatTimeAndClicks } from "../domain/formatting";
import type { GameSession } from "../domain/gameSession";
import type { PlayAnotherSuggestionState } from "../domain/playAnother";
import type { Article, Challenge, LeaderboardContext } from "../domain/types";
import type { ChallengeBoardResponse } from "../server/contracts";
import type { VWikiRaceApiClient } from "../services/vwikiRaceApiClient";
import type { VGamesIdentityStatus } from "../services/vgamesIdentity";
import { WikipediaArticlePanel } from "./RaceMode";
import { ShareResultButton } from "./shared";

function emptyBoard(challengeId: string): ChallengeBoardResponse {
  return { challengeId, placements: [], dnfs: [] };
}

/**
 * Beat 3 of the race flow: Results. Two outcomes share this screen -
 * "completed" (target reached) and "dnf" (ended the run via End Run with
 * >=1 click) - per the spec's Race flow section and Home's DNF sub-state
 * language family. Both read from data already fetched elsewhere
 * (leaderboardContext/leaderboard); nothing here calls the network.
 */
export type RaceResultOutcome =
  | {
      status: "completed";
      session: GameSession;
      elapsedMs: number;
      leaderboardContext: LeaderboardContext | null;
      runId: string | null;
    }
  | {
      status: "dnf";
      challenge: Challenge;
      clicks: number;
      elapsedMs: number;
      runId: string | null;
    };

export default function RaceResults({
  apiClient,
  article,
  outcome,
  identityAccountId,
  todayCentral,
  identityStatus,
  identityDisplayName,
  preRaceCompletions,
  playAgainDisabled,
  playAnotherSuggestion,
  randomChallengeBusy,
  randomChallengeError,
  onCreateRandomChallenge,
  onOpenChallenge,
  onPlayAgain,
  onShowLeaderboard,
  onShowChallenges,
  onClaimIdentity,
  onGoHome,
  handleArticleClick,
  handleArticlePrewarm,
}: {
  // PKG-03 (council 2026-07-19): Results self-fetches its own board
  // snippet data (mirrors Boards.tsx/ChallengeDetail.tsx's own board-fetch
  // effect) rather than reading the app shell's raw per-attempt
  // `leaderboard` projection, which the deduped board endpoint replaces
  // here - see the doc comment above `boardSnippetRowsForResult`.
  apiClient: VWikiRaceApiClient;
  article: Article | null;
  outcome: RaceResultOutcome;
  identityAccountId: string | null;
  // The current Central-time date (see App.tsx's currentCentralDate/
  // todayUtc) - the only thing that distinguishes "today's actual daily"
  // from any other challenge for the "today"/"Today's board" copy below.
  todayCentral: string;
  identityStatus: VGamesIdentityStatus | null;
  identityDisplayName: string;
  // Ritual hook (spec Race flow beat 3): "the account's first finish of any
  // kind - not daily-specific - adds... 'come defend your spot'." M2 fix:
  // this is a snapshot of the account's totals.completed taken at the
  // moment THIS run started (see App.tsx's preRaceCompletionsRef), not the
  // live/current accountStats - which can still read stale (pre-refetch) or
  // already-advanced by the time this screen renders, in either direction.
  // `null` means no snapshot was taken (e.g. a recovered run resumed after
  // reload) - treated as "not eligible" rather than guessing.
  preRaceCompletions: number | null;
  playAgainDisabled: boolean;
  // Increment 5: centrally fetched/owned in App.tsx (see Home's identical
  // prop) so Results and Home never disagree.
  playAnotherSuggestion: PlayAnotherSuggestionState;
  randomChallengeBusy: boolean;
  randomChallengeError: string | null;
  onCreateRandomChallenge: () => void;
  onOpenChallenge: (challengeId: string) => void;
  onPlayAgain: () => void;
  onShowLeaderboard: () => void;
  onShowChallenges: () => void;
  onClaimIdentity: (mode: "create" | "login") => void;
  // PKG-05 (council 2026-07-19): low-emphasis, nice-to-have exit straight to
  // Home - not load-bearing (the daily ritual already round-trips through
  // Home via the mode-nav once View leaderboard/Browse land), just a
  // cheaper way back for anyone who's done for the day.
  onGoHome: () => void;
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

  // PKG-12 (council 2026-07-19): a DNF lands here with nothing to receive
  // focus at all - WikipediaArticlePanel only renders below for the
  // "completed" outcome, so a keyboard/screen-reader user got silence.
  // Scoped to the DNF outcome only: the "completed" case already has a
  // focus target (WikipediaArticlePanel's own mount effect, RaceMode.tsx,
  // focuses the article heading - React fires that child effect before
  // this parent one on mount, so adding an unconditional focus-here effect
  // would silently steal focus from an existing, already-tested behavior
  // for no reason - "Fruit"'s article heading is the right landing spot
  // when there's an article to land on).
  const resultHeadingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (outcome.status === "dnf") {
      resultHeadingRef.current?.focus();
    }
    // Mount-only: RaceFlow always fully unmounts/remounts RaceResults
    // between runs (RaceMode <-> RaceResults, never the same instance
    // re-purposed), so `outcome` can't change under an already-mounted
    // instance.
  }, []);

  const challenge = outcome.status === "completed" ? outcome.session.challenge : outcome.challenge;

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

  // The literal run that just ended, in `boardSnippetRowsForResult` terms -
  // same source (`outcome`/`leaderboardContext`) the header above already
  // reads, so the two can never disagree (PKG-03 change 5's "one source of
  // truth"). See that function's doc comment for the known open question
  // (a non-personal-best repeat's own true rank/time vs. the account's
  // canonical placement elsewhere on the same board).
  const justFinishedRow = outcome.status === "completed"
    ? {
        status: "completed" as const,
        rank: outcome.leaderboardContext?.rank ?? null,
        displayName: identityDisplayName,
        elapsedMs: outcome.elapsedMs,
        clickCount: outcome.session.clicks,
      }
    : {
        status: "dnf" as const,
        rank: null,
        displayName: identityDisplayName,
        elapsedMs: outcome.elapsedMs,
        clickCount: outcome.clicks,
      };

  const isGuest = identityStatus === "ghost";
  // "Today"/"Today's board" is only accurate when the raced challenge is
  // actually today's daily - anything else (an older daily, a custom
  // challenge) gets the generic "on this board"/"Leaderboard" copy instead.
  // Same helper App.tsx's "View leaderboard" exit routing uses (PKG-05), so
  // the two can't independently drift on the same calculation.
  const isDailyToday = isChallengeDailyToday(challenge, todayCentral);
  // Ritual hook (spec beat 3): fires only on the account's literal first-ever
  // completed race - i.e. the pre-race snapshot was exactly 0 completions,
  // regardless of how long the post-race stats refetch takes (M2 fix).
  const showFirstFinishRitual = outcome.status === "completed" &&
    preRaceCompletions === 0;

  return (
    <section className="race-results">
      <aside aria-live="polite" className="result-panel">
        {outcome.status === "completed" ? (
          <CompletedResultHeader isDailyToday={isDailyToday} outcome={outcome} />
        ) : (
          <DnfResultHeader
            clicks={outcome.clicks}
            elapsedMs={outcome.elapsedMs}
            headingRef={resultHeadingRef}
          />
        )}

        {showFirstFinishRitual ? (
          <p className="ritual-hook" role="status">
            🔥 Day 1 · New daily drops 5:00 AM — come defend your spot
          </p>
        ) : null}

        {/* PKG-05 (council 2026-07-19): Share and (for a still-unclaimed
            guest) the claim nudge move directly under the header - un-gated
            from `status === "completed"` so a DNF is no longer a dead end
            (a losing run is still shareable and a guest can still claim
            their spot). Both read off `justFinishedRow`, the same
            one-source-of-truth data the header/board row above already use
            (PKG-03 change 5), so a DNF's share text carries its own
            explicit "DNF" marker rather than reading like a blazing win. */}
        {isGuest ? (
          <ClaimCta
            displayName={identityDisplayName}
            onClaimIdentity={onClaimIdentity}
          />
        ) : null}
        <ShareResultButton
          challenge={challenge}
          clicks={justFinishedRow.clickCount}
          elapsedMs={justFinishedRow.elapsedMs}
          rank={justFinishedRow.rank}
          status={justFinishedRow.status}
        />

        {/* Hierarchy (PKG-05): the clock-commit action gets the same coral
            `.start-race-button` class PreRacePreview's "Start race" uses -
            Play Again/Try again restarts the race clock immediately, same
            as Start, so it earns the same "clock-commit" treatment (design
            spec: "coral reserved for primary/destructive race actions").
            "View leaderboard" only opens a board, so it gets the existing
            `.secondary-button` treatment (already used by
            ChallengeShareButton) instead of matching solid-cyan weight. */}
        <div className="result-actions">
          <button
            className="start-race-button"
            disabled={playAgainDisabled}
            type="button"
            onClick={onPlayAgain}
          >
            {outcome.status === "dnf" ? "Try again" : "Play again"}
          </button>
          <button className="secondary-button" type="button" onClick={onShowLeaderboard}>
            View leaderboard
          </button>
        </div>

        {outcome.status === "completed" ? (
          <PathRecap session={outcome.session} />
        ) : null}

        <BoardSnippet
          title={isDailyToday ? "Today's board" : "Leaderboard"}
          rows={boardSnippetRowsForResult(board, identityAccountId, justFinishedRow)}
        />

        <PlayAnotherCard
          onBrowseChallenges={onShowChallenges}
          onCreateRandomChallenge={onCreateRandomChallenge}
          onOpenChallenge={onOpenChallenge}
          randomChallengeBusy={randomChallengeBusy}
          randomChallengeError={randomChallengeError}
          suggestion={playAnotherSuggestion}
        />

        {/* Judge A amendment 2: nice-to-have, not load-bearing - the daily
            ritual already closes fine via View leaderboard/Browse (both
            round-trip through the mode-nav, Home one tap away). Just a
            cheaper, lower-emphasis way back for anyone done for the day. */}
        <div className="result-home-exit">
          <button className="link-button" type="button" onClick={onGoHome}>
            Home
          </button>
        </div>
      </aside>

      {outcome.status === "completed" && article ? (
        <WikipediaArticlePanel
          article={article}
          challengeLabel={outcome.session.challenge.label ?? outcome.session.challenge.mode}
          acceptedPageId={outcome.session.currentPage.pageId}
          onClick={stableArticleClick}
          onFocus={stableArticleFocus}
          onPointerDown={stableArticlePointerDown}
          pendingNavigationTitle={null}
        />
      ) : null}
    </section>
  );
}

function CompletedResultHeader({
  isDailyToday,
  outcome,
}: {
  isDailyToday: boolean;
  outcome: Extract<RaceResultOutcome, { status: "completed" }>;
}) {
  const rank = outcome.leaderboardContext?.rank ?? null;
  const placement = isDailyToday ? "today" : "on this board";
  const resultLine = rank !== null
    ? `#${rank} ${placement} · ${formatTimeAndClicks(outcome.elapsedMs, outcome.session.clicks)}`
    : formatTimeAndClicks(outcome.elapsedMs, outcome.session.clicks);

  return (
    <>
      <span className="result-kicker">YOU REACHED IT 🏁</span>
      <h2>{outcome.session.challenge.target.title}</h2>
      <p className="result-score">{resultLine}</p>
    </>
  );
}

function DnfResultHeader({
  clicks,
  elapsedMs,
  headingRef,
}: {
  clicks: number;
  elapsedMs: number;
  // PKG-12: the DNF outcome has no article panel to land focus on (unlike
  // "completed", where WikipediaArticlePanel's own mount effect already
  // focuses the article heading) - nothing received focus here at all.
  // tabIndex=-1 + a mount-effect focus() call (RaceResults) makes this the
  // landing spot for a keyboard/screen-reader user arriving at a DNF.
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  return (
    <>
      {/* PKG-05: "DNF" is never spelled out anywhere else in the app - a
          first-time viewer has no way to learn what it means. The kicker is
          the one place that can carry the expansion without disturbing the
          compact "DNF · time · clicks" score line invariant 1 requires. */}
      <span className="result-kicker">DNF — Did not finish</span>
      <h2 ref={headingRef} tabIndex={-1}>That one got away</h2>
      {/* Invariant 1 ("Time AND clicks, always") applies to DNF too. */}
      <p className="result-score">DNF · {formatTimeAndClicks(elapsedMs, clicks)}</p>
    </>
  );
}

function PathRecap({ session }: { session: GameSession }) {
  const pathTitles = [
    session.challenge.start.title,
    ...session.path.map((entry) => entry.resolvedDestination.canonicalTitle),
  ];
  const lastTitle = pathTitles.at(-1) ?? "";
  const compressed = compressPathForStrip(pathTitles, lastTitle);

  return (
    <details className="path-recap">
      <summary>
        <span className="path-recap-line">
          {compressed.join(" → ")} ({session.clicks} {session.clicks === 1 ? "click" : "clicks"})
        </span>
        <span className="link-affordance">see path ›</span>
      </summary>
      <ol className="winning-path">
        {pathTitles.map((title, index) => (
          <li key={`${title}-${index}`}>{title}</li>
        ))}
      </ol>
    </details>
  );
}

function ClaimCta({
  displayName,
  onClaimIdentity,
}: {
  displayName: string;
  onClaimIdentity: (mode: "create" | "login") => void;
}) {
  return (
    <section aria-label="Keep your spot" className="claim-cta">
      <h3>Keep your spot</h3>
      <p>You&apos;re on the board as {displayName}. Claim it so it stays yours.</p>
      <div className="claim-cta-actions">
        {/* PKG-11 (council 2026-07-19): "Make a name" was flagged in the
            design spec's own council notes as "a pun that may not parse for
            first-time readers" - replaced with the app-wide account-verb
            pair ("Create account"/"Log in") every other entry point now
            uses. */}
        <button type="button" onClick={() => onClaimIdentity("create")}>
          Create account
        </button>
        <button className="link-button" type="button" onClick={() => onClaimIdentity("login")}>
          Log in
        </button>
      </div>
    </section>
  );
}

