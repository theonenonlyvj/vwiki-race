import type {
  AccountStatus,
  AccountStats,
  AbandonRunTransition,
  AuthorizedAccount,
  Challenge,
  LeaderboardContext,
  RankedLeaderboardRow,
  RunTransition,
  ServerPathStep,
} from "../domain/types";
import type {
  AbandonRunV2Input,
  RecordClickV2Input,
  StartRunV2Input,
} from "./runProtocol";

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
}

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
  findChallengeCreationReplay(
    account: AuthorizedAccount,
    input: { idempotencyKey: string; requestFingerprint: string },
  ): Promise<Challenge | null>;
  createChallengeV2(
    account: AuthorizedAccount,
    input: CreateChallengeV2Input,
  ): Promise<Challenge>;
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
  getAccountStats(account: AuthorizedAccount): Promise<AccountStats>;
  getPublicRunPath(runId: string): Promise<ServerPathStep[]>;
}
