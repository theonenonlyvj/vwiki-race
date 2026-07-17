import { describe, expect, it, vi } from "vitest";
import type { DailyFlavor } from "../domain/dailyEditorial";
import type { Article } from "../domain/types";
import type { EditorialTarget } from "./editorialTargetPools";
import {
  createDailyCandidateEvaluator,
  DailyChallengeCandidateError,
} from "./dailyCandidateEvaluator";

const NOW = Date.UTC(2026, 6, 17, 12, 0, 0);
const lead = "A".repeat(100);

describe("daily candidate evaluator", () => {
  it("does not expose target-pool injection through the evaluator", () => {
    if (false) {
      createDailyCandidateEvaluator({
        fetchImpl: vi.fn() as unknown as typeof fetch,
        gateway: { getArticle: vi.fn(), clear: () => undefined },
        // @ts-expect-error Target pools must be loaded through the evaluator's counted fetch path.
        targetPools: { list: vi.fn() },
      });
    }
  });

  it("samples no more than ten editorial targets, uses three independent starts, and returns canonical IDs", async () => {
    const targets = Array.from({ length: 11 }, (_, index) => target(`Target ${index + 1}`, index + 1));
    const fetchImpl = wikipediaFetch({ targets, starts: ["Start one", "Start two", "Start three"] });
    const getArticle = vi.fn(async (title: string) => article({
      pageId: title === "Start one" ? 101 : title === "Start two" ? 102 : 103,
      canonicalTitle: `${title} canonical`,
      links: allowedLinks(8),
    }));
    const evaluator = createDailyCandidateEvaluator({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      gateway: { getArticle, clear: () => undefined },
      now: () => NOW,
    });

    const result = await evaluator.findCandidate({ dailyDate: "2026-07-17", flavor: "recognizable" });

    expect(poolFetchCalls(fetchImpl)).toHaveLength(4);
    const metadata = findActionCalls(fetchImpl, "info|pageprops|extracts|pageimages|categories");
    expect(metadata).toHaveLength(1);
    expect(new URL(String(metadata[0]![0])).searchParams.get("titles")?.split("|")).toHaveLength(10);
    expect(findActionCalls(fetchImpl, "info|pageprops")).toHaveLength(3);
    expect(getArticle).toHaveBeenCalledTimes(3);
    expect(result.startTitle).toMatch(/^Start (one|two|three) canonical$/);
    expect(result.startPageId).toBeGreaterThanOrEqual(101);
    expect(result.targetTitle).toMatch(/^Target \d+ canonical$/);
    expect(result.targetPageId).toBeGreaterThan(0);
  });

  it("keeps an editorial target eligible when the latest 30-day pageview request fails", async () => {
    const targets = [target("Target", 1)];
    const fetchImpl = wikipediaFetch({ targets, starts: ["Start one", "Start two", "Start three"], pageviewsStatus: 503 });
    const evaluator = createDailyCandidateEvaluator({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      gateway: gatewayForStarts(),
      now: () => NOW,
    });

    await expect(evaluator.findCandidate({ dailyDate: "2026-07-17", flavor: "weird" })).resolves.toMatchObject({
      targetTitle: "Target canonical",
      targetPageId: 1,
    });
    expect(fetchImpl.mock.calls.some(([input]) => String(input).includes("/metrics/pageviews/"))).toBe(true);
  });

  it.each<DailyFlavor>(["recognizable", "weird", "hard"])(
    "rejects direct start-to-target edges for %s candidates",
    async (flavor) => {
      const targets = [target("Target", 1)];
      const fetchImpl = wikipediaFetch({ targets, starts: ["Start one", "Start two", "Start three"] });
      const evaluator = createDailyCandidateEvaluator({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        gateway: gatewayForStarts([{ href: "/wiki/Target_canonical", title: "Target canonical", anchorText: "Target" }]),
        now: () => NOW,
      });

      await expect(evaluator.findCandidate({ dailyDate: "2026-07-17", flavor })).rejects.toMatchObject({
        code: "daily_candidate_unavailable",
      });
      expect(findActionCalls(fetchImpl, "links")).toHaveLength(0);
    },
  );

  it("rejects hard candidates with a bounded sanitized two-click proxy query", async () => {
    const targets = [target("Target", 1)];
    const firstHops = Array.from({ length: 51 }, (_, index) => ({
      href: `/wiki/Hop_${index + 1}`,
      title: `Hop ${index + 1}`,
      anchorText: `Hop ${index + 1}`,
    }));
    const fetchImpl = wikipediaFetch({
      targets,
      starts: ["Start one", "Start two", "Start three"],
      proxyResponse: (url) => {
        const titles = url.searchParams.get("titles")?.split("|") ?? [];
        return linksResponse(titles.includes("Hop 51") ? "Target canonical" : null);
      },
    });
    const evaluator = createDailyCandidateEvaluator({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      gateway: gatewayForStarts([...firstHops, {
        href: "/wiki/File:Unsafe", title: "File:Unsafe", anchorText: "Unsafe",
      }]),
      now: () => NOW,
    });

    await expect(evaluator.findCandidate({ dailyDate: "2026-07-18", flavor: "hard" })).rejects.toMatchObject({
      code: "daily_candidate_unavailable",
    });

    const proxyCalls = findActionCalls(fetchImpl, "links");
    expect(proxyCalls.length).toBeGreaterThan(0);
    for (const [input] of proxyCalls) {
      const url = new URL(String(input));
      expect(url.searchParams.get("pltitles")).toBe("Target canonical");
      expect(url.searchParams.get("titles")?.split("|").length).toBeLessThanOrEqual(50);
      expect(url.searchParams.get("titles")).not.toContain("File:Unsafe");
    }
  });

  for (const [label, payload] of [
    ["non-array pages", { query: { pages: { "1": { pageid: 1, ns: 0, title: "Hop" } } } }],
    ["non-record page entries", { query: { pages: [null] } }],
    ["record links", { query: { pages: [{ pageid: 1, ns: 0, title: "Hop", links: {} }] } }],
    ["string links", { query: { pages: [{ pageid: 1, ns: 0, title: "Hop", links: "Target canonical" }] } }],
    ["non-record link entries", { query: { pages: [{ pageid: 1, ns: 0, title: "Hop", links: ["Target canonical"] }] } }],
  ]) {
    it(`fails closed for hard proxy ${label}`, async () => {
      const targets = [target("Target", 1)];
      const evaluator = createDailyCandidateEvaluator({
        fetchImpl: wikipediaFetch({
          targets,
          starts: ["Start one", "Start two", "Start three"],
          proxyResponse: () => jsonResponse(payload),
        }) as unknown as typeof fetch,
        gateway: gatewayForStarts([
          ...allowedLinks(8),
          { href: "/wiki/Hop", title: "Hop", anchorText: "Hop" },
        ]),
        now: () => NOW,
      });

      await expect(evaluator.findCandidate({ dailyDate: "2026-07-18", flavor: "hard" })).rejects.toMatchObject({
        code: "daily_candidate_unavailable",
      });
    });
  }

  it("treats an absent hard-proxy links field as a valid no-links page", async () => {
    const targets = [target("Target", 1)];
    const evaluator = createDailyCandidateEvaluator({
      fetchImpl: wikipediaFetch({
        targets,
        starts: ["Start one", "Start two", "Start three"],
        proxyResponse: () => jsonResponse({ query: { pages: [{ pageid: 1, ns: 0, title: "Hop" }] } }),
      }) as unknown as typeof fetch,
      gateway: gatewayForStarts([
        ...allowedLinks(8),
        { href: "/wiki/Hop", title: "Hop", anchorText: "Hop" },
      ]),
      now: () => NOW,
    });

    await expect(evaluator.findCandidate({ dailyDate: "2026-07-18", flavor: "hard" })).resolves.toMatchObject({
      targetTitle: "Target canonical",
    });
  });

  it("uses one central request budget for raw API and gateway calls", async () => {
    const targets = [target("Target", 1)];
    const fetchImpl = wikipediaFetch({ targets, starts: ["Start one", "Start two", "Start three"] });
    const getArticle = vi.fn(async (title: string) => article({
      pageId: 101,
      canonicalTitle: title,
      links: [],
    }));
    const evaluator = createDailyCandidateEvaluator({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      gateway: { getArticle, clear: () => undefined },
      now: () => NOW,
      maxRequests: 10,
    });

    await expect(evaluator.findCandidate({ dailyDate: "2026-07-17", flavor: "recognizable" })).rejects.toMatchObject({
      code: "daily_candidate_unavailable",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(9);
    expect(getArticle).toHaveBeenCalledTimes(1);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "uses the configured request cap for non-finite maxRequests=%s",
    async (maxRequests) => {
      const targets = Array.from({ length: 10 }, (_, index) => target(`Target ${index + 1}`, index + 1));
      const firstHops = Array.from({ length: 51 }, (_, index) => ({
        href: `/wiki/Hop_${index + 1}`,
        title: `Hop ${index + 1}`,
        anchorText: `Hop ${index + 1}`,
      }));
      const fetchImpl = wikipediaFetch({
        targets,
        starts: ["Start one", "Start two", "Start three"],
        proxyResponse: (url) => linksResponse(
          (url.searchParams.get("titles")?.split("|") ?? []).includes("Hop 51")
            ? url.searchParams.get("pltitles")
            : null,
        ),
      });
      const gateway = gatewayForStarts(firstHops);
      const evaluator = createDailyCandidateEvaluator({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        gateway,
        now: () => NOW,
        maxRequests,
      });

      await expect(evaluator.findCandidate({ dailyDate: "2026-07-18", flavor: "hard" })).rejects.toMatchObject({
        code: "daily_candidate_unavailable",
      });
      expect(fetchImpl.mock.calls.length + gateway.getArticle.mock.calls.length).toBe(40);
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "uses the configured timeout cap for non-finite phaseTimeoutMs=%s",
    async (phaseTimeoutMs) => {
      const targets = [target("Target", 1)];
      const evaluator = createDailyCandidateEvaluator({
        fetchImpl: wikipediaFetch({
          targets,
          starts: ["Start one", "Start two", "Start three"],
          poolDelayMs: 5,
        }) as unknown as typeof fetch,
        gateway: gatewayForStarts(),
        now: () => NOW,
        phaseTimeoutMs,
      });

      await expect(evaluator.findCandidate({ dailyDate: "2026-07-17", flavor: "recognizable" })).resolves.toMatchObject({
        targetTitle: "Target canonical",
      });
    },
  );

  for (const [label, malformedItems] of malformedPageviewItems()) {
    it(`does not score ${label} pageview timestamps outside the exact latest 30 days`, async () => {
      const targets = [target("Malformed", 1), target("Valid", 2)];
      const evaluator = createDailyCandidateEvaluator({
        fetchImpl: wikipediaFetch({
          targets,
          starts: ["Start one", "Start two", "Start three"],
          pageviewsResponseForTitle: (title) => pageviewsResponse(
            title === "Malformed canonical" ? malformedItems : completePageviewItems(),
            title === "Malformed canonical" ? 1_000_000_000 : 100,
          ),
        }) as unknown as typeof fetch,
        gateway: gatewayForStarts(),
        now: () => NOW,
      });

      await expect(evaluator.findCandidate({ dailyDate: "2026-07-17", flavor: "recognizable" })).resolves.toMatchObject({
        targetTitle: "Valid canonical",
      });
    });
  }

  it("orders equal-score seeded-hash collisions by canonical start and target page IDs", async () => {
    const targets = [
      target("Target one", 125_888_618),
      target("Target two", 895_223_898),
    ];
    const startOneId = 318_546_611;
    const startTwoId = 461_502_563;
    const evaluator = createDailyCandidateEvaluator({
      fetchImpl: wikipediaFetch({
        targets,
        starts: [
          { pageid: startTwoId, title: "Start two" },
          { pageid: startOneId, title: "Start one" },
          { pageid: 0, title: "Invalid" },
        ],
      }) as unknown as typeof fetch,
      gateway: {
        getArticle: vi.fn(async (title: string) => article({
          pageId: title === "Start one" ? startOneId : startTwoId,
          canonicalTitle: title,
          links: [
            ...allowedLinks(8),
            title === "Start one"
              ? { href: "/wiki/Target_two_canonical", title: "Target two canonical", anchorText: "Target two" }
              : { href: "/wiki/Target_one_canonical", title: "Target one canonical", anchorText: "Target one" },
          ],
        })),
        clear: () => undefined,
      },
      now: () => NOW,
    });

    await expect(evaluator.findCandidate({ dailyDate: "2026-07-17", flavor: "recognizable" })).resolves.toMatchObject({
      startTitle: "Start one",
      startPageId: startOneId,
      targetTitle: "Target one canonical",
      targetPageId: 125_888_618,
    });
  });

  it("returns unavailable for malformed upstream metadata and timeout for an aborted request", async () => {
    const targets = [target("Target", 1)];
    const malformed = createDailyCandidateEvaluator({
      fetchImpl: vi.fn(async () => new Response("{}")) as unknown as typeof fetch,
      gateway: gatewayForStarts(),
      now: () => NOW,
    });
    const controller = new AbortController();
    controller.abort();
    const aborted = createDailyCandidateEvaluator({
      fetchImpl: vi.fn() as unknown as typeof fetch,
      gateway: gatewayForStarts(),
      now: () => NOW,
    });

    await expect(malformed.findCandidate({ dailyDate: "2026-07-17", flavor: "recognizable" })).rejects.toMatchObject({
      code: "daily_candidate_unavailable",
    });
    await expect(aborted.findCandidate({
      dailyDate: "2026-07-17", flavor: "recognizable", signal: controller.signal,
    })).rejects.toBeInstanceOf(DailyChallengeCandidateError);
    await expect(aborted.findCandidate({
      dailyDate: "2026-07-17", flavor: "recognizable", signal: controller.signal,
    })).rejects.toMatchObject({ code: "daily_candidate_timeout" });
  });

  it("preserves the random-request-timeout diagnostic when the phase aborts an in-flight start", async () => {
    const targets = [target("Target", 1)];
    const onDiagnostic = vi.fn();
    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (isEditorialPoolUrl(url)) return Promise.resolve(editorialPoolResponse(url, targets));
      if (url.searchParams.get("prop") === "info|pageprops|extracts|pageimages|categories") {
        return Promise.resolve(metadataResponse(targets));
      }
      if (url.pathname.includes("/metrics/pageviews/")) return Promise.resolve(pageviewsResponse());
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    });
    const evaluator = createDailyCandidateEvaluator({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      gateway: gatewayForStarts(),
      now: () => NOW,
      phaseTimeoutMs: 5,
      onDiagnostic,
    });

    await expect(evaluator.findCandidate({ dailyDate: "2026-07-17", flavor: "recognizable" })).rejects.toMatchObject({
      code: "daily_candidate_timeout",
    });
    expect(onDiagnostic).toHaveBeenCalledWith("random_request_timeout", {
      attempt: 1,
      role: "start",
      code: "AbortError",
      detail: "Aborted",
    });
  });
});

function target(
  title: string,
  pageId: number,
  source: EditorialTarget["source"] = "vital",
): EditorialTarget {
  return source === "vital"
    ? { title, pageId, source, vitalLevel: 1 }
    : { title, pageId, source };
}

function gatewayForStarts(links = allowedLinks(8)) {
  return {
    getArticle: vi.fn(async (title: string) => article({
      pageId: title === "Start one" ? 101 : title === "Start two" ? 102 : 103,
      canonicalTitle: title,
      links,
    })),
    clear: () => undefined,
  };
}

function allowedLinks(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    href: `/wiki/Move_${index + 1}`,
    title: `Move ${index + 1}`,
    anchorText: `Move ${index + 1}`,
  }));
}

function article(overrides: Partial<Article> & Pick<Article, "pageId" | "canonicalTitle">): Article {
  const { pageId, canonicalTitle, ...rest } = overrides;
  return {
    pageId,
    canonicalTitle,
    revisionId: 1,
    sourceUrl: "https://en.wikipedia.org/wiki/Start",
    attributionUrl: "https://en.wikipedia.org/w/index.php?title=Start&oldid=1",
    sanitizedHtml: "<p>Start</p>" as Article["sanitizedHtml"],
    links: allowedLinks(8),
    attribution: "Wikipedia revision 1",
    ...rest,
  };
}

function wikipediaFetch(options: {
  targets: readonly EditorialTarget[];
  starts: readonly (string | { pageid: number; title: string })[];
  pageviewsStatus?: number;
  pageviewsResponseForTitle?: (title: string) => Response;
  poolDelayMs?: number;
  proxyResponse?: (url: URL) => Response;
}) {
  let randomIndex = 0;
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (isEditorialPoolUrl(url)) {
      if (options.poolDelayMs !== undefined) await delay(options.poolDelayMs);
      return editorialPoolResponse(url, options.targets);
    }
    if (url.pathname.includes("/metrics/pageviews/")) {
      return options.pageviewsStatus
        ? new Response("unavailable", { status: options.pageviewsStatus })
        : options.pageviewsResponseForTitle?.(pageviewTitle(url)) ?? pageviewsResponse();
    }
    if (url.searchParams.get("generator") === "random") {
      const start = options.starts[randomIndex] ?? "Start three";
      randomIndex += 1;
      return randomResponse(typeof start === "string"
        ? { pageid: 100 + randomIndex, title: start }
        : start);
    }
    if (url.searchParams.get("prop") === "links") {
      return options.proxyResponse?.(url) ?? linksResponse(null);
    }
    if (url.searchParams.get("prop") === "info|pageprops|extracts|pageimages|categories") {
      const requested = new Set(url.searchParams.get("titles")?.split("|") ?? []);
      return metadataResponse(options.targets.filter((entry) => requested.has(entry.title)));
    }
    throw new Error(`Unexpected Wikimedia request: ${url}`);
  });
}

function metadataResponse(entries: readonly EditorialTarget[]): Response {
  return new Response(JSON.stringify({
    query: {
      pages: entries.map((entry) => ({
        pageid: entry.pageId,
        ns: 0,
        title: `${entry.title} canonical`,
        length: 2_000,
        extract: lead,
        thumbnail: { source: "https://upload.wikimedia.org/example.jpg" },
        categories: [{ title: "Category:Examples" }],
      })),
    },
  }), { headers: { "Content-Type": "application/json" } });
}

function pageviewsResponse(
  items: readonly { timestamp?: string }[] = completePageviewItems(),
  views = 100,
): Response {
  return new Response(JSON.stringify({
    items: items.map((item) => ({ ...item, views })),
  }), { headers: { "Content-Type": "application/json" } });
}

function randomResponse(page: { pageid: number; title: string }): Response {
  return new Response(JSON.stringify({ query: { pages: [{ ...page, ns: 0 }] } }), {
    headers: { "Content-Type": "application/json" },
  });
}

function linksResponse(targetTitle: string | null): Response {
  return new Response(JSON.stringify({
    query: {
      pages: [{
        pageid: 1,
        ns: 0,
        title: "Hop",
        links: targetTitle ? [{ ns: 0, title: targetTitle }] : [],
      }],
    },
  }), { headers: { "Content-Type": "application/json" } });
}

function findActionCalls(fetchImpl: ReturnType<typeof vi.fn>, prop: string) {
  return fetchImpl.mock.calls.filter(([input]) => new URL(String(input)).searchParams.get("prop") === prop);
}

function poolFetchCalls(fetchImpl: ReturnType<typeof vi.fn>) {
  return fetchImpl.mock.calls.filter(([input]) => isEditorialPoolUrl(new URL(String(input))));
}

function editorialPoolResponse(url: URL, targets: readonly EditorialTarget[]): Response {
  const source = url.pathname.includes("Unusual_articles") ? "unusual" : "vital";
  const entries = targets.filter((target) => target.source === source);
  const fallback = targets[0];
  const effectiveEntries = entries.length > 0 ? entries : fallback ? [fallback] : [];
  const html = source === "vital"
    ? `<main><ul>${effectiveEntries.map((entry) => `<li><a href="/wiki/${entry.title.replaceAll(" ", "_")}" data-pageid="${entry.pageId}">${entry.title}</a></li>`).join("")}</ul></main>`
    : `<main><dl>${effectiveEntries.map((entry) => `<dt><a href="/wiki/${entry.title.replaceAll(" ", "_")}" data-pageid="${entry.pageId}">${entry.title}</a></dt>`).join("")}</dl></main>`;
  return new Response(html, { headers: { "Content-Type": "text/html" } });
}

function isEditorialPoolUrl(url: URL): boolean {
  return url.hostname === "en.wikipedia.org" && (
    url.pathname.includes("Wikipedia:Vital_articles/Level/") || url.pathname.includes("Wikipedia:Unusual_articles")
  );
}

function pageviewTitle(url: URL): string {
  const segments = url.pathname.split("/");
  return decodeURIComponent(segments.at(-4) ?? "").replaceAll("_", " ");
}

function completePageviewItems(): { timestamp: string }[] {
  return Array.from({ length: 30 }, (_unused, index) => ({
    timestamp: compactTimestamp(new Date(Date.UTC(2026, 5, 17 + index))),
  }));
}

function malformedPageviewItems(): [string, { timestamp?: string }[]][] {
  const complete = completePageviewItems();
  const duplicate = completePageviewItems();
  duplicate[29] = { timestamp: duplicate[0]!.timestamp };
  const missing: { timestamp?: string }[] = completePageviewItems();
  missing[29] = {};
  const outOfRange = completePageviewItems();
  outOfRange[29] = { timestamp: "2026071700" };
  return [
    ["stale", Array.from({ length: 30 }, (_unused, index) => ({ timestamp: `202605${String(index + 1).padStart(2, "0")}00` }))],
    ["duplicate", duplicate],
    ["missing", missing],
    ["out-of-range", outOfRange],
  ];
}

function compactTimestamp(date: Date): string {
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}00`;
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
