import { describe, expect, it, vi } from "vitest";
import { createWikipediaChallengeValidator } from "./wikipediaChallengeValidator";

describe("Wikipedia challenge validator", () => {
  it("canonicalizes titles and pasted Wikipedia links", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const title = url.searchParams.get("titles");
      if (title === "Moon") {
        return queryResponse({ pageid: 1, ns: 0, title: "Moon" });
      }
      if (title === "Gravity") {
        return queryResponse({ pageid: 2, ns: 0, title: "Gravity" });
      }
      throw new Error(`Unexpected title ${title}`);
    });
    const validator = createWikipediaChallengeValidator({ fetchImpl });

    await expect(
      validator.validateChallengeArticles({
        startTitle: "https://en.wikipedia.org/wiki/Moon",
        targetTitle: "Gravity",
      }),
    ).resolves.toEqual({
      start: { title: "Moon", pageId: 1 },
      target: { title: "Gravity", pageId: 2 },
    });
  });

  it("uses a string request URL with a Wikimedia API user-agent header", async () => {
    const fetchImpl = vi.fn(async () =>
      queryResponse({ pageid: 1, ns: 0, title: "Moon" }),
    );
    const validator = createWikipediaChallengeValidator({ fetchImpl });

    await expect(
      validator.validateChallengeArticles({
        startTitle: "Moon",
        targetTitle: "https://en.wikipedia.org/wiki/Moon",
      }),
    ).rejects.toMatchObject({
      code: "same_challenge_article",
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining("https://en.wikipedia.org/w/api.php?"),
      expect.objectContaining({
        headers: expect.objectContaining({
          "Api-User-Agent": expect.stringContaining("VWiki Race"),
        }),
      }),
    );
  });

  it("rejects missing articles", async () => {
    const validator = createWikipediaChallengeValidator({
      fetchImpl: vi.fn(async () =>
        Response.json({
          query: {
            pages: {
              "-1": {
                ns: 0,
                title: "asdfasdf",
                missing: true,
              },
            },
          },
        }),
      ),
    });

    await expect(
      validator.validateChallengeArticles({
        startTitle: "asdfasdf",
        targetTitle: "Gravity",
      }),
    ).rejects.toMatchObject({
      code: "invalid_start_article",
      status: 400,
    });
  });

  it("rejects disambiguation pages and same-page pairs", async () => {
    const validator = createWikipediaChallengeValidator({
      fetchImpl: vi.fn(async (input: RequestInfo | URL) => {
        const title = new URL(String(input)).searchParams.get("titles");
        if (title === "Mercury") {
          return queryResponse({
            pageid: 10,
            ns: 0,
            title: "Mercury",
            pageprops: { disambiguation: "" },
          });
        }
        return queryResponse({ pageid: 11, ns: 0, title: "Moon" });
      }),
    });

    await expect(
      validator.validateChallengeArticles({
        startTitle: "Mercury",
        targetTitle: "Moon",
      }),
    ).rejects.toMatchObject({
      code: "disambiguation_start_article",
      status: 400,
    });

    await expect(
      validator.validateChallengeArticles({
        startTitle: "Moon",
        targetTitle: "https://en.wikipedia.org/wiki/Moon",
      }),
    ).rejects.toMatchObject({
      code: "same_challenge_article",
      status: 400,
    });
  });
});

function queryResponse(page: Record<string, unknown>): Response {
  return Response.json({
    query: {
      pages: {
        [String(page.pageid ?? "-1")]: page,
      },
    },
  });
}
