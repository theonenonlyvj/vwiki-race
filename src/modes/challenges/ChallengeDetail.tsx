import { useEffect, useState } from "react";
import RaceCard from "../../components/RaceCard";
import ChallengePathGraphButton from "../../components/ChallengePathGraphButton";
import GiveUpAffordance from "../../components/GiveUpAffordance";
import LeaderboardList from "../../components/LeaderboardList";
import StagedLoadingNotice from "../../components/StagedLoadingNotice";
import TheSolution from "../../components/TheSolution";
import WinningPathChain from "../../components/WinningPathChain";
import { challengeHeading, humanChallengeCreator } from "../../domain/challengePresentation";
import { dailyBadgeLabel } from "../../domain/challengeSelection";
import { formatTimeAndClicks } from "../../domain/formatting";
import { pathStepsToChain } from "../../domain/winningPath";
import type { Challenge, ChallengeOutcomeEntry, RankedLeaderboardRow, ServerPathStep } from "../../domain/types";
import type { ChallengeBoardResponse } from "../../server/contracts";
import { apiErrorCode, type ErrorReporter } from "../../services/errorReporting";
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
 *
 * `pathsUnlocked`/`onDisclosePath`/`runPaths` are shared, unmodified, with
 * BOTH the main Leaderboard panel and "Your history" (PKG-03 remainder fix):
 * invariant 5 gates path disclosure on the VIEWER having played, not on
 * whose run it is - once unlocked, the main board's "View path" (any
 * account with a `runId`) and "Your history"'s per-attempt one both read
 * off the same `onDisclosePath`/`runPaths` App.tsx already wires up.
 *
 * DT-1 (owner feedback, desktop screenshot): "View winning path" ->
 * "View path" everywhere ("'winning' not necessary"). "View graph" moved
 * into the Leaderboard panel's own heading row (was dangling below the DNF
 * section). "Your history" hides itself entirely when it would show
 * exactly one attempt that's already visible on the board above (a
 * completed run this account also holds the board placement for) - see
 * `showHistoryPanel` below; a lone DNF (never board-placed) or 2+ attempts
 * still render, since only then does the strip add information the board
 * above doesn't already carry.
 */
export default function ChallengeDetail({
  apiClient,
  challenge,
  errorReporter,
  identityAccountId,
  identityToken,
  leaderboard,
  leaderboardErrorMessage = null,
  leaderboardStatus = "ready",
  onBack,
  onDisclosePath,
  onPlayTodaysDaily,
  onRaceThis,
  onRetryLeaderboard,
  raceDisabled,
  runPaths,
  todayCentral,
}: {
  apiClient: VWikiRaceApiClient;
  challenge: Challenge;
  // This package: beacons this file's own board-fetch failure below (feeds
  // LeaderboardList's "Couldn't load the leaderboard.") and is threaded on
  // to TheSolution, GiveUpAffordance, and ChallengePathGraphButton for their
  // own self-fetched failures.
  errorReporter: Pick<ErrorReporter, "reportVisibleError">;
  identityAccountId: string | null;
  // GR-1 ("View graph"): the bearer token `ChallengePathGraphButton` needs
  // to fetch the merged graph - see its own doc comment.
  identityToken: string | null;
  leaderboard: RankedLeaderboardRow[];
  // RC-06: the specific server message for "Your history"'s "error" state
  // (house convention: a meaningful message survives verbatim; a generic
  // internal_error gets App.tsx's own friendly fallback - see its doc
  // comment). `null`/omitted falls back to this file's own generic copy.
  leaderboardErrorMessage?: string | null;
  // RC-06: App.tsx's tri-state for the SAME `leaderboard` prop above (the
  // per-attempt fetch feeding "Your history") - "loading"/"error" only ever
  // matter to `showHistoryPanel`'s gating below the moment they'd otherwise
  // read as a false "you haven't tried this one yet."; defaults to "ready"
  // so any other future caller stays source-compatible.
  leaderboardStatus?: "loading" | "error" | "ready";
  onBack: () => void;
  onDisclosePath: (runId: string) => void;
  // Owner-approved URL policy, item 5 (approved polish): present only when
  // AppShell has a genuine today's-daily to fund it (homeHero.kind ===
  // "today-daily") - undefined otherwise, so a catalog with no real daily
  // today simply shows no link rather than one that lies. Reuses App.tsx's
  // openRacePreviewFor, the same entry point Home's hero and Boards' CTA
  // already share.
  onPlayTodaysDaily?: () => void;
  onRaceThis: () => void;
  // RC-06 (Judge B amend 6): retries App.tsx's `refreshLeaderboard` DIRECTLY
  // for this exact challenge id - never a fresh push-based navigation (the
  // Back-ladder invariant stays untouched by a Detail-local retry).
  onRetryLeaderboard: () => void;
  raceDisabled: boolean;
  runPaths: Record<string, ServerPathStep[]>;
  todayCentral: string;
}) {
  const [board, setBoard] = useState<ChallengeBoardResponse>(() => emptyBoard(challenge.id));
  // RC-06 ("one honest loading/error system"): this panel's OWN board fetch
  // tri-state - independent of `leaderboardStatus` above, which covers the
  // separate App-owned per-attempt fetch feeding "Your history" below, not
  // this deduped board read.
  const [boardStatus, setBoardStatus] = useState<"loading" | "error" | "ready">("loading");
  const [boardRetryToken, setBoardRetryToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setBoard(emptyBoard(challenge.id));
    setBoardStatus("loading");
    void apiClient.getChallengeBoard(challenge.id)
      .then((response) => {
        if (!cancelled) {
          setBoard(response);
          setBoardStatus("ready");
        }
      })
      .catch((caught) => {
        // RC-06 (Judge A amendment 1): an honest error + Retry, never the
        // silent empty-board fallback this used to reset to.
        if (cancelled) return;
        errorReporter.reportVisibleError(
          "challenge-detail-board",
          apiErrorCode(caught),
          "Couldn't load the leaderboard.",
          { accountId: identityAccountId ?? undefined },
        );
        setBoardStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [apiClient, challenge.id, boardRetryToken]);

  // "I gave up" (owner spec, 2026-08-02): a small, self-fetched,
  // best-effort read of the caller's own outcome on THIS challenge - the
  // same bulk `getAccountChallengeOutcomes` endpoint Browse already calls
  // (RC-03 cache-backed, so this rarely costs a real network round trip),
  // filtered down to one entry. No dedicated loading/error UI: the give-up
  // affordance and "The solution" panel are enhancements layered onto an
  // already-fully-rendered screen, not load-bearing content - a failed
  // fetch just means neither renders this pass, same as `outcome`
  // defaulting to `undefined` (unauthenticated, or never touched).
  const [outcomeLoad, setOutcomeLoad] = useState<{
    token: string; challengeId: string; outcome?: ChallengeOutcomeEntry; failed?: boolean;
  } | null>(null);
  const [outcomeRefreshToken, setOutcomeRefreshToken] = useState(0);
  useEffect(() => {
    if (!identityToken) { setOutcomeLoad(null); return; }
    let cancelled = false;
    const token = identityToken;
    const challengeId = challenge.id;
    setOutcomeLoad(null);
    void apiClient.getAccountChallengeOutcomes(token)
      .then((outcomes) => {
        if (!cancelled) setOutcomeLoad({ token, challengeId, outcome: outcomes.find(entry => entry.challengeId === challengeId) });
      })
      .catch(() => { if (!cancelled) setOutcomeLoad({ token, challengeId, failed: true }); });
    return () => { cancelled = true; };
  }, [apiClient, identityToken, challenge.id, outcomeRefreshToken]);
  // Account and challenge keys prevent stale progress or reveal access on navigation.
  const currentOutcome = outcomeLoad?.token === identityToken && outcomeLoad?.challengeId === challenge.id ? outcomeLoad : null;
  const outcome = currentOutcome?.outcome;
  const peeked = Boolean(outcome?.peeked);

  const yourRows = identityAccountId
    ? leaderboard.filter((row) => row.accountId === identityAccountId)
    : [];
  // Invariant 5 ("paths stay hidden until you've played... 'played' means
  // finished, not merely started/DNF'd"): a DNF-only history still keeps
  // the anti-spoiler copy up - only a completed row unlocks disclosure.
  // "I gave up" (owner spec, 2026-08-02): extends this to "finished OR
  // peeked", matching the server's own extended disclosure guard
  // (`viewerFinishedOrPeekedChallengeExistsSql`) - a peeked account earns
  // the same "View path"/"View graph" access a finisher gets.
  // Other players’ measurements share the spoiler gate; personal history does not.
  const finished = yourRows.some((row) => row.status === "completed") || outcome?.outcome === "completed";
  const pathsUnlocked = finished || peeked;
  const unfinished = outcome?.outcome === "dnf" || yourRows.some(row => row.status === "abandoned");
  const progressPending = Boolean(identityToken) && (!currentOutcome || leaderboardStatus === "loading");
  const progressFailed = Boolean(currentOutcome?.failed) || leaderboardStatus === "error";
  // A confirmed outcome does not depend on the separately loaded leaderboard.
  // Only the short-attempt history fallback needs a successful history load.
  const latestListedDnf = leaderboardStatus === "ready"
    ? [...yourRows].filter(row => row.status === "abandoned")
      .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))[0]
    : undefined;
  const knownDnf = outcome?.outcome === "dnf" || (leaderboardStatus === "ready" && unfinished);
  const showGiveUp = Boolean(currentOutcome) && !currentOutcome?.failed
    && knownDnf && !finished && !peeked;
  // DT-1 (owner-proxy ruling, "anything else" (b)): a lone completed
  // attempt that's ALSO this account's placement on the main board above is
  // pure duplication - same rank/time/clicks shown twice, once per panel.
  // Only a genuinely redundant SINGLE row is hidden: 2+ attempts (a retry, a
  // DNF alongside a finish, etc.) always have something the deduped board
  // can't show (it only ever keeps one row per account), and a lone DNF is
  // never "the board-visible one" either - DNFs live in their own board
  // section, not the ranked placements this strip would be duplicating.
  const singleRow = yourRows.length === 1 ? yourRows[0] : null;
  const singleRowIsBoardPlacement = Boolean(
    singleRow &&
    singleRow.status === "completed" &&
    board.placements.some(
      (row) => row.accountId === identityAccountId && row.runId === singleRow.runId,
    ),
  );
  const showHistoryPanel = !singleRowIsBoardPlacement;
  const dailyBadge = dailyBadgeLabel(challenge, todayCentral);
  // Owner-approved URL policy, item 5: "Today" is the only label
  // `dailyBadgeLabel` ever gives the CURRENT day's daily - anything else
  // that badge returns (a non-null "Daily M/D"/"Daily") is a past date, so a
  // stale permalink (share link, bookmark, self-healing legacy tab) can
  // funnel back into the ritual instead of dead-ending on an old board.
  const isPastDaily = Boolean(dailyBadge) && dailyBadge !== "Today";

  return (
    <section className="challenge-detail" aria-label="Challenge detail">
      <button type="button" className="back-link" onClick={onBack}>
        ← Challenges
      </button>

      <RaceCard
        challenge={challenge}
        label="Current challenge"
        routeLabel={`Start article: ${challenge.start.title}. Target article: ${challenge.target.title}.`}
        metadata={<>
          <span className="daily-badge">{challengeHeading(challenge)}</span>
          {humanChallengeCreator(challenge) ? <span>Created by {humanChallengeCreator(challenge)}</span> : null}
        </>}
        onRace={onRaceThis}
        disabled={raceDisabled}
        describedBy={peeked ? "challenge-race-status" : undefined}
      >
        {peeked ? <p id="challenge-race-status" className="daily-hero-status muted">Unranked practice</p>
          : finished ? <p className="daily-hero-status daily-hero-done">Finished{outcome?.best ? ` · Your best: ${formatTimeAndClicks(outcome.best.elapsedMs, outcome.best.clickCount)}` : ""}</p>
          : progressPending ? <p className="daily-hero-status muted">Checking your progress…</p>
          : progressFailed ? <p className="daily-hero-status muted">Your progress is unavailable.</p>
          : unfinished ? <p className="daily-hero-status daily-hero-dnf">Last try: DNF</p> : null}
        {showGiveUp ? (
          <GiveUpAffordance ineligibleReason={outcome?.outcome === "dnf" ? "more-progress" : "minimum-clicks"} attemptClickCount={latestListedDnf?.clickCount} eligible={Boolean(outcome?.giveUpEligible)} onRace={onRaceThis} raceDisabled={raceDisabled} apiClient={apiClient} challengeId={challenge.id} errorReporter={errorReporter} identityToken={identityToken} onPeeked={() => setOutcomeRefreshToken(value => value + 1)} />
        ) : null}
      </RaceCard>

      {isPastDaily && onPlayTodaysDaily ? (
        <button className="link-button challenge-today-link" onClick={onPlayTodaysDaily} type="button">Play today&apos;s daily ›</button>
      ) : null}

      {peeked && identityToken ? (
        <TheSolution
          apiClient={apiClient}
          challengeId={challenge.id}
          errorReporter={errorReporter}
          identityToken={identityToken}
        />
      ) : null}

      {/* PKG-04: was the only mode screen with no card chrome - now wrapped
          in the same `.leaderboard-panel` group Boards/Browse/You use
          (styles.css:1431-1442 area), as two panels matching mockup-browse-
          detail's leaderboard box + your-history box. */}
      <section className="leaderboard-panel" aria-label="Challenge leaderboard">
        <div className="leaderboard-heading">
          <h2>Leaderboard</h2>
          {pathsUnlocked ? (
            <ChallengePathGraphButton apiClient={apiClient} challengeId={challenge.id} errorReporter={errorReporter} identityToken={identityToken} unlocked={pathsUnlocked} />
          ) : null}
        </div>
        <LeaderboardList
          dnfs={board.dnfs}
          identityAccountId={identityAccountId}
          onDisclosePath={onDisclosePath}
          onRetry={() => setBoardRetryToken((value) => value + 1)}
          pathsUnlocked={pathsUnlocked}
          placements={board.placements}
          runPaths={runPaths}
          status={boardStatus}
        />
        {!pathsUnlocked ? (
          <p className="muted board-footnote">
            Other players’ times and clicks, and all paths, stay hidden until you finish or confirm a reveal.
          </p>
        ) : null}
      </section>

      {showHistoryPanel ? (
        <section className="leaderboard-panel" aria-label="Your history">
          <h3>Your history</h3>
          {leaderboardStatus === "error" ? (
            // RC-06 (Changes item 2): the same in-place tri-state as the
            // Leaderboard panel above, for the SEPARATE App-owned per-attempt
            // fetch this strip reads - a failed Detail open is retriable
            // here instead of via the vanishing global banner.
            <div className="board-error">
              <p className="error-banner" role="alert">
                {leaderboardErrorMessage ?? "Couldn't load your history."}
              </p>
              <button onClick={onRetryLeaderboard} type="button">
                Retry
              </button>
            </div>
          ) : leaderboardStatus === "loading" ? (
            <StagedLoadingNotice
              active
              onRetry={onRetryLeaderboard}
              pendingLabel="Loading your history…"
            />
          ) : yourRows.length ? (
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
                      {/* DT-1: "View winning path" -> "View path"
                          everywhere - the old status-based ternary (DNF
                          rows already read "View path", completed rows read
                          "View winning path") collapses to one literal now
                          that both branches agree. */}
                      <summary>View path</summary>
                      {runPaths[row.runId] ? (
                        <WinningPathChain titles={pathStepsToChain(runPaths[row.runId])} />
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
      ) : null}

      <ChallengeShareButton challengeId={challenge.id} />
    </section>
  );
}
