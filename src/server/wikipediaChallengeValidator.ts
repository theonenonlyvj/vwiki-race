import {
  normalizeTitle,
  parseWikipediaArticleTarget,
} from "../domain/rules";
import { ApiError } from "./http";

export interface ValidatedWikipediaArticle {
  title: string;
  pageId: number;
  allowedLinkCount: number;
}

export interface ValidateChallengeArticlesInput {
  startTitle: string;
  targetTitle: string;
}

export interface ValidateChallengeArticlesResult {
  start: ValidatedWikipediaArticle;
  target: ValidatedWikipediaArticle;
}

export type ValidateChallengeArticles = (
  input: ValidateChallengeArticlesInput,
) => Promise<ValidateChallengeArticlesResult>;

export interface WikipediaChallengeValidator {
  validateChallengeArticles: ValidateChallengeArticles;
}

interface WikipediaPage {
  pageid?: number;
  ns?: number;
  title?: string;
  missing?: unknown;
  pageprops?: Record<string, unknown>;
}

interface WikipediaQueryResponse {
  query?: {
    pages?: Record<string, WikipediaPage> | WikipediaPage[];
  };
}

interface WikipediaParseResponse {
  parse?: {
    pageid?: number;
    title?: string;
    links?: unknown[];
  };
}

const WIKIMEDIA_API_USER_AGENT =
  "VWiki Race/0.0 (https://vwikirace.pages.dev; contact: https://github.com/theonenonlyvj/vwiki-race)";

export function createWikipediaChallengeValidator(options: {
  fetchImpl?: typeof fetch;
  endpoint?: string;
} = {}): WikipediaChallengeValidator {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = options.endpoint ?? "https://en.wikipedia.org/w/api.php";

  return {
    async validateChallengeArticles(input) {
      const startInput = parseManualArticleInput("start", input.startTitle);
      const targetInput = parseManualArticleInput("target", input.targetTitle);
      const start = await loadArticle("start", startInput);
      const target = await loadArticle("target", targetInput);

      if (start.pageId === target.pageId) {
        throw new ApiError(
          "same_challenge_article",
          "Start and target must be different Wikipedia articles.",
        );
      }

      const allowedLinkCount = await loadAllowedStartLinkCount(start);
      if (allowedLinkCount < 1) {
        throw new ApiError(
          "start_has_no_allowed_links",
          "The start article has no allowed links.",
        );
      }

      return {
        start: { ...start, allowedLinkCount },
        target,
      };
    },
  };

  async function loadArticle(
    label: "start" | "target",
    title: string,
  ): Promise<ValidatedWikipediaArticle> {
    const url = wikipediaApiUrl(endpoint, {
      action: "query",
      format: "json",
      formatversion: "2",
      origin: "*",
      ppprop: "disambiguation",
      prop: "info|pageprops",
      redirects: "1",
      titles: title,
    });
    const payload = (await requestWikipediaJson(
      fetchImpl,
      url,
      label,
    )) as WikipediaQueryResponse;
    const pages = payload.query?.pages;
    const page = Array.isArray(pages)
      ? pages[0] ?? null
      : Object.values(pages ?? {})[0] ?? null;

    if (
      !page ||
      page.missing !== undefined ||
      !Number.isSafeInteger(page.pageid) ||
      Number(page.pageid) < 1
    ) {
      throw new ApiError(
        `invalid_${label}_article`,
        `That ${label} article does not exist on Wikipedia.`,
      );
    }
    if (page.ns !== 0) {
      throw new ApiError(
        `invalid_${label}_article`,
        `Use a main Wikipedia article for the ${label}.`,
      );
    }
    if (page.pageprops?.disambiguation !== undefined) {
      throw new ApiError(
        `disambiguation_${label}_article`,
        `Choose a specific Wikipedia article for the ${label}, not a disambiguation page.`,
      );
    }

    const canonicalTitle =
      typeof page.title === "string" ? page.title.trim() : "";
    if (!canonicalTitle || !parseWikipediaArticleTarget(canonicalTitle)) {
      throw invalidWikipediaResponse();
    }

    return {
      allowedLinkCount: 0,
      pageId: Number(page.pageid),
      title: canonicalTitle,
    };
  }

  async function loadAllowedStartLinkCount(
    start: ValidatedWikipediaArticle,
  ): Promise<number> {
    const url = wikipediaApiUrl(endpoint, {
      action: "parse",
      format: "json",
      formatversion: "2",
      origin: "*",
      page: start.title,
      prop: "links|revid",
      redirects: "1",
    });
    const payload = (await requestWikipediaJson(
      fetchImpl,
      url,
      "start_links",
    )) as WikipediaParseResponse;
    const parse = payload.parse;
    if (
      !parse ||
      parse.pageid !== start.pageId ||
      typeof parse.title !== "string" ||
      normalizeTitle(parse.title) !== normalizeTitle(start.title) ||
      !Array.isArray(parse.links)
    ) {
      throw invalidWikipediaResponse();
    }

    let allowedLinkCount = 0;
    for (const link of parse.links) {
      if (!isRecord(link) || link.ns !== 0 || !hasExistingLinkMarker(link)) {
        continue;
      }
      const rawTitle =
        typeof link.title === "string"
          ? link.title
          : typeof link["*"] === "string"
            ? link["*"]
            : "";
      const target = parseWikipediaArticleTarget(rawTitle);
      if (
        target &&
        normalizeTitle(target.title) !== normalizeTitle(start.title)
      ) {
        allowedLinkCount += 1;
      }
    }
    return allowedLinkCount;
  }
}

function parseManualArticleInput(
  label: "start" | "target",
  rawTitle: string,
): string {
  const target = parseWikipediaArticleTarget(rawTitle);
  if (!target) {
    throw new ApiError(
      `invalid_${label}_article`,
      `Use a valid English Wikipedia article for the ${label}.`,
    );
  }
  return target.title;
}

async function requestWikipediaJson(
  fetchImpl: typeof fetch,
  url: string,
  label: "start" | "target" | "start_links",
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: {
        "Api-User-Agent": WIKIMEDIA_API_USER_AGENT,
        "User-Agent": WIKIMEDIA_API_USER_AGENT,
      },
    });
  } catch (caught) {
    console.error(
      "wikipedia_validation_fetch_failed",
      JSON.stringify({
        error: describeCaughtError(caught),
        label,
      }),
    );
    throw wikipediaBoundaryError();
  }

  if (!response.ok) {
    console.error(
      "wikipedia_validation_bad_status",
      JSON.stringify({
        label,
        status: response.status,
        statusText: response.statusText,
      }),
    );
    throw new ApiError(
      "wikipedia_validation_failed",
      `Could not verify those Wikipedia articles right now. Wikipedia returned status ${response.status}.`,
      502,
    );
  }

  try {
    return await response.json();
  } catch (caught) {
    console.error(
      "wikipedia_validation_invalid_json",
      JSON.stringify({
        error: describeCaughtError(caught),
        label,
      }),
    );
    throw wikipediaBoundaryError();
  }
}

function wikipediaApiUrl(
  endpoint: string,
  parameters: Record<string, string>,
): string {
  const url = new URL(endpoint);
  url.search = new URLSearchParams(parameters).toString();
  return url.toString();
}

function hasExistingLinkMarker(link: Record<string, unknown>): boolean {
  return (
    Object.prototype.hasOwnProperty.call(link, "exists") &&
    link.exists !== false &&
    link.exists !== null
  );
}

function invalidWikipediaResponse(): ApiError {
  return new ApiError(
    "wikipedia_validation_failed",
    "Wikipedia returned an invalid article response.",
    502,
  );
}

function wikipediaBoundaryError(): ApiError {
  return new ApiError(
    "wikipedia_validation_failed",
    "Could not verify those Wikipedia articles right now.",
    502,
  );
}

function describeCaughtError(caught: unknown): string {
  if (caught instanceof Error) {
    return `${caught.name}: ${caught.message}`;
  }
  return String(caught);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
