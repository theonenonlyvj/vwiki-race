import { ApiError } from "./http";

export interface ValidatedWikipediaArticle {
  title: string;
  pageId: number;
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
    pages?: Record<string, WikipediaPage>;
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
      const start = await loadArticle("start", input.startTitle);
      const target = await loadArticle("target", input.targetTitle);

      if (start.pageId === target.pageId) {
        throw new ApiError(
          "same_challenge_article",
          "Start and target must be different Wikipedia articles.",
        );
      }

      return { start, target };
    },
  };

  async function loadArticle(
    label: "start" | "target",
    rawTitle: string,
  ): Promise<ValidatedWikipediaArticle> {
    const title = normalizeArticleInput(rawTitle);
    const url = new URL(endpoint);
    url.search = new URLSearchParams({
      action: "query",
      format: "json",
      origin: "*",
      ppprop: "disambiguation",
      prop: "info|pageprops",
      redirects: "1",
      titles: title,
    }).toString();

    let response: Response;
    try {
      response = await fetchImpl(url.toString(), {
        headers: {
          "Api-User-Agent": WIKIMEDIA_API_USER_AGENT,
        },
      });
    } catch {
      throw new ApiError(
        "wikipedia_validation_failed",
        "Could not verify those Wikipedia articles right now.",
        502,
      );
    }

    if (!response.ok) {
      throw new ApiError(
        "wikipedia_validation_failed",
        "Could not verify those Wikipedia articles right now.",
        502,
      );
    }

    const payload = (await response.json()) as WikipediaQueryResponse;
    const page = Object.values(payload.query?.pages ?? {})[0] ?? null;
    if (!page || page.missing !== undefined || typeof page.pageid !== "number") {
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
    if (typeof page.title !== "string" || !page.title.trim()) {
      throw new ApiError(
        "wikipedia_validation_failed",
        "Wikipedia returned an invalid article response.",
        502,
      );
    }

    return {
      title: page.title.trim(),
      pageId: page.pageid,
    };
  }
}

function normalizeArticleInput(rawTitle: string): string {
  const trimmed = rawTitle.trim();
  try {
    const url = new URL(trimmed);
    if (!url.hostname.endsWith("wikipedia.org")) {
      return trimmed;
    }

    const match = url.pathname.match(/^\/wiki\/(.+)$/);
    if (!match?.[1]) {
      return trimmed;
    }

    return safeDecode(match[1]).replace(/_/g, " ").trim();
  } catch {
    return trimmed.replace(/_/g, " ");
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
