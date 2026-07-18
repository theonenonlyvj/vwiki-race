import type { DailyFeature } from "./dailyEditorial";

export type AccountStatus = "ghost" | "claimed" | "merged";
export type ChallengeMode = "solo" | "daily";
export type Ruleset = "ranked_classic";
export type RunStatus = "active" | "completed" | "abandoned";

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
   * §Boards - the 7d/30d/lifetime participation guard): this account's own
   * 30-day rolling-placement standing, guard-gated the same way Boards'
   * trend segments are. `avgPlacement` is only meaningful when `ranked` is
   * true; a below-guard account still gets `playedCount` so Home/You can
   * render "N/{guard} dailies" progress copy instead of a bare rejection.
   */
  trend30: {
    avgPlacement: number | null;
    playedCount: number;
    ranked: boolean;
  };
}

/**
 * Boards' rolling-trend row (Increment 4, UX redesign spec §Boards -
 * "7d/30d/lifetime" paragraph): one row per canonical account, using the
 * same best-rank-per-account-per-daily definition as `ChallengeBoardPlacement`,
 * aggregated across a window's dailies. A `DailyTrendRankedEntry` has
 * cleared the participation guard (`playedCount >= guard`, and has at least
 * one finished daily to average - F2: `playedCount` alone counts
 * board-visible DNF days too, but an all-DNF account has no `avgPlacement`
 * to rank by and stays unranked); accounts below it appear as
 * `DailyTrendUnrankedEntry` instead, with no `avgPlacement` - council:
 * unranked state "should read as progress toward a goal, not a bare
 * rejection", so `playedCount` is still surfaced.
 */
export interface DailyTrendRankedEntry {
  accountId: string;
  displayName: string | null;
  avgPlacement: number;
  playedCount: number;
}

export interface DailyTrendUnrankedEntry {
  accountId: string;
  displayName: string | null;
  playedCount: number;
}

export interface RankedLeaderboardRow extends ServerLeaderboardRow {
  rank: number;
}

/**
 * Boards' daily-view finisher row (Increment 3, UX redesign spec §Boards):
 * one row per canonical account, deduped to their best attempt - the wire
 * shape of `listChallengePlacements`, already invariant-2-correct (unlike
 * `RankedLeaderboardRow`, which is per-attempt). No `runId` - Boards never
 * discloses a per-run path this increment (spec: "paths hidden until
 * you've played"), so there's nothing to key a path disclosure on.
 */
export interface ChallengeBoardPlacement {
  accountId: string;
  displayName: string | null;
  placement: number;
  elapsedMs: number;
  clickCount: number;
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
}
