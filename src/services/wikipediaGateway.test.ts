import { describe, expect, it, vi } from "vitest";
import { createWikipediaGateway } from "./wikipediaGateway";

describe("wikipedia gateway", () => {
  it("P8 preserves faithful article structure and unwraps forbidden anchors", async () => {
    const gateway = gatewayForHtml(`
      <div class="mw-parser-output">
        <p>The <b>apple</b> is an <em>edible</em>
          <a href="/wiki/Fruit"><strong>fruit</strong></a>.
          <a href="https://example.test/out"><em>External child</em></a>
          <a class="new" href="/wiki/Red_article"><span>red child survives</span></a>
        </p>
        <table class="infobox"><tbody><tr><th>Family</th><td>Rosaceae</td></tr></tbody></table>
        <table class="wikitable"><caption>Wide facts</caption><tbody><tr>
          <th>Topic</th><td><a href="/wiki/Wide_article">Wide article</a></td>
        </tr></tbody></table>
        <ul><li><a href="./List_article">List article</a></li></ul>
        <pre><code>const apple = true;</code></pre>
        <span class="mwe-math-element"><math display="inline"><semantics>
          <mrow><mi>x</mi><mo>=</mo><mn>1</mn></mrow>
        </semantics></math></span>
        <figure class="thumb tright">
          <a class="mw-file-description" href="/wiki/File:Apple.jpg">
            <img alt="A whole apple" width="220" height="147"
              src="//upload.wikimedia.org/wikipedia/commons/a/apple.jpg">
          </a>
          <figcaption>An <i>apple</i> caption</figcaption>
        </figure>
      </div>
    `);

    const article = await gateway.getArticle("Apple");
    const document = parseResult(article.sanitizedHtml);

    expect(article.links.map((link) => link.title)).toEqual([
      "Fruit",
      "Wide article",
      "List article",
    ]);
    expect(document.querySelector("table.infobox")).not.toBeNull();
    expect(document.querySelector("table.wikitable a")?.textContent).toBe(
      "Wide article",
    );
    expect(document.querySelector("ul a")?.textContent).toBe("List article");
    expect(document.querySelector("math mrow")?.textContent).toBe("x=1");
    expect(document.querySelector("pre code")?.textContent).toContain("const apple");
    expect(document.querySelector("img")?.closest("a")).toBeNull();
    expect(document.querySelector("img")?.getAttribute("alt")).toBe("A whole apple");
    expect(document.querySelector("img")?.getAttribute("width")).toBe("220");
    expect(document.querySelector("figcaption")?.innerHTML).toContain("<i>apple</i>");
    expect(document.querySelector("em")?.textContent).toBe("edible");
    expect(document.body.textContent).toContain("External child");
    expect(document.body.textContent).toContain("red child survives");
    expect([...document.querySelectorAll("a")]).toHaveLength(3);
  });

  it("P9 removes excluded sections in legacy and current MediaWiki DOM shapes", async () => {
    const gateway = gatewayForHtml(`
      <div class="mw-parser-output">
        <p>Lead survives</p>
        <h2><span class="mw-headline" id="See_also">See also</span></h2>
        <p>legacy see marker <a href="/wiki/Pear">Pear</a></p>
        <h2><span class="mw-headline" id="History">History</span></h2>
        <p>history marker <a href="/wiki/History_of_apples">History link</a></p>
        <section data-mw-section-id="4">
          <div class="mw-heading mw-heading2"><h2 id="See_also_2">See also</h2></div>
          <p>current see marker <a href="/wiki/Quince">Quince</a></p>
        </section>
        <section data-mw-section-id="5">
          <div class="mw-heading mw-heading2"><h2 id="Notes">Notes</h2></div>
          <p>current notes marker <a href="/wiki/Note">Note</a></p>
        </section>
        <section data-mw-section-id="6">
          <div class="mw-heading mw-heading2"><h2 id="References">References</h2></div>
          <ol><li>current references marker</li></ol>
        </section>
        <div class="mw-heading mw-heading2"><h2 id="Bibliography">Bibliography</h2></div>
        <p>legacy bibliography marker</p>
        <div class="mw-heading mw-heading2"><h2 id="Legacy">Legacy</h2></div>
        <p>legacy section survives</p>
        <h2><span class="mw-headline" id="Notes_on_cultivation">Notes on cultivation</span></h2>
        <p>notes-on marker <a href="/wiki/Apple_cultivation">Cultivation</a></p>
        <h2><span class="mw-headline" id="Afterword">Afterword</span></h2>
        <p>afterword survives</p>
        <nav><a href="/wiki/Site_navigation">site nav marker</a></nav>
        <div role="navigation"><a href="/wiki/Role_navigation">role nav marker</a></div>
        <div class="toc">toc marker</div>
        <div class="navbox">navbox marker</div>
        <div id="catlinks">category chrome marker</div>
        <div class="portal"><a href="/wiki/Portal:Apples">portal marker</a></div>
      </div>
    `);

    const article = await gateway.getArticle("Apple");

    expect(article.sanitizedHtml).toContain("Lead survives");
    expect(article.sanitizedHtml).toContain("history marker");
    expect(article.sanitizedHtml).toContain("legacy section survives");
    expect(article.sanitizedHtml).toContain("notes-on marker");
    expect(article.sanitizedHtml).toContain("afterword survives");
    expect(article.links.map((link) => link.title)).toEqual([
      "History of apples",
      "Apple cultivation",
    ]);
    for (const removed of [
      "legacy see marker",
      "current see marker",
      "current notes marker",
      "current references marker",
      "legacy bibliography marker",
      "site nav marker",
      "role nav marker",
      "toc marker",
      "navbox marker",
      "category chrome marker",
      "portal marker",
    ]) {
      expect(article.sanitizedHtml).not.toContain(removed);
    }
  });

  it("P10 applies an explicit security allowlist to tags, attributes, and URLs", async () => {
    const gateway = gatewayForHtml(`
      <div class="mw-parser-output" onclick="steal()" style="position:fixed" data-evil="1">
        <script>script marker</script>
        <style>style marker</style>
        <iframe srcdoc="<script>steal()</script>">iframe marker</iframe>
        <object data="https://example.test">object marker <a href="/wiki/Object_move">object move</a></object>
        <embed src="https://example.test/embed">
        <svg onload="steal()"><a href="/wiki/Svg_move">svg marker</a></svg>
        <math><semantics><mrow><mi>y</mi></mrow>
          <annotation-xml encoding="text/html"><p>annotation marker</p></annotation-xml>
        </semantics></math>
        <p onclick="steal()" style="background:url(javascript:steal())">
          <a href="javascript:steal()"><strong>javascript child survives</strong></a>
          <a href="https://example.test/path"><em>external child survives</em></a>
          <img alt="unsafe" src="javascript:steal()" onerror="steal()" style="width:999px">
        </p>
        <x-article-widget onactivate="steal()"><strong>custom child survives</strong></x-article-widget>
      </div>
    `);

    const article = await gateway.getArticle("Apple");
    const document = parseResult(article.sanitizedHtml);

    for (const removed of [
      "script marker",
      "style marker",
      "iframe marker",
      "object marker",
      "svg marker",
      "annotation marker",
    ]) {
      expect(article.sanitizedHtml).not.toContain(removed);
    }
    expect(document.body.textContent).toContain("javascript child survives");
    expect(document.body.textContent).toContain("external child survives");
    expect(document.body.textContent).toContain("custom child survives");
    expect(document.querySelector("script, style, iframe, object, embed, svg")).toBeNull();
    expect(document.querySelector("x-article-widget")).toBeNull();
    expect(document.querySelector("[onclick], [onerror], [onactivate], [style], [data-evil]"))
      .toBeNull();
    expect(document.querySelector("a")).toBeNull();
    expect(document.querySelector("img")?.hasAttribute("src")).toBe(false);
    expect(article.links).toEqual([]);
  });

  it("P11 rewrites every valid Wikimedia src/srcset URL and removes unsafe values", async () => {
    const gateway = gatewayForHtml(`
      <div class="mw-parser-output">
        <img alt="protocol relative" src="//upload.wikimedia.org/a.jpg" width="320" height="200"
          srcset="//upload.wikimedia.org/a-half.jpg 0.5x, //upload.wikimedia.org/a-1x.jpg 1x, /w/a-2x.jpg 2x, https://commons.wikimedia.org/a-3x.jpg 3x, https://evil.test/a-4x.jpg 4x, javascript:steal() 5x">
        <img alt="root relative" src="/w/extensions/math.png">
        <img alt="absolute" src="https://upload.wikimedia.org/b.jpg">
        <img alt="http" src="http://upload.wikimedia.org/c.jpg">
        <img alt="foreign" src="https://upload.wikimedia.org.evil.test/d.jpg">
      </div>
    `);

    const article = await gateway.getArticle("Apple");
    const document = parseResult(article.sanitizedHtml);
    const image = (alt: string) => document.querySelector(`img[alt="${alt}"]`);

    expect(image("protocol relative")?.getAttribute("src")).toBe(
      "https://upload.wikimedia.org/a.jpg",
    );
    expect(image("protocol relative")?.getAttribute("srcset")).toBe(
      "https://upload.wikimedia.org/a-half.jpg 0.5x, https://upload.wikimedia.org/a-1x.jpg 1x, https://en.wikipedia.org/w/a-2x.jpg 2x, https://commons.wikimedia.org/a-3x.jpg 3x",
    );
    expect(image("protocol relative")?.getAttribute("width")).toBe("320");
    expect(image("protocol relative")?.getAttribute("height")).toBe("200");
    expect(image("root relative")?.getAttribute("src")).toBe(
      "https://en.wikipedia.org/w/extensions/math.png",
    );
    expect(image("absolute")?.getAttribute("src")).toBe(
      "https://upload.wikimedia.org/b.jpg",
    );
    expect(image("http")?.hasAttribute("src")).toBe(false);
    expect(image("foreign")?.hasAttribute("src")).toBe(false);
  });

  it("P12a returns exact canonical source and revision attribution metadata", async () => {
    const gateway = gatewayForHtml("<p>Apple body</p>");

    const article = await gateway.getArticle("Malus domestica");

    expect(article).toMatchObject({
      pageId: 18978754,
      canonicalTitle: "Apple",
      revisionId: 123456,
      sourceUrl: "https://en.wikipedia.org/wiki/Apple",
      attributionUrl:
        "https://en.wikipedia.org/w/index.php?title=Apple&oldid=123456",
      attribution: "Wikipedia revision 123456, available under CC BY-SA 4.0.",
    });
    expect(article.html).toBe(article.sanitizedHtml);
  });

  it("P12b deduplicates per instance, aliases canonical titles, and clear refetches", async () => {
    const fetchImpl = vi.fn(async () => parseResponse("<p>Body</p>", { title: "AC/DC" }));
    const firstGateway = createWikipediaGateway({ fetchImpl });
    const secondGateway = createWikipediaGateway({ fetchImpl });

    const [first, duplicate] = await Promise.all([
      firstGateway.getArticle("AC%2FDC"),
      firstGateway.getArticle("AC%2FDC"),
    ]);
    const canonicalAlias = await firstGateway.getArticle("AC/DC");
    await secondGateway.getArticle("AC/DC");
    firstGateway.clear();
    await firstGateway.getArticle("AC/DC");

    expect(first).toEqual(duplicate);
    expect(canonicalAlias).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("P12c keeps revision and ruleset cache keys distinct", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const oldId = Number(new URL(String(input)).searchParams.get("oldid"));
      return parseResponse("<p>Body</p>", { revid: oldId });
    });
    const gateway = createWikipediaGateway({ fetchImpl });

    await gateway.getArticle("Apple", { revisionId: 100, ruleset: "ranked_classic" });
    await gateway.getArticle("Apple", { revisionId: 100, ruleset: "ranked_classic" });
    await gateway.getArticle("Apple", { revisionId: 101, ruleset: "ranked_classic" });
    await gateway.getArticle("Apple", { revisionId: 101, ruleset: "future_ruleset" });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(String(fetchImpl.mock.calls[0][0])).toContain("oldid=100");
    expect(String(fetchImpl.mock.calls[1][0])).toContain("oldid=101");
  });

  it("P12d evicts rejected requests so a retry can recover", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(parseResponse("<p>Recovered</p>"));
    const gateway = createWikipediaGateway({ fetchImpl });

    await expect(gateway.getArticle("Apple")).rejects.toMatchObject({
      code: "bad_status",
    });
    await expect(gateway.getArticle("Apple")).resolves.toMatchObject({
      canonicalTitle: "Apple",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("P12e aborts cleanly, evicts the request, and does not cache a late response", async () => {
    const pending = deferred<Response>();
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(async () => pending.promise)
      .mockResolvedValueOnce(parseResponse("<p>Fresh</p>", { revid: 222 }));
    const gateway = createWikipediaGateway({ fetchImpl });
    const abortController = new AbortController();

    const superseded = gateway.getArticle("Apple", {
      signal: abortController.signal,
    });
    abortController.abort();
    await expect(superseded).rejects.toMatchObject({ name: "AbortError" });

    pending.resolve(parseResponse("<p>Late</p>", { revid: 111 }));
    const current = await gateway.getArticle("Apple");
    expect(current.revisionId).toBe(222);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("P12f clear invalidates in-flight work at the gateway boundary", async () => {
    const pending = deferred<Response>();
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(async () => pending.promise)
      .mockResolvedValueOnce(parseResponse("<p>Current</p>", { revid: 222 }));
    const gateway = createWikipediaGateway({ fetchImpl });

    const stale = gateway.getArticle("Apple");
    gateway.clear();
    await expect(stale).rejects.toMatchObject({ name: "AbortError" });

    const current = await gateway.getArticle("Apple");
    pending.resolve(parseResponse("<p>Stale</p>", { revid: 111 }));
    expect(current.revisionId).toBe(222);
    expect((await gateway.getArticle("Apple")).revisionId).toBe(222);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

function gatewayForHtml(html: string) {
  return createWikipediaGateway({
    fetchImpl: vi.fn(async () => parseResponse(html)),
    endpoint: "https://example.test/api.php",
  });
}

function parseResponse(
  html: string,
  overrides: Partial<{
    pageid: number;
    revid: number;
    title: string;
  }> = {},
): Response {
  return Response.json({
    parse: {
      title: overrides.title ?? "Apple",
      pageid: overrides.pageid ?? 18978754,
      revid: overrides.revid ?? 123456,
      text: html,
    },
  });
}

function parseResult(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}
