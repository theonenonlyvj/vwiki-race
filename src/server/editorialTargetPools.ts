import { DOMParser as WorkerDOMParser } from "linkedom/worker";
import { normalizeTitle, parseWikipediaArticleTarget } from "../domain/rules";
import type { DailyFlavor } from "../domain/dailyEditorial";
import { WIKIMEDIA_API_USER_AGENT } from "../services/wikipediaGateway";

const CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const STALE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const WIKIPEDIA_BASE_URL = "https://en.wikipedia.org";
// Single canonical UA (also used by the gateway/validator) so Wikimedia
// robot-policy compliance only needs verifying in one place.
const USER_AGENT = WIKIMEDIA_API_USER_AGENT;

export interface EditorialTarget {
  title: string;
  /** Project-page HTML normally lacks IDs; the evaluator canonicalizes these later. */
  pageId?: number;
  source: "vital" | "unusual";
  vitalLevel?: 1 | 2 | 3;
}

/**
 * Per-source-URL fetch/parse outcome, captured for all 4 source pages
 * regardless of whether the overall pool load succeeds. Lets a total pool
 * failure name exactly which source misbehaved and how (bad status /
 * network error / a parser that suddenly found zero entries) instead of
 * the previous single opaque error (see the 2026-07-19 incident, where
 * Wikipedia:Unusual_articles switched from <dt> definition lists to
 * <table class="wikitable"> rows and the parser silently found nothing).
 */
export interface EditorialSourceDiagnostic {
  url: string;
  /** HTTP status if a response was received; null on a fetch/network failure. */
  status: number | null;
  /** Error name/code if the fetch itself failed; null when a response came back. */
  errorCode: string | null;
  /** Parsed entry count; null when the source couldn't be read at all (fetch failure). */
  entryCount: number | null;
}

export class EditorialTargetPoolError extends Error {
  readonly sources: readonly EditorialSourceDiagnostic[];

  constructor(
    message = "Wikipedia did not provide a valid editorial target pool.",
    sources: readonly EditorialSourceDiagnostic[] = [],
  ) {
    super(message);
    this.name = "EditorialTargetPoolError";
    this.sources = sources;
  }
}

interface EditorialPoolCache {
  loadedAt: number;
  recognizable: EditorialTarget[];
  weird: EditorialTarget[];
}

export interface EditorialTargetPools {
  list(flavor: DailyFlavor, signal?: AbortSignal): Promise<EditorialTarget[]>;
}

export function createEditorialTargetPools(options: {
  fetchImpl?: typeof fetch;
  now?: () => number;
  vitalUrls?: readonly [string, string, string];
  unusualUrl?: string;
  /** Fired once per total pool-load failure with all 4 sources' outcomes. */
  onDiagnostic?: (sources: readonly EditorialSourceDiagnostic[]) => void;
} = {}): EditorialTargetPools {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const vitalUrls = options.vitalUrls ?? [
    `${WIKIPEDIA_BASE_URL}/wiki/Wikipedia:Vital_articles/Level/1`,
    `${WIKIPEDIA_BASE_URL}/wiki/Wikipedia:Vital_articles/Level/2`,
    `${WIKIPEDIA_BASE_URL}/wiki/Wikipedia:Vital_articles/Level/3`,
  ];
  const unusualUrl = options.unusualUrl ?? `${WIKIPEDIA_BASE_URL}/wiki/Wikipedia:Unusual_articles`;
  const onDiagnostic = options.onDiagnostic;
  let cache: EditorialPoolCache | null = null;

  return {
    async list(flavor, signal) {
      throwIfAborted(signal);
      const requestedAt = now();
      if (cache && requestedAt - cache.loadedAt < CACHE_TTL_MS) {
        return forFlavor(cache, flavor);
      }

      try {
        const loaded = await load(signal);
        cache = { loadedAt: requestedAt, ...loaded };
        return forFlavor(cache, flavor);
      } catch (caught) {
        if (isAbort(caught) || signal?.aborted) throw caught;
        if (cache && requestedAt - cache.loadedAt <= STALE_TTL_MS) {
          return forFlavor(cache, flavor);
        }
        throw caught instanceof EditorialTargetPoolError
          ? caught
          : new EditorialTargetPoolError();
      }
    },
  };

  async function load(signal?: AbortSignal): Promise<Omit<EditorialPoolCache, "loadedAt">> {
    // Fetch+parse all 4 sources independently (never short-circuit on a
    // single bad source, aborts excepted) so a total failure can report
    // every source's outcome, not just whichever happened to fail first.
    const vitalOutcomes = await Promise.all(vitalUrls.map(async (url, index) => {
      const level = (index + 1) as 1 | 2 | 3;
      const fetched = await fetchSource(fetchImpl, url, signal);
      const entries = fetched.html !== null ? parseVitalEntries(fetched.html, level) : [];
      const diagnostic: EditorialSourceDiagnostic = {
        url,
        status: fetched.status,
        errorCode: fetched.errorCode,
        entryCount: fetched.html !== null ? entries.length : null,
      };
      return { entries, diagnostic };
    }));
    const unusualFetched = await fetchSource(fetchImpl, unusualUrl, signal);
    const unusualEntries = unusualFetched.html !== null ? parseUnusualEntries(unusualFetched.html) : [];
    const unusualDiagnostic: EditorialSourceDiagnostic = {
      url: unusualUrl,
      status: unusualFetched.status,
      errorCode: unusualFetched.errorCode,
      entryCount: unusualFetched.html !== null ? unusualEntries.length : null,
    };

    const sources = [...vitalOutcomes.map((outcome) => outcome.diagnostic), unusualDiagnostic];
    const vitalFailed = vitalOutcomes.some((outcome) => outcome.entries.length === 0);
    if (vitalFailed || unusualEntries.length === 0) {
      onDiagnostic?.(sources);
      throw new EditorialTargetPoolError(undefined, sources);
    }

    return {
      recognizable: deduplicate(vitalOutcomes.flatMap((outcome) => outcome.entries)),
      weird: unusualEntries,
    };
  }
}

export function parseVitalEntries(html: string, vitalLevel: 1 | 2 | 3): EditorialTarget[] {
  const document = parseHtml(html);
  const entries: EditorialTarget[] = [];
  for (const item of Array.from(document.querySelectorAll("#mw-content-text li, main li"))) {
    const anchor = firstDirectArticleLink(item);
    const target = anchor && entryFromAnchor(anchor, { source: "vital", vitalLevel });
    if (target) entries.push(target);
  }
  return deduplicate(entries);
}

export function parseUnusualEntries(html: string): EditorialTarget[] {
  const document = parseHtml(html);
  const entries: EditorialTarget[] = [];
  // Legacy layout: each entry is a description-list term, e.g.
  // <dt><a href="/wiki/Foo">Foo</a></dt><dd>...</dd>
  for (const term of Array.from(document.querySelectorAll("#mw-content-text dt, main dt"))) {
    const target = firstUsableAnchorEntry(term, "unusual");
    if (target) entries.push(target);
  }
  // Current layout (since ~2026-07): entries live in two-column wikitable
  // rows, e.g. <table class="wikitable"><tr><td><b><a href="/wiki/Foo">Foo</a></b></td><td>description</td></tr>...
  // Only the row's first cell (the title cell) is considered - the second
  // cell is free-text description prose that itself contains unrelated
  // wiki-links we must not treat as entries.
  for (const row of Array.from(document.querySelectorAll("#mw-content-text table.wikitable tr, main table.wikitable tr"))) {
    const firstCell = row.querySelector("td");
    if (!firstCell) continue;
    const target = firstUsableAnchorEntry(firstCell, "unusual");
    if (target) entries.push(target);
  }
  return deduplicate(entries);
}

function firstUsableAnchorEntry(scope: Element, source: EditorialTarget["source"]): EditorialTarget | null {
  for (const anchor of Array.from(scope.querySelectorAll("a"))) {
    const target = entryFromAnchor(anchor, { source });
    if (target) return target;
  }
  return null;
}

interface SourceFetchResult {
  status: number | null;
  errorCode: string | null;
  html: string | null;
}

async function fetchSource(fetchImpl: typeof fetch, url: string, signal?: AbortSignal): Promise<SourceFetchResult> {
  throwIfAborted(signal);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { "Api-User-Agent": USER_AGENT, "User-Agent": USER_AGENT, Accept: "text/html" },
      signal,
    });
  } catch (caught) {
    if (isAbort(caught) || signal?.aborted) throw caught;
    return { status: null, errorCode: errorCodeOf(caught), html: null };
  }
  if (!response.ok) return { status: response.status, errorCode: null, html: null };
  const html = await response.text();
  if (!html.trim()) return { status: response.status, errorCode: "empty_body", html: null };
  return { status: response.status, errorCode: null, html };
}

function errorCodeOf(caught: unknown): string {
  if (caught && typeof caught === "object") {
    if ("name" in caught && typeof (caught as { name?: unknown }).name === "string") {
      return (caught as { name: string }).name.slice(0, 64);
    }
  }
  return "fetch_error";
}

function parseHtml(html: string): Document {
  return new WorkerDOMParser().parseFromString(html, "text/html") as unknown as Document;
}

function firstDirectArticleLink(item: Element): Element | null {
  for (const child of Array.from(item.children)) {
    if (child.tagName.toLowerCase() === "a" && entryFromAnchor(child, { source: "vital" })) return child;
  }
  return null;
}

function entryFromAnchor(
  anchor: Element,
  attributes: Pick<EditorialTarget, "source" | "vitalLevel">,
): EditorialTarget | null {
  const href = anchor.getAttribute("href");
  if (!href || href.includes("#") || !isCanonicalArticleHref(href)) return null;
  const parsed = parseWikipediaArticleTarget(href, {
    redLink: anchor.classList.contains("new") || anchor.getAttribute("data-redlink") === "1",
  });
  if (!parsed) return null;
  const pageId = readPageId(anchor);
  return { title: parsed.title, ...(pageId ? { pageId } : {}), ...attributes };
}

function isCanonicalArticleHref(href: string): boolean {
  if (href.includes("?") || href.includes("#")) return false;
  return href.startsWith("/wiki/") || /^https:\/\/en\.wikipedia\.org\/wiki\//i.test(href);
}

function readPageId(anchor: Element): number | undefined {
  const values = [
    anchor.getAttribute("data-pageid"),
    anchor.getAttribute("data-page-id"),
    pageIdFromDataMw(anchor.getAttribute("data-mw")),
  ];
  for (const value of values) {
    const pageId = typeof value === "number" ? value : Number(value);
    if (Number.isSafeInteger(pageId) && pageId > 0) return pageId;
  }
  return undefined;
}

function pageIdFromDataMw(value: string | null): number | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as { pageId?: unknown; pageid?: unknown };
    const candidate = parsed.pageId ?? parsed.pageid;
    return typeof candidate === "number" ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function deduplicate(entries: readonly EditorialTarget[]): EditorialTarget[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = normalizeTitle(entry.title);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function forFlavor(cache: EditorialPoolCache, flavor: DailyFlavor): EditorialTarget[] {
  if (flavor === "recognizable") return recognizableVitalEntries(cache.recognizable);
  if (flavor === "weird") return [...cache.weird];
  // hard: the full vital union (Level 1-3) plus unusual - hard days may
  // lean on obscure Level 3 entries, that is the point (owner decision 3).
  return deduplicate([...cache.recognizable, ...cache.weird]);
}

const RECOGNIZABLE_MAX_VITAL_LEVEL = 2;

/**
 * Owner decision 3: the daily "recognizable" pool serves only famous
 * (Level 1-2) vital articles - Level 3 stays in the vital pool for "hard"
 * only. `entries` is `cache.recognizable`, the full Level 1-3 vital union.
 *
 * If the Level 1-2 subset is ever empty (a parse regression - structurally
 * shouldn't happen today since `load()` already fails the whole pool load
 * when any single level's entryCount is 0, but this defends against a
 * future refactor of that guard), degrade to the full vital set rather
 * than serving an empty "recognizable" pool - the 2026-07-19
 * Unusual_articles incident taught us a thin pool must degrade, not die.
 */
export function recognizableVitalEntries(entries: readonly EditorialTarget[]): EditorialTarget[] {
  const famous = entries.filter((entry) => (entry.vitalLevel ?? 3) <= RECOGNIZABLE_MAX_VITAL_LEVEL);
  if (famous.length > 0) return famous;
  console.error("editorial_recognizable_subset_empty", JSON.stringify({ vitalPoolSize: entries.length }));
  return [...entries];
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

function isAbort(caught: unknown): boolean {
  return caught instanceof DOMException && caught.name === "AbortError";
}
