import type {
  AccountStatus,
  Challenge,
  RankedLeaderboardRow,
  ServerPathStep,
} from "../domain/types";
import type { RunRecordResponse } from "./trackingRepository";

export interface ChallengesResponse {
  challenges: Challenge[];
}

export interface CreateChallengeRequest {
  startTitle: string;
  targetTitle: string;
  creatorDisplayName?: string;
}

export interface CreateChallengeResponse {
  challenge: Challenge;
}

export interface StartRunRequest {
  challengeId: string;
  accountId: string;
  publicName: string;
  identityStatus: AccountStatus;
}

export interface StartRunResponse {
  run: RunRecordResponse;
}

export interface ClickRequest {
  sourceTitle: string;
  clickedAnchorText: string;
  requestedTitle: string;
  destinationTitle: string;
  destinationPageId?: number;
  clientTimestampMs?: number;
}

export interface ClickResponse {
  clickCount: number;
}

export interface CompleteRunRequest {
  finalTitle: string;
  clientTimestampMs?: number;
}

export interface CompleteRunResponse {
  leaderboardRow: RankedLeaderboardRow;
}

export interface AbandonRunResponse {
  status: "abandoned";
}

export interface LeaderboardResponse {
  leaderboard: RankedLeaderboardRow[];
}

export interface RunPathResponse {
  path: ServerPathStep[];
}
