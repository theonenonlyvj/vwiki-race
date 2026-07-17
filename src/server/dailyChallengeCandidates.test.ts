import { describe, expect, it, vi } from "vitest";
import type { DailyCandidateEvaluator } from "./dailyCandidateEvaluator";
import { createDailyChallengeCandidateSource } from "./dailyChallengeCandidates";

describe("daily challenge candidate facade", () => {
  it("delegates the editorial daily request and preserves the persistence candidate shape", async () => {
    const findCandidate = vi.fn(async () => ({
      startTitle: "Start", startPageId: 101, targetTitle: "Target", targetPageId: 202,
    }));
    const source = createDailyChallengeCandidateSource({
      fetchImpl: vi.fn() as unknown as typeof fetch,
      gateway: { getArticle: vi.fn(), clear: () => undefined },
      evaluator: { findCandidate } as unknown as DailyCandidateEvaluator,
    });

    await expect(source.findCandidate({ dailyDate: "2026-07-17", flavor: "weird" })).resolves.toEqual({
      startTitle: "Start", startPageId: 101, targetTitle: "Target", targetPageId: 202,
    });
    expect(findCandidate).toHaveBeenCalledWith({ dailyDate: "2026-07-17", flavor: "weird" });

    if (false) {
      // @ts-expect-error Daily candidate selection requires the claimed daily date and flavor.
      source.findCandidate();
    }
  });

  it("rejects a missing facade request instead of synthesizing a legacy date and flavor", async () => {
    const findCandidate = vi.fn(async () => ({
      startTitle: "Start", startPageId: 101, targetTitle: "Target", targetPageId: 202,
    }));
    const source = createDailyChallengeCandidateSource({
      fetchImpl: vi.fn() as unknown as typeof fetch,
      gateway: { getArticle: vi.fn(), clear: () => undefined },
      evaluator: { findCandidate } as unknown as DailyCandidateEvaluator,
    });

    await expect((source as unknown as { findCandidate(): Promise<unknown> }).findCandidate()).rejects.toThrow(
      "Daily candidate requests require a daily date and flavor.",
    );
    expect(findCandidate).not.toHaveBeenCalled();
  });

  it("does not expose target-pool injection through the facade", () => {
    if (false) {
      createDailyChallengeCandidateSource({
        fetchImpl: vi.fn() as unknown as typeof fetch,
        gateway: { getArticle: vi.fn(), clear: () => undefined },
        // @ts-expect-error Target pools must be loaded through the evaluator's counted fetch path.
        targetPools: { list: vi.fn() },
      });
    }
  });

  it("continues to surface the established random diagnostics from the delegated evaluator", async () => {
    const onDiagnostic = vi.fn();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "en.wikipedia.org" && (
        url.pathname.includes("Wikipedia:Vital_articles/Level/") || url.pathname.includes("Wikipedia:Unusual_articles")
      )) {
        return new Response(url.pathname.includes("Unusual_articles")
          ? "<main><dl><dt><a href=\"/wiki/Target\" data-pageid=\"2\">Target</a></dt></dl></main>"
          : "<main><ul><li><a href=\"/wiki/Target\" data-pageid=\"2\">Target</a></li></ul></main>");
      }
      if (url.searchParams.get("prop") === "info|pageprops|extracts|pageimages|categories") {
        return new Response(JSON.stringify({ query: { pages: [{
          pageid: 2, ns: 0, title: "Target", length: 2_000, extract: "A".repeat(100),
        }] } }));
      }
      if (url.pathname.includes("/metrics/pageviews/")) {
        return new Response(JSON.stringify({ items: Array.from({ length: 30 }, () => ({ views: 1 })) }));
      }
      return new Response("{}", { headers: { "Content-Type": "application/json" } });
    });
    const source = createDailyChallengeCandidateSource({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      gateway: { getArticle: vi.fn(), clear: () => undefined },
      onDiagnostic,
    });

    await expect(source.findCandidate({ dailyDate: "2026-07-17", flavor: "recognizable" })).rejects.toMatchObject({
      code: "daily_candidate_unavailable",
    });
    expect(onDiagnostic).toHaveBeenCalledWith("random_invalid_payload", {
      attempt: 1,
      role: "start",
    });
    expect(fetchImpl.mock.calls.filter(([input]) => {
      const url = new URL(String(input));
      return url.hostname === "en.wikipedia.org" && url.pathname.includes("Wikipedia:");
    })).toHaveLength(4);
  });
});
