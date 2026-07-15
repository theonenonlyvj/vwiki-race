import type { AbandonRunV2Response, AccountStatsResponse, ClickV2Response, LeaderboardResponse, RunPathResponse } from "../server/contracts";
import type { AccountStats, Challenge, RankedLeaderboardRow, ServerPathStep } from "../domain/types";
import type { ActiveRunRecord, RunRecordResponse } from "../server/trackingRepository";
import type { RecordClickV2Input } from "../server/runProtocol";
import { resolveApiOrigin } from "./apiOrigin";
import { defaultApiFetch, requestJson } from "./apiRequest";

const DEFAULT_API_ORIGIN = resolveApiOrigin(import.meta.env.VITE_VWIKI_RACE_API_URL, {
  production: import.meta.env.PROD,
});
const READ_TIMEOUT_MS = 10_000;
const MUTATION_TIMEOUT_MS = 15_000;

export interface CreateTrackedChallengeRequest {
  startTitle: string;
  targetTitle: string;
}

export interface StartTrackedRunRequest {
  challengeId: string;
}

export type RecordTrackedClickRequest = Omit<RecordClickV2Input, "runId">;

export interface VWikiRaceApiClient {
  listChallenges(): Promise<Challenge[]>;
  createChallenge(input: CreateTrackedChallengeRequest, token: string): Promise<Challenge>;
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
  getRunPath(runId: string): Promise<ServerPathStep[]>;
  getAccountStats(token: string): Promise<AccountStats>;
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
    const request = requestJson(fetchImpl, requestUrl, {
      timeoutMs: READ_TIMEOUT_MS,
      retry: "read-once",
      validate,
    }).finally(() => inFlight.delete(requestUrl));
    inFlight.set(requestUrl, request);
    return request;
  };

  return {
    async listChallenges() {
      return (await read(urlPath.challenges, isChallengesResponse)).challenges;
    },
    async createChallenge(input, token) {
      const response = await write(urlPath.challenges, input, token, isChallengeResponse, true);
      invalidateStats();
      return response.challenge;
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
  };

  function write<T>(
    path: string,
    body: unknown,
    token: string,
    validate: (value: unknown) => value is T,
    retryable = false,
    stableIdempotencyKey?: string,
  ): Promise<T> {
    return requestJson(fetchImpl, url(path), {
      method: "POST",
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
}

const urlPath = {
  challenges: "/api/v2/challenges",
  startRun: "/api/v2/runs/start",
  activeRun: "/api/v2/runs/active",
  accountStats: "/api/v2/accounts/me/stats",
  run: (runId: string, action: string) =>
    `/api/v2/runs/${encodeURIComponent(runId)}/${action}`,
  leaderboard: (challengeId: string) =>
    `/api/v2/challenges/${encodeURIComponent(challengeId)}/leaderboard`,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isChallengesResponse(value: unknown): value is { challenges: Challenge[] } {
  return isRecord(value) && Array.isArray(value.challenges) && value.challenges.every(isChallenge);
}

function isChallengeResponse(value: unknown): value is { challenge: Challenge } {
  return isRecord(value) && isChallenge(value.challenge);
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
    );
}

function isLeaderboardRow(value: unknown): value is RankedLeaderboardRow {
  return isRecord(value) &&
    hasNumber(value, "rank") &&
    hasString(value, "runId") &&
    hasString(value, "challengeId") &&
    hasString(value, "accountId") &&
    hasString(value, "displayName") &&
    hasNumber(value, "elapsedMs") &&
    hasNumber(value, "clickCount") &&
    hasString(value, "completedAt") &&
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
