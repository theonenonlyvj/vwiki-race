import type {
  Challenge,
  RankedLeaderboardRow,
  ServerPathStep,
} from "../domain/types";
import type { PlayerRecord, RunRecordResponse } from "./trackingRepository";

export interface PlayerRequest {
  displayName: string;
  playerId?: string;
}

export interface PlayerResponse {
  player: PlayerRecord;
}

export interface ChallengesResponse {
  challenges: Challenge[];
}

export interface StartRunRequest {
  challengeId: string;
  playerId: string;
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
