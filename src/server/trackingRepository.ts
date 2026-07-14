import type {
  Challenge,
  RankedLeaderboardRow,
  ServerPathStep,
} from "../domain/types";

export interface PlayerRecord {
  id: string;
  displayName: string;
}

export interface RunRecordResponse {
  id: string;
  challengeId: string;
  playerId: string;
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
  upsertPlayer(input: {
    displayName: string;
    playerId?: string;
  }): Promise<PlayerRecord>;
  startRun(input: {
    challengeId: string;
    playerId: string;
  }): Promise<RunRecordResponse>;
  recordClick(
    runId: string,
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
    input: {
      finalTitle: string;
      clientTimestampMs?: number;
    },
  ): Promise<RankedLeaderboardRow>;
  abandonRun(runId: string): Promise<{ status: "abandoned" }>;
  listLeaderboard(challengeId: string): Promise<RankedLeaderboardRow[]>;
  getRunPath(runId: string): Promise<ServerPathStep[]>;
}
