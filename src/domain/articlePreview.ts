import type { Article } from "./types";

const MAX_BLURB_LENGTH = 360;

// PV-1: Wikipedia articles often open with template/hatnote/sidebar
// paragraphs ("Life on Earth:", "Coordinates:", "For other uses...") before
// the real lead - the old "first non-empty <p>" picker surfaced those
// fragments verbatim as the preview blurb. Scan a bounded window of leading
// paragraphs instead and require the candidate to actually read like lead
// prose.
const MAX_SCANNED_PARAGRAPHS = 10;
const MIN_PROSE_LENGTH = 60;
const HATNOTE_PREFIXES = ["for other uses", "this article is about"];

export interface ArticlePreview {
  blurb: string | null;
}

export function extractArticlePreview(article: Article): ArticlePreview {
  const document = new DOMParser().parseFromString(article.sanitizedHtml, "text/html");
  const paragraph = [...document.body.querySelectorAll("p")]
    .slice(0, MAX_SCANNED_PARAGRAPHS)
    .map((element) => normalizeText(element.textContent ?? ""))
    .find(looksLikeLeadProse) ?? null;
  return {
    blurb: paragraph ? boundBlurb(paragraph) : null,
  };
}

function looksLikeLeadProse(value: string): boolean {
  if (value.length < MIN_PROSE_LENGTH) return false;
  if (value.endsWith(":")) return false;
  if (!value.includes(". ") && !value.endsWith(".")) return false;
  const lowered = value.toLowerCase();
  return !HATNOTE_PREFIXES.some((prefix) => lowered.startsWith(prefix));
}

function boundBlurb(value: string): string {
  if (value.length <= MAX_BLURB_LENGTH) return value;
  const candidate = value.slice(0, MAX_BLURB_LENGTH + 1);
  const boundary = candidate.lastIndexOf(" ");
  const bounded = boundary > 0
    ? candidate.slice(0, boundary)
    : candidate.slice(0, MAX_BLURB_LENGTH);
  return `${bounded.trimEnd()}...`;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
