import { describe, expect, it, vi } from "vitest";
import { appleParseResponse } from "../test/fixtures";
import { createWikipediaGateway } from "./wikipediaGateway";

describe("wikipedia gateway", () => {
  it("parses article metadata and keeps only allowed article links", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL) => {
      return new Response(JSON.stringify(appleParseResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const gateway = createWikipediaGateway({
      fetchImpl,
      endpoint: "https://example.test/api.php",
    });

    const article = await gateway.getArticle("Apple");

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(String(fetchImpl.mock.calls[0][0])).toContain("action=parse");
    expect(article).toMatchObject({
      pageId: 18978754,
      canonicalTitle: "Apple",
      revisionId: 123456,
    });
    expect(article.links.map((link) => link.title)).toEqual([
      "Fruit",
      "Apple tree",
      "Orchard",
    ]);
    expect(article.html).toContain('data-vwiki-race-title="Fruit"');
    expect(article.html).toContain('data-vwiki-race-title="Orchard"');
    expect(article.html).toContain(
      'src="https://upload.wikimedia.org/wikipedia/commons/thumb/apple.jpg/220px-apple.jpg"',
    );
    expect(article.html).toContain(
      'srcset="https://upload.wikimedia.org/wikipedia/commons/thumb/apple.jpg/440px-apple.jpg 2x"',
    );
    expect(article.html).toContain("history section");
    expect(article.html).not.toContain('data-vwiki-race-title="Apple"');
    expect(article.html).not.toContain("Category:Apples");
    expect(article.html).not.toContain("See also");
    expect(article.html).not.toContain("Pear");
    expect(article.html).not.toContain("Seed shortcut");
    expect(article.attribution).toContain("Wikipedia");
  });

  it("caches repeated article requests in memory", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL) => {
      return new Response(JSON.stringify(appleParseResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const gateway = createWikipediaGateway({
      fetchImpl,
      endpoint: "https://example.test/api.php",
    });

    const first = await gateway.getArticle("Apple");
    const second = await gateway.getArticle("Apple");

    expect(first).toEqual(second);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
