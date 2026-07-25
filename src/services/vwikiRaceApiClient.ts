import type {
  AbandonRunV2Response,
  AccountChallengeOutcomesResponse,
  AccountStatsResponse,
  BoardsTrendsResponse,
  BoardsTrendWindow,
  ChallengeBoardResponse,
  ChallengePathsResponse,
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
  AllPlayersRosterEntry,
  Challenge,
  ChallengeOutcomeEntry,
  ChallengePathRunEntry,
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
// MB-1 Part 2: mirrors the shipped login leash (apiRequest.ts
// firstAttemptTimeoutMs, commit 6d54452) for the in-race click POST. Click
// ops already carry an idempotency key per the run protocol, so the
// existing `retry: "idempotent-once"` was always safe to retry - it just
// used the full 15s MUTATION_TIMEOUT_MS for the first attempt too, meaning
// a stalled click on a bad mobile connection could take up to ~30s
// (15s stall + 15s retry) before useRaceController's acceptClick catch
// ever go a chance to revert phase="syncing" back to "active". A short
// first leash fails a stalled attempt over to the retry in ~5s instead.
const CLICK_FIRST_ATTEMPT_TIMEOUT_MS = 5_000;

export interface RecordClickHooks {
  /** Fired when the click POST's automatic retry kicks in - lets the race
   *  UI switch pendingNavigationTitle's copy to an honest "still loading"
   *  instead of an unchanging spinner (see useRaceController's
   *  navigationRetrying). */
  onRetry?: () => void;
}

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

export interface ListChallengesOptions {
  /**
   * RC-03: bypasses the 60s catalog TTL for exactly one read - App.tsx's
   * `queueCatalogRefresh` (shared by window focus, `visibilitychange`, AND
   * the 5:00 AM Central daily-drop timer - all three funnel through that
   * one callback, so this bypass automatically covers all three, not just
   * the timer) is an explicit "check for updates now" signal, distinct from
   * an incidental remount that should happily reuse a fresh-enough cached
   * catalog. Does not itself clear the cache - a plain `listChallenges()`
   * called immediately after a forced read still gets the just-fetched
   * value.
   */
  force?: boolean;
}

export interface GetChallengeBoardOptions {
  /**
   * RC-03 (Judge B amendment 3): the api client has no clock/domain
   * knowledge of which challenge id is "today's" vs. a bygone calendar day
   * (that lives in domain/challengeSelection.ts, consumed by callers) - so
   * open/closed can't be inferred from a bare challengeId. Callers that
   * KNOW a board is permanently closed (a real past daily, not the one
   * pre-drop edge case where "yesterday's daily" is still the live one) opt
   * in explicitly. `true` caches the response forever (until this specific
   * challengeId's entry is invalidated) instead of the short open-board TTL
   * - safe because a closed day's challengeId never becomes "today's" again,
   * so there's no separate rollover bookkeeping needed. Defaults to `false`
   * (short TTL) so an unmigrated call site never over-caches live data.
   */
  closed?: boolean;
}

export interface VWikiRaceApiClient extends VWikiRaceDailyAdminApiClient {
  listChallenges(options?: ListChallengesOptions): Promise<Challenge[]>;
  createChallenge(input: CreateTrackedChallengeRequest, token: string): Promise<CreateChallengeV2Response>;
  startRun(input: StartTrackedRunRequest, token: string): Promise<ActiveRunRecord>;
  getActiveRun(token: string): Promise<ActiveRunRecord | null>;
  getActiveRunPath(runId: string, token: string): Promise<ServerPathStep[]>;
  recordClick(
    runId: string,
    input: RecordTrackedClickRequest,
    token: string,
    hooks?: RecordClickHooks,
  ): Promise<ClickV2Response>;
  abandonRun(
    runId: string,
    token: string,
    input?: { recoveryProtocolVersion?: 1 },
  ): Promise<AbandonRunV2Response>;
  listLeaderboard(challengeId: string): Promise<RankedLeaderboardRow[]>;
  getChallengeBoard(
    challengeId: string,
    options?: GetChallengeBoardOptions,
  ): Promise<ChallengeBoardResponse>;
  /**
   * GR-1 ("View graph"): the merged-path visualization's bulk source - `GET
   * /api/v2/challenges/{id}/paths`. Authenticated, unlike `getChallengeBoard`
   * above - the server's own FB-4 viewer-finished guard (shared with
   * `getRunPath`) needs a real bearer token. Callers only ever invoke this
   * once the SAME client-side "could this viewer see paths" knowledge that
   * already gates the per-row disclosure affordance is true (see
   * `ChallengePathGraphButton`) - the server enforces the real boundary
   * regardless.
   */
  getChallengePaths(challengeId: string, token: string): Promise<ChallengePathsResponse>;
  getBoardsTrends(window: BoardsTrendWindow): Promise<BoardsTrendsResponse>;
  // FB-4 (council 2026-07-19, owner decision 10): now authenticated - the
  // server's own viewer-finished guard (getPublicRunPath's doc comment,
  // trackingRepository.ts) needs a real bearer token, not just a runId, so
  // client-side `pathsUnlocked` gating can't be the only access boundary.
  getRunPath(runId: string, token: string): Promise<ServerPathStep[]>;
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

/**
 * RC-03: the one shared caching primitive every newly-cached read below
 * builds on, rather than five independent copies of the same
 * get/put/expire logic - the OWNER-PROXY ruling asked for "a thin module
 * with tests, not a framework". `ttlMs: null` on `put` means "cache forever
 * until an explicit invalidate" (the closed-day board case) - never a
 * synonym for "don't cache".
 *
 * The `generation` handshake on `put` is the out-of-order-resolution guard
 * (Judge B amendment 4), mirroring the pre-existing `statsGeneration`
 * pattern this file already used for account stats: a caller captures
 * `generation()` BEFORE awaiting the network response, and its eventual
 * write only commits if nothing invalidated this cache group in the
 * meantime. Without it, a slow in-flight read that resolves AFTER a
 * mutation-triggered invalidation could silently overwrite the fresher
 * post-mutation cache entry with stale data.
 */
interface CacheGroup<T> {
  get(key: string): T | undefined;
  put(key: string, value: T, ttlMs: number | null, generation: number): void;
  generation(): number;
  /** Bumps the generation (so any write already in flight is dropped) and
   *  clears every cached entry, including `ttlMs: null` ones (closed-day
   *  boards) - see invalidateEngagementCaches' doc comment for why closed
   *  boards don't get a carve-out here. */
  invalidate(): void;
  /** Same generation bump, scoped to a single key - used where a mutation's
   *  own response names the one affected id (e.g. createChallenge) rather
   *  than requiring a blanket clear. */
  invalidateKey(key: string): void;
}

function createCacheGroup<T>(): CacheGroup<T> {
  const entries = new Map<string, { value: T; expiresAt: number | null }>();
  let currentGeneration = 0;
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    put(key, value, ttlMs, generation) {
      if (generation !== currentGeneration) return;
      entries.set(key, { value, expiresAt: ttlMs === null ? null : Date.now() + ttlMs });
    },
    generation() {
      return currentGeneration;
    },
    invalidate() {
      currentGeneration += 1;
      entries.clear();
    },
    invalidateKey(key) {
      currentGeneration += 1;
      entries.delete(key);
    },
  };
}

// RC-03 TTLs - conservative per the binding ruling ("<=60s reads"). Boards
// additionally split open (short TTL) vs. closed (forever, until a targeted
// invalidate) - see GetChallengeBoardOptions's doc comment.
const CATALOG_TTL_MS = 60_000;
const OPEN_BOARD_TTL_MS = 20_000;
const LEADERBOARD_TTL_MS = 25_000;
const SUMMARY_TTL_MS = 30_000;
const OUTCOMES_TTL_MS = 30_000;
const CATALOG_CACHE_KEY = "catalog";
const SUMMARY_CACHE_KEY = "summary";

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
  // RC-03: persistent read caches (in addition to `inFlight`'s plain
  // concurrent-request dedup above) - see createCacheGroup's doc comment.
  // NOT applied to getBoardsTrends: a prior binding council round (2026-07-19
  // QF-02, Judge A amendment 2 / Judge B amendment 3) explicitly rejected
  // caching the 7d/30d/lifetime trend windows because they keep absorbing
  // the CURRENT session's own just-finished daily until midnight - caching
  // risks a player finishing today's race, flipping to Boards, and not
  // seeing their own fresh run. RC-03 leaves `getBoardsTrends` on its
  // existing in-flight-dedup-only behavior rather than reintroducing that
  // bug (Judge B amendment 2, option (b)).
  const catalogCache = createCacheGroup<{ challenges: Challenge[] }>();
  const boardCache = createCacheGroup<ChallengeBoardResponse>();
  const leaderboardCache = createCacheGroup<{ leaderboard: RankedLeaderboardRow[] }>();
  const summaryCache = createCacheGroup<{ challenges: ChallengeSummaryEntry[] }>();
  const outcomesCache = createCacheGroup<ChallengeOutcomeEntry[]>();
  const outcomesInFlight = new Map<string, Promise<ChallengeOutcomeEntry[]>>();
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
    async listChallenges(listOptions) {
      if (!listOptions?.force) {
        const cached = catalogCache.get(CATALOG_CACHE_KEY);
        if (cached) return cached.challenges;
      }
      const generation = catalogCache.generation();
      const response = await read(urlPath.challenges, isChallengesResponse);
      catalogCache.put(CATALOG_CACHE_KEY, response, CATALOG_TTL_MS, generation);
      return response.challenges;
    },
    async createChallenge(input, token) {
      const response = await write(urlPath.challenges, input, token, isCreateChallengeResponse, true);
      invalidateStats();
      invalidateChallengeCatalog();
      summaryCache.invalidate();
      invalidateChallengeEngagement(response.challenge.id);
      return response;
    },
    async startRun(input, token) {
      const response = await write(urlPath.startRun, input, token, isStartRunResponse, true);
      invalidateEngagementCaches();
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
    async recordClick(runId, input, token, hooks) {
      const response = await write(
        urlPath.run(runId, "click"),
        input,
        token,
        isClickResponse,
        true,
        undefined,
        "POST",
        { firstAttemptTimeoutMs: CLICK_FIRST_ATTEMPT_TIMEOUT_MS, onRetry: hooks?.onRetry },
      );
      // Judge A amendment 4: a run-completing click is still recordClick,
      // not a separate "finish" mutation - this is the one place that beat
      // needed covering.
      invalidateEngagementCaches();
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
      invalidateEngagementCaches();
      return response;
    },
    async listLeaderboard(challengeId) {
      const cached = leaderboardCache.get(challengeId);
      if (cached) return cached.leaderboard;
      const generation = leaderboardCache.generation();
      const response = await read(urlPath.leaderboard(challengeId), isLeaderboardResponse);
      leaderboardCache.put(challengeId, response, LEADERBOARD_TTL_MS, generation);
      return response.leaderboard;
    },
    async getChallengeBoard(challengeId, boardOptions) {
      const cached = boardCache.get(challengeId);
      if (cached) return cached;
      const generation = boardCache.generation();
      const response = await read(urlPath.board(challengeId), isChallengeBoardResponse);
      boardCache.put(challengeId, response, boardOptions?.closed ? null : OPEN_BOARD_TTL_MS, generation);
      return response;
    },
    async getChallengePaths(challengeId, token) {
      return authenticatedRead(urlPath.paths(challengeId), token, isChallengePathsResponse);
    },
    async getBoardsTrends(window) {
      return read(urlPath.boardsTrends(window), isBoardsTrendsResponse);
    },
    async getRunPath(runId, token) {
      const cached = pathCache.get(runId);
      if (cached) return cached;
      const path = (await authenticatedRead(
        urlPath.run(runId, "path"),
        token,
        isRunPathResponse,
      )).path;
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
      const cached = summaryCache.get(SUMMARY_CACHE_KEY);
      if (cached) return cached.challenges;
      const generation = summaryCache.generation();
      const response = await read(urlPath.challengesSummary, isChallengesSummaryResponse);
      summaryCache.put(SUMMARY_CACHE_KEY, response, SUMMARY_TTL_MS, generation);
      return response.challenges;
    },
    async getAccountChallengeOutcomes(token) {
      const cached = outcomesCache.get(token);
      if (cached) return cached;
      const existing = outcomesInFlight.get(token);
      if (existing) return existing;
      const generation = outcomesCache.generation();
      let pending!: Promise<ChallengeOutcomeEntry[]>;
      pending = authenticatedRead(
        urlPath.accountChallengeOutcomes,
        token,
        isAccountChallengeOutcomesResponse,
      ).then((response) => {
        outcomesCache.put(token, response.outcomes, OUTCOMES_TTL_MS, generation);
        return response.outcomes;
      }).finally(() => {
        if (outcomesInFlight.get(token) === pending) {
          outcomesInFlight.delete(token);
        }
      });
      outcomesInFlight.set(token, pending);
      return pending;
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
      summaryCache.invalidate();
      invalidateChallengeEngagement(response.challenge.id);
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
    leash?: { firstAttemptTimeoutMs?: number; onRetry?: () => void },
  ): Promise<T> {
    return requestJson(fetchImpl, url(path), {
      method: method as "POST",
      body,
      token,
      timeoutMs: MUTATION_TIMEOUT_MS,
      firstAttemptTimeoutMs: leash?.firstAttemptTimeoutMs,
      onRetry: leash?.onRetry,
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
    // Judge A amendment 2: this used to only clear the in-flight map, which
    // was a no-op once a persistent cache existed alongside it - a new
    // challenge (createChallenge/createRandomChallenge) wouldn't actually
    // surface in the catalog for up to CATALOG_TTL_MS otherwise.
    catalogCache.invalidate();
  }

  /**
   * Wired into every run-ending mutation (startRun/recordClick/abandonRun -
   * see each call site's own comment; Judge A amendment 4 folded "finish"
   * into recordClick rather than treating it as a separate site). Blanket,
   * not per-challengeId: none of these three responses carry a challengeId
   * (RecordClickV2Input/AbandonRunV2Input don't either) for the api client
   * to target precisely, and staleness - not an extra fetch - is the
   * failure mode the risk section calls out.
   *
   * `boardCache` is fully cleared here too, including permanently-cached
   * CLOSED entries - Wave 2 review finding RC-03/keepPermanent: past dailies
   * are never deactivated server-side (no code path flips `is_active`), so
   * racing a bygone daily (Boards -> a past day -> "Race this", or a
   * Play-another suggestion) is a first-class flow, not just a pre-drop
   * edge case, and listChallengePlacements/listChallengeDnfs have no date
   * window that would keep such a run from landing on that board. The old
   * "a past day's board can't be affected by a run" premise only holds for
   * a run against a genuinely DIFFERENT, still-open challenge - it doesn't
   * hold in general, and this cache has no way to tell the two cases apart
   * from here. A closed board still caches forever (see
   * GetChallengeBoardOptions) until the next run-ending mutation re-clears
   * it - this only removes the carve-out that let a closed entry outlive
   * mutations altogether.
   */
  function invalidateEngagementCaches(): void {
    invalidateStats();
    boardCache.invalidate();
    leaderboardCache.invalidate();
    summaryCache.invalidate();
    outcomesCache.invalidate();
    outcomesInFlight.clear();
    // A board/leaderboard/summary GET that was already in flight when this
    // mutation completed was issued against pre-mutation server state - the
    // generation guard above stops its (now-stale) resolution from
    // clobbering a fresher cache write, but without this, a caller reading
    // right after this invalidation could still silently piggyback on that
    // same stale in-flight request via read()'s URL-keyed dedup instead of
    // getting a genuinely fresh fetch. Scoped by URL shape (not a blanket
    // `inFlight.clear()`) so an unrelated concurrent read - e.g. the
    // catalog, or getBoardsTrends - keeps its own dedup untouched.
    dropInFlightMatching((requestUrl) =>
      requestUrl.includes("/board") ||
      requestUrl.includes("/leaderboard") ||
      requestUrl.endsWith(urlPath.challengesSummary));
  }

  function invalidateChallengeEngagement(challengeId: string): void {
    boardCache.invalidateKey(challengeId);
    leaderboardCache.invalidateKey(challengeId);
    inFlight.delete(url(urlPath.board(challengeId)));
    inFlight.delete(url(urlPath.leaderboard(challengeId)));
  }

  function dropInFlightMatching(matches: (requestUrl: string) => boolean): void {
    for (const requestUrl of inFlight.keys()) {
      if (matches(requestUrl)) inFlight.delete(requestUrl);
    }
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
  paths: (challengeId: string) =>
    `/api/v2/challenges/${encodeURIComponent(challengeId)}/paths`,
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
    hasNumber(value, "clickCount") &&
    // PKG-03 remainder fix: `runId` is optional wire-compatibility (older/
    // cached responses and pre-existing test fixtures may lack it) - when
    // present it must be a real string, never tolerated as some other type.
    (value.runId === undefined || hasString(value, "runId"));
}

function isChallengeBoardDnfRow(value: unknown): value is ChallengeBoardResponse["dnfs"][number] {
  return isRecord(value) &&
    hasString(value, "accountId") &&
    (value.displayName === null || hasString(value, "displayName")) &&
    hasNumber(value, "clickCount") &&
    hasNumber(value, "elapsedMs");
}

function isChallengePathsResponse(value: unknown): value is ChallengePathsResponse {
  return isRecord(value) &&
    Array.isArray(value.runs) && value.runs.every(isChallengePathRunEntry) &&
    hasNumber(value, "totalRuns");
}

function isChallengePathRunEntry(value: unknown): value is ChallengePathRunEntry {
  return isRecord(value) &&
    hasString(value, "player") &&
    (value.status === "completed" || value.status === "abandoned") &&
    hasNumber(value, "elapsedMs") &&
    hasNumber(value, "clicks") &&
    Array.isArray(value.steps) && value.steps.every(isChallengePathStepEntry);
}

function isChallengePathStepEntry(value: unknown): value is ChallengePathRunEntry["steps"][number] {
  return isRecord(value) &&
    hasNumber(value, "n") &&
    hasString(value, "from") &&
    hasString(value, "to");
}

function isBoardsTrendsResponse(value: unknown): value is BoardsTrendsResponse {
  return isRecord(value) &&
    (value.window === "7" || value.window === "30" || value.window === "lifetime") &&
    hasNumber(value, "guard") &&
    Array.isArray(value.ranked) && value.ranked.every(isDailyTrendRankedEntry) &&
    Array.isArray(value.unranked) && value.unranked.every(isDailyTrendUnrankedEntry) &&
    // PKG-14: `roster` only ever exists on the lifetime segment's response -
    // absent entirely (not even `null`) on 7d/30d, so it's tolerated as
    // undefined here rather than required.
    (value.roster === undefined ||
      (Array.isArray(value.roster) && value.roster.every(isAllPlayersRosterEntry)));
}

function isAllPlayersRosterEntry(value: unknown): value is AllPlayersRosterEntry {
  return isRecord(value) &&
    hasString(value, "accountId") &&
    (value.displayName === null || hasString(value, "displayName")) &&
    hasNumber(value, "racesStarted") &&
    hasNumber(value, "finishes") &&
    hasNumber(value, "wins");
}

function isDailyTrendRankedEntry(value: unknown): value is BoardsTrendsResponse["ranked"][number] {
  return isRecord(value) &&
    hasString(value, "accountId") &&
    (value.displayName === null || hasString(value, "displayName")) &&
    hasNumber(value, "avgPlacement") &&
    hasNumber(value, "playedCount") &&
    // Owner ruling, 2026-07-25 ("metric-independent ranking changes"): the
    // info columns alongside the placement - this account's own average
    // time/clicks across its counted completions in the window. Always
    // present on a ranked entry (never optional/nullable - a ranked entry
    // has at least `DAILY_TREND_INCLUSION_FLOOR` completions to average).
    hasNumber(value, "avgElapsedMs") &&
    hasNumber(value, "avgClicks") &&
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
    // Increment 5: `POST /api/v2/challenges/random` produces exactly this
    // shape (`origin: "manual"`, `source: "wikipedia_random"`, no daily
    // date/feature - see d1TrackingRepository's mapChallengeRow) - a
    // non-daily challenge whose article pair was randomly sourced rather
    // than typed in by a player. Distinct from the `origin: "daily"` branch
    // below, which additionally requires a real calendar date.
    return (value.source === "curated" || value.source === "wikipedia_random") && hasNoDailyDate;
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
    isDailySelectionSource(value.selectionSource) &&
    // PKG-07: optional, not required - `dailyNumber` postdates this field
    // (see DailyFeature's own doc comment) and older responses/fixtures
    // may not carry it yet.
    hasOptionalNumber(value, "dailyNumber");
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
    typeof value.ranked === "boolean" &&
    // PKG-14: reality-scaled, server-echoed guard - required, same as
    // `BoardsTrendsResponse.guard`.
    hasNumber(value, "guard");
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
