import type {
  AccountStatus,
  AccountStats,
  AbandonRunTransition,
  AuthorizedAccount,
  Challenge,
  ChallengeBoardDnfRow,
  ChallengeBoardPlacement,
  DailyTrendRankedEntry,
  DailyTrendUnrankedEntry,
  LeaderboardContext,
  RankedLeaderboardRow,
  RunTransition,
  ServerPathStep,
} from "../domain/types";
import type {
  DailyNomination,
  DailyQueueEntry,
} from "../domain/dailyEditorial";
export type { CreateChallengeOutcome } from "../domain/dailyEditorial";
import type {
  AbandonRunV2Input,
  RecordClickV2Input,
  StartRunV2Input,
} from "./runProtocol";
import type { RunRecordResponse } from "./trackingRepository";
import type { CreateChallengeOutcome as DailyCreateChallengeOutcome } from "../domain/dailyEditorial";

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
  nominateForDaily?: boolean;
}

export type CreateChallengeV2Response = DailyCreateChallengeOutcome;

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

/**
 * Boards' daily-view endpoint (Increment 3, UX redesign spec §Boards): the
 * full deduped board for one challenge - a completed placement per canonical
 * account plus, separately, accounts that only DNF'd (invariant 2: "a
 * completion supersedes DNF" - no account appears in both arrays).
 */
export interface ChallengeBoardResponse {
  challengeId: string;
  placements: ChallengeBoardPlacement[];
  dnfs: ChallengeBoardDnfRow[];
}

/**
 * Boards' rolling-trend endpoint (Increment 4, UX redesign spec §Boards -
 * "7d/30d/lifetime" paragraph). `window` echoes the validated query param
 * vocabulary (`?window=7|30|lifetime`) verbatim, and `guard` is the
 * participation threshold that produced this exact `ranked`/`unranked`
 * split - the client renders copy off `guard`, it never re-derives it.
 */
export type BoardsTrendWindow = "7" | "30" | "lifetime";

/**
 * F3 (trend arrows): a ranked trend row plus its comparison point - this
 * account's `avgPlacement` in the immediately-preceding same-length window
 * (7d: [t-13,t-7]; 30d: [t-59,t-30] - see `dailyTrendPreviousWindowEnd`).
 * `null` when the account was absent/unranked in that previous window, or
 * whenever `window` is `"lifetime"` (spec: "no arrow on lifetime" - lifetime
 * has no meaningful "previous window"). Lower `avgPlacement` is better, so a
 * lower current value than `prevAvgPlacement` is an improvement (▲).
 */
export interface BoardsTrendRankedEntry extends DailyTrendRankedEntry {
  prevAvgPlacement: number | null;
}

export interface BoardsTrendsResponse {
  window: BoardsTrendWindow;
  guard: number;
  ranked: BoardsTrendRankedEntry[];
  unranked: DailyTrendUnrankedEntry[];
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

export interface DailyCapabilitiesResponse {
  canManageDailies: boolean;
}

export interface DailyAdminStateResponse {
  nominations: DailyNomination[];
  queueEntries: DailyQueueEntry[];
}
