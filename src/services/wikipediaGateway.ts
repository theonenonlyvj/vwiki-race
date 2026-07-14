import {
  extractTitleFromHref,
  isAllowedArticleHref,
  normalizeTitle,
} from "../domain/rules";
import type { Article, ArticleLink } from "../domain/types";

const DEFAULT_ENDPOINT = "https://en.wikipedia.org/w/api.php";
const REMOVE_SELECTORS = [
  ".toc",
  ".navbox",
  ".vertical-navbox",
  ".metadata",
  ".reference",
  ".mw-editsection",
  ".reflist",
  ".refbegin",
  ".ambox",
  ".sistersitebox",
];
const REMOVE_SECTION_TITLES = new Set([
  "external links",
  "further reading",
  "notes",
  "references",
  "see also",
]);

export interface WikipediaGateway {
  getArticle(title: string): Promise<Article>;
}

export function createWikipediaGateway(options: {
  fetchImpl: typeof fetch;
  endpoint?: string;
}): WikipediaGateway {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const articleCache = new Map<string, Promise<Article>>();

  return {
    async getArticle(title) {
      const cacheKey = normalizeTitle(title);
      const cached = articleCache.get(cacheKey);
      if (cached) {
        return cached;
      }

      const request = fetchArticle(options.fetchImpl, endpoint, title);
      articleCache.set(cacheKey, request);
      return request;
    },
  };
}

async function fetchArticle(
  fetchImpl: typeof fetch,
  endpoint: string,
  title: string,
): Promise<Article> {
  const url = buildParseUrl(endpoint, title);
  const response = await fetchImpl(url, {
    headers: {
      "Api-User-Agent": "VWikiRace/0.1 (local development)",
    },
  });
  if (!response.ok) {
    throw new Error(`Wikipedia fetch failed with status ${response.status}`);
  }

  const payload = (await response.json()) as MediaWikiParseResponse;
  if (!payload.parse) {
    throw new Error("Wikipedia response did not include parse data");
  }

  const rawHtml = readParseHtml(payload.parse);
  const { html, links } = sanitizeArticleHtml(rawHtml, payload.parse.title);

  return {
    pageId: payload.parse.pageid,
    canonicalTitle: payload.parse.title,
    revisionId: payload.parse.revid,
    html,
    links,
    attribution: "Content from Wikipedia, available under CC BY-SA.",
  };
}

function buildParseUrl(endpoint: string, title: string): string {
  const url = new URL(endpoint);
  url.search = new URLSearchParams({
    action: "parse",
    page: title,
    prop: "text|revid",
    redirects: "1",
    disableeditsection: "1",
    format: "json",
    origin: "*",
  }).toString();
  return url.toString();
}

function readParseHtml(parse: MediaWikiParsePayload): string {
  if (typeof parse.text === "string") {
    return parse.text;
  }

  const legacyText = parse.text?.["*"];
  if (typeof legacyText === "string") {
    return legacyText;
  }

  throw new Error("Wikipedia parse payload did not include article HTML");
}

function sanitizeArticleHtml(
  rawHtml: string,
  currentTitle: string,
): {
  html: string;
  links: ArticleLink[];
} {
  const document = new DOMParser().parseFromString(
    `<div class="vwiki-race-article-root">${rawHtml}</div>`,
    "text/html",
  );
  const root = document.querySelector(".vwiki-race-article-root");
  if (!root) {
    throw new Error("Could not parse article HTML");
  }

  for (const element of root.querySelectorAll(REMOVE_SELECTORS.join(","))) {
    element.remove();
  }
  removeRuleExcludedSections(root);
  normalizeMediaUrls(root);

  const links: ArticleLink[] = [];
  for (const anchor of root.querySelectorAll("a")) {
    const href = anchor.getAttribute("href") ?? "";
    if (!isAllowedArticleHref(href)) {
      anchor.replaceWith(document.createTextNode(anchor.textContent ?? ""));
      continue;
    }

    const title = extractTitleFromHref(href);
    if (!title) {
      anchor.replaceWith(document.createTextNode(anchor.textContent ?? ""));
      continue;
    }

    if (normalizeTitle(title) === normalizeTitle(currentTitle)) {
      anchor.replaceWith(document.createTextNode(anchor.textContent ?? ""));
      continue;
    }

    const anchorText = anchor.textContent?.trim() || title;
    links.push({
      href,
      title,
      anchorText,
      sourceSection: closestSectionTitle(anchor),
    });
    anchor.setAttribute("href", `#article:${encodeURIComponent(title)}`);
    anchor.setAttribute("data-vwiki-race-title", title);
    anchor.setAttribute("data-vwiki-race-href", href);
  }

  return {
    html: root.innerHTML,
    links,
  };
}

function removeRuleExcludedSections(root: Element) {
  const headings = [...root.querySelectorAll("h2, .mw-heading2")];
  for (const heading of headings) {
    if (!REMOVE_SECTION_TITLES.has(normalizeSectionLabel(heading.textContent ?? ""))) {
      continue;
    }

    removeSectionFrom(heading);
  }
}

function removeSectionFrom(sectionStart: Element) {
  const start =
    sectionStart.classList.contains("mw-heading2") ||
    sectionStart.parentElement?.classList.contains("mw-parser-output")
      ? sectionStart
      : sectionStart.parentElement ?? sectionStart;
  let sibling = start.nextElementSibling;
  while (sibling && !isTopLevelSectionHeading(sibling)) {
    const next = sibling.nextElementSibling;
    sibling.remove();
    sibling = next;
  }
  start.remove();
}

function isTopLevelSectionHeading(element: Element): boolean {
  return element.matches("h2, .mw-heading2");
}

function normalizeSectionLabel(value: string): string {
  return value.trim().replace(/\[edit\]/gi, "").replace(/\s+/g, " ").toLowerCase();
}

function normalizeMediaUrls(root: Element) {
  for (const image of root.querySelectorAll("img")) {
    rewriteUrlAttribute(image, "src");
    rewriteSrcSet(image);
  }
}

function rewriteUrlAttribute(element: Element, attribute: string) {
  const value = element.getAttribute(attribute);
  if (!value) {
    return;
  }

  element.setAttribute(attribute, absolutizeMediaUrl(value));
}

function rewriteSrcSet(image: Element) {
  const srcset = image.getAttribute("srcset");
  if (!srcset) {
    return;
  }

  image.setAttribute(
    "srcset",
    srcset
      .split(",")
      .map((candidate) => {
        const [url, ...descriptor] = candidate.trim().split(/\s+/);
        return [absolutizeMediaUrl(url), ...descriptor].join(" ");
      })
      .join(", "),
  );
}

function absolutizeMediaUrl(url: string): string {
  if (url.startsWith("//")) {
    return `https:${url}`;
  }
  if (url.startsWith("/")) {
    return `https://en.wikipedia.org${url}`;
  }
  return url;
}

function closestSectionTitle(anchor: Element): string | undefined {
  let node: Element | null = anchor;
  while (node) {
    const heading = node.previousElementSibling;
    if (heading?.matches("h2, h3, h4")) {
      return heading.textContent?.trim() || undefined;
    }
    node = node.parentElement;
  }
  return undefined;
}

interface MediaWikiParseResponse {
  parse?: MediaWikiParsePayload;
}

interface MediaWikiParsePayload {
  title: string;
  pageid: number;
  revid?: number;
  text?: string | { "*": string };
}
