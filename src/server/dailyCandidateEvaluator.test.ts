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
    ["empty page records", { query: { pages: [{}] } }],
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
      // 11, not 10: one target now costs 4 (pool) + 1 (metadata) + 1
      // (inbound-link floor check) + 1 (pageviews) + 3 (random starts) = 10
      // raw fetches before a single gateway call is even attempted - one
      // more than the pre-floor-check version of this test needed, so the
      // budget cap grows by exactly the one new request type to keep
      // exercising the same "gateway calls share the same budget" case
      // (exhausted on the SECOND getArticle attempt, not the first).
      maxRequests: 11,
    });

    await expect(evaluator.findCandidate({ dailyDate: "2026-07-17", flavor: "recognizable" })).rejects.toMatchObject({
      code: "daily_candidate_unavailable",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(10);
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
      // Clears every flavor's floor immediately - this test is about the
      // RANDOM-start request hanging until the phase aborts, not the
      // inbound-link floor check.
      if (url.searchParams.get("prop") === "linkshere") return Promise.resolve(linkshereResponse(500));
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

  it("falls back to the curated static target list when the editorial pool totally fails, and still produces a candidate (PKG-13, 2026-07-19 incident)", async () => {
    const onDiagnostic = vi.fn();
    let randomIndex = 0;
    const starts = ["Start one", "Start two", "Start three"];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (isEditorialPoolUrl(url)) {
        // Simulate the incident: every editorial source page fails to load.
        return new Response("service unavailable", { status: 503 });
      }
      if (url.pathname.includes("/metrics/pageviews/")) return pageviewsResponse();
      if (url.searchParams.get("generator") === "random") {
        const start = starts[randomIndex] ?? "Start three";
        randomIndex += 1;
        return randomResponse({ pageid: 100 + randomIndex, title: start });
      }
      if (url.searchParams.get("prop") === "info|pageprops|extracts|pageimages|categories") {
        const requestedTitles = url.searchParams.get("titles")?.split("|") ?? [];
        return fallbackMetadataResponse(requestedTitles);
      }
      if (url.searchParams.get("prop") === "links") return linksResponse(null);
      throw new Error(`Unexpected Wikimedia request: ${url}`);
    });
    const evaluator = createDailyCandidateEvaluator({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      gateway: gatewayForStarts(),
      now: () => NOW,
      onDiagnostic,
    });

    const result = await evaluator.findCandidate({ dailyDate: "2026-07-17", flavor: "recognizable" });

    expect(result.startTitle).toMatch(/^Start (one|two|three)$/);
    expect(result.targetTitle).toBeTruthy();
    expect(onDiagnostic).toHaveBeenCalledWith(
      "editorial_pool_source_failed",
      expect.objectContaining({ status: 503 }),
    );
    expect(onDiagnostic).toHaveBeenCalledWith(
      "editorial_pool_fallback_used",
      expect.objectContaining({ dailyDate: "2026-07-17", flavor: "recognizable" }),
    );
  });

  it("returns the chosen flavor score and emits exact bounded selection metrics", async () => {
    const onDiagnostic = vi.fn();
    const evaluator = createDailyCandidateEvaluator({
      fetchImpl: wikipediaFetch({
        targets: [target("Target", 1)],
        starts: ["Start one", "Start two", "Start three"],
      }) as unknown as typeof fetch,
      gateway: gatewayForStarts(),
      now: () => NOW,
      onDiagnostic,
    });

    await expect(evaluator.findCandidate({
      dailyDate: "2026-07-17",
      flavor: "recognizable",
    })).resolves.toEqual({
      startTitle: "Start two",
      startPageId: 102,
      startAllowedLinkCount: 8,
      targetTitle: "Target canonical",
      targetPageId: 1,
      selectedScore: 79,
    });
    expect(onDiagnostic).toHaveBeenCalledWith("selection", {
      dailyDate: "2026-07-17",
      flavor: "recognizable",
      candidateCount: 3,
      requestCount: 13,
      selectedScore: 79,
    });
  });
});

describe("daily candidate evaluator: inbound-link floor (owner incident, 2026-07-26)", () => {
  it("discards a target below its flavor's inbound-link floor before scoring, keeps one that clears it, and caps the check to floor+1", async () => {
    const targets = [target("Low", 1), target("High", 2)];
    const fetchImpl = wikipediaFetch({
      targets,
      starts: ["Start one", "Start two", "Start three"],
      linkshereResponse: (url) => {
        const title = url.searchParams.get("titles");
        // "recognizable" floor is 150 - 10 fails it, 500 clears it (and
        // exceeds the real cap the code applies, exercising the "return the
        // full array, the caller only checks length" path).
        return linkshereResponse(title === "Low canonical" ? 10 : 500, title ?? "Hop");
      },
    });
    const onDiagnostic = vi.fn();
    const evaluator = createDailyCandidateEvaluator({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      gateway: gatewayForStarts(),
      now: () => NOW,
      onDiagnostic,
    });

    const result = await evaluator.findCandidate({ dailyDate: "2026-07-17", flavor: "recognizable" });

    expect(result.targetTitle).toBe("High canonical");
    expect(onDiagnostic).toHaveBeenCalledWith("inbound_link_floor_discarded", {
      title: "Low canonical",
      flavor: "recognizable",
      floor: 150,
    });

    const linkshereCalls = findActionCalls(fetchImpl, "linkshere");
    expect(linkshereCalls.length).toBeGreaterThan(0);
    for (const [input] of linkshereCalls) {
      // Cheapness invariant: `lhlimit` is always floor+1 (151), never the
      // target's true total - proving "at least the floor" without ever
      // fetching it.
      expect(new URL(String(input)).searchParams.get("lhlimit")).toBe("151");
      expect(new URL(String(input)).searchParams.get("lhnamespace")).toBe("0");
    }
  });

  it("counts the inbound-link floor check against the shared request budget", async () => {
    const targets = [target("Target", 1)];
    const fetchImpl = wikipediaFetch({ targets, starts: ["Start one", "Start two", "Start three"] });
    const evaluator = createDailyCandidateEvaluator({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      gateway: gatewayForStarts(),
      now: () => NOW,
      // The editorial pool (4) + one metadata batch (1) exactly exhausts
      // this budget - the floor check is the very next request the
      // evaluator would make, so it must never fire.
      maxRequests: 5,
    });

    await expect(evaluator.findCandidate({ dailyDate: "2026-07-17", flavor: "recognizable" })).rejects.toMatchObject({
      code: "daily_candidate_unavailable",
    });
    expect(findActionCalls(fetchImpl, "linkshere")).toHaveLength(0);
  });

  it("degrades to 'passes' (never discards) when the inbound-link check itself fails, with a diagnostic - a thin pool must degrade, not die", async () => {
    const targets = [target("Target", 1)];
    const onDiagnostic = vi.fn();
    const fetchImpl = wikipediaFetch({
      targets,
      starts: ["Start one", "Start two", "Start three"],
      linkshereResponse: () => new Response("service unavailable", { status: 503 }),
    });
    const evaluator = createDailyCandidateEvaluator({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      gateway: gatewayForStarts(),
      now: () => NOW,
      onDiagnostic,
    });

    await expect(evaluator.findCandidate({
      dailyDate: "2026-07-17",
      flavor: "recognizable",
    })).resolves.toMatchObject({ targetTitle: "Target canonical" });
    expect(onDiagnostic).toHaveBeenCalledWith(
      "inbound_link_check_failed",
      expect.objectContaining({ title: "Target canonical" }),
    );
  });

  it("treats a page MediaWiki omits the linkshere key for (a legitimate zero) as failing any positive floor", async () => {
    const targets = [target("Target", 1)];
    const fetchImpl = wikipediaFetch({
      targets,
      starts: ["Start one", "Start two", "Start three"],
      linkshereResponse: () => new Response(JSON.stringify({
        query: { pages: [{ pageid: 1, ns: 0, title: "Target canonical" }] },
      }), { headers: { "Content-Type": "application/json" } }),
    });
    const evaluator = createDailyCandidateEvaluator({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      gateway: gatewayForStarts(),
      now: () => NOW,
    });

    await expect(evaluator.findCandidate({
      dailyDate: "2026-07-17",
      flavor: "recognizable",
    })).rejects.toMatchObject({ code: "daily_candidate_unavailable" });
  });
});

describe("daily candidate evaluator: recognizable pageviews floor (owner-reviewed analysis, 2026-07-26)", () => {
  it("discards a 'recognizable' target under the 1000 monthly pageviews floor, keeps one that clears it", async () => {
    const targets = [target("Low", 1), target("High", 2)];
    const fetchImpl = wikipediaFetch({
      targets,
      starts: ["Start one", "Start two", "Start three"],
      pageviewsResponseForTitle: (title) =>
        monthlyPageviewsResponse(title === "Low canonical" ? 500 : 5000),
    });
    const onDiagnostic = vi.fn();
    const evaluator = createDailyCandidateEvaluator({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      gateway: gatewayForStarts(),
      now: () => NOW,
      onDiagnostic,
    });

    const result = await evaluator.findCandidate({ dailyDate: "2026-07-17", flavor: "recognizable" });

    expect(result.targetTitle).toBe("High canonical");
    expect(onDiagnostic).toHaveBeenCalledWith("recognizable_pageviews_floor_discarded", {
      title: "Low canonical",
      flavor: "recognizable",
      recentPageviews: 500,
      floor: 1000,
    });
  });

  it("passes a 'recognizable' target with pageviews at/above the floor without discarding it", async () => {
    const targets = [target("Target", 1)];
    const fetchImpl = wikipediaFetch({
      targets,
      starts: ["Start one", "Start two", "Start three"],
      pageviewsResponseForTitle: () => monthlyPageviewsResponse(5000),
    });
    const onDiagnostic = vi.fn();
    const evaluator = createDailyCandidateEvaluator({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      gateway: gatewayForStarts(),
      now: () => NOW,
      onDiagnostic,
    });

    await expect(evaluator.findCandidate({
      dailyDate: "2026-07-17",
      flavor: "recognizable",
    })).resolves.toMatchObject({ targetTitle: "Target canonical" });
    expect(onDiagnostic).not.toHaveBeenCalledWith(
      "recognizable_pageviews_floor_discarded",
      expect.anything(),
    );
  });

  it("degrades to 'passes' (never discards) when pageviews are unavailable for a 'recognizable' target, with a diagnostic", async () => {
    const targets = [target("Target", 1)];
    const onDiagnostic = vi.fn();
    const fetchImpl = wikipediaFetch({
      targets,
      starts: ["Start one", "Start two", "Start three"],
      pageviewsStatus: 503,
    });
    const evaluator = createDailyCandidateEvaluator({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      gateway: gatewayForStarts(),
      now: () => NOW,
      onDiagnostic,
    });

    await expect(evaluator.findCandidate({
      dailyDate: "2026-07-17",
      flavor: "recognizable",
    })).resolves.toMatchObject({ targetTitle: "Target canonical" });
    expect(onDiagnostic).toHaveBeenCalledWith("recognizable_pageviews_unavailable", {
      title: "Target canonical",
      flavor: "recognizable",
    });
  });

  it("does not apply the pageviews floor to 'weird' - obscurity is that pool's entire point (Bullfrog County, 789/mo, finished 4/5)", async () => {
    const targets = [target("Target", 1)];
    const onDiagnostic = vi.fn();
    const fetchImpl = wikipediaFetch({
      targets,
      starts: ["Start one", "Start two", "Start three"],
      pageviewsResponseForTitle: () => monthlyPageviewsResponse(200),
    });
    const evaluator = createDailyCandidateEvaluator({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      gateway: gatewayForStarts(),
      now: () => NOW,
      onDiagnostic,
    });

    await expect(evaluator.findCandidate({
      dailyDate: "2026-07-17",
      flavor: "weird",
    })).resolves.toMatchObject({ targetTitle: "Target canonical" });
    expect(onDiagnostic).not.toHaveBeenCalledWith(
      "recognizable_pageviews_floor_discarded",
      expect.anything(),
    );
    expect(onDiagnostic).not.toHaveBeenCalledWith(
      "recognizable_pageviews_unavailable",
      expect.anything(),
    );
  });
});

describe("daily candidate evaluator: no-repeat exclusions (owner incident, 2026-07-29 - a target is used once, ever)", () => {
  it("discards an already-used editorial target before spending any inbound-link/pageviews budget on it", async () => {
    const targets = [target("Low", 1), target("High", 2)];
    const fetchImpl = wikipediaFetch({ targets, starts: ["Start one", "Start two", "Start three"] });
    const onDiagnostic = vi.fn();
    const evaluator = createDailyCandidateEvaluator({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      gateway: gatewayForStarts(),
      now: () => NOW,
      onDiagnostic,
    });

    const result = await evaluator.findCandidate({
      dailyDate: "2026-07-17",
      flavor: "recognizable",
      excludedTargetTitles: new Set(["low"]),
    });

    expect(result.targetTitle).toBe("High canonical");
    expect(onDiagnostic).toHaveBeenCalledWith("excluded_target_discarded", { title: "Low" });
    // Pre-floor, zero API cost: the excluded target never even reaches the
    // metadata batch fetch (never mind the inbound-link/pageviews checks).
    const metadata = findActionCalls(fetchImpl, "info|pageprops|extracts|pageimages|categories");
    expect(metadata).toHaveLength(1);
    expect(new URL(String(metadata[0]![0])).searchParams.get("titles")?.split("|")).toEqual(["High"]);
  });

  it("rejects the day when every sampled target is excluded, same as any other exhausted pool", async () => {
    const targets = [target("Low", 1)];
    const fetchImpl = wikipediaFetch({ targets, starts: ["Start one", "Start two", "Start three"] });
    const evaluator = createDailyCandidateEvaluator({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      gateway: gatewayForStarts(),
      now: () => NOW,
    });

    await expect(evaluator.findCandidate({
      dailyDate: "2026-07-17",
      flavor: "recognizable",
      excludedTargetTitles: new Set(["low"]),
    })).rejects.toMatchObject({ code: "daily_candidate_unavailable" });
  });

  it("discards a start used by a recent daily right after the cheap random fetch, before the gateway render", async () => {
    const targets = [target("Target", 1)];
    const fetchImpl = wikipediaFetch({ targets, starts: ["Start one", "Start two", "Start three"] });
    const getArticle = vi.fn(async (title: string) => article({
      pageId: title === "Start two" ? 102 : 103,
      canonicalTitle: title,
      links: allowedLinks(8),
    }));
    const onDiagnostic = vi.fn();
    const evaluator = createDailyCandidateEvaluator({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      gateway: { getArticle, clear: () => undefined },
      now: () => NOW,
      onDiagnostic,
    });

    const result = await evaluator.findCandidate({
      dailyDate: "2026-07-17",
      flavor: "recognizable",
      excludedStartTitles: new Set(["start one"]),
    });

    expect(result.startTitle).not.toBe("Start one");
    expect(getArticle).not.toHaveBeenCalledWith("Start one");
    expect(onDiagnostic).toHaveBeenCalledWith(
      "excluded_start_discarded",
      expect.objectContaining({ title: "Start one" }),
    );
  });

  it("treats an empty exclusion set identically to omitting it entirely", async () => {
    const targets = Array.from({ length: 3 }, (_, index) => target(`Target ${index + 1}`, index + 1));
    const evaluatorWithout = createDailyCandidateEvaluator({
      fetchImpl: wikipediaFetch({ targets, starts: ["Start one", "Start two", "Start three"] }) as unknown as typeof fetch,
      gateway: gatewayForStarts(),
      now: () => NOW,
    });
    const evaluatorWithEmpty = createDailyCandidateEvaluator({
      fetchImpl: wikipediaFetch({ targets, starts: ["Start one", "Start two", "Start three"] }) as unknown as typeof fetch,
      gateway: gatewayForStarts(),
      now: () => NOW,
    });

    const withoutFields = await evaluatorWithout.findCandidate({
      dailyDate: "2026-07-17",
      flavor: "recognizable",
    });
    const withEmptySets = await evaluatorWithEmpty.findCandidate({
      dailyDate: "2026-07-17",
      flavor: "recognizable",
      excludedTargetTitles: new Set(),
      excludedStartTitles: new Set(),
    });

    expect(withEmptySets).toEqual(withoutFields);
  });

  it("does not exclude anything for a request that omits both fields (the on-demand random-challenge path's shape)", async () => {
    const targets = [target("Technology", 1)];
    const evaluator = createDailyCandidateEvaluator({
      fetchImpl: wikipediaFetch({ targets, starts: ["Start one", "Start two", "Start three"] }) as unknown as typeof fetch,
      gateway: gatewayForStarts(),
      now: () => NOW,
    });

    await expect(evaluator.findCandidate({
      dailyDate: "2026-07-17",
      flavor: "recognizable",
    })).resolves.toMatchObject({ targetTitle: "Technology canonical" });
  });
});

describe("daily candidate evaluator: \"I gave up\" reference path (owner spec, 2026-08-02, dailies only)", () => {
  it("never computes a reference path unless the caller opts in (the on-demand random-challenge path never does)", async () => {
    const evaluator = createDailyCandidateEvaluator({
      fetchImpl: wikipediaFetch({
        targets: [target("Target", 1)],
        starts: ["Start one", "Start two", "Start three"],
      }) as unknown as typeof fetch,
      gateway: gatewayForStarts(),
      now: () => NOW,
    });

    const result = await evaluator.findCandidate({ dailyDate: "2026-07-17", flavor: "recognizable" });

    expect(result).not.toHaveProperty("referencePath");
  });

  it("depth 2, zero extra requests: a start first-hop title that's ALSO one of the target's already-fetched inbound-linkers", async () => {
    const fetchImpl = wikipediaFetch({
      targets: [target("Target", 1)],
      starts: ["Start one", "Start two", "Start three"],
      // >= the recognizable floor (150) so "Target" qualifies at all; one
      // entry ("Move 3") deliberately overlaps the start's own first-hop
      // titles ("Move 1".."Move 8", from the default `allowedLinks(8)`).
      linkshereResponse: () => linkshereResponseWithTitles(["Move 3", ...inboundTitles(199)]),
    });
    const evaluator = createDailyCandidateEvaluator({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      gateway: gatewayForStarts(),
      now: () => NOW,
    });

    const result = await evaluator.findCandidate({
      dailyDate: "2026-07-17",
      flavor: "recognizable",
      computeReferencePath: true,
    });

    // Whichever of the three (structurally-identical) starts wins the
    // ranking tiebreak, the reference path must begin with THAT start.
    expect(result.referencePath).toEqual([result.startTitle, "Move 3", "Target canonical"]);
    // Depth 2 is a pure in-memory intersection of two lists the evaluator
    // already fetched for other reasons (the start's own render, and the
    // inbound-link floor check) - it must never cost an extra `prop=links`
    // request.
    expect(findActionCalls(fetchImpl, "links")).toHaveLength(0);
  });

  it("depth 3, budgeted: reconstructs start -> X -> Y -> target from a bounded prop=links search when depths 1-2 both miss", async () => {
    const fetchImpl = wikipediaFetch({
      targets: [target("Target", 1)],
      starts: ["Start one", "Start two", "Start three"],
      linkshereResponse: () => linkshereResponseWithTitles(inboundTitles(200)),
      proxyResponse: pathProxyResponse("Move 5", "Inbound 7"),
    });
    const evaluator = createDailyCandidateEvaluator({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      gateway: gatewayForStarts(),
      now: () => NOW,
    });

    const result = await evaluator.findCandidate({
      dailyDate: "2026-07-17",
      flavor: "recognizable",
      computeReferencePath: true,
    });

    expect(result.referencePath).toEqual([result.startTitle, "Move 5", "Inbound 7", "Target canonical"]);
  });

  it("degrades to null - never throws, never fails candidate selection - when the bounded depth-3 search finds nothing", async () => {
    const fetchImpl = wikipediaFetch({
      targets: [target("Target", 1)],
      starts: ["Start one", "Start two", "Start three"],
      linkshereResponse: () => linkshereResponseWithTitles(inboundTitles(200)),
      // No overlap anywhere, and the proxy response never matches any
      // queried title - a genuine "found nothing within budget" miss.
      proxyResponse: () => linksResponse(null),
    });
    const evaluator = createDailyCandidateEvaluator({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      gateway: gatewayForStarts(),
      now: () => NOW,
    });

    await expect(evaluator.findCandidate({
      dailyDate: "2026-07-17",
      flavor: "recognizable",
      computeReferencePath: true,
    })).resolves.toMatchObject({ referencePath: null });
  });

  it("degrades to null on a malformed depth-3 response rather than failing the whole daily job", async () => {
    const fetchImpl = wikipediaFetch({
      targets: [target("Target", 1)],
      starts: ["Start one", "Start two", "Start three"],
      linkshereResponse: () => linkshereResponseWithTitles(inboundTitles(200)),
      proxyResponse: () => new Response("not json", { status: 200 }),
    });
    const evaluator = createDailyCandidateEvaluator({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      gateway: gatewayForStarts(),
      now: () => NOW,
    });

    await expect(evaluator.findCandidate({
      dailyDate: "2026-07-17",
      flavor: "recognizable",
      computeReferencePath: true,
    })).resolves.toMatchObject({ referencePath: null, targetTitle: "Target canonical" });
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
  linkshereResponse?: (url: URL) => Response;
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
    if (url.searchParams.get("prop") === "linkshere") {
      // Default: comfortably clears every flavor's floor - individual tests
      // for the floor's own discard/pass/degrade behavior override this via
      // `linkshereResponse`.
      return options.linkshereResponse?.(url) ?? linkshereResponse(500);
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

/**
 * Like metadataResponse, but for the static-fallback-target path: those
 * targets carry no pageId, so matching happens by (unmodified) title -
 * unlike metadataResponse's synthetic " canonical" suffix, which relies on
 * the normal path's pageId-keyed match instead.
 */
function fallbackMetadataResponse(titles: readonly string[]): Response {
  return new Response(JSON.stringify({
    query: {
      pages: titles.map((title, index) => ({
        pageid: index + 1,
        ns: 0,
        title,
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

/**
 * Like pageviewsResponse, but the 30 daily view counts sum to exactly
 * `total` (front-loading the remainder of `total / 30`) - the recognizable
 * pageviews floor tests need specific totals relative to
 * RECOGNIZABLE_PAGEVIEWS_FLOOR (1000), not just "some views".
 */
function monthlyPageviewsResponse(total: number): Response {
  const items = completePageviewItems();
  const base = Math.floor(total / items.length);
  let remainder = total - base * items.length;
  return new Response(JSON.stringify({
    items: items.map((item) => {
      const bonus = remainder > 0 ? 1 : 0;
      if (remainder > 0) remainder -= 1;
      return { ...item, views: base + bonus };
    }),
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

function linkshereResponse(count: number, title = "Hop"): Response {
  return new Response(JSON.stringify({
    query: {
      pages: [{
        pageid: 1,
        ns: 0,
        title,
        linkshere: Array.from({ length: count }, (_unused, index) => ({
          pageid: index + 1,
          ns: 0,
          title: `Inbound ${index + 1}`,
        })),
      }],
    },
  }), { headers: { "Content-Type": "application/json" } });
}

function findActionCalls(fetchImpl: ReturnType<typeof vi.fn>, prop: string) {
  return fetchImpl.mock.calls.filter(([input]) => new URL(String(input)).searchParams.get("prop") === prop);
}

/** "I gave up" reference path tests: `count` distinct "Inbound N" titles. */
function inboundTitles(count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => `Inbound ${index + 1}`);
}

/**
 * Like `linkshereResponse`, but with an explicit, caller-controlled title
 * list (rather than always "Inbound 1..count") - the reference-path tests
 * need to deliberately overlap (or not overlap) specific titles with the
 * start's own first-hop links.
 */
function linkshereResponseWithTitles(titles: readonly string[]): Response {
  return new Response(JSON.stringify({
    query: {
      pages: [{
        pageid: 1,
        ns: 0,
        title: "Target",
        linkshere: titles.map((title, index) => ({ pageid: index + 1, ns: 0, title })),
      }],
    },
  }), { headers: { "Content-Type": "application/json" } });
}

/**
 * `findReferencePath`'s depth-3 search issues one `prop=links` request per
 * chunk of the start's first-hop titles, filtered (`pltitles`) to the
 * target's inbound-linkers. This stub echoes back every REQUESTED source
 * title as its own page, giving `matchSourceTitle` a single outgoing link to
 * `matchDestinationTitle` and every other requested title no links at all -
 * proving the search correctly attributes the match to the right (X, Y)
 * pair rather than just "some page in the batch matched something".
 */
function pathProxyResponse(matchSourceTitle: string, matchDestinationTitle: string) {
  return (url: URL): Response => {
    const titles = (url.searchParams.get("titles") ?? "").split("|").filter(Boolean);
    return new Response(JSON.stringify({
      query: {
        pages: titles.map((title) => ({
          pageid: 1,
          ns: 0,
          title,
          ...(title === matchSourceTitle
            ? { links: [{ ns: 0, title: matchDestinationTitle }] }
            : {}),
        })),
      },
    }), { headers: { "Content-Type": "application/json" } });
  };
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
