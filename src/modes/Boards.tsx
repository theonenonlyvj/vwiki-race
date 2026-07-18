import { useEffect, useMemo, useState } from "react";
import { dailyDateForChallenge, previousCentralDate } from "../domain/challengeSelection";
import { dailyFlavorLabel } from "../domain/dailyEditorial";
import { formatTimeAndClicks } from "../domain/formatting";
import type { Challenge } from "../domain/types";
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

const TREND_WINDOW_PARAM: Record<TrendSegment, BoardsTrendWindow> = {
  "7d": "7",
  "30d": "30",
  lifetime: "lifetime",
};

const EMPTY_BOARD: ChallengeBoardResponse = { challengeId: "", placements: [], dnfs: [] };

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
 * "Today" reuses `todaysHeroChallenge` - the exact same daily-or-fallback
 * challenge AppShell already computed for Home's hero - rather than
 * re-deriving "today's daily" from the catalog independently, so the two
 * screens can never disagree about which challenge is "today's." Yesterday
 * has no such fallback: a genuine daily catalog gap there is expected
 * (spec: "can happen; not a stub") and renders its own graceful empty state.
 *
 * Unlike the old `LeaderboardList`/Detail's board, Boards never discloses a
 * per-run path this increment (spec: "Paths hidden until you've played" -
 * and Boards rows must not expose path disclosure at all) - the board
 * endpoint's rows don't even carry a `runId` to disclose. The trend
 * drill-down (tapping your own ranked row) is the one exception the spec
 * allows ("placement + time · clicks", invariant 1) - implemented as the
 * simplest invariant-1-compliant option available without a new endpoint:
 * it looks up the viewer's last 3 daily challenges from the catalog already
 * in hand and re-fetches each one's existing `getChallengeBoard` (already
 * built in Increment 3), rather than adding a bespoke per-account detail
 * endpoint. At friend-scale (a handful of dailies a week) this is 3 small
 * reads, not a real cost - documented here as a deliberate scope choice.
 */
export default function Boards({
  apiClient,
  challenges,
  identityAccountId,
  initialSegment = "today",
  onRaceChallenge,
  raceBusy,
  todaysHeroChallenge,
  todayCentral,
}: {
  apiClient: VWikiRaceApiClient;
  challenges: Challenge[];
  identityAccountId: string | null;
  initialSegment?: BoardsSegment;
  onRaceChallenge: (challengeId: string) => void;
  raceBusy: boolean;
  todaysHeroChallenge: Challenge | null;
  todayCentral: string;
}) {
  const [segment, setSegment] = useState<BoardsSegment>(initialSegment);
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

  const activeChallenge = isTrendSegment(segment)
    ? null
    : segment === "today" ? todaysHeroChallenge : yesterdaysDaily;

  useEffect(() => {
    let cancelled = false;
    if (isTrendSegment(segment)) return;
    if (!activeChallenge) {
      setBoard(EMPTY_BOARD);
      return;
    }
    void apiClient.getChallengeBoard(activeChallenge.id)
      .then((response) => {
        if (!cancelled) setBoard(response);
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
  const showRaceCta = segment === "today" && Boolean(todaysHeroChallenge) && !ownPlacement;
  const flavorBadge = activeChallenge?.dailyFeature
    ? dailyFlavorLabel(activeChallenge.dailyFeature.flavor)
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

  return (
    <section className="boards-mode leaderboard-panel" aria-label="Boards">
      <h2>Boards</h2>

      <div className="board-segment-control" role="tablist" aria-label="Board period">
        {ALL_SEGMENTS.map((key) => (
          <button
            aria-selected={segment === key}
            className={segment === key ? "active" : undefined}
            key={key}
            onClick={() => setSegment(key)}
            role="tab"
            type="button"
          >
            {SEGMENT_LABEL[key]}
          </button>
        ))}
      </div>

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
              Rolling {SEGMENT_LABEL[segment]} · ranked by average placement · play {"≥"}{guard} dailies to rank
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
                          <span>
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
                <p className="muted">No one has cleared the ranking guard yet.</p>
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
          </>
        )
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
              <span>{segment === "today" ? "Today" : "Yesterday"}</span>
              {flavorBadge ? <span className="daily-badge">{flavorBadge}</span> : null}
            </div>
            <strong>
              {activeChallenge.start.title} <span className="route-arrow">{"->"}</span>{" "}
              {activeChallenge.target.title}
            </strong>
          </div>

          {showRaceCta ? (
            <div className="player-gate">
              <button
                className="start-race-button"
                disabled={raceBusy}
                onClick={() => onRaceChallenge(activeChallenge.id)}
                type="button"
              >
                {"▶"} Race today's daily
              </button>
            </div>
          ) : null}

          <section className="board-snippet" aria-label={`${segment === "today" ? "Today's" : "Yesterday's"} board`}>
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
                    </li>
                  );
                })}
              </ol>
            ) : (
              <p className="muted">No completed runs yet.</p>
            )}
          </section>

          <section className="board-snippet board-dnf-section muted" aria-label="DNF">
            <h3>DNF</h3>
            {dnfs.length ? (
              <ol>
                {dnfs.map((row) => {
                  const isYou = row.accountId === identityAccountId;
                  return (
                    <li className={isYou ? "is-you" : undefined} key={row.accountId}>
                      <span className="rank">{"—"}</span>
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

          <p className="muted board-footnote">Paths hidden until you&apos;ve played.</p>
        </>
      )}
    </section>
  );
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
