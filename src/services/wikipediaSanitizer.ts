import {
  normalizeTitle,
  parseWikipediaArticleTarget,
} from "../domain/rules";
import type { ArticleLink } from "../domain/types";

const REMOVE_SELECTORS = [
  "[role='navigation']",
  "#catlinks",
  "#toc",
  ".ambox",
  ".authority-control",
  ".catlinks",
  ".hatnote",
  ".metadata",
  ".mw-cite-backlink",
  ".mw-editsection",
  ".mw-indicators",
  ".mw-jump-link",
  ".navbox",
  ".navbar",
  ".portal",
  ".portalbox",
  ".printfooter",
  ".refbegin",
  ".refend",
  ".reference",
  ".reflist",
  ".sistersitebox",
  ".sidebar",
  ".toc",
  ".vertical-navbox",
  "form",
  "nav",
];

const REMOVE_SECTION_TITLES = new Set([
  "bibliography",
  "citations",
  "external links",
  "footnotes",
  "further reading",
  "notes",
  "references",
  "see also",
  "sources",
  "works cited",
]);

const ALLOWED_HTML_TAGS = new Set([
  "a",
  "abbr",
  "b",
  "bdi",
  "bdo",
  "blockquote",
  "br",
  "caption",
  "cite",
  "code",
  "data",
  "dd",
  "del",
  "dfn",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "kbd",
  "li",
  "ol",
  "p",
  "picture",
  "pre",
  "q",
  "rp",
  "rt",
  "ruby",
  "s",
  "samp",
  "small",
  "source",
  "span",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "time",
  "tr",
  "u",
  "ul",
  "var",
  "wbr",
]);

const ALLOWED_MATHML_TAGS = new Set([
  "math",
  "menclose",
  "merror",
  "mfenced",
  "mfrac",
  "mi",
  "mmultiscripts",
  "mn",
  "mo",
  "mover",
  "mpadded",
  "mphantom",
  "mprescripts",
  "mroot",
  "mrow",
  "ms",
  "mspace",
  "msqrt",
  "mstyle",
  "msub",
  "msubsup",
  "msup",
  "mtable",
  "mtd",
  "mtext",
  "mtr",
  "munder",
  "munderover",
  "none",
  "semantics",
]);

const DROP_WITH_CONTENTS = new Set([
  "applet",
  "audio",
  "base",
  "canvas",
  "embed",
  "frame",
  "frameset",
  "iframe",
  "link",
  "meta",
  "noscript",
  "object",
  "script",
  "style",
  "svg",
  "template",
  "video",
]);

const GLOBAL_ATTRIBUTES = new Set([
  "aria-hidden",
  "aria-label",
  "class",
  "dir",
  "lang",
  "title",
]);

const TAG_ATTRIBUTES: Record<string, ReadonlySet<string>> = {
  a: new Set([
    "data-vwiki-race-href",
    "data-vwiki-race-title",
    "href",
  ]),
  data: new Set(["value"]),
  figure: new Set(["typeof"]),
  img: new Set([
    "alt",
    "decoding",
    "height",
    "loading",
    "src",
    "srcset",
    "width",
  ]),
  li: new Set(["value"]),
  math: new Set(["display"]),
  ol: new Set(["reversed", "start", "type"]),
  source: new Set(["media", "sizes", "srcset", "type"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["abbr", "colspan", "rowspan", "scope"]),
  time: new Set(["datetime"]),
};

const WIKIMEDIA_MEDIA_HOSTS = new Set([
  "commons.wikimedia.org",
  "en.wikipedia.org",
  "upload.wikimedia.org",
]);

export interface SanitizedWikipediaArticle {
  sanitizedHtml: string;
  links: ArticleLink[];
}

export function sanitizeWikipediaArticleHtml(
  rawHtml: string,
  currentTitle: string,
): SanitizedWikipediaArticle {
  const document = new DOMParser().parseFromString(rawHtml, "text/html");
  const root = document.body;

  for (const element of root.querySelectorAll(REMOVE_SELECTORS.join(","))) {
    element.remove();
  }
  removeUnsafeSubtrees(root);
  removeRuleExcludedSections(root);

  const links = rewriteArticleLinks(document, root, currentTitle);
  sanitizeTree(root);
  rewriteMediaUrls(root);

  return {
    links,
    sanitizedHtml: root.innerHTML,
  };
}

function rewriteArticleLinks(
  _document: Document,
  root: HTMLElement,
  currentTitle: string,
): ArticleLink[] {
  const links: ArticleLink[] = [];
  for (const anchor of [...root.querySelectorAll("a")]) {
    const href = anchor.getAttribute("href") ?? "";
    const target = parseWikipediaArticleTarget(href, {
      redLink: anchor.classList.contains("new"),
    });
    if (!target || normalizeTitle(target.title) === normalizeTitle(currentTitle)) {
      unwrapElement(anchor);
      continue;
    }

    const anchorText = anchor.textContent?.trim() || target.title;
    links.push({
      anchorText,
      href: target.sourceUrl,
      sourceSection: closestSectionTitle(anchor),
      title: target.title,
    });
    anchor.setAttribute("href", `#article:${encodeURIComponent(target.title)}`);
    anchor.setAttribute("data-vwiki-race-title", target.title);
    anchor.setAttribute("data-vwiki-race-href", target.sourceUrl);
  }
  return links;
}

function removeRuleExcludedSections(root: HTMLElement): void {
  const headings = [...root.querySelectorAll("h2, .mw-heading2")];
  const handled = new Set<Element>();
  for (const candidate of headings) {
    const heading = candidate.matches("h2")
      ? candidate
      : candidate.querySelector("h2") ?? candidate;
    const sectionLabels = [
      heading.textContent ?? "",
      heading.getAttribute("id") ?? "",
      heading.querySelector("[id]")?.getAttribute("id") ?? "",
    ].map(normalizeSectionLabel);
    if (!sectionLabels.some(isExcludedSectionLabel)) {
      continue;
    }

    const section = heading.closest("section[data-mw-section-id]");
    if (section) {
      section.remove();
      continue;
    }

    const sectionStart = heading.closest(".mw-heading2") ?? heading;
    if (handled.has(sectionStart)) {
      continue;
    }
    handled.add(sectionStart);
    removeLegacySectionFrom(sectionStart);
  }
}

function isExcludedSectionLabel(label: string): boolean {
  const labelWithoutDuplicateSuffix = label.replace(/\s+\d+$/, "");
  return REMOVE_SECTION_TITLES.has(labelWithoutDuplicateSuffix);
}

function removeLegacySectionFrom(sectionStart: Element): void {
  let sibling = sectionStart.nextElementSibling;
  while (sibling && !isTopLevelSectionHeading(sibling)) {
    const next = sibling.nextElementSibling;
    sibling.remove();
    sibling = next;
  }
  sectionStart.remove();
}

function isTopLevelSectionHeading(element: Element): boolean {
  return element.matches("h2, .mw-heading2");
}

function normalizeSectionLabel(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/\[edit\]/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function sanitizeTree(root: HTMLElement): void {
  removeComments(root);
  const elements = [...root.querySelectorAll("*")];
  for (const element of elements) {
    if (!element.isConnected) {
      continue;
    }

    const tagName = element.localName.toLowerCase();
    if (DROP_WITH_CONTENTS.has(tagName) || tagName === "annotation-xml") {
      element.remove();
      continue;
    }
    if (!ALLOWED_HTML_TAGS.has(tagName) && !ALLOWED_MATHML_TAGS.has(tagName)) {
      unwrapElement(element);
      continue;
    }

    sanitizeAttributes(element, tagName);
  }
}

function removeUnsafeSubtrees(root: HTMLElement): void {
  const selectors = [...DROP_WITH_CONTENTS, "annotation-xml"].join(",");
  for (const element of root.querySelectorAll(selectors)) {
    element.remove();
  }
}

function sanitizeAttributes(element: Element, tagName: string): void {
  const tagAttributes = TAG_ATTRIBUTES[tagName];
  for (const attribute of [...element.attributes]) {
    const name = attribute.name.toLowerCase();
    if (!GLOBAL_ATTRIBUTES.has(name) && !tagAttributes?.has(name)) {
      element.removeAttribute(attribute.name);
    }
  }

  if (tagName === "img") {
    sanitizeDimension(element, "width");
    sanitizeDimension(element, "height");
    sanitizeTokenAttribute(element, "loading", new Set(["eager", "lazy"]));
    sanitizeTokenAttribute(element, "decoding", new Set(["async", "auto", "sync"]));
  }
  if (tagName === "td" || tagName === "th") {
    sanitizeSpan(element, "colspan");
    sanitizeSpan(element, "rowspan");
  }
}

function rewriteMediaUrls(root: HTMLElement): void {
  for (const image of root.querySelectorAll("img")) {
    rewriteMediaUrlAttribute(image, "src");
    rewriteSrcSet(image);
  }
  for (const source of root.querySelectorAll("source")) {
    rewriteSrcSet(source);
  }
}

function rewriteMediaUrlAttribute(element: Element, attribute: string): void {
  const value = element.getAttribute(attribute);
  if (!value) {
    return;
  }
  const safeUrl = safeWikimediaMediaUrl(value);
  if (safeUrl) {
    element.setAttribute(attribute, safeUrl);
  } else {
    element.removeAttribute(attribute);
  }
}

function rewriteSrcSet(element: Element): void {
  const srcset = element.getAttribute("srcset");
  if (!srcset) {
    return;
  }

  const safeCandidates: string[] = [];
  for (const rawCandidate of srcset.split(",")) {
    const [rawUrl, ...descriptors] = rawCandidate.trim().split(/\s+/);
    const safeUrl = safeWikimediaMediaUrl(rawUrl ?? "");
    if (!safeUrl || !isValidSrcSetDescriptor(descriptors)) {
      continue;
    }
    safeCandidates.push([safeUrl, ...descriptors].join(" "));
  }

  if (safeCandidates.length > 0) {
    element.setAttribute("srcset", safeCandidates.join(", "));
  } else {
    element.removeAttribute("srcset");
  }
}

function safeWikimediaMediaUrl(candidate: string): string | null {
  const normalized = candidate.startsWith("//") ? `https:${candidate}` : candidate;
  let url: URL;
  try {
    url = new URL(normalized, "https://en.wikipedia.org/");
  } catch {
    return null;
  }

  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    !WIKIMEDIA_MEDIA_HOSTS.has(url.hostname)
  ) {
    return null;
  }
  url.hash = "";
  return url.toString();
}

function isValidSrcSetDescriptor(descriptors: string[]): boolean {
  if (descriptors.length === 0) {
    return true;
  }
  if (descriptors.length !== 1) {
    return false;
  }
  return /^(?:(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*)x|[1-9]\d*w)$/.test(
    descriptors[0] ?? "",
  );
}

function sanitizeDimension(element: Element, attribute: "height" | "width"): void {
  const value = element.getAttribute(attribute);
  if (!value) {
    return;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 4096) {
    element.removeAttribute(attribute);
  }
}

function sanitizeSpan(element: Element, attribute: "colspan" | "rowspan"): void {
  const value = element.getAttribute(attribute);
  if (!value) {
    return;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) {
    element.removeAttribute(attribute);
  }
}

function sanitizeTokenAttribute(
  element: Element,
  attribute: string,
  allowed: ReadonlySet<string>,
): void {
  const value = element.getAttribute(attribute)?.toLowerCase();
  if (value && !allowed.has(value)) {
    element.removeAttribute(attribute);
  }
}

function removeComments(root: HTMLElement): void {
  const iterator = root.ownerDocument.createNodeIterator(root, NodeFilter.SHOW_COMMENT);
  const comments: Node[] = [];
  let node: Node | null;
  while ((node = iterator.nextNode())) {
    comments.push(node);
  }
  for (const comment of comments) {
    comment.parentNode?.removeChild(comment);
  }
}

function unwrapElement(element: Element): void {
  element.replaceWith(...element.childNodes);
}

function closestSectionTitle(anchor: Element): string | undefined {
  const section = anchor.closest("section[data-mw-section-id]");
  const sectionHeading = section?.querySelector(":scope > .mw-heading2 h2, :scope > h2");
  if (sectionHeading?.textContent?.trim()) {
    return sectionHeading.textContent.trim();
  }

  let node: Element | null = anchor;
  while (node && node.parentElement) {
    let sibling = node.previousElementSibling;
    while (sibling) {
      const heading = sibling.matches("h2, h3, h4, h5, h6")
        ? sibling
        : sibling.matches(".mw-heading2")
          ? sibling.querySelector("h2")
          : null;
      if (heading?.textContent?.trim()) {
        return heading.textContent.trim();
      }
      sibling = sibling.previousElementSibling;
    }
    node = node.parentElement;
  }
  return undefined;
}
