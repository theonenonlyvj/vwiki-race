import type {
  AccountStatus,
  AccountStats,
  AbandonRunTransition,
  AllPlayersRosterEntry,
  AuthorizedAccount,
  Challenge,
  ChallengeOutcomeEntry,
  ChallengeSummaryEntry,
  DailyTrendRankedEntry,
  DailyTrendUnrankedEntry,
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
}

export interface DailyAdminState {
  nominations: DailyNomination[];
  queueEntries: DailyQueueEntry[];
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
   * Boards' 7d/30d/lifetime trend segments (Increment 4). `windowDays` is
   * `null` for lifetime (all dailies, no date filter). Uses the same
   * best-rank-per-account-per-daily dedup as `listChallengePlacements`, with
   * NO `LIMIT` (unlike that query and `listChallengeDnfs`) - see Task 3.1's
   * flagged "revisit at Increment 4": rolling trends must consider every
   * eligible finisher of each daily, not just the first 100.
   *
   * F2 (spec §Boards "≥1 eligible/leaderboard-visible run"): a
   * board-visible DNF counts toward each entry's `playedCount`
   * (participation) the same as a finish does, both for clearing the
   * ranking guard and for the below-guard progress count - but
   * `avgPlacement` is only ever computed over finished dailies.
   *
   * PKG-14: `guard` is now computed HERE (not by the caller from `windowDays`
   * alone) because it's reality-scaled off `dailiesAvailable` - the count of
   * `daily_features` rows actually inside this exact window (lifetime = all
   * time) - which only this query's own `WHERE`/date-bind logic already
   * knows. Callers (apiHandlers' `getBoardsTrends`, `getAccountStats`'
   * `trend30`) just echo this `guard` back out; see `dailyTrendGuard`.
   */
  listDailyTrends(windowDays: 7 | 30 | null, todayCentral: string): Promise<{
    ranked: DailyTrendRankedEntry[];
    unranked: DailyTrendUnrankedEntry[];
    guard: number;
  }>;
  /**
   * PKG-14 (direct owner feedback): Lifetime's "Everyone who's played"
   * roster - every canonical account with ≥1 board-visible run across ANY
   * challenge (daily or custom), independent of the ranked-trends
   * participation guard entirely. See `AllPlayersRosterEntry`'s doc comment
   * for the exact `racesStarted`/`finishes`/`wins` definitions.
   */
  listAllPlayersRoster(): Promise<AllPlayersRosterEntry[]>;
  /**
   * Boards/Home streak (Increment 4): consecutive Central dates, ending
   * today or yesterday, on which `accountId` (alias-resolved) has ≥1
   * eligible completed OR board-visible-DNF run on that date's daily (F2 -
   * same participation definition as `listDailyTrends`). Silent reset on a
   * missed day - no grace period.
   */
  getAccountDailyStreak(accountId: string, todayCentral: string): Promise<number>;
  findQueuedDailyCandidate(flavor: DailyFlavor): Promise<DailyQueuedCandidate | null>;
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
}
