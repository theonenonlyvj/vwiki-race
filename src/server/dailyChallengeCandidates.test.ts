import { describe, expect, it, vi } from "vitest";
import type { DailyCandidateEvaluator } from "./dailyCandidateEvaluator";
import { createDailyChallengeCandidateSource } from "./dailyChallengeCandidates";
import type { EditorialTarget } from "./editorialTargetPools";

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
  });

  it("continues to surface the established random diagnostics from the delegated evaluator", async () => {
    const onDiagnostic = vi.fn();
    const source = createDailyChallengeCandidateSource({
      fetchImpl: vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.searchParams.get("prop") === "info|pageprops|extracts|pageimages|categories") {
          return new Response(JSON.stringify({ query: { pages: [{
            pageid: 2, ns: 0, title: "Target", length: 2_000, extract: "A".repeat(100),
          }] } }));
        }
        if (url.pathname.includes("/metrics/pageviews/")) {
          return new Response(JSON.stringify({ items: Array.from({ length: 30 }, () => ({ views: 1 })) }));
        }
        return new Response("{}", { headers: { "Content-Type": "application/json" } });
      }) as unknown as typeof fetch,
      gateway: { getArticle: vi.fn(), clear: () => undefined },
      targetPools: { list: vi.fn(async () => [{
        title: "Target", source: "vital", vitalLevel: 1,
      }] satisfies EditorialTarget[]) },
      onDiagnostic,
    });

    await expect(source.findCandidate({ dailyDate: "2026-07-17", flavor: "recognizable" })).rejects.toMatchObject({
      code: "daily_candidate_unavailable",
    });
    expect(onDiagnostic).toHaveBeenCalledWith("random_invalid_payload", {
      attempt: 1,
      role: "start",
    });
  });
});
