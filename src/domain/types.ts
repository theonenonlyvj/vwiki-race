import type { DailyFeature } from "./dailyEditorial";

export type AccountStatus = "ghost" | "claimed" | "merged";
export type ChallengeMode = "solo" | "daily";
export type Ruleset = "ranked_classic";
export type RunStatus = "active" | "completed" | "abandoned";
// RC-01: one explicit signal for "can the challenge catalog be used right
// now", shared by App.tsx (derivation), Home.tsx, and AppShell.tsx (render).
// 'ready' takes precedence over 'failed' whenever challenges.length > 0 - a
// later background refetch failure (focus/visibilitychange/daily-drop timer)
// must never demote a still-usable, previously-loaded catalog back to a
// dead-end "failed" screen (see App.tsx's catalogStatus derivation).
export type CatalogStatus = "loading" | "failed" | "ready";

export interface AuthorizedAccount {
  accountId: string;
  displayName: string;
  status: "ghost" | "claimed";
  aliases: string[];
}

export interface RunTransition {
  runId: string;
  clickCount: number;
  runStatus: "active" | "completed";
  completedAt?: string;
  elapsedMs?: number;
}

export interface LeaderboardContext {
  isPersonalBest: boolean;
  rank: number | null;
}

export interface AbandonRunTransition {
  runId: string;
  runStatus: "abandoned" | "completed";
  completedAt?: string;
  // PKG-03 (council 2026-07-19): populated for a genuine "abandoned" outcome
  // too, not just "already_completed" - the server's own just-persisted
  // `runs.elapsed_ms` (computed from `abandoned_at - started_at` at the
  // moment the abandon was PROCESSED), never the client's pre-call timer
  // snapshot. Closes the header/board-row time mismatch at the source
  // (useRaceController's `endRun` + App.tsx's `confirmEndRun` prefer this
  // over the client snapshot when present) instead of patching it after a
  // second, separate leaderboard refetch.
  elapsedMs?: number;
  outcome?: "abandoned" | "already_completed" | "legacy_recovery_abandoned";
}

export interface VGamesAccount {
  accountId: string;
  displayName: string;
  status: AccountStatus;
  token: string;
}

export interface ArticleRef {
  title: string;
  pageId?: number;
}

export interface ChallengeCreator {
  accountId: string;
  displayName: string;
  identityStatus: AccountStatus;
}

export interface Challenge {
  id: string;
  label?: string;
  sortOrder?: number;
  isActive?: boolean;
  dateKey?: string;
  mode: ChallengeMode;
  start: ArticleRef;
  target: ArticleRef;
  ruleset: Ruleset;
  origin?: "manual" | "daily";
  dailyDate?: string | null;
  dailyFeature?: DailyFeature | null;
  source: "curated" | "wikipedia_random";
  createdBy?: ChallengeCreator;
}

export interface ArticleLink {
  href: string;
  title: string;
  pageId?: number;
  anchorText: string;
  sourceSection?: string;
}

declare const sanitizedWikipediaHtmlBrand: unique symbol;
export type SanitizedWikipediaHtml = string & {
  readonly [sanitizedWikipediaHtmlBrand]: true;
};

export interface Article {
  pageId: number;
  canonicalTitle: string;
  revisionId: number;
  sourceUrl: string;
  attributionUrl: string;
  sanitizedHtml: SanitizedWikipediaHtml;
  links: ArticleLink[];
  attribution: string;
}

export interface PathPage {
  pageId?: number;
  canonicalTitle: string;
}

export interface PathEntry {
  sourcePage: PathPage;
  clickedAnchorText: string;
  requestedTitle: string;
  resolvedDestination: PathPage;
  timestamp: number;
  clickNumber: number;
}

export interface RunResult {
  challenge: Challenge;
  accountId: string;
  clicks: number;
  elapsedMs: number;
  path: PathEntry[];
  status: Extract<RunStatus, "completed" | "abandoned">;
}

export interface LeaderboardEntry {
  accountId: string;
  displayName: string;
  challengeId: string;
  clicks: number;
  elapsedMs: number;
  submittedAt: number;
  pathHash: string;
  pendingSync?: boolean;
}

export interface RunRecord {
  id: string;
  accountId: string;
  challengeId: string;
  mode: ChallengeMode;
  status: Extract<RunStatus, "completed" | "abandoned">;
  start: PathPage;
  target: PathPage;
  clicks: number;
  elapsedMs: number;
  createdAt: number;
  completedAt?: number;
  abandonedAt?: number;
  path: PathEntry[];
}

export interface CountStat {
  title: string;
  count: number;
}

export interface JumpStat {
  sourceTitle: string;
  destinationTitle: string;
  count: number;
}

export interface StatsSummary {
  totals: {
    runs: number;
    completed: number;
    abandoned: number;
    bestClicks: number | null;
    averageClicks: number;
    averageElapsedMs: number;
  };
  topStarts: CountStat[];
  topTargets: CountStat[];
  mostVisited: CountStat[];
  bridgePages: CountStat[];
  commonJumps: JumpStat[];
}

export interface ServerPathStep {
  stepNumber: number;
  sourceTitle: string;
  clickedAnchorText: string;
  destinationTitle: string;
  destinationPageId?: number;
  elapsedSinceStartMs?: number;
  createdAt: string;
}

/**
 * GR-1 ("View graph"): one hop within `ChallengePathRunEntry.steps`, shaped
 * 1:1 with the visualize-graph prototype's `graph-fixture.json` (and the
 * component's own local `ChallengePathStep`, src/components/
 * ChallengePathGraph.tsx) - a deliberately narrower shape than
 * `ServerPathStep` (just the two titles + hop index), since the merged
 * graph only ever needs the article chain, not click provenance/timing.
 */
export interface ChallengePathStepEntry {
  n: number;
  from: string;
  to: string;
}

/**
 * GR-1: one counted run's full path, for `GET
 * /api/v2/challenges/{id}/paths` - the bulk source `ChallengePathGraph`
 * merges into one graph. One entry per account's best counted run on the
 * challenge (same best-attempt dedup `listChallengePlacements`/
 * `listChallengeDnfs` already use for the public board - a repeat
 * completion or DNF would otherwise draw the same player twice), ordered
 * finishers-fastest-first then DNFs. Gated server-side by the same FB-4
 * viewer-finished guard `getPublicRunPath` uses (d1TrackingRepository.ts).
 */
export interface ChallengePathRunEntry {
  player: string;
  status: "completed" | "abandoned";
  elapsedMs: number;
  clicks: number;
  steps: ChallengePathStepEntry[];
}

/**
 * GR-1: `totalRuns` is the real (uncapped) count of eligible deduped runs
 * on the challenge - `runs` itself is capped at `CHALLENGE_PATHS_LIMIT`
 * (d1TrackingRepository.ts) so a very popular challenge's graph stays
 * legible instead of drawing dozens of strands.
 */
export interface ChallengePathsResult {
  runs: ChallengePathRunEntry[];
  totalRuns: number;
  /**
   * "I gave up" solution view, case (b)/(c) (owner spec, 2026-08-02): when
   * `runs` is empty (nobody has a counted finish or DNF strand yet) but the
   * viewer's own disclosure guard passed (finished OR peeked - see
   * `viewerFinishedOrPeekedChallengeExistsSql`), this carries the challenge's
   * stored `reference_path` (a bounded forward search computed at daily-drop
   * time, `dailyCandidateEvaluator.ts`'s `findReferencePath`) as a plain
   * title chain (start..target inclusive), or `null` when no reference path
   * was ever computed/stored - the client's "No one - human or machine - has
   * cracked this one yet." case. Always `undefined` when `runs` is
   * non-empty: a real finisher's path always wins over the reference route
   * (case (a) takes priority over (b)), so the field is only meaningful in
   * the zero-strand branch.
   */
  referencePath?: string[] | null;
}

/** "I gave up" flow (owner spec, 2026-08-02): the durable outcome of
 *  `POST /api/v2/challenges/{id}/give-up` - always `peeked: true` on
 *  success (a rejection throws instead; see `give_up_not_eligible`/
 *  `give_up_already_finished`). */
export interface GiveUpChallengeResult {
  challengeId: string;
  peeked: true;
}

export interface ServerLeaderboardRow {
  runId: string;
  challengeId: string;
  accountId: string;
  displayName: string;
  status: "completed" | "abandoned";
  isRepeatRun: boolean;
  startedAt: string;
  elapsedMs: number;
  clickCount: number;
  completedAt?: string;
  abandonedAt?: string;
  protocolVersion: 1 | 2;
}

export interface AccountStats {
  totals: {
    attempts: number;
    completed: number;
    abandoned: number;
    timedCompleted: number;
    totalClicks: number;
    bestClicks: number | null;
    bestElapsedMs: number | null;
    averageClicks: number;
    averageElapsedMs: number;
  };
  topStarts: CountStat[];
  topTargets: CountStat[];
  mostVisited: CountStat[];
  /**
   * Increment 4 (UX redesign spec §Data requirements - "Streaks"): count of
   * consecutive Central dates, ending today or yesterday, on which this
   * account has ≥1 eligible completed OR board-visible-DNF daily run (F2).
   * Silent reset on a missed day (no grace period) - see
   * `getAccountDailyStreak`.
   */
  dailyStreak: number;
  /**
   * Increment 4 (spec §Data requirements - "Rolling avg placement" +
   * §Boards - the 7d/30d/lifetime participation guard); generalized by
   * FB-10 (owner ruling, 2026-07-20) from daily-only to every challenge:
   * this account's own 30-day rolling-placement standing across ALL
   * challenges played (created within that window), guard-gated the same
   * way Boards' trend segments are. `avgPlacement` is only meaningful when
   * `ranked` is true; a below-guard account still gets `playedCount` so
   * Home/You can render `trendGuardProgressCopy` (domain/dailyTrends.ts)
   * instead of a bare rejection. Owner ruling, 2026-07-25 ("metric-
   * independent ranking changes"): `guard` is now a flat, constant floor
   * (`DAILY_TREND_INCLUSION_FLOOR`, domain/dailyTrends.ts) - no longer
   * reality-scaled off how many ACTIVE challenges exist in the window - and
   * `playedCount` here means COUNTED COMPLETIONS only (a DNF no longer
   * contributes, unlike "played" everywhere else in this app - see
   * `listDailyTrends`'s doc comment). Home reads `guard` off this field the
   * same way Boards reads `BoardsTrendsResponse.guard` (F5 invariant: never
   * re-derived client-side).
   */
  trend30: {
    avgPlacement: number | null;
    playedCount: number;
    ranked: boolean;
    guard: number;
  };
}

/**
 * Boards' rolling-trend row (Increment 4, UX redesign spec §Boards -
 * "7d/30d/lifetime" paragraph; generalized by FB-10, owner ruling
 * 2026-07-20, from daily-only to every challenge): one row per canonical
 * account, using the same best-rank-per-account-per-challenge definition as
 * `ChallengeBoardPlacement`, aggregated across a window's challenges.
 *
 * Owner ruling, 2026-07-25 ("metric-independent ranking changes"): a
 * `DailyTrendRankedEntry` has cleared the flat `DAILY_TREND_INCLUSION_FLOOR`
 * (domain/dailyTrends.ts) - `playedCount` here is COUNTED COMPLETIONS only
 * (best attempt per challenge, same dedup as `avgPlacement`'s own
 * denominator), NOT the broader played-OR-DNF count `listChallengeDnfs`/
 * `listAllPlayersRoster`/`getAccountDailyStreak` still use elsewhere (FB-7's
 * DNF-counts-toward-"played" ruling is unchanged there, just superseded for
 * THIS inclusion guard specifically) - a DNF-only account never appears in
 * either this array or `DailyTrendUnrankedEntry` at all, since it has zero
 * counted completions to report. `avgElapsedMs`/`avgClicks` (added the same
 * ruling) are this account's own average time/clicks across those same
 * counted completions in the window - display-only info columns alongside
 * the placement; the SORT stays `avgPlacement` (a separate metric decision
 * is pending, per the owner - this ruling deliberately didn't touch it).
 * Accounts below the floor appear as `DailyTrendUnrankedEntry` instead (with
 * no `avgPlacement`/avg columns) ONLY when they have exactly
 * `DAILY_TREND_INCLUSION_FLOOR - 1` (i.e. 1, at the current floor of 2)
 * counted completions - the "runway": one finish away from ranking. A
 * zero-completion account (whether never played or DNF-only) doesn't appear
 * in `unranked` either - see `trendGuardProgressCopy` for the copy this
 * drives.
 */
export interface DailyTrendRankedEntry {
  accountId: string;
  displayName: string | null;
  avgPlacement: number;
  playedCount: number;
  avgElapsedMs: number;
  avgClicks: number;
}

export interface DailyTrendUnrankedEntry {
  accountId: string;
  displayName: string | null;
  playedCount: number;
}

/**
 * PKG-14 (direct owner feedback, 2026-07-19: "lifetime/board stats isn't
 * thorough - doesn't include other (fran, lollerskates) that have played"):
 * Lifetime's "Everyone who's played" roster row - EVERY canonical account
 * with ≥1 `board_excluded = 0` run across ANY challenge (daily or custom),
 * not just the ones who've cleared the ranked-trends participation guard.
 * Diagnosis (pre-FB-10): `listDailyTrends` used to only count
 * daily-featured challenges, so an account that solely raced custom
 * (non-daily) challenges could never appear on 7d/30d/Lifetime, even as "not
 * yet ranked" - this roster was the fix. FB-10 (owner ruling, 2026-07-20)
 * later generalized `listDailyTrends` itself to every challenge, closing
 * that gap for the ranked/unranked lists too - but this roster still serves
 * a distinct purpose (below-guard AND below-`MIN_COUNTED_DNF_CLICKS`
 * accounts included unconditionally) and stays Lifetime-only (no 7d/30d
 * roster - spec scope). Counts, not
 * a leaderboard: the time+clicks-on-board-rows invariant governs ranked
 * board rows, not this roster (owner-proxy ruling) - `racesStarted`/
 * `finishes`/`wins` are plain counts, never a time. `wins` uses the exact
 * same best-rank-per-account-per-challenge dedup as `DailyTrendRankedEntry`/
 * `ChallengeBoardPlacement` ("the deduped placement rule"), generalized
 * across every challenge ever instead of one window's; `finishes` is the
 * simpler raw completed-run count `AccountStats.totals.completed` already
 * uses (no ranked-eligibility filter) - this roster is a friendly census,
 * not a ranking. Alias-resolved through `account_aliases` like every other
 * board/roster query, so a re-linked account can't double-count. FB-7
 * (owner ruling, 2026-07-19): `racesStarted` is deliberately NOT gated by
 * the `MIN_COUNTED_DNF_CLICKS` DNF threshold applied everywhere else
 * "played" is derived - it stays this raw, honest count.
 */
export interface AllPlayersRosterEntry {
  accountId: string;
  displayName: string | null;
  racesStarted: number;
  finishes: number;
  wins: number;
}

export interface RankedLeaderboardRow extends ServerLeaderboardRow {
  rank: number;
}

/**
 * Boards' daily-view finisher row (Increment 3, UX redesign spec §Boards):
 * one row per canonical account, deduped to their best attempt - the wire
 * shape of `listChallengePlacements`, already invariant-2-correct (unlike
 * `RankedLeaderboardRow`, which is per-attempt). Boards/Home never disclose
 * a per-run path (spec invariant 5: "paths hidden until you've played" -
 * neither surface gates path disclosure on the viewer's own play state, so
 * they simply never wire `runId` up to anything).
 *
 * `runId` (PKG-03 remainder fix, 2026-07-19): the surviving best attempt's
 * own run id, added so Challenge Detail - which DOES gate on `pathsUnlocked`
 * - can link ANY placement row (not just the viewer's own "Your history"
 * rows) to its winning path via the existing public `GET
 * /runs/{runId}/path` endpoint. Optional so older/cached responses and the
 * many existing board fixtures across the test suite that predate this
 * field keep parsing (`isChallengeBoardPlacement` tolerates its absence) -
 * the real server always populates it.
 */
export interface ChallengeBoardPlacement {
  accountId: string;
  displayName: string | null;
  placement: number;
  elapsedMs: number;
  clickCount: number;
  runId?: string;
}

/**
 * Boards' daily-view DNF row: accounts with an eligible abandoned run and no
 * completed eligible run on this challenge (invariant 2 - "a completion
 * supersedes DNF"), one row per canonical account keeping their
 * most-progressed attempt. Ordered by progress (clicks), not time - DNFs
 * aren't placed/ranked.
 */
export interface ChallengeBoardDnfRow {
  accountId: string;
  displayName: string | null;
  clickCount: number;
  elapsedMs: number;
}

/**
 * Browse's per-challenge aggregate card data (Increment 5, UX redesign spec
 * §Challenges - "N players · best 0:38 · 5 clk"; §Data requirements -
 * "Browse aggregate + bulk per-account outcome"). `playerCount` is DISTINCT
 * CANONICAL ACCOUNTS with a board-visible run (completed-eligible OR
 * ≥1-click DNF, `board_excluded = 0`) - council: "already forge-floored vs
 * raw run counts," so no extra account-days flooring is needed on top of
 * this (unlike the rolling multi-daily trends, a single static challenge has
 * no day dimension to inflate via repeat same-day plays). `best` is the
 * challenge's #1 placement (completed-only, same ordering as
 * `listChallengePlacements`); `null` when nobody has finished it yet even if
 * it has DNFs/players.
 */
export interface ChallengeSummaryEntry {
  challengeId: string;
  playerCount: number;
  best: { elapsedMs: number; clickCount: number } | null;
}

/**
 * Bulk per-account outcome across the whole catalog (Increment 5, UX
 * redesign spec §Challenges state chips; invariant 2 precedence - a
 * completed-eligible run beats a later DNF, permanently: "A completion is
 * permanent"). Alias-resolved to the caller's canonical account. Only
 * challenges the account has an ELIGIBLE run on appear here at all (a
 * 0-click or otherwise ineligible run is absent - the client's default
 * "NEW" chip covers that case by omission). `best` is populated only for
 * `outcome: "completed"`.
 */
export interface ChallengeOutcomeEntry {
  challengeId: string;
  outcome: "completed" | "dnf";
  best: { elapsedMs: number; clickCount: number } | null;
  /**
   * "I gave up" affordance gating (owner spec, 2026-08-02): true only when
   * `outcome === "dnf"` AND the account has at least one counted DNF on this
   * challenge clearing `MIN_GIVE_UP_CLICKS` clicks or `MIN_GIVE_UP_WALL_MS`
   * wall-elapsed ("any attempt" - not necessarily the account's most recent
   * one). Always `false`/omitted for `outcome: "completed"` (a finisher has
   * nothing to give up on) and for challenges absent from this response
   * entirely (never attempted, or only sub-`MIN_COUNTED_DNF_CLICKS`
   * accidental opens - neither is a real attempt). Optional for wire
   * back-compat with older cached responses/fixtures.
   */
  giveUpEligible?: boolean;
  /**
   * True once this account has confirmed "I give up" on this challenge
   * (durable - `operation_idempotency` 'solution_peek' row, never reverses).
   * Once true, the give-up affordance itself stops rendering (redundant -
   * see `GiveUpAffordance`) and Detail's "The solution" panel takes over
   * instead. A peeked account's later completions on this same challenge are
   * still possible but permanently `ranked_eligible = 0` - see
   * `startRunV2`'s peek check.
   */
  peeked?: boolean;
}
