import { useEffect, useMemo, useState } from "react";
import BoardSnippet from "../components/BoardSnippet";
import { dailyDateForChallenge, previousCentralDate } from "../domain/challengeSelection";
import { dailyFlavorLabel } from "../domain/dailyEditorial";
import { dailyTrendGuard } from "../domain/dailyTrends";
import { formatTimeAndClicks } from "../domain/formatting";
import type { AccountStats, Challenge, RankedLeaderboardRow } from "../domain/types";
import { ShareResultButton } from "../race/shared";
import type { VWikiRaceApiClient } from "../services/vwikiRaceApiClient";

type DailyState = "not-attempted" | "dnf" | "finished";

/**
 * Home v2 (Increment 2 Task 2): the stateful daily hub (UX redesign spec,
 * Home §stateful). Reads today's daily as one of three conditions - not
 * attempted, attempted-not-finished (DNF), finished - derived entirely from
 * existing data: `heroChallenge` (today's real daily, or the pre-redesign
 * default-challenge fallback when the catalog has none - see AppShell) and
 * that challenge's own leaderboard, fetched here directly (no new
 * endpoint). Own row = a leaderboard row whose accountId matches the
 * current identity (works after a guest->claimed upgrade too, since claims
 * carry the same canonical accountId - see server's account_aliases
 * resolution). `sessionDnfChallengeIds` covers the one gap a leaderboard
 * can't: a 0-click abandon leaves no row at all, so App.tsx remembers "ended
 * a run for this challenge this session" locally for that case only (never
 * used for the teaching gate, which stays server-derived - migration note
 * iii).
 *
 * Old how-to-play copy is gone - the app-shell teaching gate supersedes it.
 * The embedded ChallengeBrowser/target-preview card from Home v1 are gone
 * too - Browse now owns the library, and the Pre-race preview beat owns the
 * target blurb; Home's hero only needs the pair + a Race button.
 */
export default function Home({
  accountStats,
  apiClient,
  challenges,
  heroChallenge,
  identityAccountId,
  onGoToBoards,
  onRaceChallenge,
  onShowChallenges,
  raceBusy,
  selectedChallengeId,
  sessionDnfChallengeIds,
  sharedLeaderboard,
  todayCentral,
}: {
  // Increment 4 (UX redesign spec, Home §Pre-play/§Post-play): the guarded
  // streak/trend chip. `null` while identity/stats haven't resolved yet -
  // the row simply doesn't render, matching the teaching gate's existing
  // "loading/errored stats reads as no stats" convention rather than
  // showing a placeholder number.
  accountStats: AccountStats | null;
  apiClient: VWikiRaceApiClient;
  challenges: Challenge[];
  heroChallenge: Challenge | null;
  identityAccountId: string | null;
  onGoToBoards: () => void;
  onRaceChallenge: (challengeId: string) => void;
  onShowChallenges: () => void;
  raceBusy: boolean;
  // The app shell already fetches/refreshes a leaderboard for whatever
  // challenge is currently selected elsewhere (Boards/Detail) - when that
  // happens to be today's daily too (the common case: nothing else has been
  // browsed yet), Home reuses it instead of firing a second, redundant
  // request for the exact same endpoint.
  selectedChallengeId: string | null;
  sessionDnfChallengeIds: ReadonlySet<string>;
  sharedLeaderboard: RankedLeaderboardRow[];
  todayCentral: string;
}) {
  const yesterdayCentral = useMemo(
    () => previousCentralDate(todayCentral),
    [todayCentral],
  );
  // The catalog only carries active challenges (spec: Home §Pre-play) - a
  // genuine "yesterday's daily" is often simply absent once its day passes.
  // That's expected, not an error - the card below omits itself gracefully.
  const yesterdaysDaily = useMemo(
    () => challenges.find((challenge) => dailyDateForChallenge(challenge) === yesterdayCentral) ?? null,
    [challenges, yesterdayCentral],
  );

  const heroMatchesSelected = Boolean(heroChallenge) && selectedChallengeId === heroChallenge?.id;
  const [independentTodayBoard, setIndependentTodayBoard] = useState<RankedLeaderboardRow[]>([]);
  const [yesterdayBoard, setYesterdayBoard] = useState<RankedLeaderboardRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    if (!heroChallenge || heroMatchesSelected) {
      // Nothing to fetch, or the app shell's own selection already covers
      // this exact challenge - see sharedLeaderboard above.
      return;
    }
    void apiClient.listLeaderboard(heroChallenge.id)
      .then((rows) => {
        if (!cancelled) setIndependentTodayBoard(rows);
      })
      .catch(() => {
        if (!cancelled) setIndependentTodayBoard([]);
      });
    return () => {
      cancelled = true;
    };
  }, [apiClient, heroChallenge?.id, heroMatchesSelected]);
  const todayBoard = heroMatchesSelected ? sharedLeaderboard : independentTodayBoard;

  useEffect(() => {
    let cancelled = false;
    if (!yesterdaysDaily) {
      setYesterdayBoard([]);
      return;
    }
    void apiClient.listLeaderboard(yesterdaysDaily.id)
      .then((rows) => {
        if (!cancelled) setYesterdayBoard(rows);
      })
      .catch(() => {
        if (!cancelled) setYesterdayBoard([]);
      });
    return () => {
      cancelled = true;
    };
  }, [apiClient, yesterdaysDaily?.id]);

  if (!heroChallenge) {
    return (
      <section className="home-layout">
        <section className="empty-state">
          <span>Challenge</span>
          <h2>Loading challenge catalog</h2>
        </section>
      </section>
    );
  }

  const myRows = identityAccountId
    ? todayBoard.filter((row) => row.accountId === identityAccountId)
    : [];
  // Invariant 2: "A completion is permanent... A later DNF never demotes a
  // prior checkmark." - a completed row always wins over a DNF row or the
  // local session flag, regardless of which happened more recently.
  const myCompletedRow = myRows.find((row) => row.status === "completed") ?? null;
  const myDnfRow = myRows.find((row) => row.status === "abandoned") ?? null;
  const dailyState: DailyState = myCompletedRow
    ? "finished"
    : myDnfRow || sessionDnfChallengeIds.has(heroChallenge.id)
      ? "dnf"
      : "not-attempted";

  const yesterdayMyRow = identityAccountId
    ? yesterdayBoard.find((row) => row.accountId === identityAccountId) ?? null
    : null;
  const flavorBadge = heroChallenge.dailyFeature
    ? dailyFlavorLabel(heroChallenge.dailyFeature.flavor)
    : null;

  return (
    <section className="home-layout">
      <div className="daily-hero challenge-route" aria-label="Today's daily">
        <div className="challenge-meta">
          {flavorBadge ? <span className="daily-badge">{flavorBadge}</span> : null}
        </div>
        <strong>
          {heroChallenge.start.title} <span className="route-arrow">{"->"}</span> {heroChallenge.target.title}
        </strong>

        {dailyState === "finished" && myCompletedRow ? (
          <p className="daily-hero-status daily-hero-done">
            {"✓"} DONE · You finished #{myCompletedRow.rank} ·{" "}
            {formatTimeAndClicks(myCompletedRow.elapsedMs, myCompletedRow.clickCount)}
          </p>
        ) : dailyState === "dnf" ? (
          <>
            <p className="daily-hero-status daily-hero-dnf">Last try: DNF</p>
            <div className="player-gate">
              <button
                className="start-race-button"
                disabled={raceBusy}
                onClick={() => onRaceChallenge(heroChallenge.id)}
                type="button"
              >
                Try again
              </button>
            </div>
          </>
        ) : (
          <div className="player-gate">
            <button
              className="start-race-button"
              disabled={raceBusy}
              onClick={() => onRaceChallenge(heroChallenge.id)}
              type="button"
            >
              {"▶"} Race
            </button>
          </div>
        )}
      </div>

      {dailyState !== "finished" ? <StreakTrendRow stats={accountStats} /> : null}

      {dailyState !== "finished" && yesterdaysDaily ? (
        <BoardSnippet
          title="Yesterday's results"
          leaderboard={yesterdayBoard}
          highlightRunId={yesterdayMyRow?.runId ?? null}
        >
          <button
            className="link-button"
            onClick={() => onGoToBoards()}
            type="button"
          >
            see full board ›
          </button>
        </BoardSnippet>
      ) : null}

      {dailyState === "finished" && myCompletedRow ? (
        <>
          <BoardSnippet
            title="Today's board"
            leaderboard={todayBoard}
            highlightRunId={myCompletedRow.runId}
          />

          <ShareResultButton
            challenge={heroChallenge}
            clicks={myCompletedRow.clickCount}
            elapsedMs={myCompletedRow.elapsedMs}
            rank={myCompletedRow.rank}
          />

          <section aria-label="Play another challenge" className="play-another-card">
            <h3>Got a few more minutes?</h3>
            <button className="link-button" onClick={onShowChallenges} type="button">
              Browse all challenges ›
            </button>
          </section>

          <StreakTrendRow stats={accountStats} />

          <p className="ritual-line muted">
            New daily drops 5:00 AM Central — come defend your spot.
          </p>
        </>
      ) : null}
    </section>
  );
}

/**
 * Home's guarded streak/avg-placement chip (Increment 4, UX redesign spec:
 * "slim stats row: 🔥 streak · '30-day avg #2.4 (26 dailies)'"; post-play:
 * "streak/trend row (inherits the Boards §7d/30d participation guard)").
 * The streak piece is omitted entirely at 0 (spec: "(omit when 0)").
 *
 * F4 (council acceptance): a below-guard trend no longer goes silent - it
 * shows the same muted "M/{guard} dailies" progress framing Boards' own
 * unranked section uses, so a below-guard account still sees *something*
 * moving instead of a chip that just isn't there. `dailyTrendGuard(30)` is
 * a fixed constant (always 10; see `dailyTrendGuard`), not a value that
 * could drift from a server-side number, so hardcoding it here doesn't
 * reintroduce the guard-re-derivation problem F5 fixes on Boards (which
 * has to pick between 3/10/10 depending on the selected window).
 * The whole row still disappears when there's truly nothing to show yet -
 * no streak and zero dailies played, ever (a brand-new account).
 */
function StreakTrendRow({ stats }: { stats: AccountStats | null }) {
  if (!stats) return null;
  const { dailyStreak, trend30 } = stats;
  if (dailyStreak <= 0 && !trend30.ranked && trend30.playedCount === 0) return null;

  return (
    <p className="home-streak-trend-row muted">
      {dailyStreak > 0 ? `🔥 ${dailyStreak}-day streak` : null}
      {dailyStreak > 0 ? " · " : null}
      {trend30.ranked
        ? `30-day avg #${trend30.avgPlacement?.toFixed(1)} (${trend30.playedCount} dailies)`
        : `${trend30.playedCount}/${dailyTrendGuard(30)} dailies`}
    </p>
  );
}
