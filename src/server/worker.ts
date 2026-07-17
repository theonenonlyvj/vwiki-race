/// <reference types="@cloudflare/workers-types" />

import type { AuthorizedAccount } from "../domain/types";
import { dailyFlavorForCentralDate } from "../domain/dailyEditorial";
import { createApiHandlers, type ApiHandlers } from "./apiHandlers";
import { createD1TrackingRepository } from "./d1TrackingRepository";
import { ApiError } from "./http";
import {
  createVGamesIdentityClient,
  type VGamesIdentityClient,
} from "./vgamesIdentityClient";
import { createWikipediaChallengeValidator } from "./wikipediaChallengeValidator";
import {
  createDailyChallengeCandidateSource,
  type DailyCandidateRequest,
  type DailyChallengeCandidate,
} from "./dailyChallengeCandidates";
import { createWorkerWikipediaGateway } from "./workerWikipediaGateway";
import type { RunProtocolRepository } from "./trackingRepository";
import { legacyCreateOperationKey } from "./runProtocol";

interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  VWIKI_RACE_DB: D1Database;
  VGAMES_IDENTITY?: Pick<Fetcher, "fetch">;
  VGAMES_URL: string;
  ALLOWED_ORIGINS?: string;
  CLICK_RATE_LIMITER: RateLimiter;
  ACCOUNT_READ_RATE_LIMITER: RateLimiter;
  CHALLENGE_CREATE_RATE_LIMITER: RateLimiter;
  CLIENT_ERROR_RATE_LIMITER?: RateLimiter;
}

type AuthorizedVGamesAccount = AuthorizedAccount;

export interface WorkerTracking {
  handlers: ApiHandlers;
  identity: VGamesIdentityClient;
  runProtocol?: RunProtocolRepository;
  authorize(request: Request): Promise<AuthorizedVGamesAccount>;
}

export interface WorkerOptions {
  createTracking?: (env: Env) => WorkerTracking;
  createDailyCandidateSource?: () => {
    findCandidate(request: DailyCandidateRequest): Promise<DailyChallengeCandidate>;
  };
  now?: () => Date;
}

export function createWorker(options: WorkerOptions = {}) {
  const buildTracking = options.createTracking ?? createTracking;
  const now = options.now ?? (() => new Date());
  const buildDailyCandidateSource = options.createDailyCandidateSource ?? (() =>
    createDailyChallengeCandidateSource({
      fetchImpl: fetch,
      gateway: createWorkerWikipediaGateway(fetch),
      onDiagnostic: logDailyCandidateDiagnostic,
    }));

  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const startedAt = Date.now();
      const requestId = crypto.randomUUID();
      const corsHeaders = corsHeadersFor(request, env);
      let response: Response;
      if (request.method === "OPTIONS") {
        response = new Response(null, { status: 204, headers: corsHeaders });
        logRequest(request, response.status, requestId, startedAt);
        return response;
      }

      const url = new URL(request.url);
      const tracking = buildTracking(env);

      try {
        const v2Response = await dispatchV2(request, url, tracking, corsHeaders, env, requestId);
        if (v2Response) {
          response = v2Response;
        } else {
          response = await dispatchLegacy(request, url, tracking, corsHeaders, env);
        }
      } catch (caught) {
        response = error(caught, corsHeaders, requestId);
      }
      response.headers.set("X-Request-Id", requestId);
      logRequest(request, response.status, requestId, startedAt, response.status >= 400 ? "request_failed" : undefined);
      return response;
    },

    async scheduled(
      controller: Pick<ScheduledController, "scheduledTime" | "cron">,
      env: Env,
    ): Promise<void> {
      const scheduledAt = new Date(controller.scheduledTime);
      if (scheduledAt.getTime() > now().getTime() + 5 * 60 * 1000) {
        logDailyJob("future_trigger_ignored", {
          scheduledAt: scheduledAt.toISOString(),
        });
        return;
      }
      const dailyDate = centralDailyDateAtFive(scheduledAt);
      const isRetryTrigger = controller.cron === "17 * * * *";
      if (!dailyDate && !isRetryTrigger) {
        logDailyJob("outside_central_window", {
          scheduledAt: scheduledAt.toISOString(),
        });
        return;
      }

      const tracking = buildTracking(env);
      const repository = protocol(tracking);
      if (dailyDate) {
        await repository.ensureDailyChallengeJob(dailyDate);
      }
      const job = await repository.claimDueDailyChallengeJob();
      if (!job) {
        logDailyJob("no_due_job", { dailyDate: dailyDate ?? "retry" });
        return;
      }

      logDailyJob("claimed", { dailyDate: job.dailyDate, attemptCount: job.attemptCount });
      try {
        const candidate = await buildDailyCandidateSource().findCandidate({
          dailyDate: job.dailyDate,
          flavor: dailyFlavorForCentralDate(job.dailyDate),
        });
        const challenge = await repository.acceptDailyChallenge(job, candidate);
        logDailyJob("accepted", {
          dailyDate: job.dailyDate,
          attemptCount: job.attemptCount,
          challengeId: challenge.id,
        });
      } catch (caught) {
        const failureCode = dailyFailureCode(caught);
        try {
          await repository.failDailyChallengeJob(job, failureCode);
        } catch {
          logDailyJob("failure_record_failed", { dailyDate: job.dailyDate, failureCode });
        }
        logDailyJob("failed", { dailyDate: job.dailyDate, attemptCount: job.attemptCount, failureCode });
        throw caught;
      }
    },
  };
}

export default createWorker();

async function dispatchV2(
  request: Request,
  url: URL,
  tracking: WorkerTracking,
  corsHeaders: HeadersInit,
  env: Env,
  requestId: string,
): Promise<Response | null> {
  if (request.method === "POST" && url.pathname === "/api/client-error") {
    return handleClientError(request, env, corsHeaders, requestId);
  }

  if (!url.pathname.startsWith("/api/v2/")) {
    return null;
  }

  if (request.method === "GET" && url.pathname === "/api/v2/challenges") {
    return json(await tracking.handlers.listChallenges(), { headers: publicCacheHeaders() }, corsHeaders);
  }
  if (request.method === "POST" && url.pathname === "/api/v2/challenges") {
    const account = await tracking.authorize(request);
    await enforceChallengeCreateRateLimit(env, account.accountId);
    const input = challengeInput(await readJson(request));
    return json(
      await tracking.handlers.createChallengeV2(account, input, requireIdempotencyKey(request)),
      undefined,
      corsHeaders,
    );
  }
  if (request.method === "POST" && url.pathname === "/api/v2/runs/start") {
    const account = await tracking.authorize(request);
    const input = startInput(await readJson(request));
    return json(
      { run: await protocol(tracking).startRunV2(account, {
        challengeId: input.challengeId,
        idempotencyKey: requireIdempotencyKey(request),
      }) },
      undefined,
      corsHeaders,
    );
  }
  if (request.method === "GET" && url.pathname === "/api/v2/runs/active") {
    const account = await tracking.authorize(request);
    await enforceAccountReadRateLimit(env, account.accountId, "active");
    return json({ run: await protocol(tracking).findActiveRun(account) }, undefined, corsHeaders);
  }
  if (request.method === "GET" && url.pathname === "/api/v2/accounts/me/stats") {
    const account = await tracking.authorize(request);
    await enforceAccountReadRateLimit(env, account.accountId, "stats");
    return json({ stats: await protocol(tracking).getAccountStats(account) }, undefined, corsHeaders);
  }
  if (request.method === "POST" && url.pathname === "/api/v2/identity/guest") {
    return json(
      await tracking.identity.quick(guestIdentityInput(await readJson(request))),
      undefined,
      corsHeaders,
    );
  }
  if (request.method === "POST" && url.pathname === "/api/v2/identity/secure") {
    return json(
      await tracking.identity.secure(secureIdentityInput(await readJson(request))),
      undefined,
      corsHeaders,
    );
  }
  if (request.method === "POST" && url.pathname === "/api/v2/identity/login") {
    return json(
      await tracking.identity.login(loginIdentityInput(await readJson(request))),
      undefined,
      corsHeaders,
    );
  }

  const leaderboardMatch = url.pathname.match(
    /^\/api\/v2\/challenges\/([^/]+)\/leaderboard$/,
  );
  if (request.method === "GET" && leaderboardMatch?.[1]) {
    return json(
      await tracking.handlers.listLeaderboard(decodeURIComponent(leaderboardMatch[1])),
      { headers: noStoreHeaders() },
      corsHeaders,
    );
  }

  const runMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/([^/]+)$/);
  if (runMatch?.[1] && runMatch[2]) {
    const runId = decodeURIComponent(runMatch[1]);
    const action = runMatch[2];
    if (request.method === "GET" && action === "recovery-path") {
      const account = await tracking.authorize(request);
      await enforceAccountReadRateLimit(env, account.accountId, "recovery-path");
      return json(
        { path: await protocol(tracking).getRecoveryRunPath(account, runId) },
        undefined,
        corsHeaders,
      );
    }
    if (request.method === "GET" && action === "path") {
      return json({ path: await protocol(tracking).getPublicRunPath(runId) }, undefined, corsHeaders);
    }
    if (request.method === "POST" && action === "click") {
      const account = await tracking.authorize(request);
      await enforceClickRateLimit(env, account.accountId);
      return json(
        await protocol(tracking).recordClickV2(account, {
          ...clickInput(await readJson(request)),
          runId,
        }),
        undefined,
        corsHeaders,
      );
    }
    if (request.method === "POST" && action === "abandon") {
      const account = await tracking.authorize(request);
      const input = abandonInput(await readJson(request));
      return json(
        await protocol(tracking).abandonRunV2(account, {
          runId,
          idempotencyKey: requireIdempotencyKey(request),
          recoveryProtocolVersion: input.recoveryProtocolVersion,
        }),
        undefined,
        corsHeaders,
      );
    }
  }

  return json(
    { error: { code: "not_found", message: "Not found." } },
    { status: 404 },
    corsHeaders,
  );
}

async function dispatchLegacy(
  request: Request,
  url: URL,
  tracking: WorkerTracking,
  corsHeaders: HeadersInit,
  env: Env,
): Promise<Response> {
  if (request.method === "GET" && url.pathname === "/api/challenges") {
    return json(
      await tracking.handlers.listChallenges(),
      { headers: publicCacheHeaders() },
      corsHeaders,
    );
  }
  if (request.method === "POST" && url.pathname === "/api/challenges") {
    const account = await tracking.authorize(request);
    await enforceChallengeCreateRateLimit(env, account.accountId);
    const input = challengeInput(await readJson(request));
    return json(
      await tracking.handlers.createChallengeV2(
        account,
        input,
        await legacyCreateOperationKey(account.accountId, input),
      ),
      undefined,
      corsHeaders,
    );
  }
  if (request.method === "POST" && url.pathname === "/api/identity/guest") {
    return json(
      await tracking.identity.quick(guestIdentityInput(await readJson(request))),
      undefined,
      corsHeaders,
    );
  }
  if (request.method === "POST" && url.pathname === "/api/identity/secure") {
    return json(
      await tracking.identity.secure(secureIdentityInput(await readJson(request))),
      undefined,
      corsHeaders,
    );
  }
  if (request.method === "POST" && url.pathname === "/api/identity/login") {
    return json(
      await tracking.identity.login(loginIdentityInput(await readJson(request))),
      undefined,
      corsHeaders,
    );
  }
  if (request.method === "POST" && url.pathname === "/api/runs/start") {
    const account = await tracking.authorize(request);
    const input = startInput(await readJson(request));
    if (tracking.runProtocol) {
      return json(
        {
          run: await tracking.runProtocol.startRunLegacy(account, {
            challengeId: input.challengeId,
          }),
        },
        undefined,
        corsHeaders,
      );
    }
    return json(
      await tracking.handlers.startRun({
        challengeId: input.challengeId,
        accountId: account.accountId,
        publicName: account.displayName,
        identityStatus: account.status,
      }),
      undefined,
      corsHeaders,
    );
  }

  const leaderboardMatch = url.pathname.match(/^\/api\/challenges\/([^/]+)\/leaderboard$/);
  if (request.method === "GET" && leaderboardMatch?.[1]) {
    return json(
      await tracking.handlers.listLeaderboard(decodeURIComponent(leaderboardMatch[1])),
      { headers: noStoreHeaders() },
      corsHeaders,
    );
  }

  const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/([^/]+)$/);
  if (runMatch?.[1] && runMatch[2]) {
    const runId = decodeURIComponent(runMatch[1]);
    const action = runMatch[2];
    if (request.method === "GET" && action === "path") {
      return json(
        { path: await protocol(tracking).getPublicRunPath(runId) },
        undefined,
        corsHeaders,
      );
    }
    if (request.method === "POST" && action === "click") {
      const account = await tracking.authorize(request);
      await enforceClickRateLimit(env, account.accountId);
      const input = legacyClickInput(await readJson(request));
      if (tracking.runProtocol) {
        return json(
          await tracking.runProtocol.recordClickLegacy(account, runId, input),
          undefined,
          corsHeaders,
        );
      }
      return json(
        await tracking.handlers.recordClick(runId, account.accountId, input),
        undefined,
        corsHeaders,
      );
    }
    if (request.method === "POST" && action === "complete") {
      const account = await tracking.authorize(request);
      const input = legacyCompleteInput(await readJson(request));
      if (tracking.runProtocol) {
        return json(
          {
            leaderboardRow: await tracking.runProtocol.completeRunLegacy(
              account,
              runId,
              input,
            ),
          },
          undefined,
          corsHeaders,
        );
      }
      return json(
        await tracking.handlers.completeRun(runId, account.accountId, input),
        undefined,
        corsHeaders,
      );
    }
    if (request.method === "POST" && action === "abandon") {
      const account = await tracking.authorize(request);
      if (tracking.runProtocol) {
        return json(
          await tracking.runProtocol.abandonRunLegacy(account, runId),
          undefined,
          corsHeaders,
        );
      }
      return json(
        await tracking.handlers.abandonRun(runId, account.accountId),
        undefined,
        corsHeaders,
      );
    }
  }

  return json(
    { error: { code: "not_found", message: "Not found." } },
    { status: 404 },
    corsHeaders,
  );
}

function createTracking(env: Env): WorkerTracking {
  const repository = createD1TrackingRepository({ db: env.VWIKI_RACE_DB });
  const wikipedia = createWikipediaChallengeValidator({ fetchImpl: fetch });
  const handlers = createApiHandlers(repository, {
    validateChallengeArticles: wikipedia.validateChallengeArticles,
  });
  const identity = createVGamesIdentityClient({
    baseUrl: env.VGAMES_URL,
    fetchImpl: resolveVGamesFetch(env.VGAMES_IDENTITY),
  });
  return {
    handlers,
    identity,
    runProtocol: repository,
    authorize: (request) => authorizeVGamesRequest(request, identity),
  };
}

export function resolveVGamesFetch(
  binding?: Pick<Fetcher, "fetch">,
): typeof fetch {
  if (!binding) return fetch;
  return (input, init) => binding.fetch(input, init);
}

const CENTRAL_DAILY_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function centralDailyDateAtFive(value: Date): string | null {
  if (!Number.isFinite(value.getTime())) {
    throw new Error("Scheduled event did not include a valid time.");
  }

  const parts = Object.fromEntries(
    CENTRAL_DAILY_FORMATTER.formatToParts(value)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  if (parts.hour !== "05" || parts.minute !== "00") {
    return null;
  }
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function dailyFailureCode(caught: unknown): string {
  if (caught && typeof caught === "object" && "code" in caught &&
      typeof (caught as { code?: unknown }).code === "string") {
    return (caught as { code: string }).code;
  }
  return "daily_persistence_failed";
}

function logDailyJob(event: string, fields: Record<string, string | number>): void {
  console.info("daily_challenge_job", JSON.stringify({ event, ...fields }));
}

function logDailyCandidateDiagnostic(
  event: string,
  fields: Record<string, string | number | boolean>,
): void {
  console.info("daily_challenge_candidate", JSON.stringify({ event, ...fields }));
}

async function authorizeVGamesRequest(
  request: Request,
  identity: Pick<VGamesIdentityClient, "introspect">,
): Promise<AuthorizedVGamesAccount> {
  const result = await identity.introspect(readBearerToken(request));
  if (!result.valid) {
    throw new ApiError("unauthorized", "Sign in before changing VWiki Race.", 401);
  }
  return result;
}

function readBearerToken(request: Request): string {
  const authorization = request.headers.get("Authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]) {
    throw new ApiError("unauthorized", "Sign in before changing VWiki Race.", 401);
  }
  return match[1].trim();
}

async function readJson(request: Request, maxBytes = 16 * 1024): Promise<unknown> {
  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxBytes)) {
    throw new ApiError("body_too_large", `Request body must be ${maxBytes / 1024} KiB or smaller.`, 413);
  }
  try {
    const reader = request.body?.getReader();
    if (!reader) return {};
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ApiError("body_too_large", `Request body must be ${maxBytes / 1024} KiB or smaller.`, 413);
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (caught) {
    if (caught instanceof ApiError) throw caught;
    throw new ApiError("invalid_json", "Request body must be valid JSON.", 400);
  }
}

function protocol(tracking: WorkerTracking): RunProtocolRepository {
  if (!tracking.runProtocol) {
    throw new ApiError("run_protocol_unavailable", "The v2 run protocol is unavailable.", 500);
  }
  return tracking.runProtocol;
}

function requireIdempotencyKey(request: Request): string {
  const value = request.headers.get("Idempotency-Key")?.trim() ?? "";
  if (!value || value.length > 200) {
    throw new ApiError("invalid_idempotency_key", "An idempotency key is required.", 400);
  }
  return value;
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("invalid_request", "Request body must be an object.", 400);
  }
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, code: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    throw new ApiError(code, "Request field is invalid.", 400);
  }
  return value.trim();
}

function boundedOpaqueString(value: unknown, code: string, maxLength: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength) {
    throw new ApiError(code, "Request field is invalid.", 400);
  }
  return value;
}

function boundedInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new ApiError(code, "Request field is invalid.", 400);
  }
  return Number(value);
}

function challengeInput(value: unknown): {
  startTitle: string;
  targetTitle: string;
  nominateForDaily?: boolean;
} {
  const body = requireObject(value);
  const input: {
    startTitle: string;
    targetTitle: string;
    nominateForDaily?: boolean;
  } = {
    startTitle: boundedString(body.startTitle, "invalid_start_title", 2048),
    targetTitle: boundedString(body.targetTitle, "invalid_target_title", 2048),
  };
  if (body.nominateForDaily !== undefined) {
    input.nominateForDaily = body.nominateForDaily as boolean;
  }
  return input;
}

function startInput(value: unknown): { challengeId: string } {
  const body = requireObject(value);
  return { challengeId: boundedString(body.challengeId, "invalid_challenge_id", 120) };
}

function clickInput(value: unknown) {
  const body = requireObject(value);
  const decisionElapsedMs = body.decisionElapsedMs;
  if (!Number.isSafeInteger(decisionElapsedMs) || Number(decisionElapsedMs) < 0) {
    throw new ApiError("invalid_decision_time", "Request field is invalid.", 400);
  }
  return {
    clientEventId: boundedString(body.clientEventId, "invalid_client_event_id", 128),
    expectedStepNumber: boundedInteger(body.expectedStepNumber, "invalid_step_number"),
    sourceTitle: boundedString(body.sourceTitle, "invalid_source_title", 512),
    sourcePageId: boundedInteger(body.sourcePageId, "invalid_source_page_id"),
    sourceRevisionId: body.sourceRevisionId === undefined
      ? undefined
      : boundedInteger(body.sourceRevisionId, "invalid_source_revision"),
    clickedAnchorText: boundedString(body.clickedAnchorText, "invalid_anchor_text", 512),
    requestedTitle: boundedString(body.requestedTitle, "invalid_requested_title", 512),
    destinationTitle: boundedString(body.destinationTitle, "invalid_destination_title", 512),
    destinationPageId: boundedInteger(body.destinationPageId, "invalid_destination_page_id"),
    decisionElapsedMs: Number(decisionElapsedMs),
    clientObservedAt: body.clientObservedAt === undefined
      ? undefined
      : boundedString(body.clientObservedAt, "invalid_client_observed_at", 64),
  };
}

const CLIENT_ERROR_SOURCES = new Set([
  "window",
  "unhandledrejection",
  "error-boundary",
  "manual",
]);

const CLIENT_ERROR_BODY_MAX_BYTES = 8 * 1024;

interface ClientErrorInput {
  source: string;
  name: string;
  message: string;
  stack?: string;
  url?: string;
  userAgent?: string;
  ts?: string;
}

async function handleClientError(
  request: Request,
  env: Env,
  corsHeaders: HeadersInit,
  requestId: string,
): Promise<Response> {
  await enforceClientErrorRateLimit(env, clientErrorRateLimitKey(request));
  const input = clientErrorInput(await readJson(request, CLIENT_ERROR_BODY_MAX_BYTES));
  console.error(JSON.stringify({ type: "client_error", requestId, ...input }));
  return new Response(null, { status: 204, headers: corsHeaders });
}

function clientErrorInput(value: unknown): ClientErrorInput {
  const body = requireObject(value);
  if (typeof body.source !== "string" || !CLIENT_ERROR_SOURCES.has(body.source)) {
    throw new ApiError("invalid_source", "Request field is invalid.", 400);
  }
  if (typeof body.name !== "string" || !body.name) {
    throw new ApiError("invalid_name", "Request field is invalid.", 400);
  }
  if (typeof body.message !== "string" || !body.message) {
    throw new ApiError("invalid_message", "Request field is invalid.", 400);
  }
  return {
    source: body.source,
    name: body.name,
    message: body.message.slice(0, 512),
    stack: optionalClientErrorString(body.stack, "invalid_stack", 4096),
    url: optionalClientErrorString(body.url, "invalid_url", 512),
    userAgent: optionalClientErrorString(body.userAgent, "invalid_user_agent", 512),
    ts: optionalClientErrorString(body.ts, "invalid_ts", 64),
  };
}

function optionalClientErrorString(
  value: unknown,
  code: string,
  maxLength: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new ApiError(code, "Request field is invalid.", 400);
  }
  return value.slice(0, maxLength);
}

function clientErrorRateLimitKey(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown-client";
}

async function enforceClientErrorRateLimit(env: Env, key: string): Promise<void> {
  if (!env.CLIENT_ERROR_RATE_LIMITER) {
    return;
  }
  const result = await env.CLIENT_ERROR_RATE_LIMITER.limit({ key });
  if (!result.success) {
    throw new ApiError(
      "client_error_rate_limited",
      "Too many client error reports. Try again shortly.",
      429,
      60,
    );
  }
}

async function enforceClickRateLimit(env: Env, accountId: string): Promise<void> {
  if (!env.CLICK_RATE_LIMITER) {
    throw new ApiError(
      "rate_limiter_unavailable",
      "Click rate limiting is temporarily unavailable.",
      503,
    );
  }
  const result = await env.CLICK_RATE_LIMITER.limit({ key: accountId });
  if (!result.success) {
    throw new ApiError("click_rate_limited", "Too many click requests. Try again shortly.", 429, 60);
  }
}

async function enforceAccountReadRateLimit(
  env: Env,
  accountId: string,
  route: "active" | "recovery-path" | "stats",
): Promise<void> {
  if (!env.ACCOUNT_READ_RATE_LIMITER) {
    throw new ApiError(
      "rate_limiter_unavailable",
      "Account read rate limiting is temporarily unavailable.",
      503,
    );
  }
  const result = await env.ACCOUNT_READ_RATE_LIMITER.limit({
    key: `${route}:${accountId}`,
  });
  if (!result.success) {
    throw new ApiError(
      "account_read_rate_limited",
      "Too many account read requests. Try again shortly.",
      429,
      60,
    );
  }
}

async function enforceChallengeCreateRateLimit(
  env: Env,
  accountId: string,
): Promise<void> {
  if (!env.CHALLENGE_CREATE_RATE_LIMITER) {
    throw new ApiError(
      "rate_limiter_unavailable",
      "Challenge creation rate limiting is temporarily unavailable.",
      503,
    );
  }
  const result = await env.CHALLENGE_CREATE_RATE_LIMITER.limit({ key: accountId });
  if (!result.success) {
    throw new ApiError(
      "challenge_create_rate_limited",
      "Too many challenge validation requests. Try again shortly.",
      429,
      60,
    );
  }
}

function abandonInput(value: unknown): { recoveryProtocolVersion?: 1 } {
  const body = requireObject(value);
  if (
    body.recoveryProtocolVersion !== undefined &&
    body.recoveryProtocolVersion !== 1
  ) {
    throw new ApiError(
      "invalid_recovery_protocol_version",
      "Recovery protocol version must be 1 when provided.",
      400,
    );
  }
  return {
    recoveryProtocolVersion: body.recoveryProtocolVersion as 1 | undefined,
  };
}

function guestIdentityInput(value: unknown): {
  deviceCredential: string;
  displayName: string;
} {
  const body = requireObject(value);
  return {
    deviceCredential: boundedString(
      body.deviceCredential,
      "invalid_device_credential",
      512,
    ),
    displayName: boundedString(body.displayName, "invalid_display_name", 24),
  };
}

function secureIdentityInput(value: unknown): {
  deviceCredential: string;
  token: string;
  username: string;
  password: string;
} {
  const body = requireObject(value);
  return {
    deviceCredential: boundedString(
      body.deviceCredential,
      "invalid_device_credential",
      512,
    ),
    token: boundedOpaqueString(body.token, "invalid_token", 8192),
    username: boundedString(body.username, "invalid_username", 64),
    password: boundedOpaqueString(body.password, "invalid_password", 1024),
  };
}

function loginIdentityInput(value: unknown): {
  deviceCredential: string;
  username: string;
  password: string;
} {
  const body = requireObject(value);
  return {
    deviceCredential: boundedString(
      body.deviceCredential,
      "invalid_device_credential",
      512,
    ),
    username: boundedString(body.username, "invalid_username", 64),
    password: boundedOpaqueString(body.password, "invalid_password", 1024),
  };
}

function legacyClickInput(value: unknown): {
  sourceTitle: string;
  clickedAnchorText: string;
  requestedTitle: string;
  destinationTitle: string;
  destinationPageId?: number;
  clientTimestampMs?: number;
} {
  const body = requireObject(value);
  const optionalPositiveInteger = (field: unknown, code: string): number | undefined =>
    field === undefined ? undefined : boundedInteger(field, code);
  const optionalFiniteNumber = (field: unknown, code: string): number | undefined => {
    if (field === undefined) return undefined;
    if (typeof field !== "number" || !Number.isFinite(field)) {
      throw new ApiError(code, "Request field is invalid.", 400);
    }
    return field;
  };
  return {
    sourceTitle: boundedString(body.sourceTitle, "invalid_source_title", 512),
    clickedAnchorText: boundedString(body.clickedAnchorText, "invalid_anchor_text", 512),
    requestedTitle: boundedString(body.requestedTitle, "invalid_requested_title", 512),
    destinationTitle: boundedString(body.destinationTitle, "invalid_destination_title", 512),
    destinationPageId: optionalPositiveInteger(
      body.destinationPageId,
      "invalid_destination_page_id",
    ),
    clientTimestampMs: optionalFiniteNumber(
      body.clientTimestampMs,
      "invalid_client_timestamp",
    ),
  };
}

function legacyCompleteInput(value: unknown): {
  finalTitle: string;
  clientTimestampMs?: number;
} {
  const body = requireObject(value);
  if (
    body.clientTimestampMs !== undefined &&
    (typeof body.clientTimestampMs !== "number" ||
      !Number.isFinite(body.clientTimestampMs))
  ) {
    throw new ApiError(
      "invalid_client_timestamp",
      "Request field is invalid.",
      400,
    );
  }
  return {
    finalTitle: boundedString(body.finalTitle, "invalid_final_title", 512),
    clientTimestampMs: body.clientTimestampMs as number | undefined,
  };
}

function publicCacheHeaders(): HeadersInit {
  return { "Cache-Control": "public, max-age=60" };
}

function noStoreHeaders(): HeadersInit {
  return { "Cache-Control": "no-store" };
}

function logRequest(
  request: Request,
  status: number,
  requestId: string,
  startedAt: number,
  failureBoundary?: string,
): void {
  console.info(JSON.stringify({
    route: new URL(request.url).pathname,
    status,
    requestId,
    latencyMs: Date.now() - startedAt,
    failureBoundary: failureBoundary ?? null,
  }));
}

function corsHeadersFor(request: Request, env: Env): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Idempotency-Key",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    Vary: "Origin",
  };
  const origin = request.headers.get("Origin");
  if (origin && allowedOrigins(env).has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function allowedOrigins(env: Env): Set<string> {
  return new Set(
    (env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}

function json(value: unknown, init: ResponseInit | undefined, corsHeaders: HeadersInit): Response {
  return Response.json(value, {
    ...init,
    headers: {
      "Cache-Control": "no-store",
      ...corsHeaders,
      ...(init?.headers ?? {}),
    },
  });
}

function error(caught: unknown, corsHeaders: HeadersInit, requestId: string): Response {
  if (caught instanceof ApiError) {
    return json(
      { error: { code: caught.code, message: caught.message } },
      {
        status: caught.status,
        headers: caught.retryAfterSeconds === null
          ? undefined
          : { "Retry-After": String(caught.retryAfterSeconds) },
      },
      corsHeaders,
    );
  }
  const { name, message, stack } = describeUnhandledError(caught);
  console.error(JSON.stringify({ type: "unhandled_error", requestId, name, message, stack }));
  return json(
    { error: { code: "internal_error", message: "Something went wrong." } },
    { status: 500 },
    corsHeaders,
  );
}

function describeUnhandledError(
  caught: unknown,
): { name: string; message: string; stack?: string } {
  if (caught instanceof Error) {
    return {
      name: caught.name,
      message: caught.message,
      stack: caught.stack ? caught.stack.slice(0, 4096) : undefined,
    };
  }
  return {
    name: "NonErrorThrown",
    message: stringifyUnknownThrown(caught).slice(0, 4096),
  };
}

function stringifyUnknownThrown(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
