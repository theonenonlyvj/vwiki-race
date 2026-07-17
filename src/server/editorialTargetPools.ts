import { DOMParser as WorkerDOMParser } from "linkedom/worker";
import { normalizeTitle, parseWikipediaArticleTarget } from "../domain/rules";
import type { DailyFlavor } from "../domain/dailyEditorial";

const CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const STALE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const WIKIPEDIA_BASE_URL = "https://en.wikipedia.org";
const USER_AGENT =
  "VWiki Race/0.0 (https://vwikirace.pages.dev; contact: https://github.com/theonenonlyvj/vwiki-race)";

export interface EditorialTarget {
  title: string;
  /** Project-page HTML normally lacks IDs; the evaluator canonicalizes these later. */
  pageId?: number;
  source: "vital" | "unusual";
  vitalLevel?: 1 | 2 | 3;
}

export class EditorialTargetPoolError extends Error {
  constructor(message = "Wikipedia did not provide a valid editorial target pool.") {
    super(message);
    this.name = "EditorialTargetPoolError";
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
} = {}): EditorialTargetPools {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const vitalUrls = options.vitalUrls ?? [
    `${WIKIPEDIA_BASE_URL}/wiki/Wikipedia:Vital_articles/Level/1`,
    `${WIKIPEDIA_BASE_URL}/wiki/Wikipedia:Vital_articles/Level/2`,
    `${WIKIPEDIA_BASE_URL}/wiki/Wikipedia:Vital_articles/Level/3`,
  ];
  const unusualUrl = options.unusualUrl ?? `${WIKIPEDIA_BASE_URL}/wiki/Wikipedia:Unusual_articles`;
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
    const vital = await Promise.all(vitalUrls.map(async (url, index) => {
      const html = await fetchHtml(fetchImpl, url, signal);
      const entries = parseVitalEntries(html, (index + 1) as 1 | 2 | 3);
      if (entries.length === 0) throw new EditorialTargetPoolError();
      return entries;
    }));
    const unusual = parseUnusualEntries(await fetchHtml(fetchImpl, unusualUrl, signal));
    if (unusual.length === 0) throw new EditorialTargetPoolError();

    return {
      recognizable: deduplicate(vital.flat()),
      weird: unusual,
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
  for (const term of Array.from(document.querySelectorAll("#mw-content-text dt, main dt"))) {
    for (const anchor of Array.from(term.querySelectorAll("a"))) {
      const target = entryFromAnchor(anchor, { source: "unusual" });
      if (target) {
        entries.push(target);
        break;
      }
    }
  }
  return deduplicate(entries);
}

async function fetchHtml(fetchImpl: typeof fetch, url: string, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { "Api-User-Agent": USER_AGENT, "User-Agent": USER_AGENT, Accept: "text/html" },
      signal,
    });
  } catch (caught) {
    if (isAbort(caught) || signal?.aborted) throw caught;
    throw new EditorialTargetPoolError();
  }
  if (!response.ok) throw new EditorialTargetPoolError();
  const html = await response.text();
  if (!html.trim()) throw new EditorialTargetPoolError();
  return html;
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
  if (flavor === "recognizable") return [...cache.recognizable];
  if (flavor === "weird") return [...cache.weird];
  return deduplicate([...cache.recognizable, ...cache.weird]);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

function isAbort(caught: unknown): boolean {
  return caught instanceof DOMException && caught.name === "AbortError";
}
