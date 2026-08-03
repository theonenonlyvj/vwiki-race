import type {
  AccountStatus,
  AccountStats,
  AbandonRunTransition,
  AllPlayersRosterEntry,
  AuthorizedAccount,
  Challenge,
  ChallengeBoardDnfRow,
  ChallengeBoardPlacement,
  ChallengeOutcomeEntry,
  ChallengePathRunEntry,
  ChallengeSummaryEntry,
  DailyTrendRankedEntry,
  DailyTrendUnrankedEntry,
  GiveUpChallengeResult,
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
  /**
   * PKG-14 (direct owner feedback): Lifetime's "Everyone who's played"
   * roster, folded into this same response (one fetch, no separate route)
   * rather than a dedicated `/api/v2/boards/roster` endpoint - `window ===
   * "7"`/`"30"` never populate this field at all (Lifetime-only scope), so
   * `undefined` here just means "not lifetime," not "still loading."
   */
  roster?: AllPlayersRosterEntry[];
}

export interface RunPathResponse {
  path: ServerPathStep[];
}

/**
 * GR-1 ("View graph"): `GET /api/v2/challenges/{id}/paths` - the merged
 * graph's bulk source. See `ChallengePathsResult`/`ChallengePathRunEntry`
 * (domain/types.ts) for the shape contract and the FB-4 viewer-finished
 * guard this shares with `RunPathResponse` above.
 */
export interface ChallengePathsResponse {
  runs: ChallengePathRunEntry[];
  totalRuns: number;
  // "I gave up" solution view case (b)/(c) - see `ChallengePathsResult`'s
  // doc comment (domain/types.ts) for the exact contract.
  referencePath?: string[] | null;
}

/** "I gave up" flow (owner spec, 2026-08-02): `POST
 * /api/v2/challenges/{id}/give-up`'s response - see `GiveUpChallengeResult`. */
export type GiveUpChallengeResponse = GiveUpChallengeResult;

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

/**
 * Browse's per-card aggregate (Increment 5, unauthenticated - `GET
 * /api/v2/challenges/summary`, "like the catalog" per plan). One entry per
 * active challenge; the client matches entries to `listChallenges` rows by
 * `challengeId`.
 */
export interface ChallengesSummaryResponse {
  challenges: ChallengeSummaryEntry[];
}

/**
 * Browse's bulk state-chip data for the caller (Increment 5, authenticated -
 * `GET /api/v2/account/challenge-outcomes`). One entry per challenge the
 * caller has touched with an eligible run; absence means the client's
 * default "NEW" chip applies.
 */
export interface AccountChallengeOutcomesResponse {
  outcomes: ChallengeOutcomeEntry[];
}

/**
 * Home's Play-another suggestion (Increment 5, authenticated - `GET
 * /api/v2/challenges/suggestion`). `challenge` is `null` once the caller has
 * started every active, non-daily challenge - the client falls back to "Create
 * a random new one" (`POST /api/v2/challenges/random`).
 */
export interface ChallengeSuggestionResponse {
  challenge: Challenge | null;
}
