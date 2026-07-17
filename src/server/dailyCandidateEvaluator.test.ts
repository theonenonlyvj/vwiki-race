import { describe, expect, it, vi } from "vitest";
import type { DailyFlavor } from "../domain/dailyEditorial";
import type { Article } from "../domain/types";
import type { EditorialTarget, EditorialTargetPools } from "./editorialTargetPools";
import {
  createDailyCandidateEvaluator,
  DailyChallengeCandidateError,
} from "./dailyCandidateEvaluator";

const NOW = Date.UTC(2026, 6, 17, 12, 0, 0);
const lead = "A".repeat(100);

describe("daily candidate evaluator", () => {
  it("samples no more than ten editorial targets, uses three independent starts, and returns canonical IDs", async () => {
    const targets = Array.from({ length: 11 }, (_, index) => target(`Target ${index + 1}`, index + 1));
    const fetchImpl = wikipediaFetch({ targets, starts: ["Start one", "Start two", "Start three"] });
    const getArticle = vi.fn(async (title: string) => article({
      pageId: title === "Start one" ? 101 : title === "Start two" ? 102 : 103,
      canonicalTitle: `${title} canonical`,
      links: allowedLinks(8),
    }));
    const pools = poolFor(targets);
    const evaluator = createDailyCandidateEvaluator({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      gateway: { getArticle, clear: () => undefined },
      targetPools: pools,
      now: () => NOW,
    });

    const result = await evaluator.findCandidate({ dailyDate: "2026-07-17", flavor: "recognizable" });

    expect(pools.list).toHaveBeenCalledWith("recognizable", expect.any(AbortSignal));
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
      targetPools: poolFor(targets),
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
        targetPools: poolFor(targets),
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
      targetPools: poolFor(targets),
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
      targetPools: poolFor(targets),
      now: () => NOW,
      maxRequests: 6,
    });

    await expect(evaluator.findCandidate({ dailyDate: "2026-07-17", flavor: "recognizable" })).rejects.toMatchObject({
      code: "daily_candidate_unavailable",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(getArticle).toHaveBeenCalledTimes(1);
  });

  it("returns unavailable for malformed upstream metadata and timeout for an aborted request", async () => {
    const targets = [target("Target", 1)];
    const malformed = createDailyCandidateEvaluator({
      fetchImpl: vi.fn(async () => new Response("{}")) as unknown as typeof fetch,
      gateway: gatewayForStarts(),
      targetPools: poolFor(targets),
      now: () => NOW,
    });
    const controller = new AbortController();
    controller.abort();
    const aborted = createDailyCandidateEvaluator({
      fetchImpl: vi.fn() as unknown as typeof fetch,
      gateway: gatewayForStarts(),
      targetPools: poolFor(targets),
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
      targetPools: poolFor(targets),
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

function poolFor(entries: readonly EditorialTarget[]): EditorialTargetPools & { list: ReturnType<typeof vi.fn> } {
  return { list: vi.fn(async () => [...entries]) };
}

function target(title: string, pageId: number): EditorialTarget {
  return { title, pageId, source: "vital", vitalLevel: 1 };
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
  starts: readonly string[];
  pageviewsStatus?: number;
  proxyResponse?: (url: URL) => Response;
}) {
  let randomIndex = 0;
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/metrics/pageviews/")) {
      return options.pageviewsStatus
        ? new Response("unavailable", { status: options.pageviewsStatus })
        : pageviewsResponse();
    }
    if (url.searchParams.get("generator") === "random") {
      const title = options.starts[randomIndex] ?? "Start three";
      randomIndex += 1;
      return randomResponse({ pageid: 101 + randomIndex - 1, title });
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

function pageviewsResponse(): Response {
  return new Response(JSON.stringify({
    items: Array.from({ length: 30 }, (_, index) => ({
      timestamp: `202606${String(index + 1).padStart(2, "0")}00`,
      views: 100 + index,
    })),
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
