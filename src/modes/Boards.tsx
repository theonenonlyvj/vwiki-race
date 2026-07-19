import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  dailyDateForChallenge,
  previousCentralDate,
  type HomeHeroSelection,
} from "../domain/challengeSelection";
import { dailyFlavorBadgeText } from "../domain/dailyEditorial";
import { formatTimeAndClicks } from "../domain/formatting";
import type { AllPlayersRosterEntry, Challenge, ServerPathStep } from "../domain/types";
import type {
  BoardsTrendRankedEntry,
  BoardsTrendsResponse,
  BoardsTrendWindow,
  ChallengeBoardResponse,
} from "../server/contracts";
import type { VWikiRaceApiClient } from "../services/vwikiRaceApiClient";

export type BoardsSegment = "today" | "yesterday" | "7d" | "30d" | "lifetime";
type TrendSegment = "7d" | "30d" | "lifetime";

const ALL_SEGMENTS: BoardsSegment[] = ["today", "yesterday", "7d", "30d", "lifetime"];

const SEGMENT_LABEL: Record<BoardsSegment, string> = {
  today: "Today",
  yesterday: "Yesterday",
  "7d": "7d",
  "30d": "30d",
  lifetime: "Lifetime",
};

// PKG-11 (council 2026-07-19, Judge A amendment 1): spelled-out prose only
// for the "Rolling {window}" subheader line beneath the segment tabs - the
// tabs themselves keep their compact "7d"/"30d" convention (a defensible,
// common analytics shorthand the judges agreed doesn't need reworking).
const TREND_PROSE_LABEL: Record<TrendSegment, string> = {
  "7d": "7 days",
  "30d": "30 days",
  lifetime: "Lifetime",
};

const TREND_WINDOW_PARAM: Record<TrendSegment, BoardsTrendWindow> = {
  "7d": "7",
  "30d": "30",
  lifetime: "lifetime",
};

const EMPTY_BOARD: ChallengeBoardResponse = { challengeId: "", placements: [], dnfs: [] };

// PKG-10 remainder fix (2026-07-19): completes the ARIA tabs pattern the
// binding ruling itemized (role=tab/tablist + roving tabindex + arrow keys
// were already there) - each tab now `aria-controls` this one shared panel
// id (only one segment's content is ever mounted at a time, so a single
// swapped panel is the correct single-panel-per-tablist shape, not a gap),
// and the panel itself carries `role="tabpanel"` + `aria-labelledby` the
// currently-active tab's own id.
const BOARDS_SEGMENT_PANEL_ID = "boards-segment-panel";
function boardsTabId(segment: BoardsSegment): string {
  return `boards-tab-${segment}`;
}

type RecentDailyDetail =
  | { challengeId: string; dailyDate: string; status: "loading" }
  | { challengeId: string; dailyDate: string; status: "not-played" }
  | { challengeId: string; dailyDate: string; status: "placement"; placement: number; elapsedMs: number; clickCount: number }
  | { challengeId: string; dailyDate: string; status: "dnf"; elapsedMs: number; clickCount: number };

function isTrendSegment(segment: BoardsSegment): segment is TrendSegment {
  return segment === "7d" || segment === "30d" || segment === "lifetime";
}

/**
 * Boards v1/v2 (Increments 3 + 4, UX redesign spec §Boards): a segmented
 * [Today][Yesterday][7d][30d][Lifetime] control. The first two are daily
 * views (Increment 3 - unchanged this increment); the last three are
 * rolling-placement trends (Increment 4), reading `GET
 * /api/v2/boards/trends` - ranked rows that have cleared the participation
 * guard, plus a muted "not yet ranked" section framed as progress ("M/{guard}
 * dailies"), never a bare rejection (council note). All trend copy (the
 * guard number itself, and every "N/{guard}" progress line) reads off the
 * server-echoed `trends.guard` - never re-derived client-side (F5) - so a
 * future guard-formula change can't silently disagree between server and
 * client. Each ranked row also gets a muted ▲/▼/– trend arrow (F3) comparing
 * its `avgPlacement` against the immediately-preceding same-length window
 * (server-computed as `prevAvgPlacement`); lifetime never gets one (no
 * "previous window" to compare against). A failed trends fetch renders an
 * error banner + Retry (F6), never the "no one has cleared the guard" empty
 * state - that empty state is reserved for a real zero-ranked response.
 *
 * "Today" reuses `heroSelection` - AppShell's `homeHero` (PKG-01), the exact
 * same kind-aware selection Home's hero and Browse's pinned row read - not a
 * separately-derived "today's daily." Before PKG-01, Today kept its own
 * `selectDefaultChallenge` call, whose fallback chain silently ends at
 * `activeChallenges[0]` (an arbitrary catalog entry); pre-drop or on a
 * broken-generation day that meant Today badged a random challenge "TODAY"
 * with a "Race today's daily" CTA while Home correctly showed yesterday's
 * still-playable daily. Today now branches on `heroSelection.kind`: real
 * today's daily post-drop (unchanged "TODAY" framing); yesterday's
 * still-playable daily pre-drop mirrors Home's exact honest framing (the
 * "Yesterday's daily · <flavor>" badge, the "New daily drops 5:00 AM
 * Central" line, and a downgraded bare "Race" CTA - never "Race today's
 * daily" when it isn't); and the "default" kind (no daily anywhere in the
 * catalog) renders its own explicit empty state rather than ever showing the
 * fallback challenge as if it were a daily. Owner-proxy ruling (2026-07-19
 * council): Today and Yesterday briefly rendering the identical board
 * pre-drop is intentional, not a redundancy bug - pre-drop, the current
 * daily genuinely IS yesterday's, so the two tabs agreeing is correct.
 * Yesterday keeps its own independent `yesterdaysDaily` lookup (no fallback
 * of its own): a genuine daily catalog gap there is expected (spec: "can
 * happen; not a stub") and renders its own graceful empty state.
 *
 * FB-4 (council 2026-07-19, owner decision 10, "path comparison": Yes) -
 * Today/Yesterday's daily board now DOES disclose a per-run path, same rule
 * as Challenge Detail's `LeaderboardList` (invariant 5: "paths stay hidden
 * until YOU'VE played" - the viewer, not each row's own player). `pathsUnlocked`
 * below is `Boolean(ownPlacement)` - the viewer's own placement row on
 * THIS board, i.e. a completed run on the currently-shown daily; a DNF alone
 * never unlocks it (invariant 2 - only a completion counts as "played").
 * Deliberately duplicates `LeaderboardList`'s row markup/CSS classes
 * (`.path-disclosure`/`.winning-path`) here rather than importing that
 * component, matching this file's pre-existing precedent of keeping its own
 * inline `.board-snippet`/`.board-dnf-section` markup in lockstep with
 * Detail's by hand (see that component's own doc comment) rather than a
 * shared abstraction. DNF rows never get the affordance - `ChallengeBoardDnfRow`
 * carries no `runId` to disclose, so the absence is structural, not a
 * separate check. The actual disclosure request now runs through the
 * server's own viewer-finished guard (`getPublicRunPath`, extended this
 * same package) - client-side `pathsUnlocked` is UX gating, not the real
 * access boundary.
 *
 * The trend drill-down (tapping your own ranked row) is the one place the
 * spec's "placement + time · clicks" (invariant 1) suffices on its own,
 * without a path - implemented as the simplest invariant-1-compliant option
 * available without a new endpoint: it looks up the viewer's last 3 daily
 * challenges from the catalog already in hand and re-fetches each one's
 * existing `getChallengeBoard` (already built in Increment 3), rather than
 * adding a bespoke per-account detail endpoint. At friend-scale (a handful
 * of dailies a week) this is 3 small reads, not a real cost - documented
 * here as a deliberate scope choice.
 */
export default function Boards({
  apiClient,
  challenges,
  heroSelection,
  identityAccountId,
  initialSegment = "today",
  onDisclosePath,
  onRaceChallenge,
  raceBusy,
  runPaths,
  todayCentral,
}: {
  apiClient: VWikiRaceApiClient;
  challenges: Challenge[];
  // PKG-01: AppShell's `homeHero` - the same kind-aware selection Home's
  // hero reads, not a Boards-local re-derivation. `null` while the catalog
  // is still loading (or is genuinely empty).
  heroSelection: HomeHeroSelection | null;
  identityAccountId: string | null;
  initialSegment?: BoardsSegment;
  // FB-4: same `onDisclosePath`/`runPaths` App.tsx already wires up for
  // Challenge Detail - one App.tsx-owned cache/dedup (`requestedPaths`,
  // `runPaths`), not a Boards-local reimplementation.
  onDisclosePath: (runId: string) => void;
  onRaceChallenge: (challengeId: string) => void;
  raceBusy: boolean;
  runPaths: Record<string, ServerPathStep[]>;
  todayCentral: string;
}) {
  const [segment, setSegment] = useState<BoardsSegment>(initialSegment);
  // Bug B: the segment control scrolls horizontally on narrow widths (see
  // styles.css) rather than compressing labels, which means a segment
  // picked programmatically (initialSegment deep-link) or by tap can start
  // out scrolled offscreen. Keep the active tab reachable/visible by
  // scrolling it into view whenever the active segment changes.
  const segmentButtonRefs = useRef<Partial<Record<BoardsSegment, HTMLButtonElement | null>>>({});
  // PKG-10: an inert spacer after the last segment (styles.css) so the
  // static right-edge fade never lands on a real, fully-visible "Lifetime"
  // label - see the ref's own usage below for why it needs a scroll nudge
  // of its own.
  const segmentSpacerRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    // Optional-chained on the method itself, not just the element: jsdom
    // (this repo's test environment) doesn't implement scrollIntoView at
    // all, and some older/embedded browsers omit it too.
    segmentButtonRefs.current[segment]?.scrollIntoView?.({
      behavior: "smooth",
      block: "nearest",
      inline: "nearest",
    });
    // PKG-10: "nearest" stops the instant the tapped button's trailing edge
    // touches the scrollport's edge - it has no reason to also reveal the
    // inert spacer that follows the last segment, so on its own it would
    // leave the static edge-fade (styles.css) overlapping real "Lifetime"
    // glyphs even though nothing more is left to scroll. Only the last
    // segment can ever sit at the true scroll end, so only it needs the
    // extra nudge - scrolling the spacer (not the label) the rest of the
    // way there so the fade lands on empty space instead.
    if (segment === ALL_SEGMENTS[ALL_SEGMENTS.length - 1]) {
      segmentSpacerRef.current?.scrollIntoView?.({
        behavior: "smooth",
        block: "nearest",
        inline: "nearest",
      });
    }
  }, [segment]);

  const [board, setBoard] = useState<ChallengeBoardResponse>(EMPTY_BOARD);
  const [trends, setTrends] = useState<BoardsTrendsResponse | null>(null);
  // F6: a failed trends fetch is its own state, distinct from "still
  // loading" and from a genuine zero-ranked response - never silently
  // reused as the empty state. Scoped to the segment that produced it so a
  // segment switch doesn't show a stale error from a different window.
  const [trendsErrorSegment, setTrendsErrorSegment] = useState<TrendSegment | null>(null);
  const [trendsRetryToken, setTrendsRetryToken] = useState(0);
  const [ownRowExpanded, setOwnRowExpanded] = useState(false);
  const [recentDailyDetails, setRecentDailyDetails] = useState<RecentDailyDetail[]>([]);

  const yesterdayCentral = useMemo(
    () => previousCentralDate(todayCentral),
    [todayCentral],
  );
  // Same gap Home already lives with (spec: "The catalog only carries active
  // challenges") - a real "yesterday's daily" is often simply absent once
  // its day passes, including transiently while the catalog is still
  // loading. Home doesn't distinguish those two cases for its own yesterday
  // card either; Boards matches that precedent rather than inventing a new
  // loading state this increment.
  const yesterdaysDaily = useMemo(
    () => challenges.find((challenge) => dailyDateForChallenge(challenge) === yesterdayCentral) ?? null,
    [challenges, yesterdayCentral],
  );

  // PKG-01: Today never shows the "default" kind (the pre-redesign
  // arbitrary-fallback challenge) as if it were a daily - that's the exact
  // "TODAY / Moon -> Gravity" mislabeling the council flagged. A `null`
  // `activeChallenge` here (as opposed to a real `today-daily`/
  // `yesterday-daily` selection) is what drives the explicit empty state
  // below, and also correctly skips the board fetch effect for it.
  const todayHeroKind = heroSelection?.kind ?? null;
  const activeChallenge = isTrendSegment(segment)
    ? null
    : segment === "today"
      ? (todayHeroKind && todayHeroKind !== "default" ? heroSelection!.challenge : null)
      : yesterdaysDaily;
  // Owner-proxy ruling (2026-07-19 council): pre-drop, Today mirrors Home's
  // honest yesterday-daily framing rather than getting its own empty state -
  // Today and Yesterday briefly showing the identical board is intentional
  // (the current daily genuinely IS yesterday's pre-drop), not a redundancy
  // bug.
  const todayShowsYesterdayFraming = segment === "today" && todayHeroKind === "yesterday-daily";

  // QF-02: session-scoped cache for the one segment that's actually and
  // permanently closed data - "yesterday" can't change once the day has
  // passed. Deliberately narrower than the package's literal text (which
  // also named "finished trend windows"): 7d/30d/lifetime keep absorbing
  // the CURRENT session's own just-finished daily until midnight, so
  // caching those risks a player finishing today's race, flipping to
  // Boards, and not seeing their own fresh run in the rolling windows -
  // council flagged this independently (Judge A amendment 2, Judge B
  // amendment 3) and the binding ruling didn't override it. "Today" is
  // never cached (still-open data).
  const yesterdayBoardCache = useRef(new Map<string, ChallengeBoardResponse>());

  useEffect(() => {
    let cancelled = false;
    if (isTrendSegment(segment)) return;
    if (!activeChallenge) {
      setBoard(EMPTY_BOARD);
      return;
    }
    if (segment === "yesterday") {
      const cached = yesterdayBoardCache.current.get(activeChallenge.id);
      if (cached) {
        setBoard(cached);
        return;
      }
    }
    void apiClient.getChallengeBoard(activeChallenge.id)
      .then((response) => {
        if (cancelled) return;
        setBoard(response);
        if (segment === "yesterday") {
          yesterdayBoardCache.current.set(activeChallenge.id, response);
        }
      })
      .catch(() => {
        if (!cancelled) setBoard(EMPTY_BOARD);
      });
    return () => {
      cancelled = true;
    };
  }, [apiClient, segment, activeChallenge?.id]);

  useEffect(() => {
    let cancelled = false;
    if (!isTrendSegment(segment)) return;
    setTrendsErrorSegment(null);
    void apiClient.getBoardsTrends(TREND_WINDOW_PARAM[segment])
      .then((response) => {
        if (!cancelled) setTrends(response);
      })
      .catch(() => {
        // F6: an honest error state + Retry, never the fake "no one has
        // cleared the guard" empty state - that reads as real board data
        // when it's actually a fetch failure.
        if (!cancelled) setTrendsErrorSegment(segment);
      });
    return () => {
      cancelled = true;
    };
  }, [apiClient, segment, trendsRetryToken]);

  // Collapse the drill-down whenever the segment changes - it's scoped to
  // "your row on this specific window," not a standing UI state.
  useEffect(() => {
    setOwnRowExpanded(false);
    setRecentDailyDetails([]);
  }, [segment]);

  const recentDailyChallenges = useMemo(() => {
    return challenges
      .map((challenge) => ({ challenge, dailyDate: dailyDateForChallenge(challenge) }))
      .filter((entry): entry is { challenge: Challenge; dailyDate: string } =>
        entry.dailyDate !== null && entry.dailyDate <= todayCentral)
      .sort((left, right) => right.dailyDate.localeCompare(left.dailyDate))
      .slice(0, 3);
  }, [challenges, todayCentral]);

  useEffect(() => {
    let cancelled = false;
    if (!ownRowExpanded) return;
    if (!recentDailyChallenges.length) {
      setRecentDailyDetails([]);
      return;
    }
    setRecentDailyDetails(
      recentDailyChallenges.map(({ challenge, dailyDate }) => ({
        challengeId: challenge.id,
        dailyDate,
        status: "loading",
      })),
    );
    void Promise.all(
      recentDailyChallenges.map(({ challenge, dailyDate }) =>
        apiClient.getChallengeBoard(challenge.id)
          .then((response): RecentDailyDetail => {
            const placement = identityAccountId
              ? response.placements.find((row) => row.accountId === identityAccountId)
              : undefined;
            if (placement) {
              return {
                challengeId: challenge.id,
                dailyDate,
                status: "placement",
                placement: placement.placement,
                elapsedMs: placement.elapsedMs,
                clickCount: placement.clickCount,
              };
            }
            const dnf = identityAccountId
              ? response.dnfs.find((row) => row.accountId === identityAccountId)
              : undefined;
            if (dnf) {
              return {
                challengeId: challenge.id,
                dailyDate,
                status: "dnf",
                elapsedMs: dnf.elapsedMs,
                clickCount: dnf.clickCount,
              };
            }
            return { challengeId: challenge.id, dailyDate, status: "not-played" };
          })
          .catch((): RecentDailyDetail => ({ challengeId: challenge.id, dailyDate, status: "not-played" })),
      ),
    ).then((details) => {
      if (!cancelled) setRecentDailyDetails(details);
    });
    return () => {
      cancelled = true;
    };
  }, [apiClient, identityAccountId, ownRowExpanded, recentDailyChallenges]);

  const boardMatchesActiveChallenge = Boolean(activeChallenge) && board.challengeId === activeChallenge?.id;
  const placements = boardMatchesActiveChallenge ? board.placements : [];
  const dnfs = boardMatchesActiveChallenge ? board.dnfs : [];

  const ownPlacement = identityAccountId
    ? placements.find((row) => row.accountId === identityAccountId) ?? null
    : null;
  // Invariant 2: a DNF (below) never counts as "finished" - only a
  // completed placement row does, so the CTA stays up through a DNF retry.
  const showRaceCta = segment === "today" && Boolean(activeChallenge) && !ownPlacement;
  // FB-4 (invariant 5): "played" means finished THIS board's challenge -
  // same completed-placement-row test `showRaceCta` above already uses, so
  // the two can't independently drift on what counts as "played".
  const pathsUnlocked = Boolean(ownPlacement);
  // PKG-01: pre-drop, Today's badge mirrors Home's exact "Yesterday's
  // daily · <flavor>" prefix (never a bare flavor pill that reads as if
  // today's real daily) - see Home.tsx's identically-shaped `flavorBadge`.
  // PKG-07: both branches now go through the same shared
  // `dailyFlavorBadgeText` Home/Preview also use, so the "Daily #N" suffix
  // can't independently drift between screens.
  const flavorBadge = activeChallenge?.dailyFeature
    ? dailyFlavorBadgeText(activeChallenge.dailyFeature, todayShowsYesterdayFraming ? "yesterday" : "today")
    : null;

  const trendWindow = isTrendSegment(segment) ? TREND_WINDOW_PARAM[segment] : null;
  const trendMatchesSegment = trendWindow !== null && trends?.window === trendWindow;
  const trendHasError = isTrendSegment(segment) && trendsErrorSegment === segment;
  const rankedRows = trendMatchesSegment ? trends!.ranked : [];
  const unrankedRows = trendMatchesSegment ? trends!.unranked : [];
  // F5: `guard` always reads off the server-echoed `trends.guard` - never a
  // client-side re-derivation. `null` while this segment's trends haven't
  // loaded (or errored) yet, so guard-dependent copy just doesn't render
  // rather than showing a guessed number.
  const guard = trendMatchesSegment ? trends!.guard : null;
  // PKG-14 (direct owner feedback): Lifetime-only "Everyone who's played"
  // roster - the server never populates `roster` for 7d/30d at all, but the
  // `segment === "lifetime"` check below is the belt-and-suspenders
  // Lifetime-only guard the spec calls for, independent of that.
  const roster = trendMatchesSegment ? trends!.roster : undefined;

  /**
   * PKG-10 (owner-proxy ruling: keep role=tab/tablist, complete the
   * pattern): roving tabindex + ArrowLeft/Right, matching the WAI-ARIA tabs
   * pattern's "automatic activation" model - moving focus with the arrow
   * keys selects the newly-focused segment immediately, same as a tap.
   * Wraps at both ends.
   */
  function handleSegmentKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const currentIndex = ALL_SEGMENTS.indexOf(segment);
    const delta = event.key === "ArrowRight" ? 1 : -1;
    const nextSegment =
      ALL_SEGMENTS[(currentIndex + delta + ALL_SEGMENTS.length) % ALL_SEGMENTS.length];
    setSegment(nextSegment);
    segmentButtonRefs.current[nextSegment]?.focus();
  }

  return (
    // PKG-14 (direct owner feedback): user-visible "Boards" -> "Stats"
    // rename only - the mode key, file, and every internal identifier
    // (BoardsSegment, getBoardsTrends, .boards-mode, etc.) stay "boards".
    <section className="boards-mode leaderboard-panel" aria-label="Stats">
      <h2>Stats</h2>

      <div
        aria-label="Board period"
        className="board-segment-control"
        onKeyDown={handleSegmentKeyDown}
        role="tablist"
      >
        {ALL_SEGMENTS.map((key) => (
          <button
            aria-controls={BOARDS_SEGMENT_PANEL_ID}
            aria-selected={segment === key}
            className={segment === key ? "active" : undefined}
            id={boardsTabId(key)}
            key={key}
            onClick={() => setSegment(key)}
            ref={(el) => {
              segmentButtonRefs.current[key] = el;
            }}
            role="tab"
            tabIndex={segment === key ? 0 : -1}
            type="button"
          >
            {SEGMENT_LABEL[key]}
          </button>
        ))}
        {/* PKG-10: inert - scrollIntoView'd (never focused/tapped) so the
            static edge-fade (styles.css, Bug B) has empty space to land on
            once the row's actually scrolled all the way to "Lifetime". */}
        <span aria-hidden="true" className="board-segment-spacer" ref={segmentSpacerRef} />
      </div>

      <div
        aria-labelledby={boardsTabId(segment)}
        id={BOARDS_SEGMENT_PANEL_ID}
        role="tabpanel"
      >
      {isTrendSegment(segment) ? (
        trendHasError ? (
          // F6: an honest error state + Retry - never the "no one has
          // cleared the guard" empty state below, which is reserved for a
          // real zero-ranked response.
          <div className="board-trend-error">
            <p className="error-banner" role="alert">Couldn&apos;t load this trend.</p>
            <button onClick={() => setTrendsRetryToken((value) => value + 1)} type="button">
              Retry
            </button>
          </div>
        ) : !trendMatchesSegment || guard === null ? (
          <p className="muted">Loading trend…</p>
        ) : (
          <>
            <p className="board-trend-subheader muted">
              Rolling {TREND_PROSE_LABEL[segment]} · ranked by average placement · play {"≥"}{guard} dailies to rank
            </p>

            <section className="board-snippet" aria-label={`${SEGMENT_LABEL[segment]} rolling trend`}>
              {rankedRows.length ? (
                <ol>
                  {rankedRows.map((row, index) => {
                    const isYou = row.accountId === identityAccountId;
                    return (
                      <li className={isYou ? "is-you" : undefined} key={row.accountId}>
                        <button
                          aria-expanded={isYou ? ownRowExpanded : undefined}
                          className="trend-row-toggle"
                          disabled={!isYou}
                          onClick={isYou ? () => setOwnRowExpanded((value) => !value) : undefined}
                          type="button"
                        >
                          <span className="rank">{index + 1}.</span>
                          <span className="trend-row-name">
                            {row.displayName ?? "Unknown"}
                            {isYou ? <span className="muted"> (you)</span> : null}
                          </span>
                          <span>
                            avg #{row.avgPlacement.toFixed(1)} ({row.playedCount} dailies){" "}
                            <span aria-label={trendArrowLabel(row)} className="trend-arrow muted">
                              {trendArrowGlyph(row)}
                            </span>
                          </span>
                        </button>
                        {isYou && ownRowExpanded ? (
                          <ol className="board-trend-drilldown muted" aria-label="Recent dailies">
                            {recentDailyDetails.length ? (
                              recentDailyDetails.map((detail) => (
                                <li key={detail.challengeId}>
                                  <span>{detail.dailyDate}</span>
                                  <span>{recentDailyDetailText(detail)}</span>
                                </li>
                              ))
                            ) : (
                              <li>No recent dailies yet.</li>
                            )}
                          </ol>
                        ) : null}
                      </li>
                    );
                  })}
                </ol>
              ) : (
                // PKG-11 (council 2026-07-19, owner-proxy ruling): the old
                // "No one has cleared the ranking guard yet." leaked internal
                // jargon ("ranking guard" is a design-note term, never
                // in-app copy) - reworded to the warm, progress-framed voice
                // Boards' own unranked section already uses below. Reads off
                // the same server-echoed `guard` this branch's own presence
                // already guarantees is non-null (F5 - never hardcode it).
                <p className="muted">
                  Nobody&apos;s played enough dailies to rank yet — play {guard} to show up here.
                </p>
              )}
            </section>

            {unrankedRows.length ? (
              <section className="board-snippet board-trend-unranked muted" aria-label="Not yet ranked">
                <h3>Not yet ranked</h3>
                <ol>
                  {unrankedRows.map((row) => {
                    const isYou = row.accountId === identityAccountId;
                    return (
                      <li key={row.accountId}>
                        <span>
                          {row.displayName ?? "Unknown"}
                          {isYou ? <span className="muted"> (you)</span> : null}
                        </span>
                        <span>{row.playedCount}/{guard} dailies</span>
                      </li>
                    );
                  })}
                </ol>
              </section>
            ) : null}

            {/* PKG-14 (direct owner feedback, 2026-07-19: "lifetime/board
                stats isn't thorough - doesn't include other (fran,
                lollerskates) that have played"): Lifetime-only census of
                EVERY board-visible account across ANY challenge, daily or
                custom - independent of the ranked-trends participation
                guard entirely, so a custom-only racer (invisible to
                `listDailyTrends`) still shows up here. Counts, not a
                leaderboard (owner-proxy ruling: the time+clicks invariant
                governs ranked board rows, not this roster) - no time is
                ever shown, only races/finishes/wins. */}
            {segment === "lifetime" && roster ? (
              <section className="board-snippet board-roster muted" aria-label="Everyone who's played">
                <h3>Everyone who&apos;s played</h3>
                <p className="board-roster-explainer muted">
                  Daily rankings need {guard} played dailies — every racer counts here.
                </p>
                {roster.length ? (
                  <ol>
                    {roster.map((row) => {
                      const isYou = row.accountId === identityAccountId;
                      return (
                        <li key={row.accountId}>
                          <span>
                            {row.displayName ?? "Unknown"}
                            {isYou ? <span className="muted"> (you)</span> : null}
                          </span>
                          <span>{rosterCountsText(row)}</span>
                        </li>
                      );
                    })}
                  </ol>
                ) : (
                  <p className="muted">Nobody has raced yet.</p>
                )}
              </section>
            ) : null}
          </>
        )
      ) : segment === "today" && todayHeroKind === "default" ? (
        // PKG-01: the "default" kind means no daily exists anywhere in the
        // catalog (neither today's nor yesterday's) - Today says so
        // honestly rather than silently racing the pre-redesign
        // arbitrary-fallback challenge under an unqualified "TODAY" label
        // (the exact mislabeling the council flagged - a random user
        // challenge shown as "TODAY / Moon -> Gravity" with a "Race today's
        // daily" CTA).
        <p className="muted">No daily challenge right now. Check Challenges for something else to race.</p>
      ) : !activeChallenge ? (
        <p className="muted">
          {segment === "yesterday"
            ? "Yesterday's daily isn't available."
            : "Loading today's daily…"}
        </p>
      ) : (
        <>
          <div className="board-segment-header challenge-route">
            <div className="challenge-meta">
              {todayShowsYesterdayFraming ? (
                // Owner-proxy ruling: pre-drop, Today mirrors Home's exact
                // honest framing - the combined "Yesterday's daily ·
                // <flavor>" badge stands alone, never alongside an
                // unqualified "Today" kicker (see Home.tsx's identically-
                // shaped badge).
                flavorBadge ? <span className="daily-badge">{flavorBadge}</span> : null
              ) : (
                <>
                  <span>{segment === "today" ? "Today" : "Yesterday"}</span>
                  {flavorBadge ? <span className="daily-badge">{flavorBadge}</span> : null}
                </>
              )}
            </div>
            <strong>
              {activeChallenge.start.title} <span className="route-arrow">{"→"}</span>{" "}
              {activeChallenge.target.title}
            </strong>
          </div>

          {todayShowsYesterdayFraming ? (
            <p className="ritual-line muted">New daily drops 5:00 AM Central.</p>
          ) : null}

          <section
            className="board-snippet"
            aria-label={`${segment === "today" && !todayShowsYesterdayFraming ? "Today's" : "Yesterday's"} board`}
          >
            {placements.length ? (
              <ol>
                {placements.map((row) => {
                  const isYou = row.accountId === identityAccountId;
                  return (
                    <li className={isYou ? "is-you" : undefined} key={row.accountId}>
                      <span className="rank">#{row.placement}</span>
                      <span>
                        {row.displayName ?? "Unknown"}
                        {isYou ? <span className="muted"> (you)</span> : null}
                      </span>
                      <span>{formatTimeAndClicks(row.elapsedMs, row.clickCount)}</span>
                      {/* FB-4: same disclosure affordance as Challenge
                          Detail's LeaderboardList - a compact "View winning
                          path" link on the row, not a new column. Any
                          placement row (not just the viewer's own), once
                          `pathsUnlocked`; DNF rows never get one (see the
                          DNF section below - no `runId` to hang it off). */}
                      {pathsUnlocked && row.runId ? (
                        <details
                          className="path-disclosure"
                          onToggle={(event) => {
                            if (event.currentTarget.open) onDisclosePath(row.runId!);
                          }}
                        >
                          <summary>View winning path</summary>
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
                  );
                })}
              </ol>
            ) : (
              <p className="muted">No completed runs yet.</p>
            )}
          </section>

          <section className="board-snippet board-dnf-section muted" aria-label="DNF">
            {/* QF-05: spelled out - matches RaceResults' own kicker
                ("DNF — Did not finish") and LeaderboardList's sibling
                section, so a first-time player isn't left to guess. */}
            <h3>DNF — Did not finish</h3>
            {dnfs.length ? (
              <ol>
                {dnfs.map((row) => {
                  const isYou = row.accountId === identityAccountId;
                  return (
                    <li className={isYou ? "is-you" : undefined} key={row.accountId}>
                      {/* QF-04: every row in this section is a genuine DNF
                          (sourced from `dnfs`, never merged with completed-
                          unranked rows), so `.rank-dnf` applies
                          unconditionally - salmon, never CTA teal. */}
                      <span className="rank rank-dnf">{"—"}</span>
                      <span>
                        {row.displayName ?? "Unknown"}
                        {isYou ? <span className="muted"> (you)</span> : null}
                      </span>
                      <span>{formatTimeAndClicks(row.elapsedMs, row.clickCount)}</span>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <p>No DNFs.</p>
            )}
          </section>

          {!pathsUnlocked ? (
            <p className="muted board-footnote">Paths hidden until you&apos;ve played.</p>
          ) : null}

          {/* PKG-10: below the leaderboard/DNF/footnote, matching
              mockup-boards-trends' "Daily view" bottom-of-screen CTA
              placement (council: see-the-board-then-commit order) - it used
              to render right under the badge/title, above any board data at
              all. */}
          {showRaceCta ? (
            <div className="player-gate">
              {/* PKG-04: opens the preview only (non-committal), same class
                  as Home's hero and Detail's "Race this" - see Home.tsx's
                  doc comment on the identical treatment. PKG-01: the label
                  itself downgrades to a bare "Race" whenever the shown
                  challenge isn't actually today's daily - matches Home's
                  identical downgrade. */}
              <button
                className="race-preview-button"
                disabled={raceBusy}
                onClick={() => onRaceChallenge(activeChallenge.id)}
                type="button"
              >
                {todayShowsYesterdayFraming ? `${"▶"} Race` : `${"▶"} Race today's daily`}
              </button>
            </div>
          ) : null}
        </>
      )}
      </div>
    </section>
  );
}

/**
 * PKG-14: the roster row's count summary - "races started / finishes /
 * wins", never a time (owner-proxy ruling: this is a census, not a
 * leaderboard - the time+clicks invariant doesn't apply to it).
 */
function rosterCountsText(row: AllPlayersRosterEntry): string {
  return `${row.racesStarted} ${row.racesStarted === 1 ? "race" : "races"} · ` +
    `${row.finishes} ${row.finishes === 1 ? "finish" : "finishes"} · ` +
    `${row.wins} ${row.wins === 1 ? "win" : "wins"}`;
}

function recentDailyDetailText(detail: RecentDailyDetail): string {
  switch (detail.status) {
    case "loading":
      return "…";
    case "placement":
      return `#${detail.placement} · ${formatTimeAndClicks(detail.elapsedMs, detail.clickCount)}`;
    case "dnf":
      return `DNF · ${formatTimeAndClicks(detail.elapsedMs, detail.clickCount)}`;
    case "not-played":
      return "Not played";
  }
}

/**
 * F3: lower `avgPlacement` is better, so a current average lower than
 * `prevAvgPlacement` is an improvement (▲). `–` covers both "nothing to
 * compare" (unranked/absent in the previous window, or lifetime - which
 * never gets a `prevAvgPlacement` at all, per the spec's "no arrow on
 * lifetime") and a genuine tie.
 */
function trendArrowGlyph(row: BoardsTrendRankedEntry): "▲" | "▼" | "–" {
  const prevAvgPlacement = row.prevAvgPlacement ?? null;
  if (prevAvgPlacement === null) return "–";
  if (row.avgPlacement < prevAvgPlacement) return "▲";
  if (row.avgPlacement > prevAvgPlacement) return "▼";
  return "–";
}

function trendArrowLabel(row: BoardsTrendRankedEntry): string {
  const prevAvgPlacement = row.prevAvgPlacement ?? null;
  if (prevAvgPlacement === null) return "No previous window to compare";
  if (row.avgPlacement < prevAvgPlacement) return "Improved vs. previous window";
  if (row.avgPlacement > prevAvgPlacement) return "Declined vs. previous window";
  return "No change vs. previous window";
}
