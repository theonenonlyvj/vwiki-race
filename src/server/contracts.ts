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
import type { RunRecordResponse } from "./trackingRepository";

export interface ChallengesResponse {
  challenges: Challenge[];
}

export interface CreateChallengeRequest {
  startTitle: string;
  targetTitle: string;
  creatorDisplayName?: string;
}

export interface CreateChallengeV2Request {
  startTitle: string;
  targetTitle: string;
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
  status: "abandoned" | "completed";
}

export interface StartRunV2Request extends StartRunV2Input {
  account: AuthorizedAccount;
}

export interface ClickV2Request extends RecordClickV2Input {
  account: AuthorizedAccount;
}

export interface ClickV2Response {
  transition: RunTransition;
  leaderboardContext?: LeaderboardContext;
}

export interface AbandonRunV2Request extends AbandonRunV2Input {
  account: AuthorizedAccount;
}

export type AbandonRunV2Response = AbandonRunTransition;

export interface LeaderboardResponse {
  leaderboard: RankedLeaderboardRow[];
}

export interface RunPathResponse {
  path: ServerPathStep[];
}

export interface ActiveRunResponse {
  run: RunRecordResponse | null;
}

export interface AccountStatsResponse {
  stats: AccountStats;
}
