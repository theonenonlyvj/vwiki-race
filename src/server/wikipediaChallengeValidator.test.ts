import { afterEach, describe, expect, it, vi } from "vitest";
import { createWikipediaChallengeValidator } from "./wikipediaChallengeValidator";

describe("Wikipedia challenge validator", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("V1a resolves redirects and returns canonical page IDs plus allowed start moves", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.searchParams.get("action") === "parse") {
        return parseLinksResponse({
          pageid: 1,
          title: "Moon",
          links: [
            { ns: 0, title: "Gravity", exists: true },
            { ns: 0, title: "AC/DC", exists: "" },
            { ns: 6, title: "File:Moon.jpg", exists: true },
            { ns: 0, title: "Missing page" },
          ],
        });
      }

      const title = url.searchParams.get("titles");
      if (title === "Luna") {
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
        startTitle: "https://en.wikipedia.org/wiki/Luna#History",
        targetTitle: "Gravity",
      }),
    ).resolves.toEqual({
      start: { title: "Moon", pageId: 1, allowedLinkCount: 2 },
      target: { title: "Gravity", pageId: 2, allowedLinkCount: 0 },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const urls = fetchImpl.mock.calls.map(([input]) => new URL(String(input)));
    expect(urls.map((url) => url.searchParams.get("action"))).toEqual([
      "query",
      "query",
      "parse",
    ]);
    expect(urls[0].searchParams.get("redirects")).toBe("1");
    expect(urls[0].searchParams.get("prop")).toBe("info|pageprops");
    expect(urls[2].searchParams.get("prop")).toBe("links|revid");
    expect(urls[2].searchParams.get("page")).toBe("Moon");
    expect(urls.every((url) => !url.searchParams.has("generator"))).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining("https://en.wikipedia.org/w/api.php?"),
      expect.objectContaining({
        headers: expect.objectContaining({
          "Api-User-Agent": expect.stringContaining("VWiki Race"),
          "User-Agent": expect.stringContaining("VWiki Race"),
        }),
      }),
    );
  });

  it.each([
    "http://en.wikipedia.org/wiki/Moon",
    "//en.wikipedia.org/wiki/Moon",
    "https://en.wikipedia.org.evil.test/wiki/Moon",
    "https://fr.wikipedia.org/wiki/Moon",
    "https://en.wikipedia.org/wiki/Moon?oldid=1",
    "/wiki/Bad%ZZ",
    "fIlE:Moon.jpg",
  ])("V1b rejects an invalid manual start before any Wikipedia call: %s", async (startTitle) => {
    const fetchImpl = vi.fn();
    const validator = createWikipediaChallengeValidator({ fetchImpl });

    await expect(
      validator.validateChallengeArticles({
        startTitle,
        targetTitle: "Gravity",
      }),
    ).rejects.toMatchObject({
      code: "invalid_start_article",
      status: 400,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("V1c preserves encoded slash titles when resolving manual input", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.searchParams.get("action") === "parse") {
        return parseLinksResponse({
          pageid: 1,
          title: "AC/DC",
          links: [{ ns: 0, title: "Rock music", exists: true }],
        });
      }
      const title = url.searchParams.get("titles");
      return title === "AC/DC"
        ? queryResponse({ pageid: 1, ns: 0, title: "AC/DC" })
        : queryResponse({ pageid: 2, ns: 0, title: "Gravity" });
    });
    const validator = createWikipediaChallengeValidator({ fetchImpl });

    await validator.validateChallengeArticles({
      startTitle: "https://en.wikipedia.org/wiki/AC%2FDC",
      targetTitle: "Gravity",
    });

    const firstUrl = new URL(String(fetchImpl.mock.calls[0][0]));
    expect(firstUrl.searchParams.get("titles")).toBe("AC/DC");
  });

  it.each([
    ["missing", { ns: 0, title: "Missing", missing: true }, "invalid_start_article"],
    ["namespace", { pageid: 1, ns: 6, title: "File:Moon.jpg" }, "invalid_start_article"],
    [
      "disambiguation",
      { pageid: 1, ns: 0, title: "Mercury", pageprops: { disambiguation: "" } },
      "disambiguation_start_article",
    ],
  ])("V1d rejects a %s source page", async (_case, page, code) => {
    const validator = createWikipediaChallengeValidator({
      fetchImpl: vi.fn(async () => queryResponse(page)),
    });

    await expect(
      validator.validateChallengeArticles({
        startTitle: "Moon",
        targetTitle: "Gravity",
      }),
    ).rejects.toMatchObject({ code, status: 400 });
  });

  it("V1e rejects equal canonical page IDs without requesting outgoing links", async () => {
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
      status: 400,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("V1f rejects a start with no allowed existing outgoing move", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.searchParams.get("action") === "parse") {
        return parseLinksResponse({
          pageid: 1,
          title: "Moon",
          links: [
            { ns: 6, title: "File:Moon.jpg", exists: true },
            { ns: 0, title: "File:Moon.jpg", exists: true },
            { ns: 0, title: "Missing page" },
            { ns: 0, title: "Moon", exists: true },
          ],
        });
      }
      const title = url.searchParams.get("titles");
      return title === "Moon"
        ? queryResponse({ pageid: 1, ns: 0, title: "Moon" })
        : queryResponse({ pageid: 2, ns: 0, title: "Gravity" });
    });
    const validator = createWikipediaChallengeValidator({ fetchImpl });

    await expect(
      validator.validateChallengeArticles({
        startTitle: "Moon",
        targetTitle: "Gravity",
      }),
    ).rejects.toMatchObject({
      code: "start_has_no_allowed_links",
      status: 400,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("V1g returns a typed upstream error without reading or logging its body", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let bodyRead = false;
    const response = new Response("SECRET_WIKIPEDIA_RESPONSE_BODY", { status: 403 });
    Object.defineProperty(response, "text", {
      value: async () => {
        bodyRead = true;
        return "SECRET_WIKIPEDIA_RESPONSE_BODY";
      },
    });
    const validator = createWikipediaChallengeValidator({
      fetchImpl: vi.fn(async () => response),
    });

    await expect(
      validator.validateChallengeArticles({
        startTitle: "Moon",
        targetTitle: "Gravity",
      }),
    ).rejects.toMatchObject({
      code: "wikipedia_validation_failed",
      status: 502,
    });
    expect(bodyRead).toBe(false);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(
      "SECRET_WIKIPEDIA_RESPONSE_BODY",
    );
  });

  it("V1h converts malformed JSON and network failures to typed boundary errors", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const malformed = createWikipediaChallengeValidator({
      fetchImpl: vi.fn(async () =>
        new Response("not-json", {
          headers: { "Content-Type": "application/json" },
        }),
      ),
    });
    const network = createWikipediaChallengeValidator({
      fetchImpl: vi.fn(async () => {
        throw new Error("network unavailable");
      }),
    });

    await expect(
      malformed.validateChallengeArticles({ startTitle: "Moon", targetTitle: "Gravity" }),
    ).rejects.toMatchObject({ code: "wikipedia_validation_failed", status: 502 });
    await expect(
      network.validateChallengeArticles({ startTitle: "Moon", targetTitle: "Gravity" }),
    ).rejects.toMatchObject({ code: "wikipedia_validation_failed", status: 502 });
    expect(errorSpy).toHaveBeenCalled();
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

function parseLinksResponse(parse: Record<string, unknown>): Response {
  return Response.json({ parse });
}
