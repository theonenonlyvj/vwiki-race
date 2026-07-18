import type {
  AbandonRunV2Response,
  AccountChallengeOutcomesResponse,
  AccountStatsResponse,
  BoardsTrendsResponse,
  BoardsTrendWindow,
  ChallengeBoardResponse,
  ChallengesSummaryResponse,
  ChallengeSuggestionResponse,
  ClickV2Response,
  CreateChallengeV2Response,
  DailyAdminStateResponse,
  DailyCapabilitiesResponse,
  LeaderboardResponse,
  RunPathResponse,
} from "../server/contracts";
import type {
  AccountStats,
  Challenge,
  ChallengeOutcomeEntry,
  ChallengeSummaryEntry,
  RankedLeaderboardRow,
  ServerPathStep,
} from "../domain/types";
import type { DailyFlavor, DailyNomination, DailyQueueEntry } from "../domain/dailyEditorial";
import type { ActiveRunRecord, RunRecordResponse } from "../server/trackingRepository";
import type { RecordClickV2Input } from "../server/runProtocol";
import { resolveApiOrigin } from "./apiOrigin";
import { defaultApiFetch, requestJson } from "./apiRequest";

const DEFAULT_API_ORIGIN = resolveApiOrigin(import.meta.env.VITE_VWIKI_RACE_API_URL, {
  production: import.meta.env.PROD,
});
const READ_TIMEOUT_MS = 10_000;
const MUTATION_TIMEOUT_MS = 15_000;
// Increment 5 (spec: "plus loading/timeout UX for the endpoint's up-to-~25s
// wall time"): comfortably above the documented ~25s worst case, with no
// automatic retry (see createRandomChallenge below) - a client-side timeout
// here does not mean the server-side attempt stopped, so silently retrying
// could immediately collide with the still-in-flight original and surface a
// confusing "in_progress" 429 right after what looks like a fresh request.
const RANDOM_CHALLENGE_TIMEOUT_MS = 35_000;

export interface CreateTrackedChallengeRequest {
  startTitle: string;
  targetTitle: string;
  nominateForDaily?: boolean;
}

export interface StartTrackedRunRequest {
  challengeId: string;
}

export type RecordTrackedClickRequest = Omit<RecordClickV2Input, "runId">;

export interface ApproveDailyNominationRequest {
  flavor?: DailyFlavor;
}

export interface QueueDailyChallengeRequest {
  challengeId: string;
  flavor: DailyFlavor;
}

export interface VWikiRaceDailyAdminApiClient {
  getCapabilities(token: string): Promise<DailyCapabilitiesResponse>;
  getDailyAdminState(token: string): Promise<DailyAdminStateResponse>;
  approveDailyNomination(
    nominationId: string,
    input: ApproveDailyNominationRequest,
    token: string,
  ): Promise<DailyQueueEntry>;
  declineDailyNomination(nominationId: string, token: string): Promise<DailyNomination>;
  queueDailyChallenge(input: QueueDailyChallengeRequest, token: string): Promise<DailyQueueEntry>;
  removeDailyQueueEntry(queueEntryId: string, token: string): Promise<DailyQueueEntry>;
}

export interface VWikiRaceApiClient extends VWikiRaceDailyAdminApiClient {
  listChallenges(): Promise<Challenge[]>;
  createChallenge(input: CreateTrackedChallengeRequest, token: string): Promise<CreateChallengeV2Response>;
  startRun(input: StartTrackedRunRequest, token: string): Promise<ActiveRunRecord>;
  getActiveRun(token: string): Promise<ActiveRunRecord | null>;
  getActiveRunPath(runId: string, token: string): Promise<ServerPathStep[]>;
  recordClick(runId: string, input: RecordTrackedClickRequest, token: string): Promise<ClickV2Response>;
  abandonRun(
    runId: string,
    token: string,
    input?: { recoveryProtocolVersion?: 1 },
  ): Promise<AbandonRunV2Response>;
  listLeaderboard(challengeId: string): Promise<RankedLeaderboardRow[]>;
  getChallengeBoard(challengeId: string): Promise<ChallengeBoardResponse>;
  getBoardsTrends(window: BoardsTrendWindow): Promise<BoardsTrendsResponse>;
  getRunPath(runId: string): Promise<ServerPathStep[]>;
  getAccountStats(token: string): Promise<AccountStats>;
  /**
   * Browse's per-card aggregate (Increment 5, unauthenticated - `GET
   * /api/v2/challenges/summary`). One entry per active challenge; the
   * caller matches entries to the catalog by `challengeId`.
   */
  getChallengesSummary(): Promise<ChallengeSummaryEntry[]>;
  /**
   * Browse's bulk state-chip data for the caller (Increment 5, authenticated
   * - `GET /api/v2/account/challenge-outcomes`). Absence of a challenge from
   * the result means the client's default "NEW" chip applies.
   */
  getAccountChallengeOutcomes(token: string): Promise<ChallengeOutcomeEntry[]>;
  /**
   * Home/Results' Play-another suggestion (Increment 5, authenticated - `GET
   * /api/v2/challenges/suggestion`). `null` once the caller has started
   * every active, non-daily challenge.
   */
  getPlayAnotherSuggestion(token: string): Promise<Challenge | null>;
  /**
   * On-demand random-challenge creation (Increment 5, authenticated - `POST
   * /api/v2/challenges/random`). No automatic retry (see
   * RANDOM_CHALLENGE_TIMEOUT_MS) - a fresh idempotency key every call, since
   * a caller-initiated retry after a genuine failure is a new attempt, not a
   * replay of one the caller gave up on.
   */
  createRandomChallenge(token: string): Promise<CreateChallengeV2Response>;
}

export interface VWikiRaceApiClientOptions {
  apiOrigin?: string;
}

export function createVWikiRaceApiClient(
  fetchImpl: typeof fetch = defaultApiFetch,
  options: VWikiRaceApiClientOptions = {},
): VWikiRaceApiClient {
  const apiOrigin = options.apiOrigin ?? DEFAULT_API_ORIGIN;
  const inFlight = new Map<string, Promise<unknown>>();
  const pathCache = new Map<string, ServerPathStep[]>();
  const statsCache = new Map<string, AccountStats>();
  const statsInFlight = new Map<string, Promise<AccountStats>>();
  let statsGeneration = 0;
  const url = (path: string) => `${apiOrigin}${path}`;
  const read = <T>(path: string, validate: (value: unknown) => value is T): Promise<T> => {
    const requestUrl = url(path);
    const existing = inFlight.get(requestUrl) as Promise<T> | undefined;
    if (existing) {
      return existing;
    }
    let request!: Promise<T>;
    request = requestJson(fetchImpl, requestUrl, {
      timeoutMs: READ_TIMEOUT_MS,
      retry: "read-once",
      validate,
    }).finally(() => {
      if (inFlight.get(requestUrl) === request) {
        inFlight.delete(requestUrl);
      }
    });
    inFlight.set(requestUrl, request);
    return request;
  };

  return {
    async listChallenges() {
      return (await read(urlPath.challenges, isChallengesResponse)).challenges;
    },
    async createChallenge(input, token) {
      const response = await write(urlPath.challenges, input, token, isCreateChallengeResponse, true);
      invalidateStats();
      invalidateChallengeCatalog();
      return response;
    },
    async startRun(input, token) {
      const response = await write(urlPath.startRun, input, token, isStartRunResponse, true);
      invalidateStats();
      return response.run;
    },
    async getActiveRun(token) {
      return (await authenticatedRead(urlPath.activeRun, token, isActiveRunResponse)).run;
    },
    async getActiveRunPath(runId, token) {
      return (await authenticatedRead(
        urlPath.run(runId, "recovery-path"),
        token,
        isRunPathResponse,
      )).path;
    },
    async recordClick(runId, input, token) {
      const response = await write(urlPath.run(runId, "click"), input, token, isClickResponse, true);
      invalidateStats();
      return response;
    },
    async abandonRun(runId, token, input) {
      const response = await write(
        urlPath.run(runId, "abandon"),
        input ?? {},
        token,
        isAbandonRunResponse,
        true,
        abandonIdempotencyKey(runId),
      );
      invalidateStats();
      return response;
    },
    async listLeaderboard(challengeId) {
      return (await read(urlPath.leaderboard(challengeId), isLeaderboardResponse)).leaderboard;
    },
    async getChallengeBoard(challengeId) {
      return read(urlPath.board(challengeId), isChallengeBoardResponse);
    },
    async getBoardsTrends(window) {
      return read(urlPath.boardsTrends(window), isBoardsTrendsResponse);
    },
    async getRunPath(runId) {
      const cached = pathCache.get(runId);
      if (cached) return cached;
      const path = (await read(urlPath.run(runId, "path"), isRunPathResponse)).path;
      pathCache.set(runId, path);
      return path;
    },
    async getAccountStats(token) {
      const cached = statsCache.get(token);
      if (cached) return cached;
      const existing = statsInFlight.get(token);
      if (existing) return existing;
      const generation = statsGeneration;
      let pending!: Promise<AccountStats>;
      pending = authenticatedRead(
        urlPath.accountStats,
        token,
        isAccountStatsResponse,
      ).then((response) => {
        if (generation === statsGeneration) {
          statsCache.set(token, response.stats);
        }
        return response.stats;
      }).finally(() => {
        if (statsInFlight.get(token) === pending) {
          statsInFlight.delete(token);
        }
      });
      statsInFlight.set(token, pending);
      return pending;
    },
    async getChallengesSummary() {
      return (await read(urlPath.challengesSummary, isChallengesSummaryResponse)).challenges;
    },
    async getAccountChallengeOutcomes(token) {
      return (await authenticatedRead(
        urlPath.accountChallengeOutcomes,
        token,
        isAccountChallengeOutcomesResponse,
      )).outcomes;
    },
    async getPlayAnotherSuggestion(token) {
      return (await authenticatedRead(
        urlPath.challengeSuggestion,
        token,
        isChallengeSuggestionResponse,
      )).challenge;
    },
    async createRandomChallenge(token) {
      const response = await requestJson(fetchImpl, url(urlPath.randomChallenge), {
        method: "POST",
        body: {},
        token,
        timeoutMs: RANDOM_CHALLENGE_TIMEOUT_MS,
        retry: "never",
        idempotencyKey: createIdempotencyKey(),
        validate: isCreateChallengeResponse,
      });
      invalidateStats();
      invalidateChallengeCatalog();
      return response;
    },
    async getCapabilities(token) {
      return authenticatedRead(urlPath.capabilities, token, isDailyCapabilitiesResponse);
    },
    async getDailyAdminState(token) {
      return authenticatedRead(urlPath.adminDailies, token, isDailyAdminStateResponse);
    },
    async approveDailyNomination(nominationId, input, token) {
      const response = await write(
        urlPath.dailyNomination(nominationId, "approve"),
        input,
        token,
        isDailyQueueEntry,
        true,
      );
      invalidateChallengeCatalog();
      return response;
    },
    async declineDailyNomination(nominationId, token) {
      const response = await write(
        urlPath.dailyNomination(nominationId, "decline"),
        {},
        token,
        isDailyNomination,
        true,
      );
      invalidateChallengeCatalog();
      return response;
    },
    async queueDailyChallenge(input, token) {
      const response = await write(
        urlPath.dailyQueue,
        input,
        token,
        isDailyQueueEntry,
        true,
      );
      invalidateChallengeCatalog();
      return response;
    },
    async removeDailyQueueEntry(queueEntryId, token) {
      const response = await write(
        urlPath.dailyQueueEntry(queueEntryId),
        {},
        token,
        isDailyQueueEntry,
        true,
        undefined,
        "DELETE",
      );
      invalidateChallengeCatalog();
      return response;
    },
  };

  function write<T>(
    path: string,
    body: unknown,
    token: string,
    validate: (value: unknown) => value is T,
    retryable = false,
    stableIdempotencyKey?: string,
    method: "POST" | "DELETE" = "POST",
  ): Promise<T> {
    return requestJson(fetchImpl, url(path), {
      method: method as "POST",
      body,
      token,
      timeoutMs: MUTATION_TIMEOUT_MS,
      retry: retryable ? "idempotent-once" : "never",
      idempotencyKey: retryable
        ? stableIdempotencyKey ?? createIdempotencyKey()
        : undefined,
      validate,
    });
  }

  function authenticatedRead<T>(
    path: string,
    token: string,
    validate: (value: unknown) => value is T,
  ): Promise<T> {
    return requestJson(fetchImpl, url(path), {
      token,
      timeoutMs: READ_TIMEOUT_MS,
      retry: "read-once",
      validate,
    });
  }

  function invalidateStats(): void {
    statsGeneration += 1;
    statsCache.clear();
    statsInFlight.clear();
  }

  function invalidateChallengeCatalog(): void {
    inFlight.delete(url(urlPath.challenges));
  }
}

const urlPath = {
  challenges: "/api/v2/challenges",
  startRun: "/api/v2/runs/start",
  activeRun: "/api/v2/runs/active",
  accountStats: "/api/v2/accounts/me/stats",
  capabilities: "/api/v2/accounts/me/capabilities",
  adminDailies: "/api/v2/admin/dailies",
  dailyNomination: (nominationId: string, action: "approve" | "decline") =>
    `/api/v2/admin/daily-nominations/${encodeURIComponent(nominationId)}/${action}`,
  dailyQueue: "/api/v2/admin/daily-queue",
  dailyQueueEntry: (queueEntryId: string) =>
    `/api/v2/admin/daily-queue/${encodeURIComponent(queueEntryId)}`,
  run: (runId: string, action: string) =>
    `/api/v2/runs/${encodeURIComponent(runId)}/${action}`,
  leaderboard: (challengeId: string) =>
    `/api/v2/challenges/${encodeURIComponent(challengeId)}/leaderboard`,
  board: (challengeId: string) =>
    `/api/v2/challenges/${encodeURIComponent(challengeId)}/board`,
  boardsTrends: (window: BoardsTrendWindow) =>
    `/api/v2/boards/trends?window=${encodeURIComponent(window)}`,
  challengesSummary: "/api/v2/challenges/summary",
  accountChallengeOutcomes: "/api/v2/account/challenge-outcomes",
  challengeSuggestion: "/api/v2/challenges/suggestion",
  randomChallenge: "/api/v2/challenges/random",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isChallengesResponse(value: unknown): value is { challenges: Challenge[] } {
  return isRecord(value) && Array.isArray(value.challenges) && value.challenges.every(isChallenge);
}

function isCreateChallengeResponse(value: unknown): value is CreateChallengeV2Response {
  return isRecord(value) &&
    isChallenge(value.challenge) &&
    (value.disposition === "created" || value.disposition === "existing") &&
    (value.nomination === "not_requested" ||
      value.nomination === "pending" ||
      value.nomination === "already_exists" ||
      value.nomination === "previously_featured" ||
      value.nomination === "account_required");
}

function isStartRunResponse(value: unknown): value is { run: ActiveRunRecord } {
  return isRecord(value) && isActiveRun(value.run) && value.run.status === "active";
}

function isClickResponse(value: unknown): value is ClickV2Response {
  return isRecord(value) && isRunTransition(value.transition) &&
    (value.leaderboardContext === undefined || isLeaderboardContext(value.leaderboardContext));
}

function isAbandonRunResponse(value: unknown): value is AbandonRunV2Response {
  return isRecord(value) && hasString(value, "runId") &&
    (value.runStatus === "abandoned" || value.runStatus === "completed");
}

function isLeaderboardResponse(value: unknown): value is LeaderboardResponse {
  return isRecord(value) &&
    Array.isArray(value.leaderboard) &&
    value.leaderboard.every(isLeaderboardRow);
}

function isChallengeBoardResponse(value: unknown): value is ChallengeBoardResponse {
  return isRecord(value) &&
    hasString(value, "challengeId") &&
    Array.isArray(value.placements) && value.placements.every(isChallengeBoardPlacement) &&
    Array.isArray(value.dnfs) && value.dnfs.every(isChallengeBoardDnfRow);
}

function isChallengeBoardPlacement(value: unknown): value is ChallengeBoardResponse["placements"][number] {
  return isRecord(value) &&
    hasString(value, "accountId") &&
    (value.displayName === null || hasString(value, "displayName")) &&
    hasNumber(value, "placement") &&
    hasNumber(value, "elapsedMs") &&
    hasNumber(value, "clickCount");
}

function isChallengeBoardDnfRow(value: unknown): value is ChallengeBoardResponse["dnfs"][number] {
  return isRecord(value) &&
    hasString(value, "accountId") &&
    (value.displayName === null || hasString(value, "displayName")) &&
    hasNumber(value, "clickCount") &&
    hasNumber(value, "elapsedMs");
}

function isBoardsTrendsResponse(value: unknown): value is BoardsTrendsResponse {
  return isRecord(value) &&
    (value.window === "7" || value.window === "30" || value.window === "lifetime") &&
    hasNumber(value, "guard") &&
    Array.isArray(value.ranked) && value.ranked.every(isDailyTrendRankedEntry) &&
    Array.isArray(value.unranked) && value.unranked.every(isDailyTrendUnrankedEntry);
}

function isDailyTrendRankedEntry(value: unknown): value is BoardsTrendsResponse["ranked"][number] {
  return isRecord(value) &&
    hasString(value, "accountId") &&
    (value.displayName === null || hasString(value, "displayName")) &&
    hasNumber(value, "avgPlacement") &&
    hasNumber(value, "playedCount") &&
    // F3: `prevAvgPlacement` is nullable (unranked/absent previous window,
    // or lifetime - "no arrow"); also tolerated as entirely absent so an
    // older cached response shape doesn't hard-fail validation.
    (value.prevAvgPlacement === undefined ||
      value.prevAvgPlacement === null ||
      hasNumber(value, "prevAvgPlacement"));
}

function isDailyTrendUnrankedEntry(value: unknown): value is BoardsTrendsResponse["unranked"][number] {
  return isRecord(value) &&
    hasString(value, "accountId") &&
    (value.displayName === null || hasString(value, "displayName")) &&
    hasNumber(value, "playedCount");
}

function isRunPathResponse(value: unknown): value is RunPathResponse {
  return isRecord(value) && Array.isArray(value.path) && value.path.every(isPathStep);
}

function isActiveRunResponse(value: unknown): value is { run: ActiveRunRecord | null } {
  return isRecord(value) && (
    value.run === null ||
    (isActiveRun(value.run) && value.run.status === "active")
  );
}

function isAccountStatsResponse(value: unknown): value is AccountStatsResponse {
  return isRecord(value) && isAccountStats(value.stats);
}

function isChallengesSummaryResponse(value: unknown): value is ChallengesSummaryResponse {
  return isRecord(value) &&
    Array.isArray(value.challenges) && value.challenges.every(isChallengeSummaryEntry);
}

function isChallengeSummaryEntry(value: unknown): value is ChallengeSummaryEntry {
  return isRecord(value) &&
    hasString(value, "challengeId") &&
    hasNumber(value, "playerCount") &&
    (value.best === null || isBestTimeClicks(value.best));
}

function isAccountChallengeOutcomesResponse(
  value: unknown,
): value is AccountChallengeOutcomesResponse {
  return isRecord(value) &&
    Array.isArray(value.outcomes) && value.outcomes.every(isChallengeOutcomeEntry);
}

function isChallengeOutcomeEntry(value: unknown): value is ChallengeOutcomeEntry {
  if (!isRecord(value) ||
    !hasString(value, "challengeId") ||
    !(value.outcome === "completed" || value.outcome === "dnf")) {
    return false;
  }
  // Doc comment on ChallengeOutcomeEntry: "`best` is populated only for
  // `outcome: 'completed'`" - enforced here, not just documented.
  return value.outcome === "completed" ? isBestTimeClicks(value.best) : value.best === null;
}

function isChallengeSuggestionResponse(value: unknown): value is ChallengeSuggestionResponse {
  return isRecord(value) && (value.challenge === null || isChallenge(value.challenge));
}

function isBestTimeClicks(value: unknown): value is { elapsedMs: number; clickCount: number } {
  return isRecord(value) && hasNumber(value, "elapsedMs") && hasNumber(value, "clickCount");
}

function isDailyCapabilitiesResponse(value: unknown): value is DailyCapabilitiesResponse {
  return isRecord(value) && typeof value.canManageDailies === "boolean";
}

function isDailyAdminStateResponse(value: unknown): value is DailyAdminStateResponse {
  return isRecord(value) &&
    Array.isArray(value.nominations) && value.nominations.every(isDailyNomination) &&
    Array.isArray(value.queueEntries) && value.queueEntries.every(isDailyQueueEntry);
}

function isChallenge(value: unknown): value is Challenge {
  return isRecord(value) &&
    hasString(value, "id") &&
    hasOptionalType(value, "label", "string") &&
    hasOptionalNumber(value, "sortOrder") &&
    hasOptionalType(value, "isActive", "boolean") &&
    hasOptionalType(value, "dateKey", "string") &&
    (value.mode === "solo" || value.mode === "daily") &&
    isArticleRef(value.start) &&
    isArticleRef(value.target) &&
    value.ruleset === "ranked_classic" &&
    hasCoherentChallengeProvenance(value) &&
    (value.createdBy === undefined || isChallengeCreator(value.createdBy));
}

function hasCoherentChallengeProvenance(value: Record<string, unknown>): boolean {
  if (value.dailyFeature !== undefined && value.dailyFeature !== null) {
    if (!isDailyFeature(value.dailyFeature)) return false;
    return value.mode === "daily" &&
      value.origin === "daily" &&
      value.dailyDate === value.dailyFeature.dailyDate &&
      value.source === (value.dailyFeature.selectionSource === "automatic"
        ? "wikipedia_random"
        : "curated");
  }
  const hasNoDailyDate = value.dailyDate === undefined || value.dailyDate === null;
  if (value.origin === undefined) {
    return value.source === "curated" && hasNoDailyDate;
  }
  if (value.origin === "manual") {
    return value.source === "curated" && hasNoDailyDate;
  }
  if (value.origin === "daily") {
    return value.source === "wikipedia_random" && isStrictCalendarDate(value.dailyDate);
  }
  return false;
}

function isDailyFeature(value: unknown): value is NonNullable<Challenge["dailyFeature"]> {
  return isRecord(value) &&
    isStrictCalendarDate(value.dailyDate) &&
    isDailyFlavor(value.flavor) &&
    isDailySelectionSource(value.selectionSource);
}

function isDailyFlavor(value: unknown): value is DailyFlavor {
  return value === "recognizable" || value === "weird" || value === "hard";
}

function isDailySelectionSource(value: unknown): boolean {
  return value === "automatic" || value === "community" || value === "admin";
}

function isStrictCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function hasString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === "string" && value[key].length > 0;
}

function hasNumber(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === "number" && Number.isFinite(value[key]);
}

function hasOptionalNumber(value: Record<string, unknown>, key: string): boolean {
  return value[key] === undefined || hasNumber(value, key);
}

function hasNullableNumber(value: Record<string, unknown>, key: string): boolean {
  return value[key] === null || hasNumber(value, key);
}

function hasOptionalString(value: Record<string, unknown>, key: string): boolean {
  return value[key] === undefined || hasString(value, key);
}

function hasOptionalType(
  value: Record<string, unknown>,
  key: string,
  type: "boolean" | "string",
): boolean {
  return value[key] === undefined || typeof value[key] === type;
}

function isArticleRef(value: unknown): value is Challenge["start"] {
  return isRecord(value) &&
    hasString(value, "title") &&
    hasOptionalNumber(value, "pageId");
}

function isChallengeCreator(value: unknown): value is NonNullable<Challenge["createdBy"]> {
  return isRecord(value) &&
    hasString(value, "accountId") &&
    hasString(value, "displayName") &&
    (value.identityStatus === "ghost" ||
      value.identityStatus === "claimed" ||
      value.identityStatus === "merged");
}

function isDailyNomination(value: unknown): value is DailyNomination {
  if (!isRecord(value) ||
    !hasString(value, "id") ||
    !hasString(value, "challengeId") ||
    !hasString(value, "nominatedByAccountId") ||
    !hasString(value, "nominatedByDisplayName") ||
    !(value.status === "pending" || value.status === "approved" || value.status === "declined") ||
    !hasNullableNumber(value, "recognizableScore") ||
    !hasNullableNumber(value, "weirdScore") ||
    !hasNullableNumber(value, "hardScore") ||
    !(value.suggestedFlavor === null || isDailyFlavor(value.suggestedFlavor)) ||
    !(value.confidence === "high" || value.confidence === "medium" ||
      value.confidence === "low" || value.confidence === "unclassified") ||
    !hasString(value, "classifierVersion") ||
    !hasString(value, "createdAt") ||
    !hasString(value, "updatedAt")) {
    return false;
  }

  if (value.status === "pending") {
    return value.reviewedByAccountId === null && value.reviewedAt === null;
  }
  return hasString(value, "reviewedByAccountId") && hasString(value, "reviewedAt");
}

function isDailyQueueEntry(value: unknown): value is DailyQueueEntry {
  if (!isRecord(value) ||
    !hasString(value, "id") ||
    !hasString(value, "challengeId") ||
    !(value.nominationId === null || hasString(value, "nominationId")) ||
    !isDailyFlavor(value.flavor) ||
    !(value.source === "community" || value.source === "admin") ||
    !(value.status === "queued" || value.status === "consumed" ||
      value.status === "removed" || value.status === "invalid") ||
    !hasString(value, "queuedByAccountId") ||
    !hasString(value, "queuedAt") ||
    !hasString(value, "updatedAt")) {
    return false;
  }

  if (value.status === "consumed") {
    return isStrictCalendarDate(value.consumedDailyDate) && hasString(value, "consumedAt");
  }
  return value.consumedDailyDate === null && value.consumedAt === null;
}

function isRunRecord(value: unknown): value is RunRecordResponse {
  return isRecord(value) &&
    hasString(value, "id") &&
    hasString(value, "challengeId") &&
    hasString(value, "accountId") &&
    (value.status === "active" || value.status === "completed" || value.status === "abandoned") &&
    hasString(value, "startTitle") &&
    hasString(value, "targetTitle") &&
    hasNumber(value, "clickCount") &&
    hasString(value, "startedAt") &&
    hasOptionalString(value, "completedAt") &&
    hasOptionalNumber(value, "elapsedMs");
}

function isActiveRun(value: unknown): value is ActiveRunRecord {
  return isRecord(value) && isRunRecord(value) &&
    (value.protocolVersion === 1 || value.protocolVersion === 2) &&
    hasString(value, "canonicalAccountId");
}

function isRunTransition(value: unknown): value is ClickV2Response["transition"] {
  return isRecord(value) && hasString(value, "runId") && hasNumber(value, "clickCount") &&
    (value.runStatus === "active" || value.runStatus === "completed") &&
    (value.runStatus !== "completed" || (hasString(value, "completedAt") && hasNumber(value, "elapsedMs")));
}

function isLeaderboardContext(value: unknown): boolean {
  return isRecord(value) && typeof value.isPersonalBest === "boolean" &&
    (value.rank === null || hasNumber(value, "rank"));
}

function isAccountStats(value: unknown): value is AccountStats {
  if (!isRecord(value) || !isRecord(value.totals)) return false;
  const totals = value.totals;
  return ["attempts", "completed", "abandoned", "timedCompleted", "totalClicks"].every((key) => hasNumber(totals, key)) &&
    (totals.bestClicks === null || hasNumber(totals, "bestClicks")) &&
    (totals.bestElapsedMs === null || hasNumber(totals, "bestElapsedMs")) &&
    hasNumber(totals, "averageClicks") &&
    hasNumber(totals, "averageElapsedMs") &&
    [value.topStarts, value.topTargets, value.mostVisited].every((rows) =>
      Array.isArray(rows) && rows.every((row) => isRecord(row) && hasString(row, "title") && hasNumber(row, "count")),
    ) &&
    hasNumber(value, "dailyStreak") &&
    isAccountTrend30(value.trend30);
}

function isAccountTrend30(value: unknown): value is AccountStats["trend30"] {
  return isRecord(value) &&
    (value.avgPlacement === null || hasNumber(value, "avgPlacement")) &&
    hasNumber(value, "playedCount") &&
    typeof value.ranked === "boolean";
}

function isLeaderboardRow(value: unknown): value is RankedLeaderboardRow {
  return isRecord(value) &&
    hasNumber(value, "rank") &&
    hasString(value, "runId") &&
    hasString(value, "challengeId") &&
    hasString(value, "accountId") &&
    hasString(value, "displayName") &&
    (value.status === "completed" || value.status === "abandoned") &&
    typeof value.isRepeatRun === "boolean" &&
    hasString(value, "startedAt") &&
    hasNumber(value, "elapsedMs") &&
    hasNumber(value, "clickCount") &&
    hasOptionalString(value, "completedAt") &&
    hasOptionalString(value, "abandonedAt") &&
    (value.status !== "completed" || hasString(value, "completedAt")) &&
    (value.status !== "abandoned" || hasString(value, "abandonedAt")) &&
    (value.protocolVersion === 1 || value.protocolVersion === 2);
}

function isPathStep(value: unknown): value is ServerPathStep {
  return isRecord(value) &&
    hasNumber(value, "stepNumber") &&
    hasString(value, "sourceTitle") &&
    hasString(value, "clickedAnchorText") &&
    hasString(value, "destinationTitle") &&
    hasOptionalNumber(value, "destinationPageId") &&
    hasOptionalNumber(value, "elapsedSinceStartMs") &&
    hasString(value, "createdAt");
}

function createIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

function abandonIdempotencyKey(runId: string): string {
  return `vwiki-race-abandon:${runId}`;
}
