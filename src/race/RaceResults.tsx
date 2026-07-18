import { useCallback, useRef, type FocusEvent, type MouseEvent, type PointerEvent } from "react";
import { dailyDateForChallenge } from "../domain/challengeSelection";
import { compressPathForStrip } from "../domain/pathCompression";
import { formatTimeAndClicks } from "../domain/formatting";
import type { GameSession } from "../domain/gameSession";
import type {
  Article,
  Challenge,
  LeaderboardContext,
  RankedLeaderboardRow,
} from "../domain/types";
import type { VGamesIdentityStatus } from "../services/vgamesIdentity";
import { WikipediaArticlePanel } from "./RaceMode";
import { challengeShareUrl, useClipboardShare } from "./shared";

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

export interface PlayAnotherSuggestion {
  title: string;
  onSelect: () => void;
}

export default function RaceResults({
  article,
  outcome,
  leaderboard,
  todayCentral,
  identityStatus,
  identityDisplayName,
  playAgainDisabled,
  playAnotherSuggestion,
  onPlayAgain,
  onShowLeaderboard,
  onShowChallenges,
  onClaimIdentity,
  handleArticleClick,
  handleArticlePrewarm,
}: {
  article: Article | null;
  outcome: RaceResultOutcome;
  leaderboard: RankedLeaderboardRow[];
  // The current Central-time date (see App.tsx's currentCentralDate/
  // todayUtc) - the only thing that distinguishes "today's actual daily"
  // from any other challenge for the "today"/"Today's board" copy below.
  todayCentral: string;
  identityStatus: VGamesIdentityStatus | null;
  identityDisplayName: string;
  playAgainDisabled: boolean;
  playAnotherSuggestion?: PlayAnotherSuggestion | null;
  onPlayAgain: () => void;
  onShowLeaderboard: () => void;
  onShowChallenges: () => void;
  onClaimIdentity: (mode: "create" | "login") => void;
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

  const challenge = outcome.status === "completed" ? outcome.session.challenge : outcome.challenge;
  const isGuest = identityStatus === "ghost";
  // "Today"/"Today's board" is only accurate when the raced challenge is
  // actually today's daily - anything else (an older daily, a custom
  // challenge) gets the generic "on this board"/"Leaderboard" copy instead.
  const isDailyToday = dailyDateForChallenge(challenge) === todayCentral;

  return (
    <section className="race-results">
      <aside aria-live="polite" className="result-panel">
        {outcome.status === "completed" ? (
          <CompletedResultHeader isDailyToday={isDailyToday} outcome={outcome} />
        ) : (
          <DnfResultHeader clicks={outcome.clicks} elapsedMs={outcome.elapsedMs} />
        )}

        <div className="result-actions">
          <button
            disabled={playAgainDisabled}
            type="button"
            onClick={onPlayAgain}
          >
            {outcome.status === "dnf" ? "Try again" : "Play Again"}
          </button>
          <button type="button" onClick={onShowLeaderboard}>
            View leaderboard
          </button>
        </div>

        {outcome.status === "completed" ? (
          <PathRecap session={outcome.session} />
        ) : null}

        <BoardSnippet
          isDailyToday={isDailyToday}
          leaderboard={leaderboard}
          highlightRunId={outcome.runId}
        />

        <PlayAnotherSlot
          onBrowseChallenges={onShowChallenges}
          suggestion={playAnotherSuggestion ?? null}
        />

        {outcome.status === "completed" ? (
          <>
            {isGuest ? (
              <ClaimCta
                displayName={identityDisplayName}
                onClaimIdentity={onClaimIdentity}
              />
            ) : null}
            <ShareResultButton challenge={challenge} outcome={outcome} />
          </>
        ) : null}
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

function DnfResultHeader({ clicks, elapsedMs }: { clicks: number; elapsedMs: number }) {
  return (
    <>
      <span className="result-kicker">DNF</span>
      <h2>That one got away</h2>
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

function BoardSnippet({
  isDailyToday,
  leaderboard,
  highlightRunId,
}: {
  isDailyToday: boolean;
  leaderboard: RankedLeaderboardRow[];
  highlightRunId: string | null;
}) {
  const boardLabel = isDailyToday ? "Today's board" : "Leaderboard";

  if (leaderboard.length === 0) {
    return (
      <section aria-label={boardLabel} className="board-snippet">
        <h3>{boardLabel}</h3>
        <p className="muted">No completed runs yet.</p>
      </section>
    );
  }

  const top3 = leaderboard.slice(0, 3);
  const highlightedRow = highlightRunId
    ? leaderboard.find((row) => row.runId === highlightRunId) ?? null
    : null;
  const highlightedInTop3 = Boolean(highlightedRow) &&
    top3.some((row) => row.runId === highlightedRow?.runId);
  const visibleRows = highlightedRow && !highlightedInTop3 ? [...top3, highlightedRow] : top3;

  return (
    <section aria-label={boardLabel} className="board-snippet">
      <h3>{boardLabel}</h3>
      <ol>
        {visibleRows.map((row) => {
          const isYou = row.runId === highlightRunId;
          return (
            <li className={isYou ? "is-you" : undefined} key={row.runId}>
              <span className="rank">{row.status === "abandoned" ? "DNF" : `#${row.rank}`}</span>
              <span>
                {row.displayName}
                {isYou ? <span className="muted"> (you)</span> : null}
              </span>
              <span>{formatTimeAndClicks(row.elapsedMs, row.clickCount)}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function PlayAnotherSlot({
  onBrowseChallenges,
  suggestion,
}: {
  onBrowseChallenges: () => void;
  // Named seam for Increment 5's smart suggestion endpoint - when populated,
  // the caller supplies a specific challenge to invite the player into.
  // v1 leaves this null and shows the static invite only.
  suggestion: PlayAnotherSuggestion | null;
}) {
  return (
    <section aria-label="Play another challenge" className="play-another-card">
      <h3>Got a few more minutes?</h3>
      {suggestion ? (
        <button type="button" onClick={suggestion.onSelect}>
          {suggestion.title}
        </button>
      ) : null}
      <button className="link-button" type="button" onClick={onBrowseChallenges}>
        Browse all challenges ›
      </button>
    </section>
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
        <button type="button" onClick={() => onClaimIdentity("create")}>
          Make a name
        </button>
        <button className="link-button" type="button" onClick={() => onClaimIdentity("login")}>
          Log in
        </button>
      </div>
    </section>
  );
}

function ShareResultButton({
  challenge,
  outcome,
}: {
  challenge: Challenge;
  outcome: Extract<RaceResultOutcome, { status: "completed" }>;
}) {
  const shareText = composeShareText(challenge, outcome);
  const { status, copy } = useClipboardShare(shareText);

  return (
    <div className="share-result">
      <button
        disabled={status === "copying"}
        type="button"
        onClick={() => void copy()}
      >
        Share result
      </button>
      {status !== "idle" ? (
        <span aria-live="polite" role="status">
          {status === "copying"
            ? "Copying result..."
            : status === "copied"
              ? "Result copied. Paste it anywhere."
              : "Automatic copy was blocked. Select the text below."}
        </span>
      ) : null}
      {status === "failed" ? (
        <input
          aria-label="Share text"
          onFocus={(event) => event.currentTarget.select()}
          readOnly
          value={shareText}
        />
      ) : null}
    </div>
  );
}

/**
 * One-line, real-data share text (no fabricated "daily #N" - the catalog
 * has no such field yet). Always carries time+clicks (invariant 1) when
 * ranked; falls back gracefully when the server didn't return a rank.
 */
export function composeShareText(
  challenge: Challenge,
  outcome: Extract<RaceResultOutcome, { status: "completed" }>,
): string {
  const label = challenge.label ?? challenge.id;
  const rank = outcome.leaderboardContext?.rank ?? null;
  const scoreLine = rank !== null
    ? `#${rank} · ${formatTimeAndClicks(outcome.elapsedMs, outcome.session.clicks)}`
    : formatTimeAndClicks(outcome.elapsedMs, outcome.session.clicks);
  return `VWiki Race — ${label} — ${scoreLine} — ${challengeShareUrl(challenge.id)}`;
}
