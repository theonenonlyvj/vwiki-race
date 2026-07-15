const WIKIPEDIA_ARTICLE_BASE = "https://en.wikipedia.org/wiki/";

const DISALLOWED_NAMESPACES = new Set([
  "category",
  "category talk",
  "draft",
  "draft talk",
  "file",
  "file talk",
  "gadget",
  "gadget definition",
  "gadget definition talk",
  "gadget talk",
  "help",
  "help talk",
  "image",
  "image talk",
  "media",
  "mediawiki",
  "mediawiki talk",
  "module",
  "module talk",
  "portal",
  "portal talk",
  "project",
  "project talk",
  "special",
  "talk",
  "template",
  "template talk",
  "timedtext",
  "timedtext talk",
  "topic",
  "user",
  "user talk",
  "wikipedia",
  "wikipedia talk",
  "wp",
  "wt",
]);

export interface WikipediaArticleTarget {
  title: string;
  sourceUrl: string;
}

export function parseWikipediaArticleTarget(
  candidate: string,
  options: { redLink?: boolean } = {},
): WikipediaArticleTarget | null {
  const trimmed = candidate.trim();
  if (!trimmed || options.redLink || trimmed.startsWith("//")) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(trimmed, WIKIPEDIA_ARTICLE_BASE);
  } catch {
    return null;
  }

  if (
    url.protocol !== "https:" ||
    url.hostname !== "en.wikipedia.org" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    !url.pathname.startsWith("/wiki/") ||
    url.search !== ""
  ) {
    return null;
  }

  const encodedSegments = url.pathname.slice("/wiki/".length).split("/");
  if (!encodedSegments[0]) {
    return null;
  }

  let decodedSegments: string[];
  try {
    decodedSegments = encodedSegments.map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }

  const title = decodedSegments.join("/").replaceAll("_", " ").trim();
  if (!title || /[\u0000-\u001f\u007f]/.test(title)) {
    return null;
  }

  const namespace = title.split(":", 1)[0]?.trim().toLowerCase();
  if (namespace && DISALLOWED_NAMESPACES.has(namespace)) {
    return null;
  }

  return {
    title,
    sourceUrl: wikipediaArticleUrl(title),
  };
}

export function isAllowedArticleHref(href: string): boolean {
  return parseWikipediaArticleTarget(href) !== null;
}

export function extractTitleFromHref(href: string): string | null {
  return parseWikipediaArticleTarget(href)?.title ?? null;
}

export function wikipediaArticleUrl(title: string): string {
  const encodedTitle = title
    .split("/")
    .map((segment) => encodeURIComponent(segment.replaceAll(" ", "_")))
    .join("/");
  return `${WIKIPEDIA_ARTICLE_BASE}${encodedTitle}`;
}

export function normalizeTitle(title: string): string {
  return title.trim().replaceAll("_", " ").replace(/\s+/g, " ").toLowerCase();
}
