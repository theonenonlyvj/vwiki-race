import { getSortedChallenges } from "../domain/challenges";
import { optionalNumber, requiredString } from "./http";
import type {
  AbandonRunResponse,
  ChallengesResponse,
  ClickRequest,
  ClickResponse,
  CompleteRunRequest,
  CompleteRunResponse,
  LeaderboardResponse,
  PlayerRequest,
  PlayerResponse,
  RunPathResponse,
  StartRunRequest,
  StartRunResponse,
} from "./contracts";
import type { TrackingRepository } from "./trackingRepository";

export interface ApiHandlers {
  listChallenges(): Promise<ChallengesResponse>;
  upsertPlayer(input: PlayerRequest): Promise<PlayerResponse>;
  startRun(input: StartRunRequest): Promise<StartRunResponse>;
  recordClick(runId: string, input: ClickRequest): Promise<ClickResponse>;
  completeRun(
    runId: string,
    input: CompleteRunRequest,
  ): Promise<CompleteRunResponse>;
  abandonRun(runId: string): Promise<AbandonRunResponse>;
  listLeaderboard(challengeId: string): Promise<LeaderboardResponse>;
  getRunPath(runId: string): Promise<RunPathResponse>;
}

export function createApiHandlers(
  repository: TrackingRepository,
): ApiHandlers {
  return {
    async listChallenges() {
      return {
        challenges: getSortedChallenges(await repository.listChallenges()),
      };
    },

    async upsertPlayer(input) {
      const displayName = requiredString(
        input.displayName,
        "invalid_display_name",
        "Enter a display name before starting.",
      ).slice(0, 24);
      const playerId = input.playerId?.trim() || undefined;

      return {
        player: await repository.upsertPlayer({ displayName, playerId }),
      };
    },

    async startRun(input) {
      const challengeId = requiredString(
        input.challengeId,
        "invalid_challenge_id",
        "Choose a challenge before starting.",
      );
      const playerId = requiredString(
        input.playerId,
        "invalid_player_id",
        "Enter a display name before starting.",
      );

      return {
        run: await repository.startRun({ challengeId, playerId }),
      };
    },

    async recordClick(runId, input) {
      const cleanRunId = requiredString(
        runId,
        "invalid_run_id",
        "A run id is required.",
      );

      return repository.recordClick(cleanRunId, {
        sourceTitle: requiredString(
          input.sourceTitle,
          "invalid_source_title",
          "A source article title is required.",
        ),
        clickedAnchorText: requiredString(
          input.clickedAnchorText,
          "invalid_anchor_text",
          "Clicked link text is required.",
        ),
        requestedTitle: requiredString(
          input.requestedTitle,
          "invalid_requested_title",
          "A requested article title is required.",
        ),
        destinationTitle: requiredString(
          input.destinationTitle,
          "invalid_destination_title",
          "A destination article title is required.",
        ),
        destinationPageId: optionalNumber(input.destinationPageId),
        clientTimestampMs: optionalNumber(input.clientTimestampMs),
      });
    },

    async completeRun(runId, input) {
      const cleanRunId = requiredString(
        runId,
        "invalid_run_id",
        "A run id is required.",
      );
      const finalTitle = requiredString(
        input.finalTitle,
        "invalid_final_title",
        "A final article title is required.",
      );

      return {
        leaderboardRow: await repository.completeRun(cleanRunId, {
          finalTitle,
          clientTimestampMs: optionalNumber(input.clientTimestampMs),
        }),
      };
    },

    async abandonRun(runId) {
      return repository.abandonRun(
        requiredString(runId, "invalid_run_id", "A run id is required."),
      );
    },

    async listLeaderboard(challengeId) {
      return {
        leaderboard: await repository.listLeaderboard(
          requiredString(
            challengeId,
            "invalid_challenge_id",
            "A challenge id is required.",
          ),
        ),
      };
    },

    async getRunPath(runId) {
      return {
        path: await repository.getRunPath(
          requiredString(runId, "invalid_run_id", "A run id is required."),
        ),
      };
    },
  };
}
