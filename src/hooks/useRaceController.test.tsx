import { StrictMode, type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Article, Challenge, ServerPathStep } from "../domain/types";
import { ApiRequestError } from "../services/apiRequest";
import type { VWikiRaceApiClient } from "../services/vwikiRaceApiClient";
import type { WikipediaGateway } from "../services/wikipediaGateway";
import { useRaceController } from "./useRaceController";

const challenge: Challenge = {
  id: "challenge-1", label: "Challenge #1", mode: "daily",
  start: { title: "Apple", pageId: 1 }, target: { title: "Fruit", pageId: 2 },
  ruleset: "ranked_classic", source: "curated",
};
const apple = article("Apple", 1);
const fruit = article("Fruit", 2);

describe("useRaceController", () => {
  it("accepts async start responses under React StrictMode", async () => {
    const start = deferred<ReturnType<typeof activeRun>>();
    const api = apiClient({ startRun: vi.fn(() => start.promise) });
    const gateway = wikiGateway({ Apple: apple });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StrictMode>{children}</StrictMode>
    );
    const { result } = renderHook(
      () => useRaceController({ apiClient: api, gateway }),
      { wrapper },
    );

    let pending!: ReturnType<typeof result.current.start>;
    act(() => { pending = result.current.start(challenge, "token"); });
    await act(async () => { start.resolve(activeRun()); await pending; });

    expect(result.current.phase).toBe("active");
    expect(result.current.article).toEqual(apple);
  });

  it("preloads before start and reveals with a zero timer only after acceptance", async () => {
    const start = deferred<ReturnType<typeof activeRun>>();
    const api = apiClient({ startRun: vi.fn(() => start.promise) });
    const gateway = wikiGateway({ Apple: apple });
    const { result } = renderHook(() => useRaceController({ apiClient: api, gateway }));

    let pending!: ReturnType<typeof result.current.start>;
    act(() => { pending = result.current.start(challenge, "token"); });
    expect(gateway.getArticle).toHaveBeenCalledWith("Apple", expect.objectContaining({
      ruleset: "ranked_classic",
      signal: expect.any(AbortSignal),
    }));
    expect(result.current.phase).toBe("preparing");
    expect(result.current.article).toBeNull();

    let outcome: Awaited<typeof pending>;
    await act(async () => { start.resolve(activeRun()); outcome = await pending; });
    expect(outcome!).toEqual({ status: "started", challengeId: challenge.id });
    expect(result.current.phase).toBe("active");
    expect(result.current.article?.canonicalTitle).toBe("Apple");
    expect(result.current.elapsedMs).toBe(0);
  });

  it("refuses to start when the preloaded article is not the selected canonical start", async () => {
    const startRun = vi.fn(async () => activeRun());
    const api = apiClient({ startRun });
    const gateway = wikiGateway({ Apple: fruit });
    const { result } = renderHook(() => useRaceController({ apiClient: api, gateway }));

    let outcome!: Awaited<ReturnType<typeof result.current.start>>;
    await act(async () => { outcome = await result.current.start(challenge, "token"); });

    expect(outcome).toEqual({ status: "failed", challengeId: challenge.id });
    expect(startRun).not.toHaveBeenCalled();
    expect(result.current.phase).toBe("idle");
    expect(result.current.article).toBeNull();
  });

  it("reveals a loaded destination while syncing and commits its path only after acceptance", async () => {
    const click = deferred<ReturnType<typeof activeClick>>();
    const recordClick = vi.fn(() => click.promise);
    const abandonRun = vi.fn();
    const api = apiClient({ abandonRun, recordClick });
    const gateway = wikiGateway({ Apple: apple, Fruit: fruit });
    const { result } = renderHook(() => useRaceController({ apiClient: api, gateway, createEventId: () => "event-1" }));
    await act(async () => { await result.current.start(challenge, "token"); });

    let navigation!: ReturnType<typeof result.current.followLink>;
    act(() => { navigation = result.current.followLink("Fruit", "fruit", "token"); });
    expect(result.current.phase).toBe("syncing");
    expect(result.current.article?.canonicalTitle).toBe("Apple");
    await expect(result.current.followLink("Fruit", "fruit", "token")).resolves.toEqual({ status: "ignored" });
    await expect(result.current.endRun("token")).resolves.toEqual({ status: "ignored" });
    expect(abandonRun).not.toHaveBeenCalled();

    await act(async () => {
      await waitFor(() => expect(recordClick).toHaveBeenCalledTimes(1));
    });
    expect(result.current.phase).toBe("syncing");
    expect(result.current.article?.canonicalTitle).toBe("Fruit");
    expect(result.current.session?.currentPage.canonicalTitle).toBe("Apple");

    let outcome: Awaited<typeof navigation>;
    await act(async () => { click.resolve(activeClick()); outcome = await navigation; });
    expect(outcome!).toMatchObject({ status: "completed", challengeId: challenge.id });
    expect(recordClick).toHaveBeenCalledTimes(1);
    expect((recordClick.mock.calls as unknown[][])[0]?.[1]).toMatchObject({ clientEventId: "event-1", expectedStepNumber: 1, destinationTitle: "Fruit" });
    expect(result.current.article?.canonicalTitle).toBe("Fruit");
    expect(result.current.phase).toBe("completed");
  });

  it("prewarms one indicated playable link without changing race state", async () => {
    const gateway = wikiGateway({ Apple: apple, Fruit: fruit });
    const { result } = renderHook(() => useRaceController({
      apiClient: apiClient(),
      gateway,
    }));
    await act(async () => { await result.current.start(challenge, "token"); });

    act(() => { result.current.prewarmLink("Fruit"); });
    await waitFor(() => expect(gateway.getArticle).toHaveBeenCalledWith(
      "Fruit",
      { ruleset: "ranked_classic" },
    ));
    expect(result.current.phase).toBe("active");
    expect(result.current.article).toEqual(apple);
  });

  it("aborts start article work and ignores its stale response after unmount", async () => {
    const articleRequest = deferred<Article>();
    let receivedSignal: AbortSignal | undefined;
    const gateway: WikipediaGateway = {
      getArticle: vi.fn((_title, options) => {
        receivedSignal = options?.signal;
        return articleRequest.promise;
      }),
      clear: vi.fn(),
    };
    const api = apiClient();
    const { result, unmount } = renderHook(() => useRaceController({ apiClient: api, gateway }));

    let pending!: ReturnType<typeof result.current.start>;
    act(() => { pending = result.current.start(challenge, "token"); });
    unmount();
    expect(receivedSignal?.aborted).toBe(true);
    articleRequest.resolve(apple);
    await expect(pending).resolves.toEqual({ status: "stale" });
    expect(api.startRun).not.toHaveBeenCalled();
  });

  it("aborts and ignores a stale start when a newer generation supersedes it", async () => {
    const startArticle = deferred<Article>();
    let startSignal: AbortSignal | undefined;
    const gateway: WikipediaGateway = {
      getArticle: vi.fn((_title, options) => {
        startSignal = options?.signal;
        return startArticle.promise;
      }),
      clear: vi.fn(),
    };
    const api = apiClient({ getActiveRun: vi.fn(async () => null) });
    const { result } = renderHook(() => useRaceController({ apiClient: api, gateway }));

    let pendingStart!: ReturnType<typeof result.current.start>;
    act(() => { pendingStart = result.current.start(challenge, "token"); });
    let recovery!: Awaited<ReturnType<typeof result.current.recoverActiveRun>>;
    await act(async () => { recovery = await result.current.recoverActiveRun([challenge], "token"); });
    expect(recovery!).toEqual({ status: "none" });
    expect(startSignal?.aborted).toBe(true);

    startArticle.resolve(apple);
    await expect(pendingStart).resolves.toEqual({ status: "stale" });
    expect(api.startRun).not.toHaveBeenCalled();
  });

  it("aborts in-flight destination work on unmount", async () => {
    const destination = deferred<Article>();
    let destinationSignal: AbortSignal | undefined;
    const gateway: WikipediaGateway = {
      getArticle: vi.fn((title, options) => {
        if (title === "Apple") return Promise.resolve(apple);
        destinationSignal = options?.signal;
        return destination.promise;
      }),
      clear: vi.fn(),
    };
    const api = apiClient();
    const { result, unmount } = renderHook(() => useRaceController({ apiClient: api, gateway }));
    await act(async () => { await result.current.start(challenge, "token"); });

    let pending!: ReturnType<typeof result.current.followLink>;
    act(() => { pending = result.current.followLink("Fruit", "fruit", "token"); });
    unmount();
    expect(destinationSignal?.aborted).toBe(true);
    destination.resolve(fruit);
    await expect(pending).resolves.toEqual({ status: "stale" });
    expect(api.recordClick).not.toHaveBeenCalled();
  });

  it("retries the exact pending click without refetching or recomputing its body", async () => {
    const recordClick = vi.fn()
      .mockRejectedValueOnce(new ApiRequestError("network_error", "offline", 503))
      .mockResolvedValueOnce({ transition: { runId: "run-1", clickCount: 1, runStatus: "active" } });
    const abandonRun = vi.fn();
    const api = apiClient({ abandonRun, recordClick });
    const gateway = wikiGateway({ Apple: apple, Fruit: fruit });
    const { result } = renderHook(() => useRaceController({
      apiClient: api,
      gateway,
      createEventId: () => "event-fixed",
      observedAt: () => "2026-07-15T00:00:01.000Z",
    }));
    await act(async () => { await result.current.start(challenge, "token"); });

    let first!: Awaited<ReturnType<typeof result.current.followLink>>;
    await act(async () => { first = await result.current.followLink("Fruit", "fruit", "token"); });
    expect(first).toMatchObject({ status: "retryable" });
    expect(result.current.phase).toBe("active");
    expect(result.current.article).toEqual(apple);
    expect(result.current.pendingRetry).not.toBeNull();
    await expect(result.current.endRun("token")).resolves.toEqual({ status: "ignored" });
    expect(abandonRun).not.toHaveBeenCalled();

    let second!: Awaited<ReturnType<typeof result.current.retryPendingClick>>;
    await act(async () => { second = await result.current.retryPendingClick("token"); });
    expect(second).toMatchObject({ status: "active" });
    expect(gateway.getArticle).toHaveBeenCalledTimes(2);
    expect(recordClick).toHaveBeenCalledTimes(2);
    expect(recordClick.mock.calls[1]?.[1]).toBe(recordClick.mock.calls[0]?.[1]);
    expect(recordClick.mock.calls[1]?.[1]).toEqual(recordClick.mock.calls[0]?.[1]);
    expect(JSON.stringify(recordClick.mock.calls[1]?.[1])).toBe(JSON.stringify(recordClick.mock.calls[0]?.[1]));
    expect(recordClick.mock.calls[1]?.[1]).toMatchObject({
      clientEventId: "event-fixed",
      clientObservedAt: "2026-07-15T00:00:01.000Z",
    });
  });

  it("keeps decision time frozen while an accepted click waits for retry", async () => {
    let now = 1_000;
    const water = article("Water", 3);
    const recordClick = vi.fn()
      .mockRejectedValueOnce(new ApiRequestError("network_error", "offline", 503))
      .mockResolvedValueOnce({
        transition: { runId: "run-1", clickCount: 1, runStatus: "active" as const },
      })
      .mockResolvedValueOnce({
        transition: { runId: "run-1", clickCount: 2, runStatus: "active" as const },
      });
    const api = apiClient({ recordClick });
    const gateway = wikiGateway({ Apple: apple, Fruit: fruit, Water: water });
    const { result } = renderHook(() => useRaceController({
      apiClient: api,
      gateway,
      now: () => now,
    }));
    await act(async () => { await result.current.start(challenge, "token"); });

    now = 1_500;
    await act(async () => { await result.current.followLink("Fruit", "fruit", "token"); });
    expect(recordClick.mock.calls[0]?.[1]).toMatchObject({ decisionElapsedMs: 500 });

    now = 9_000;
    await act(async () => { await result.current.retryPendingClick("token"); });
    now = 9_200;
    await act(async () => { await result.current.followLink("Water", "water", "token"); });

    expect(recordClick.mock.calls[2]?.[1]).toMatchObject({ decisionElapsedMs: 700 });
  });

  it("resumes decision time from the last accepted path step, excluding wall latency", async () => {
    let now = 10_000;
    const run = { ...activeRun(), clickCount: 1, lastTitle: "Apple", lastPageId: 1, wallElapsedMs: 9_000 };
    const path = [pathStep({ elapsedSinceStartMs: 500 })];
    const recordClick = vi.fn(async (..._args: Parameters<VWikiRaceApiClient["recordClick"]>) => ({
      transition: { runId: "run-1", clickCount: 2, runStatus: "active" as const },
    }));
    const getActiveRunPath = vi.fn(async () => path);
    const api = apiClient({ getActiveRun: vi.fn(async () => run), getActiveRunPath, recordClick });
    const gateway = wikiGateway({ Apple: apple, Fruit: fruit });
    const { result } = renderHook(() => useRaceController({ apiClient: api, gateway, now: () => now }));

    await act(async () => { await result.current.recoverActiveRun([challenge], "token"); });
    expect(getActiveRunPath).toHaveBeenCalledWith("run-1", "token");
    expect(result.current.elapsedMs).toBe(500);
    now = 10_100;
    await act(async () => { await result.current.followLink("Fruit", "fruit", "token"); });
    expect(recordClick.mock.calls[0]?.[1]).toMatchObject({ decisionElapsedMs: 600 });
  });

  it("restores a protocol-2 accepted article and path after validating identity", async () => {
    const resumableChallenge = { ...challenge, target: { title: "Water", pageId: 3 } };
    const run = { ...activeRun(), targetTitle: "Water", clickCount: 1, lastTitle: "Fruit", lastPageId: 2 };
    const path = [pathStep({ destinationTitle: "Fruit", destinationPageId: 2 })];
    const getActiveRunPath = vi.fn(async () => path);
    const api = apiClient({ getActiveRun: vi.fn(async () => run), getActiveRunPath });
    const gateway = wikiGateway({ Fruit: fruit });
    const { result } = renderHook(() => useRaceController({ apiClient: api, gateway }));

    let outcome!: Awaited<ReturnType<typeof result.current.recoverActiveRun>>;
    await act(async () => { outcome = await result.current.recoverActiveRun([resumableChallenge], "token"); });

    expect(outcome).toEqual({ status: "recovered", challengeId: challenge.id });
    expect(getActiveRunPath).toHaveBeenCalledWith("run-1", "token");
    expect(gateway.getArticle).toHaveBeenCalledWith("Fruit", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(result.current.article).toEqual(fruit);
    expect(result.current.session?.path).toHaveLength(1);
    expect(result.current.session?.currentPage).toEqual({ canonicalTitle: "Fruit", pageId: 2 });
  });

  it("refuses protocol-2 recovery when the fetched article is not the accepted page", async () => {
    const run = { ...activeRun(), clickCount: 1, lastTitle: "Fruit", lastPageId: 999 };
    const path = [pathStep({ destinationTitle: "Fruit", destinationPageId: 999 })];
    const api = apiClient({ getActiveRun: vi.fn(async () => run), getActiveRunPath: vi.fn(async () => path) });
    const gateway = wikiGateway({ Fruit: fruit });
    const { result } = renderHook(() => useRaceController({ apiClient: api, gateway }));

    let outcome!: Awaited<ReturnType<typeof result.current.recoverActiveRun>>;
    await act(async () => { outcome = await result.current.recoverActiveRun([challenge], "token"); });

    expect(outcome).toMatchObject({ status: "recovery-required", challengeId: challenge.id, run });
    expect(result.current.phase).toBe("idle");
    expect(result.current.article).toBeNull();
    expect(result.current.recoveryRun).toEqual(run);
  });

  it("recovers a zero-click active run from an empty authenticated owned path", async () => {
    const run = { ...activeRun(), lastTitle: "Apple", lastPageId: 1 };
    const getActiveRunPath = vi.fn(async () => []);
    const getRunPath = vi.fn(async () => { throw new Error("public path must not be used"); });
    const api = apiClient({
      getActiveRun: vi.fn(async () => run),
      getActiveRunPath,
      getRunPath,
    });
    const gateway = wikiGateway({ Apple: apple });
    const { result } = renderHook(() => useRaceController({ apiClient: api, gateway }));

    let outcome!: Awaited<ReturnType<typeof result.current.recoverActiveRun>>;
    await act(async () => { outcome = await result.current.recoverActiveRun([challenge], "token"); });

    expect(outcome).toEqual({ status: "recovered", challengeId: challenge.id });
    expect(getActiveRunPath).toHaveBeenCalledWith("run-1", "token");
    expect(getRunPath).not.toHaveBeenCalled();
    expect(result.current.article).toEqual(apple);
    expect(result.current.session?.path).toEqual([]);
  });

  it("requires protocol-1 recovery abandon and rolls back when abandon fails", async () => {
    const legacyRun = { ...activeRun(), protocolVersion: 1 as const };
    const abandonRun = vi.fn()
      .mockRejectedValueOnce(new ApiRequestError("network_error", "offline", 503))
      .mockResolvedValueOnce({ runId: "run-1", runStatus: "abandoned" });
    const api = apiClient({ getActiveRun: vi.fn(async () => legacyRun), abandonRun });
    const gateway = wikiGateway({});
    const { result } = renderHook(() => useRaceController({ apiClient: api, gateway }));

    await act(async () => { await result.current.recoverActiveRun([challenge], "token"); });
    expect(result.current.recoveryRun?.protocolVersion).toBe(1);
    let failed!: Awaited<ReturnType<typeof result.current.endRun>>;
    await act(async () => { failed = await result.current.endRun("token", 1); });
    expect(failed).toMatchObject({ status: "failed" });
    expect(result.current.phase).toBe("idle");
    expect(result.current.recoveryRun).toEqual(legacyRun);

    await act(async () => { await result.current.endRun("token", 1); });
    expect(abandonRun.mock.calls[1]?.[2]).toEqual({ recoveryProtocolVersion: 1 });
    expect(result.current.recoveryRun).toBeNull();
  });

  it("allows only one idempotent abandon while the first request is pending", async () => {
    const abandon = deferred<{ runId: string; runStatus: "abandoned" }>();
    const abandonRun = vi.fn(() => abandon.promise);
    const legacyRun = { ...activeRun(), protocolVersion: 1 as const };
    const api = apiClient({ abandonRun, getActiveRun: vi.fn(async () => legacyRun) });
    const gateway = wikiGateway({});
    const { result } = renderHook(() => useRaceController({ apiClient: api, gateway }));
    await act(async () => { await result.current.recoverActiveRun([challenge], "token"); });

    let first!: ReturnType<typeof result.current.endRun>;
    act(() => { first = result.current.endRun("token", 1); });
    expect(result.current.phase).toBe("abandoning");
    await expect(result.current.endRun("token", 1)).resolves.toEqual({ status: "ignored" });
    expect(abandonRun).toHaveBeenCalledTimes(1);

    await act(async () => { abandon.resolve({ runId: "run-1", runStatus: "abandoned" }); await first; });
    expect(result.current.phase).toBe("idle");
  });

  it("marks the local session completed when abandon reports an already-completed run", async () => {
    const abandonRun = vi.fn(async () => ({
      runId: "run-1",
      runStatus: "completed" as const,
      completedAt: "2026-07-15T00:00:01.500Z",
      elapsedMs: 1_500,
      outcome: "already_completed" as const,
    }));
    const api = apiClient({ abandonRun });
    const gateway = wikiGateway({ Apple: apple });
    const { result } = renderHook(() => useRaceController({ apiClient: api, gateway }));
    await act(async () => { await result.current.start(challenge, "token"); });

    await act(async () => { await result.current.endRun("token"); });

    expect(result.current.phase).toBe("completed");
    expect(result.current.session?.status).toBe("completed");
    expect(result.current.run).toMatchObject({
      status: "completed",
      completedAt: "2026-07-15T00:00:01.500Z",
      elapsedMs: 1_500,
    });
    expect(result.current.elapsedMs).toBe(1_500);
  });

  it("resets a completed run to a clean pre-start state", async () => {
    const api = apiClient();
    const gateway = wikiGateway({ Apple: apple, Fruit: fruit });
    const { result } = renderHook(() => useRaceController({ apiClient: api, gateway }));
    await act(async () => { await result.current.start(challenge, "token"); });
    await act(async () => { await result.current.followLink("Fruit", "fruit", "token"); });
    expect(result.current.phase).toBe("completed");

    let didReset = false;
    act(() => { didReset = result.current.resetCompleted(); });

    expect(didReset).toBe(true);
    expect(result.current.phase).toBe("idle");
    expect(result.current.session).toBeNull();
    expect(result.current.article).toBeNull();
    expect(result.current.run).toBeNull();
  });

  it("does not reset an active run", async () => {
    const api = apiClient();
    const gateway = wikiGateway({ Apple: apple });
    const { result } = renderHook(() => useRaceController({ apiClient: api, gateway }));
    await act(async () => { await result.current.start(challenge, "token"); });

    let didReset = true;
    act(() => { didReset = result.current.resetCompleted(); });

    expect(didReset).toBe(false);
    expect(result.current.phase).toBe("active");
    expect(result.current.article).toEqual(apple);
  });

  it("returns typed unauthorized outcomes without losing the pending intent context", async () => {
    const api = apiClient({ startRun: vi.fn(async () => { throw new ApiRequestError("unauthorized", "expired", 401); }) });
    const gateway = wikiGateway({ Apple: apple });
    const { result } = renderHook(() => useRaceController({ apiClient: api, gateway }));

    let outcome!: Awaited<ReturnType<typeof result.current.start>>;
    await act(async () => { outcome = await result.current.start(challenge, "stale-token"); });
    expect(outcome).toEqual({ status: "unauthorized", challengeId: challenge.id });
    expect(result.current.phase).toBe("idle");
  });
});

function article(canonicalTitle: string, pageId: number): Article {
  return { canonicalTitle, pageId, revisionId: 1, sourceUrl: "https://example.test", attributionUrl: "https://example.test/revision", attribution: "Wikipedia", sanitizedHtml: "<p />" as Article["sanitizedHtml"], links: [] };
}
function activeRun() {
  return { id: "run-1", challengeId: challenge.id, accountId: "account-1", canonicalAccountId: "account-1", status: "active" as const, startTitle: "Apple", targetTitle: "Fruit", clickCount: 0, startedAt: "2026-07-15T00:00:00.000Z", protocolVersion: 2 as const };
}
function pathStep(override: Partial<ServerPathStep> = {}): ServerPathStep {
  return { stepNumber: 1, sourceTitle: "Start", clickedAnchorText: "apple", destinationTitle: "Apple", destinationPageId: 1, elapsedSinceStartMs: 500, createdAt: "2026-07-15T00:00:00.500Z", ...override };
}
function activeClick() {
  return { transition: { runId: "run-1", clickCount: 1, runStatus: "completed" as const, completedAt: "2026-07-15T00:00:01.000Z", elapsedMs: 1_000 }, leaderboardContext: { isPersonalBest: true, rank: 1 } };
}
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>((done) => { resolve = done; }), resolve }; }
function apiClient(overrides: Partial<VWikiRaceApiClient> = {}): VWikiRaceApiClient {
  return { listChallenges: vi.fn(async () => []), createChallenge: vi.fn(), startRun: vi.fn(async () => activeRun()), getActiveRun: vi.fn(async () => null), getActiveRunPath: vi.fn(async () => []), recordClick: vi.fn(async () => activeClick()), abandonRun: vi.fn(), listLeaderboard: vi.fn(async () => []), getRunPath: vi.fn(async () => []), getAccountStats: vi.fn(), ...overrides };
}
function wikiGateway(articles: Record<string, Article>): WikipediaGateway {
  return { getArticle: vi.fn(async (title: string) => articles[title]!), clear: vi.fn() };
}
