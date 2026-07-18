import type {
  AccountStatus,
  AccountStats,
  AbandonRunTransition,
  AuthorizedAccount,
  Challenge,
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
   */
  listDailyTrends(windowDays: 7 | 30 | null, todayCentral: string): Promise<{
    ranked: DailyTrendRankedEntry[];
    unranked: DailyTrendUnrankedEntry[];
  }>;
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
  getPublicRunPath(runId: string): Promise<ServerPathStep[]>;
}
