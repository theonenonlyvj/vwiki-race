import { useEffect, useMemo, useState } from "react";
import BoardSnippet from "../components/BoardSnippet";
import PlayAnotherCard from "../components/PlayAnotherCard";
import { boardSnippetRowsFromBoard } from "../domain/boardSnippet";
import {
  dailyDateForChallenge,
  previousCentralDate,
  type HomeHeroSelection,
} from "../domain/challengeSelection";
import { dailyFlavorLabel } from "../domain/dailyEditorial";
import { dailyTrendGuard } from "../domain/dailyTrends";
import { formatTimeAndClicks } from "../domain/formatting";
import type { PlayAnotherSuggestionState } from "../domain/playAnother";
import type { AccountStats, Challenge } from "../domain/types";
import type { ChallengeBoardResponse } from "../server/contracts";
import { ShareResultButton } from "../race/shared";
import type { VWikiRaceApiClient } from "../services/vwikiRaceApiClient";

type DailyState = "not-attempted" | "dnf" | "finished";

/**
 * Home v2 (Increment 2 Task 2): the stateful daily hub (UX redesign spec,
 * Home §stateful). Reads today's daily as one of three conditions - not
 * attempted, attempted-not-finished (DNF), finished - derived from the
 * DEDUPED board endpoint (`GET /challenges/{id}/board`, desktop-pass FIX 3:
 * the raw per-attempt leaderboard listed the same account once per run, so
 * "Yesterday's results" could show one player twice; the board is one row
 * per canonical account, placements first, invariant-2-correct server-side).
 * Finished = your accountId is in `placements`; DNF = it's in `dnfs` (or
 * `sessionDnfChallengeIds` - a 0-click abandon leaves no board row at all,
 * so App.tsx remembers "ended a run for this challenge this session"
 * locally for that case only; never used for the teaching gate, which stays
 * server-derived - migration note iii). AccountId matching works after a
 * guest->claimed upgrade too, since claims carry the same canonical
 * accountId - see the server's account_aliases resolution.
 *
 * The hero itself is `selectHomeHeroChallenge`'s pick (FIX 4): today's real
 * daily post-drop; YESTERDAY's daily pre-drop (badged honestly, with the
 * 5:00 AM Central drop line - it's still playable); the pre-redesign
 * default-challenge fallback only when the catalog has no daily at all.
 */
export default function Home({
  accountStats,
  apiClient,
  challenges,
  hero,
  identityAccountId,
  onGoToBoards,
  onOpenChallenge,
  onCreateRandomChallenge,
  onRaceChallenge,
  onShowChallenges,
  playAnotherSuggestion,
  raceBusy,
  randomChallengeBusy,
  randomChallengeError,
  sessionDnfChallengeIds,
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
  hero: HomeHeroSelection | null;
  identityAccountId: string | null;
  onGoToBoards: () => void;
  // Play-another's suggestion opens Challenge Detail - same route as
  // Browse's own cards (spec: "a Race affordance (route consistent with
  // Browse cards → Detail)") - reuses App.tsx's existing openChallengeDetail.
  onOpenChallenge: (challengeId: string) => void;
  onCreateRandomChallenge: () => void;
  onRaceChallenge: (challengeId: string) => void;
  onShowChallenges: () => void;
  // Increment 5 (spec: "Home post-play 'Got a few more minutes?' card...
  // uses the suggestion endpoint"): centrally fetched in App.tsx (like
  // accountStats) so Home and Results can never suggest different
  // challenges to the same account in the same session.
  playAnotherSuggestion: PlayAnotherSuggestionState;
  raceBusy: boolean;
  randomChallengeBusy: boolean;
  randomChallengeError: string | null;
  sessionDnfChallengeIds: ReadonlySet<string>;
  todayCentral: string;
}) {
  const heroChallenge = hero?.challenge ?? null;
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

  const [heroBoard, setHeroBoard] = useState<ChallengeBoardResponse | null>(null);
  const [independentYesterdayBoard, setIndependentYesterdayBoard] =
    useState<ChallengeBoardResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!heroChallenge) return;
    void apiClient.getChallengeBoard(heroChallenge.id)
      .then((response) => {
        if (!cancelled) setHeroBoard(response);
      })
      .catch(() => {
        // Same convention as Boards' daily views: a failed board read renders
        // as "no results yet" rather than blocking the hero itself.
        if (!cancelled) setHeroBoard(null);
      });
    return () => {
      cancelled = true;
    };
  }, [apiClient, heroChallenge?.id]);

  // Pre-drop (FIX 4) the hero IS yesterday's daily - reuse its board rather
  // than fetching the identical endpoint twice.
  const yesterdayIsHero = Boolean(yesterdaysDaily) && yesterdaysDaily?.id === heroChallenge?.id;

  useEffect(() => {
    let cancelled = false;
    if (!yesterdaysDaily || yesterdayIsHero) {
      setIndependentYesterdayBoard(null);
      return;
    }
    void apiClient.getChallengeBoard(yesterdaysDaily.id)
      .then((response) => {
        if (!cancelled) setIndependentYesterdayBoard(response);
      })
      .catch(() => {
        if (!cancelled) setIndependentYesterdayBoard(null);
      });
    return () => {
      cancelled = true;
    };
  }, [apiClient, yesterdaysDaily?.id, yesterdayIsHero]);

  if (!hero || !heroChallenge) {
    return (
      <section className="home-layout">
        <section className="empty-state">
          <span>Challenge</span>
          <h2>Loading challenge catalog</h2>
        </section>
      </section>
    );
  }

  // Guard against a stale board briefly surviving a hero change (same
  // `board.challengeId === active.id` check Boards uses).
  const heroBoardMatches = heroBoard?.challengeId === heroChallenge.id ? heroBoard : null;
  const yesterdayBoard = yesterdayIsHero
    ? heroBoardMatches
    : independentYesterdayBoard && independentYesterdayBoard.challengeId === yesterdaysDaily?.id
      ? independentYesterdayBoard
      : null;

  const myPlacement = identityAccountId && heroBoardMatches
    ? heroBoardMatches.placements.find((row) => row.accountId === identityAccountId) ?? null
    : null;
  const myDnf = identityAccountId && heroBoardMatches
    ? heroBoardMatches.dnfs.find((row) => row.accountId === identityAccountId) ?? null
    : null;
  // Invariant 2: "A completion is permanent... A later DNF never demotes a
  // prior checkmark." - the board endpoint already resolves this server-side
  // (an account with a completed run appears ONLY in placements), so a
  // placement row always wins here by construction.
  const dailyState: DailyState = myPlacement
    ? "finished"
    : myDnf || sessionDnfChallengeIds.has(heroChallenge.id)
      ? "dnf"
      : "not-attempted";

  // FIX 4 framing: pre-drop the hero is yesterday's still-playable daily and
  // must say so - badge it explicitly and tell the player when the next one
  // lands, instead of silently presenting a stand-in as "the daily".
  const heroIsYesterday = hero.kind === "yesterday-daily";
  const flavorBadge = heroChallenge.dailyFeature
    ? heroIsYesterday
      ? `Yesterday's daily · ${dailyFlavorLabel(heroChallenge.dailyFeature.flavor)}`
      : dailyFlavorLabel(heroChallenge.dailyFeature.flavor)
    : null;
  const heroBoardTitle = heroIsYesterday ? "Yesterday's board" : "Today's board";

  return (
    <section className="home-layout">
      <div
        className="daily-hero challenge-route"
        aria-label={heroIsYesterday ? "Yesterday's daily" : "Today's daily"}
      >
        {/* FIX 5: badge + title + status copy grouped left/top; the Race
            button is a sibling so CSS can dock it right on desktop and
            stretch it full-width on mobile - no giant empty middle. */}
        <div className="daily-hero-copy">
          <div className="challenge-meta">
            {flavorBadge ? <span className="daily-badge">{flavorBadge}</span> : null}
          </div>
          <strong>
            {heroChallenge.start.title} <span className="route-arrow">{"->"}</span> {heroChallenge.target.title}
          </strong>

          {dailyState === "finished" && myPlacement ? (
            <p className="daily-hero-status daily-hero-done">
              {"✓"} DONE · You finished #{myPlacement.placement} ·{" "}
              {formatTimeAndClicks(myPlacement.elapsedMs, myPlacement.clickCount)}
            </p>
          ) : dailyState === "dnf" ? (
            <p className="daily-hero-status daily-hero-dnf">Last try: DNF</p>
          ) : null}

          {/* Finished state already closes with the "come defend your spot"
              ritual line below - don't say "drops 5:00 AM" twice. */}
          {heroIsYesterday && dailyState !== "finished" ? (
            <p className="ritual-line muted">New daily drops 5:00 AM Central.</p>
          ) : null}
        </div>

        {dailyState !== "finished" ? (
          <div className="player-gate">
            {/* PKG-04 (owner-proxy ruling): this only opens the pre-race
                preview (App.tsx's openRacePreviewFor) - non-committal, same
                as Boards' CTA and Detail's "Race this" - so it shares their
                teal `.race-preview-button` class. Coral is reserved for
                PreRacePreview's actual "Start race" and RaceMode's
                "End Run". */}
            <button
              className="race-preview-button"
              disabled={raceBusy}
              onClick={() => onRaceChallenge(heroChallenge.id)}
              type="button"
            >
              {dailyState === "dnf" ? "Try again" : `${"▶"} Race`}
            </button>
          </div>
        ) : null}
      </div>

      {dailyState !== "finished" ? <StreakTrendRow stats={accountStats} /> : null}

      {dailyState !== "finished" && yesterdaysDaily && !yesterdayIsHero ? (
        <BoardSnippet
          title="Yesterday's results"
          rows={yesterdayBoard ? boardSnippetRowsFromBoard(yesterdayBoard, identityAccountId) : []}
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

      {dailyState === "finished" && myPlacement ? (
        <>
          <BoardSnippet
            title={heroBoardTitle}
            rows={heroBoardMatches ? boardSnippetRowsFromBoard(heroBoardMatches, identityAccountId) : []}
          />

          <ShareResultButton
            challenge={heroChallenge}
            clicks={myPlacement.clickCount}
            elapsedMs={myPlacement.elapsedMs}
            rank={myPlacement.placement}
          />

          <PlayAnotherCard
            onBrowseChallenges={onShowChallenges}
            onCreateRandomChallenge={onCreateRandomChallenge}
            onOpenChallenge={onOpenChallenge}
            randomChallengeBusy={randomChallengeBusy}
            randomChallengeError={randomChallengeError}
            suggestion={playAnotherSuggestion}
          />

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
