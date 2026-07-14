const DISALLOWED_NAMESPACES = new Set([
  "category",
  "file",
  "help",
  "module",
  "portal",
  "special",
  "talk",
  "template",
  "user",
  "wikipedia",
]);

export function isAllowedArticleHref(href: string): boolean {
  return extractTitleFromHref(href) !== null;
}

export function extractTitleFromHref(href: string): string | null {
  const rawTitle = readWikiTitleSegment(href);
  if (!rawTitle) {
    return null;
  }

  if (rawTitle.includes("/")) {
    return null;
  }

  const decodedTitle = safeDecodeURIComponent(rawTitle).replaceAll("_", " ");
  const namespace = decodedTitle.split(":", 1)[0]?.toLowerCase();
  if (namespace && DISALLOWED_NAMESPACES.has(namespace)) {
    return null;
  }

  return decodedTitle;
}

function readWikiTitleSegment(href: string): string | null {
  if (href.startsWith("/wiki/")) {
    return href.slice("/wiki/".length).split("#")[0] || null;
  }

  if (href.startsWith("./")) {
    return href.slice("./".length).split("#")[0] || null;
  }

  if (href.startsWith("//en.wikipedia.org/wiki/")) {
    return href.slice("//en.wikipedia.org/wiki/".length).split("#")[0] || null;
  }

  try {
    const url = new URL(href);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return null;
    }
    if (url.hostname !== "en.wikipedia.org") {
      return null;
    }
    if (!url.pathname.startsWith("/wiki/")) {
      return null;
    }
    return url.pathname.slice("/wiki/".length).split("#")[0] || null;
  } catch {
    return null;
  }
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function normalizeTitle(title: string): string {
  return title.trim().replaceAll("_", " ").replace(/\s+/g, " ").toLowerCase();
}
