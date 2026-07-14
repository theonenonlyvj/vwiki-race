import type {
  AccountStatus,
  Challenge,
  RankedLeaderboardRow,
  ServerPathStep,
} from "../domain/types";

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
  ): Promise<{ status: "abandoned" }>;
  listLeaderboard(challengeId: string): Promise<RankedLeaderboardRow[]>;
  getRunPath(runId: string): Promise<ServerPathStep[]>;
}
