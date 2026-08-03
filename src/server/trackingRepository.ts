import type {
  AccountStatus,
  AccountStats,
  AbandonRunTransition,
  AllPlayersRosterEntry,
  AuthorizedAccount,
  Challenge,
  ChallengeOutcomeEntry,
  ChallengePathsResult,
  ChallengeSummaryEntry,
  DailyTrendRankedEntry,
  DailyTrendUnrankedEntry,
  GiveUpChallengeResult,
  LeaderboardContext,
  RankedLeaderboardRow,
  RunTransition,
  ServerPathStep,
} from "../domain/types";
export type {
  DailyFlavor,
  DailyNomination,
  DailyQueueEntry,
} from "../domain/dailyEditorial";
import type {
  AbandonRunV2Input,
  GiveUpChallengeInput,
  RecordClickV2Input,
  StartRunV2Input,
} from "./runProtocol";
import type {
  CreateChallengeOutcome,
  DailyClassification,
  DailyFlavor,
  DailyNomination,
  DailyQueueEntry,
} from "../domain/dailyEditorial";

export type CreateChallengeRepositoryResult = Challenge | CreateChallengeOutcome;

export interface AccountProfileRecord {
  accountId: string;
  publicName: string;
  identityStatus: AccountStatus;
}

export interface RunRecordResponse {
  id: string;
  challengeId: string;
  accountId: string;
  status: "active" | "completed" | "abandoned";
  startTitle: string;
  targetTitle: string;
  clickCount: number;
  startedAt: string;
  completedAt?: string;
  elapsedMs?: number;
  protocolVersion?: 1 | 2;
}

export interface ActiveRunRecord extends RunRecordResponse {
  protocolVersion: 1 | 2;
  canonicalAccountId: string;
  startPageId?: number;
  targetPageId?: number;
  lastPageId?: number;
  lastTitle?: string;
  expiresAt?: string;
  wallElapsedMs?: number;
}

export interface RecordClickV2Result {
  transition: RunTransition;
  leaderboardContext?: LeaderboardContext;
}

export interface CreateChallengeV2Input {
  startTitle: string;
  startPageId: number;
  startAllowedLinkCount: number;
  targetTitle: string;
  targetPageId: number;
  idempotencyKey: string;
  requestFingerprint?: string;
  nominateForDaily?: boolean;
  dailyClassification?: DailyClassification;
  /**
   * Increment 5 (random-challenge endpoint): overrides the `challenges.source`
   * column's default ('curated') for a manual creation whose articles came
   * from the random-candidate machinery rather than a person typing titles
   * in. Omitted (or 'curated') for every other manual-creation caller -
   * existing behavior is unchanged.
   */
  source?: "curated" | "wikipedia_random";
}

export interface DailyChallengeJob {
  dailyDate: string;
  attemptCount: number;
  leaseToken: string;
  leaseExpiresAt: string;
}

export interface DailyChallengeInput {
  startTitle: string;
  startPageId: number;
  targetTitle: string;
  targetPageId: number;
  /**
   * "I gave up" reference path (owner spec, 2026-08-02, dailies only):
   * a bounded, best-effort forward search (`dailyCandidateEvaluator.ts`'s
   * `findReferencePath`) computed right after automatic candidate
   * selection, reusing the evaluator's already-in-memory start outlinks and
   * target inbound-linkers. `undefined`/`null` when the search found nothing
   * (or wasn't attempted at all - it never runs for the on-demand random-
   * challenge path) - stores nothing and never blocks the drop either way.
   * A plain title chain, start..target inclusive.
   */
  referencePath?: string[] | null;
}

export interface DailyAdminState {
  nominations: DailyNomination[];
  queueEntries: DailyQueueEntry[];
}

/**
 * No-repeat exclusions for the daily generator (owner incident, 2026-07-29:
 * the 07-29 auto-daily picked "Technology" as its target - already the
 * 07-20 daily's target, and a live random-challenge target that same day -
 * because the generator had no memory of anything it had picked before).
 * Both sets are normalized via `domain/rules`' `normalizeTitle`, the same
 * comparison the evaluator (and every other title-equality check in this
 * codebase) already uses. See `getDailyExclusionSets`'s doc comment for
 * exactly what each set contains.
 */
export interface DailyExclusionSets {
  excludedTargetTitles: Set<string>;
  excludedStartTitles: Set<string>;
}

export interface DailyQueuedCandidate extends DailyQueueEntry {
  challenge: Challenge;
}

export interface DailyModerationInput {
  actorAccountId: string;
  idempotencyKey: string;
}

export interface ApproveDailyNominationInput extends DailyModerationInput {
  nominationId: string;
  flavor: DailyFlavor;
}

export interface DeclineDailyNominationInput extends DailyModerationInput {
  nominationId: string;
}

export interface QueueDailyChallengeInput extends DailyModerationInput {
  challengeId: string;
  flavor: DailyFlavor;
}

export interface RemoveDailyQueueEntryInput extends DailyModerationInput {
  queueEntryId: string;
}

export type DailyFeatureSelection =
  | {
      kind: "queued";
      queueEntryId: string;
      classifierVersion: string;
    }
  | {
      kind: "automatic";
      candidate: DailyChallengeInput;
      classifierVersion: string;
      selectedScore?: number | null;
    };

export interface LegacyClickInput {
  sourceTitle: string;
  clickedAnchorText: string;
  requestedTitle: string;
  destinationTitle: string;
  destinationPageId?: number;
  clientTimestampMs?: number;
}

export interface LegacyCompleteInput {
  finalTitle: string;
  clientTimestampMs?: number;
}

export interface TrackingRepository {
  listChallenges(): Promise<Challenge[]>;
  createChallenge(input: {
    startTitle: string;
    targetTitle: string;
    creatorAccountId: string;
    creatorDisplayName: string;
    creatorIdentityStatus: AccountStatus;
  }): Promise<Challenge>;
  upsertAccountProfile(input: {
    accountId: string;
    publicName: string;
    identityStatus: AccountStatus;
  }): Promise<AccountProfileRecord>;
  startRun(input: {
    challengeId: string;
    accountId: string;
    publicName: string;
    identityStatus: AccountStatus;
    aliases?: string[];
  }): Promise<RunRecordResponse>;
  recordClick(
    runId: string,
    accountId: string,
    input: {
      sourceTitle: string;
      clickedAnchorText: string;
      requestedTitle: string;
      destinationTitle: string;
      destinationPageId?: number;
      clientTimestampMs?: number;
    },
  ): Promise<{ clickCount: number }>;
  completeRun(
    runId: string,
    accountId: string,
    input: {
      finalTitle: string;
      clientTimestampMs?: number;
    },
  ): Promise<RankedLeaderboardRow>;
  abandonRun(
    runId: string,
    accountId: string,
  ): Promise<{ status: "abandoned" | "completed" }>;
  listLeaderboard(challengeId: string): Promise<RankedLeaderboardRow[]>;
  getRunPath(runId: string): Promise<ServerPathStep[]>;
}

export interface RunProtocolRepository extends TrackingRepository {
  ensureDailyChallengeJob(dailyDate: string): Promise<void>;
  claimDueDailyChallengeJob(): Promise<DailyChallengeJob | null>;
  failDailyChallengeJob(job: DailyChallengeJob, failureCode: string): Promise<void>;
  acceptDailyChallenge(job: DailyChallengeJob, input: DailyChallengeInput): Promise<Challenge>;
  listDailyAdminState(): Promise<DailyAdminState>;
  approveDailyNomination(input: ApproveDailyNominationInput): Promise<DailyQueueEntry>;
  declineDailyNomination(input: DeclineDailyNominationInput): Promise<DailyNomination>;
  queueDailyChallenge(input: QueueDailyChallengeInput): Promise<DailyQueueEntry>;
  removeDailyQueueEntry(input: RemoveDailyQueueEntryInput): Promise<DailyQueueEntry>;
  setRunBoardExclusion(
    runId: string,
    excluded: boolean,
  ): Promise<{ runId: string; boardExcluded: boolean } | null>;
  listChallengePlacements(challengeId: string): Promise<
    Array<{
      accountId: string;
      displayName: string | null;
      placement: number;
      elapsedMs: number;
      clickCount: number;
      completedAt: string;
      // PKG-03 remainder fix: the surviving best attempt's own run id, so
      // callers (getChallengeBoard) can wire up a path disclosure - see
      // ChallengeBoardPlacement's doc comment (domain/types.ts).
      runId: string;
    }>
  >;
  listChallengeDnfs(challengeId: string): Promise<
    Array<{
      accountId: string;
      displayName: string | null;
      elapsedMs: number;
      clickCount: number;
      abandonedAt: string;
    }>
  >;
  /**
   * Boards' 7d/30d/lifetime trend segments (Increment 4; generalized by
   * FB-10, owner ruling 2026-07-20, from daily-only to every challenge).
   * `windowDays` is `null` for lifetime (all challenges ever, no date
   * filter); 7d/30d membership is by each CHALLENGE'S OWN creation date
   * (Central-date of `created_at`), not `daily_features.daily_date` - see
   * `partitionChallengesByTrendWindow`. Uses the same
   * best-rank-per-account-per-challenge dedup as `listChallengePlacements`,
   * with NO `LIMIT` (unlike that query and `listChallengeDnfs`) - see Task
   * 3.1's flagged "revisit at Increment 4": rolling trends must consider
   * every eligible finisher of each challenge, not just the first 100.
   *
   * Owner ruling, 2026-07-25 ("metric-independent ranking changes"):
   * `guard` is now the flat `DAILY_TREND_INCLUSION_FLOOR` (domain/
   * dailyTrends.ts), not reality-scaled off catalog size - and `playedCount`
   * on both `ranked`/`unranked` entries here means COUNTED COMPLETIONS only
   * (best attempt per challenge, `avgPlacement`'s own denominator). This
   * supersedes the prior F2/FB-7 behavior FOR THIS METHOD ONLY: a
   * board-visible DNF still counts toward "played" everywhere else
   * (`listChallengeDnfs`, `listAllPlayersRoster`, `getAccountDailyStreak`),
   * but no longer helps an account clear this guard - only a genuine finish
   * does. An account with zero counted completions (never played, or
   * DNF-only) doesn't appear in either array at all. `avgElapsedMs`/
   * `avgClicks` on each ranked entry are that account's own average
   * time/clicks across those same counted completions - display-only info
   * columns; the SORT stays `avgPlacement` (unchanged by this ruling).
   *
   * Callers (apiHandlers' `getBoardsTrends`, `getAccountStats`'s `trend30`)
   * just echo this `guard` back out, same as before.
   */
  listDailyTrends(windowDays: 7 | 30 | null, todayCentral: string): Promise<{
    ranked: DailyTrendRankedEntry[];
    unranked: DailyTrendUnrankedEntry[];
    guard: number;
  }>;
  /**
   * PKG-14 (direct owner feedback): Lifetime's "Everyone who's played"
   * roster - every canonical account with ≥1 run row (ANY status/clicks)
   * across ANY challenge (daily or custom), independent of the
   * ranked-trends participation guard entirely. FB-7 (owner ruling,
   * 2026-07-19): deliberately NOT gated by `MIN_COUNTED_DNF_CLICKS` -
   * `racesStarted` stays a raw, honest census (broader than "played"
   * everywhere else); `finishes`/`wins` are unaffected either way, since
   * they already require a completed run. See `AllPlayersRosterEntry`'s doc
   * comment for the exact `racesStarted`/`finishes`/`wins` definitions.
   */
  listAllPlayersRoster(): Promise<AllPlayersRosterEntry[]>;
  /**
   * Boards/Home streak (Increment 4): consecutive Central dates, ending
   * today or yesterday, on which `accountId` (alias-resolved) has ≥1
   * eligible completed OR board-visible-DNF run on that date's daily (F2,
   * amended by FB-7 - same participation definition as `listDailyTrends`,
   * including the >= `MIN_COUNTED_DNF_CLICKS` DNF threshold). Silent reset
   * on a missed day - no grace period.
   */
  getAccountDailyStreak(accountId: string, todayCentral: string): Promise<number>;
  /**
   * Auto zz-sweep (owner ruling, 2026-07-25 - "metric-independent ranking
   * changes"): an idempotent maintenance sweep, run hourly off the "17 * * *
   * *" retry cron (`worker.ts`'s `scheduled()`), that flips `board_excluded
   * = 1` on any still-included run (`board_excluded = 0`) belonging to an
   * account whose CURRENT `account_profiles.public_name` starts with "zz" -
   * the house convention for manual QA/test accounts (see the
   * `listAllPlayersRoster` worker test's "zephyr-style test account"
   * comment). Previously this exclusion was entirely manual (a hand-run
   * `UPDATE runs SET board_excluded = 1 ...`); this automates it so a
   * forgotten zz-account never lingers on a public board past the next
   * hourly tick. Matches on `runs.canonical_account_id` directly (stamped at
   * run-creation time to the account's own id - see `startRunV2`'s INSERT),
   * not the `account_aliases`-resolved identity every READ query in this
   * file uses - a deliberate, narrower match: this sweep only needs to catch
   * a zz-account's OWN runs, not runs merged in from some other identity.
   * Idempotent (the `board_excluded = 0` guard means re-running it is a
   * no-op once caught up) and safe to call on every hourly tick regardless
   * of whether any zz account exists yet. Returns the number of rows
   * flipped this call, so the caller can log a structured line only when
   * something actually changed.
   */
  sweepZzExcludedTestAccountRuns(): Promise<number>;
  findQueuedDailyCandidate(flavor: DailyFlavor): Promise<DailyQueuedCandidate | null>;
  /**
   * No-repeat exclusions (owner incident, 2026-07-29 - see
   * `DailyExclusionSets`'s doc comment). Two sets, both normalized:
   *
   *  - `excludedTargetTitles`: every title EVER used as a daily target
   *    (`daily_features` joined to its `challenges.target_title`), UNION
   *    every `target_title` belonging to a currently-active catalog
   *    challenge of ANY origin (manual, community, `wikipedia_random`, or
   *    an older daily still live) - a fresh daily duplicating a target
   *    that's already playable today is just as stale as repeating a past
   *    daily. All-time, no rolling window: a target is used once, ever.
   *  - `excludedStartTitles`: start titles used by any daily in the last 30
   *    days - a lighter, rolling-window-only rule, since a start is just a
   *    launch point, not "the answer" a player is trying to avoid
   *    spoiling.
   *
   * `referenceDailyDate` anchors the 30-day start window - callers pass the
   * daily date currently being generated (`job.dailyDate`), not wall-clock
   * "now". One D1 round-trip. Called by `worker.ts`'s `scheduled()` before
   * invoking the candidate evaluator, for both the queue-miss automatic
   * path and the hourly retry path (the same code path there) - see that
   * call site's own comment for the degrade-on-failure contract (a load
   * failure here must never fail the whole daily job; thin pools degrade,
   * never die).
   */
  getDailyExclusionSets(referenceDailyDate: string): Promise<DailyExclusionSets>;
  acceptDailyFeature(job: DailyChallengeJob, selection: DailyFeatureSelection): Promise<Challenge>;
  findChallengeCreationReplay(
    account: AuthorizedAccount,
    input: { idempotencyKey: string; requestFingerprint: string },
  ): Promise<CreateChallengeRepositoryResult | null>;
  createChallengeV2(
    account: AuthorizedAccount,
    input: CreateChallengeV2Input,
  ): Promise<CreateChallengeOutcome>;
  startRunLegacy(
    account: AuthorizedAccount,
    input: { challengeId: string },
  ): Promise<RunRecordResponse>;
  recordClickLegacy(
    account: AuthorizedAccount,
    runId: string,
    input: LegacyClickInput,
  ): Promise<{ clickCount: number }>;
  completeRunLegacy(
    account: AuthorizedAccount,
    runId: string,
    input: LegacyCompleteInput,
  ): Promise<RankedLeaderboardRow>;
  abandonRunLegacy(
    account: AuthorizedAccount,
    runId: string,
  ): Promise<{ status: "abandoned" | "completed" }>;
  startRunV2(
    account: AuthorizedAccount,
    input: StartRunV2Input,
  ): Promise<ActiveRunRecord>;
  recordClickV2(
    account: AuthorizedAccount,
    input: RecordClickV2Input,
  ): Promise<RecordClickV2Result>;
  abandonRunV2(
    account: AuthorizedAccount,
    input: AbandonRunV2Input,
  ): Promise<AbandonRunTransition>;
  findActiveRun(account: AuthorizedAccount): Promise<ActiveRunRecord | null>;
  getRecoveryRunPath(
    account: AuthorizedAccount,
    runId: string,
  ): Promise<ServerPathStep[]>;
  getAccountStats(account: AuthorizedAccount): Promise<AccountStats>;
  /**
   * FB-4 (council 2026-07-19, owner decision 10; review fix): `viewerAccount`
   * is required - the `/api/v2/...` route always supplies one, which
   * enforces server-side that the viewer has an eligible completed run on
   * the SAME challenge as the target run (own or not) before disclosing
   * anything - invariant 5, never client-trusted. (The pre-migration legacy
   * `/api/runs/{runId}/path` route, which used to call this with no viewer
   * at all - a straight bypass of this guard - has been retired entirely;
   * see worker.ts.) See d1TrackingRepository.ts's implementation doc
   * comment.
   */
  getPublicRunPath(
    runId: string,
    viewerAccount: AuthorizedAccount,
  ): Promise<ServerPathStep[]>;
  /**
   * GR-1 ("View graph" - a merged, all-players visualization of every
   * counted path through a challenge): the bulk source `ChallengePathGraph`
   * consumes. Same FB-4 viewer-finished guard as `getPublicRunPath` above
   * (shared SQL fragment, see d1TrackingRepository.ts) - disclosing every
   * player's route in one response is a bigger spoiler than one row at a
   * time, so it's enforced server-side here too, never just hidden
   * client-side. One entry per account's best counted run (same dedup
   * `listChallengePlacements`/`listChallengeDnfs` use for the public
   * board), finishers-fastest-first then DNFs, capped at
   * `CHALLENGE_PATHS_LIMIT` with `totalRuns` carrying the real, uncapped
   * count.
   */
  getChallengePaths(
    challengeId: string,
    viewerAccount: AuthorizedAccount,
  ): Promise<ChallengePathsResult>;
  /**
   * Browse's per-card aggregate (Increment 5, unauthenticated, like
   * `listChallenges`): one entry per active challenge, in no particular
   * order (the client sorts). See `ChallengeSummaryEntry`.
   */
  listChallengesSummary(): Promise<ChallengeSummaryEntry[]>;
  /**
   * Browse's bulk per-account state chips (Increment 5, authenticated): one
   * entry per challenge the caller (alias-resolved) has an eligible run on.
   * See `ChallengeOutcomeEntry`.
   */
  getAccountChallengeOutcomes(
    account: AuthorizedAccount,
  ): Promise<ChallengeOutcomeEntry[]>;
  /**
   * Home's "Got a few more minutes?" suggestion (Increment 5): the
   * most-popular active challenge (by `listChallengesSummary`'s
   * `playerCount`, ties broken by lower `sortOrder`) the caller
   * (alias-resolved) has never started - "started" here means ANY run row
   * at all, including a 0-click one, which is a strictly broader bar than
   * `getAccountChallengeOutcomes`'s "eligible run" (spec: "played OR
   * attempted excludes it"). Excludes `todayCentral`'s daily. `null` when
   * every active, non-daily challenge has been started.
   */
  getPlayAnotherSuggestion(
    account: AuthorizedAccount,
    todayCentral: string,
  ): Promise<Challenge | null>;
  /**
   * On-demand random-challenge concurrency guard (Increment 5): acquires a
   * per-account lock (so at most one random-challenge attempt is ever
   * in-flight for a given account) and, only once acquired, checks the
   * rolling-hour creation quota. Returns `"in_progress"` when another
   * attempt (a different idempotency key) already holds the lock and
   * hasn't finished/gone stale; `"quota_exceeded"` when the lock was
   * acquired but the account has already created
   * `RANDOM_CHALLENGE_HOURLY_QUOTA` `source: 'wikipedia_random'` challenges
   * in the last hour (the lock is released as `"rejected"` automatically in
   * this case); `"ok"` when the caller now holds the lock and must call
   * `finishRandomChallengeAttempt` exactly once to release it.
   */
  beginRandomChallengeAttempt(
    account: AuthorizedAccount,
    idempotencyKey: string,
  ): Promise<"ok" | "in_progress" | "quota_exceeded">;
  /** Releases the lock `beginRandomChallengeAttempt` acquired. */
  finishRandomChallengeAttempt(
    account: AuthorizedAccount,
    outcome: "accepted" | "rejected",
    resourceId: string | null,
  ): Promise<void>;
  /**
   * "I gave up" flow (owner spec, 2026-08-02): `POST
   * /api/v2/challenges/{id}/give-up`. Server-side re-validates eligibility
   * from `runs` itself (never trusts the client's own gating) - the caller
   * (alias-resolved) must have a qualifying counted DNF on this challenge
   * (`MIN_GIVE_UP_CLICKS` clicks or `MIN_GIVE_UP_WALL_MS` wall-elapsed, any
   * attempt) and no eligible completed run on it. Throws
   * `give_up_already_finished` / `give_up_not_eligible` otherwise. On
   * success, durably records the peek (`operation_idempotency` 'solution_peek'
   * row keyed `${canonicalAccountId}:${challengeId}`) - idempotent: calling
   * this again for an already-peeked account/challenge pair just re-confirms
   * `{ peeked: true }` rather than erroring or double-recording.
   */
  giveUpChallenge(
    account: AuthorizedAccount,
    input: GiveUpChallengeInput,
  ): Promise<GiveUpChallengeResult>;
}
