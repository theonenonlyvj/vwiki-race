import { isAllowedArticleHref, normalizeTitle, parseWikipediaArticleInput } from "../domain/rules";
import type { DailyFlavor } from "../domain/dailyEditorial";
import type { WikipediaGateway } from "../services/wikipediaGateway";
import {
  compareScoredDailyCandidates,
  scoreDailyCandidate,
  stableSample,
  type ScoredDailyCandidate,
} from "./dailyCandidateScoring";
import {
  createEditorialTargetPools,
  type EditorialTarget,
} from "./editorialTargetPools";

const DEFAULT_ENDPOINT = "https://en.wikipedia.org/w/api.php";
const DEFAULT_PAGEVIEWS_ENDPOINT = "https://wikimedia.org/api/rest_v1";
const MAX_REQUESTS = 40;
const PHASE_TIMEOUT_MS = 25_000;
const MAX_TARGETS = 10;
const MAX_STARTS = 3;
const PROXY_BATCH_SIZE = 50;
const USER_AGENT =
  "VWikiRaceDailyBot/0.0 (https://vwikirace.pages.dev; https://github.com/theonenonlyvj/vwiki-race)";

export interface DailyChallengeCandidate {
  startTitle: string;
  startPageId: number;
  targetTitle: string;
  targetPageId: number;
}

export interface DailyCandidateRequest {
  dailyDate: string;
  flavor: DailyFlavor;
  signal?: AbortSignal;
}

export class DailyChallengeCandidateError extends Error {
  constructor(readonly code: "daily_candidate_unavailable" | "daily_candidate_timeout") {
    super("Wikipedia did not provide a usable daily challenge candidate.");
    this.name = "DailyChallengeCandidateError";
  }
}

export type DailyChallengeDiagnosticEvent =
  | "random_bad_status"
  | "random_invalid_payload"
  | "random_request_failed"
  | "random_request_timeout"
  | "render_failed"
  | "render_mismatch";

export interface DailyCandidateEvaluator {
  findCandidate(request: DailyCandidateRequest): Promise<DailyChallengeCandidate>;
}

export function createDailyCandidateEvaluator(options: {
  fetchImpl: typeof fetch;
  gateway: WikipediaGateway;
  endpoint?: string;
  pageviewsEndpoint?: string;
  now?: () => number;
  phaseTimeoutMs?: number;
  maxRequests?: number;
  onDiagnostic?: (
    event: DailyChallengeDiagnosticEvent,
    fields: Record<string, string | number | boolean>,
  ) => void;
}): DailyCandidateEvaluator {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const pageviewsEndpoint = options.pageviewsEndpoint ?? DEFAULT_PAGEVIEWS_ENDPOINT;
  const now = options.now ?? Date.now;
  const phaseTimeoutMs = clamp(options.phaseTimeoutMs ?? PHASE_TIMEOUT_MS, 1, PHASE_TIMEOUT_MS);
  const maxRequests = clamp(options.maxRequests ?? MAX_REQUESTS, 1, MAX_REQUESTS);
  const budgetsBySignal = new WeakMap<AbortSignal, WikimediaBudget>();
  const targetPools = createEditorialTargetPools({
    fetchImpl: async (input, init) => {
      const signal = init?.signal;
      const budget = signal && budgetsBySignal.get(signal);
      if (!budget) throw new Error("Editorial pool requests require an evaluator budget.");
      return budget.fetch(input, init);
    },
  });

  return {
    async findCandidate(request) {
      const phase = new AbortController();
      let timedOut = false;
      const abortPhase = () => phase.abort();
      request.signal?.addEventListener("abort", abortPhase, { once: true });
      if (request.signal?.aborted) phase.abort();
      const timer = setTimeout(() => {
        timedOut = true;
        phase.abort();
      }, phaseTimeoutMs);
      const budget = createWikimediaBudget({
        fetchImpl: options.fetchImpl,
        now,
        deadline: now() + phaseTimeoutMs,
        maxRequests,
        signal: phase.signal,
        timeout: () => {
          timedOut = true;
          phase.abort();
        },
      });
      budgetsBySignal.set(phase.signal, budget);

      try {
        budget.assertActive();
        const sampledTargets = stableSample(
          (await targetPools.list(request.flavor, phase.signal)).filter(isUsableEditorialTarget),
          MAX_TARGETS,
          `${request.dailyDate}:${request.flavor}:editorial-v1`,
        );
        if (sampledTargets.length === 0) throw unavailable();

        const targets = await loadTargets(sampledTargets, budget, endpoint);
        if (targets.length === 0) throw unavailable();
        for (const target of targets) {
          target.recentPageviews = await loadRecentPageviews(
            target.title,
            budget,
            pageviewsEndpoint,
            new Date(now()),
          );
        }

        const randomStarts = await Promise.all(
          Array.from({ length: MAX_STARTS }, (_unused, index) =>
            randomStart(index + 1, budget, endpoint, diagnostic)),
        );
        const starts = [] as EvaluatedStart[];
        for (const random of randomStarts) {
          if (!random) continue;
          const start = await loadStart(random, budget, options.gateway, diagnostic);
          if (start) starts.push(start);
        }
        if (starts.length === 0) throw unavailable();

        const ranked = rankPairs(starts, targets, request);
        if (ranked.length === 0) throw unavailable();
        if (request.flavor !== "hard") return toCandidate(ranked[0]!);

        for (const pair of ranked) {
          if (!(await hasTwoClickShortcut(pair.start, pair.target, budget, endpoint))) {
            return toCandidate(pair);
          }
        }
        throw unavailable();
      } catch (caught) {
        if (caught instanceof DailyChallengeCandidateError) throw caught;
        if (timedOut || phase.signal.aborted || request.signal?.aborted) {
          throw new DailyChallengeCandidateError("daily_candidate_timeout");
        }
        if (caught instanceof BudgetExhausted) throw unavailable();
        throw unavailable();
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", abortPhase);
        budgetsBySignal.delete(phase.signal);
      }
    },
  };

  function diagnostic(
    event: DailyChallengeDiagnosticEvent,
    fields: Record<string, string | number | boolean>,
  ): void {
    try {
      options.onDiagnostic?.(event, fields);
    } catch {
      // Candidate selection must never depend on diagnostic delivery.
    }
  }
}

interface WikimediaBudget {
  readonly signal: AbortSignal;
  assertActive(): void;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  takeGatewayRequest(): void;
}

interface CanonicalTarget {
  title: string;
  pageId: number;
  articleBytes: number;
  leadText: string;
  hasThumbnail: boolean;
  categories: string[];
  recentPageviews: number | null;
  editorial: {
    recognizable: { vitalLevel?: 1 | 2 | 3 } | false;
    weird: boolean;
  };
}

interface EvaluatedStart {
  title: string;
  pageId: number;
  allowedLinks: string[];
  firstHopTitles: string[];
}

interface CandidatePair {
  start: EvaluatedStart;
  target: CanonicalTarget;
  score: ScoredDailyCandidate;
}

interface RandomStart {
  attempt: number;
  title: string;
  pageId: number;
}

class BudgetExhausted extends Error {}
class WikimediaRequestError extends Error {
  constructor(readonly status: number | null = null) {
    super("Wikimedia request failed.");
  }
}
class MalformedWikimediaResponse extends Error {}

function createWikimediaBudget(options: {
  fetchImpl: typeof fetch;
  now: () => number;
  deadline: number;
  maxRequests: number;
  signal: AbortSignal;
  timeout: () => void;
}): WikimediaBudget {
  let requestCount = 0;

  return {
    signal: options.signal,
    assertActive() {
      if (options.signal.aborted) throw new BudgetExhausted();
      if (options.now() >= options.deadline) {
        options.timeout();
        throw new BudgetExhausted();
      }
    },
    async fetch(input, init) {
      takeRequest();
      try {
        return await options.fetchImpl(input, {
          ...init,
          headers: { "Api-User-Agent": USER_AGENT, "User-Agent": USER_AGENT, ...init?.headers },
          signal: options.signal,
        });
      } catch (caught) {
        if (options.signal.aborted) throw new BudgetExhausted();
        throw caught;
      }
    },
    takeGatewayRequest() {
      takeRequest();
    },
  };

  function takeRequest(): void {
    if (options.signal.aborted) throw new BudgetExhausted();
    if (options.now() >= options.deadline) {
      options.timeout();
      throw new BudgetExhausted();
    }
    if (requestCount >= options.maxRequests) throw new BudgetExhausted();
    requestCount += 1;
  }
}

async function loadTargets(
  editorialTargets: readonly EditorialTarget[],
  budget: WikimediaBudget,
  endpoint: string,
): Promise<CanonicalTarget[]> {
  const requested = editorialTargets.map((target) => parseWikipediaArticleInput(target.title))
    .filter((target): target is NonNullable<typeof target> => target !== null);
  if (requested.length === 0) return [];
  const payload = await apiJson(budget, endpoint, {
    action: "query",
    format: "json",
    formatversion: "2",
    origin: "*",
    redirects: "1",
    titles: requested.map((target) => target.title).join("|"),
    prop: "info|pageprops|extracts|pageimages|categories",
    inprop: "url",
    exintro: "1",
    explaintext: "1",
    piprop: "thumbnail",
    pithumbsize: "320",
    cllimit: "max",
  });
  const pages = queryPages(payload);
  const sources = editorialSourcesByReturnedTitle(payload, editorialTargets);
  const targets: CanonicalTarget[] = [];
  for (const page of pages) {
    const target = parseTarget(page, sources);
    if (target) targets.push(target);
  }
  return deduplicateTargets(targets);
}

async function loadRecentPageviews(
  title: string,
  budget: WikimediaBudget,
  pageviewsEndpoint: string,
  now: Date,
): Promise<number | null> {
  const range = latestCompleteUtcDays(now);
  const expectedTimestamps = completeUtcDayTimestamps(now);
  const url = new URL(
    `metrics/pageviews/per-article/en.wikipedia/all-access/all-agents/${encodeURIComponent(title.replaceAll(" ", "_"))}/daily/${range.start}/${range.end}`,
    ensureTrailingSlash(pageviewsEndpoint),
  );
  try {
    const response = await budget.fetch(url.toString(), { headers: { Accept: "application/json" } });
    if (!response.ok) return null;
    const payload = await response.json() as unknown;
    if (!isRecord(payload) || !Array.isArray(payload.items) || payload.items.length !== 30) return null;
    let total = 0;
    const receivedTimestamps = new Set<string>();
    for (const item of payload.items) {
      if (!isRecord(item) || typeof item.timestamp !== "string" ||
          !expectedTimestamps.has(item.timestamp) || receivedTimestamps.has(item.timestamp) ||
          !Number.isSafeInteger(item.views) || Number(item.views) < 0) return null;
      receivedTimestamps.add(item.timestamp);
      total += Number(item.views);
    }
    if (receivedTimestamps.size !== expectedTimestamps.size || !Number.isSafeInteger(total)) return null;
    return total;
  } catch (caught) {
    if (caught instanceof BudgetExhausted) throw caught;
    return null;
  }
}

async function randomStart(
  attempt: number,
  budget: WikimediaBudget,
  endpoint: string,
  diagnostic: (event: DailyChallengeDiagnosticEvent, fields: Record<string, string | number | boolean>) => void,
): Promise<RandomStart | null> {
  try {
    const payload = await apiJson(budget, endpoint, {
      action: "query",
      format: "json",
      formatversion: "2",
      origin: "*",
      generator: "random",
      grnnamespace: "0",
      grnfilterredir: "nonredirects",
      grnlimit: "1",
      prop: "info|pageprops",
    });
    const page = queryPages(payload)[0];
    if (!page || !validRandomPage(page)) {
      diagnostic("random_invalid_payload", { attempt, role: "start" });
      return null;
    }
    const parsed = parseWikipediaArticleInput(page.title as string);
    if (!parsed) {
      diagnostic("random_invalid_payload", { attempt, role: "start" });
      return null;
    }
    return { attempt, title: parsed.title, pageId: Number(page.pageid) };
  } catch (caught) {
    if (caught instanceof BudgetExhausted) {
      if (budget.signal.aborted) {
        diagnostic("random_request_timeout", {
          attempt,
          role: "start",
          code: "AbortError",
          detail: "Aborted",
        });
      }
      throw caught;
    }
    if (caught instanceof WikimediaRequestError && caught.status !== null) {
      diagnostic("random_bad_status", { attempt, role: "start", status: caught.status });
    } else if (caught instanceof MalformedWikimediaResponse) {
      diagnostic("random_invalid_payload", { attempt, role: "start" });
    } else {
      diagnostic("random_request_failed", {
        attempt,
        role: "start",
        code: diagnosticErrorCode(caught),
        detail: diagnosticErrorDetail(caught),
      });
    }
    return null;
  }
}

async function loadStart(
  random: RandomStart,
  budget: WikimediaBudget,
  gateway: WikipediaGateway,
  diagnostic: (event: DailyChallengeDiagnosticEvent, fields: Record<string, string | number | boolean>) => void,
): Promise<EvaluatedStart | null> {
  try {
    budget.takeGatewayRequest();
    const article = await gateway.getArticle(random.title, { signal: budget.signal });
    const canonicalTitle = parseWikipediaArticleInput(article.canonicalTitle)?.title;
    const pageIdMatches = article.pageId === random.pageId;
    const canonicalTitleMatches = canonicalTitle !== undefined;
    const firstHopTitles = allowedFirstHopTitles(article.links);
    if (!pageIdMatches || !canonicalTitle) {
      diagnostic("render_mismatch", {
        attempt: random.attempt,
        canonicalTitleMatches,
        hasPlayableLink: firstHopTitles.length > 0,
        pageIdMatches,
      });
      return null;
    }
    return {
      title: canonicalTitle,
      pageId: article.pageId,
      allowedLinks: firstHopTitles,
      firstHopTitles,
    };
  } catch (caught) {
    if (caught instanceof BudgetExhausted) throw caught;
    diagnostic("render_failed", {
      attempt: random.attempt,
      code: diagnosticErrorCode(caught),
      detail: diagnosticErrorDetail(caught),
    });
    return null;
  }
}

async function hasTwoClickShortcut(
  start: EvaluatedStart,
  target: CanonicalTarget,
  budget: WikimediaBudget,
  endpoint: string,
): Promise<boolean> {
  for (const titles of chunks(start.firstHopTitles, PROXY_BATCH_SIZE)) {
    const payload = await apiJson(budget, endpoint, {
      action: "query",
      format: "json",
      formatversion: "2",
      origin: "*",
      prop: "links",
      titles: titles.join("|"),
      pllimit: "max",
      pltitles: target.title,
    });
    for (const page of queryPages(payload)) {
      if (!validProxyPage(page)) throw new MalformedWikimediaResponse();
      if (page.links === undefined) continue;
      if (!Array.isArray(page.links)) throw new MalformedWikimediaResponse();
      for (const link of page.links) {
        if (!isRecord(link) || typeof link.title !== "string") throw new MalformedWikimediaResponse();
        if (normalizeTitle(link.title) === normalizeTitle(target.title)) {
          return true;
        }
      }
    }
  }
  return false;
}

function rankPairs(
  starts: readonly EvaluatedStart[],
  targets: readonly CanonicalTarget[],
  request: DailyCandidateRequest,
): CandidatePair[] {
  const pairs: CandidatePair[] = [];
  for (const start of starts) {
    for (const target of targets) {
      const score = scoreDailyCandidate({
        seed: `${request.dailyDate}:${request.flavor}:editorial-v1`,
        start,
        target,
        directEdge: start.firstHopTitles.some((title) => normalizeTitle(title) === normalizeTitle(target.title)),
      });
      if (score.eligible) pairs.push({ start, target, score });
    }
  }
  return pairs.sort((left, right) => {
    const scored = compareScoredDailyCandidates(left.score, right.score, request.flavor);
    if (scored !== 0) return scored;
    return left.start.pageId - right.start.pageId || left.target.pageId - right.target.pageId;
  });
}

function toCandidate(pair: CandidatePair): DailyChallengeCandidate {
  return {
    startTitle: pair.start.title,
    startPageId: pair.start.pageId,
    targetTitle: pair.target.title,
    targetPageId: pair.target.pageId,
  };
}

async function apiJson(
  budget: WikimediaBudget,
  endpoint: string,
  parameters: Record<string, string>,
): Promise<unknown> {
  const url = new URL(endpoint);
  url.search = new URLSearchParams(parameters).toString();
  const response = await budget.fetch(url.toString(), { headers: { Accept: "application/json" } });
  if (!response.ok) throw new WikimediaRequestError(response.status);
  try {
    return await response.json() as unknown;
  } catch {
    throw new MalformedWikimediaResponse();
  }
}

function queryPages(payload: unknown): Record<string, unknown>[] {
  if (!isRecord(payload) || !isRecord(payload.query)) throw new MalformedWikimediaResponse();
  const pages = payload.query.pages;
  if (!Array.isArray(pages)) throw new MalformedWikimediaResponse();
  const records: Record<string, unknown>[] = [];
  for (const page of pages) {
    if (!isRecord(page)) throw new MalformedWikimediaResponse();
    records.push(page);
  }
  return records;
}

function validProxyPage(page: Record<string, unknown>): boolean {
  return page.ns === 0 &&
    Number.isSafeInteger(page.pageid) && Number(page.pageid) > 0 &&
    typeof page.title === "string" && parseWikipediaArticleInput(page.title) !== null &&
    page.missing === undefined && page.invalid === undefined;
}

interface EditorialSources {
  byPageId: Map<number, EditorialTarget>;
  byTitle: Map<string, EditorialTarget>;
}

function editorialSourcesByReturnedTitle(
  payload: unknown,
  sources: readonly EditorialTarget[],
): EditorialSources {
  const entries: EditorialSources = { byPageId: new Map(), byTitle: new Map() };
  for (const source of sources) {
    entries.byTitle.set(normalizeTitle(source.title), source);
    if (source.pageId !== undefined) entries.byPageId.set(source.pageId, source);
  }
  if (!isRecord(payload) || !isRecord(payload.query) || !Array.isArray(payload.query.redirects)) return entries;
  for (const redirect of payload.query.redirects) {
    if (!isRecord(redirect) || typeof redirect.from !== "string" || typeof redirect.to !== "string") continue;
    const source = entries.byTitle.get(normalizeTitle(redirect.from));
    if (source) entries.byTitle.set(normalizeTitle(redirect.to), source);
  }
  return entries;
}

function parseTarget(
  page: Record<string, unknown>,
  sources: EditorialSources,
): CanonicalTarget | null {
  if (page.ns !== 0 || page.missing !== undefined || page.redirect !== undefined ||
      !Number.isSafeInteger(page.pageid) || Number(page.pageid) < 1 ||
      !Number.isSafeInteger(page.length) || Number(page.length) < 0 ||
      typeof page.title !== "string" || typeof page.extract !== "string") return null;
  const parsed = parseWikipediaArticleInput(page.title);
  if (!parsed || page.pageprops !== undefined && isRecord(page.pageprops) && page.pageprops.disambiguation !== undefined) return null;
  const source = sources.byPageId.get(Number(page.pageid)) ?? sources.byTitle.get(normalizeTitle(parsed.title));
  if (!source) return null;
  return {
    title: parsed.title,
    pageId: Number(page.pageid),
    articleBytes: Number(page.length),
    leadText: page.extract,
    hasThumbnail: isRecord(page.thumbnail) && typeof page.thumbnail.source === "string" && page.thumbnail.source.length > 0,
    categories: Array.isArray(page.categories)
      ? page.categories.flatMap((category) => isRecord(category) && typeof category.title === "string" ? [category.title] : [])
      : [],
    recentPageviews: null,
    editorial: {
      recognizable: source.source === "vital" ? { vitalLevel: source.vitalLevel } : false,
      weird: source.source === "unusual",
    },
  };
}

function validRandomPage(page: Record<string, unknown>): boolean {
  return page.ns === 0 && page.missing === undefined && page.redirect === undefined &&
    !(isRecord(page.pageprops) && page.pageprops.disambiguation !== undefined) &&
    Number.isSafeInteger(page.pageid) && Number(page.pageid) > 0 && typeof page.title === "string";
}

function allowedFirstHopTitles(links: readonly { href: string; title: string }[]): string[] {
  const titles = new Set<string>();
  for (const link of links) {
    if (!isAllowedArticleHref(link.href)) continue;
    const title = parseWikipediaArticleInput(link.title)?.title;
    if (title) titles.add(title);
  }
  return [...titles];
}

function latestCompleteUtcDays(now: Date): { start: string; end: string } {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 29);
  return { start: compactUtcDate(start), end: compactUtcDate(end) };
}

function completeUtcDayTimestamps(now: Date): Set<string> {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const timestamps = new Set<string>();
  for (let offset = 29; offset >= 0; offset -= 1) {
    const day = new Date(end);
    day.setUTCDate(day.getUTCDate() - offset);
    timestamps.add(`${compactUtcDate(day)}00`);
  }
  return timestamps;
}

function compactUtcDate(date: Date): string {
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
}

function deduplicateTargets(targets: readonly CanonicalTarget[]): CanonicalTarget[] {
  const seen = new Set<number>();
  return targets.filter((target) => {
    if (seen.has(target.pageId)) return false;
    seen.add(target.pageId);
    return true;
  });
}

function isUsableEditorialTarget(target: EditorialTarget): boolean {
  return parseWikipediaArticleInput(target.title) !== null;
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function unavailable(): DailyChallengeCandidateError {
  return new DailyChallengeCandidateError("daily_candidate_unavailable");
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return maximum;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function diagnosticErrorCode(caught: unknown): string {
  if (caught && typeof caught === "object") {
    if ("code" in caught && typeof (caught as { code?: unknown }).code === "string") {
      return (caught as { code: string }).code.slice(0, 64);
    }
    if ("name" in caught && typeof (caught as { name?: unknown }).name === "string") {
      return (caught as { name: string }).name.slice(0, 64);
    }
  }
  return "unknown";
}

function diagnosticErrorDetail(caught: unknown): string {
  if (caught && typeof caught === "object" && "message" in caught &&
      typeof (caught as { message?: unknown }).message === "string") {
    return (caught as { message: string }).message
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .trim()
      .slice(0, 128);
  }
  return "unavailable";
}
