import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Article, Challenge, SanitizedWikipediaHtml } from "../domain/types";
import type { WikipediaGateway } from "../services/wikipediaGateway";
import { useTargetPreview } from "./useTargetPreview";

const challengeOne = challenge("challenge-1", "Target One", 11);
const challengeTwo = challenge("challenge-2", "Target Two", 22);

describe("useTargetPreview", () => {
  it("loads and keys the selected canonical target preview", async () => {
    const target = article("Target One", 11);
    const gateway = wikipediaGateway(vi.fn(async () => target));
    const { result } = renderHook(() => useTargetPreview({
      challenge: challengeOne,
      enabled: true,
      gateway,
    }));

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(gateway.getArticle).toHaveBeenCalledWith("Target One", {
      ruleset: "ranked_classic",
      signal: expect.any(AbortSignal),
    });
    expect(result.current).toMatchObject({
      status: "ready",
      challengeId: "challenge-1",
      canonicalTitle: "Target One",
      preview: { blurb: "Target One is a useful and notable subject with plenty of interesting context to explore." },
    });
  });

  it("rejects a target whose stored canonical page identity no longer matches", async () => {
    const gateway = wikipediaGateway(vi.fn(async () => article("Target One", 999)));
    const { result } = renderHook(() => useTargetPreview({
      challenge: challengeOne,
      enabled: true,
      gateway,
    }));

    await waitFor(() => expect(result.current).toEqual({
      status: "unavailable",
      challengeId: "challenge-1",
    }));
  });

  it("aborts stale selections and cannot overwrite the latest target", async () => {
    const first = deferred<Article>();
    const second = deferred<Article>();
    const signals: AbortSignal[] = [];
    const getArticle = vi.fn((title: string, options?: { signal?: AbortSignal }) => {
      if (options?.signal) signals.push(options.signal);
      return title === "Target One" ? first.promise : second.promise;
    });
    const gateway = wikipediaGateway(getArticle);
    const { result, rerender } = renderHook(
      ({ selected }) => useTargetPreview({ challenge: selected, enabled: true, gateway }),
      { initialProps: { selected: challengeOne } },
    );

    rerender({ selected: challengeTwo });
    expect(signals[0]?.aborted).toBe(true);
    await act(async () => { second.resolve(article("Target Two", 22)); });
    expect(result.current).toMatchObject({
      status: "ready",
      challengeId: "challenge-2",
      canonicalTitle: "Target Two",
    });

    await act(async () => { first.resolve(article("Target One", 11)); });
    expect(result.current).toMatchObject({
      status: "ready",
      challengeId: "challenge-2",
    });
  });

  it("clears and aborts preview work when disabled without surfacing an error", async () => {
    const pending = deferred<Article>();
    let signal: AbortSignal | undefined;
    const gateway = wikipediaGateway(vi.fn((_title, options) => {
      signal = options?.signal;
      return pending.promise;
    }));
    const { result, rerender, unmount } = renderHook(
      ({ enabled }) => useTargetPreview({ challenge: challengeOne, enabled, gateway }),
      { initialProps: { enabled: true } },
    );

    rerender({ enabled: false });
    expect(signal?.aborted).toBe(true);
    expect(result.current).toEqual({ status: "idle" });
    unmount();
    expect(gateway.clear).toHaveBeenCalledTimes(1);
  });

  it("retains an already-loaded preview as a frozen in-game reference", async () => {
    const gateway = wikipediaGateway(vi.fn(async () => article("Target One", 11)));
    const { result, rerender } = renderHook(
      ({ enabled }) => useTargetPreview({ challenge: challengeOne, enabled, gateway }),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    rerender({ enabled: false });

    expect(result.current).toMatchObject({
      status: "ready",
      challengeId: "challenge-1",
      canonicalTitle: "Target One",
    });
    expect(gateway.getArticle).toHaveBeenCalledTimes(1);
  });
});

function challenge(id: string, targetTitle: string, targetPageId: number): Challenge {
  return {
    id,
    mode: "solo",
    start: { title: "Start", pageId: 1 },
    target: { title: targetTitle, pageId: targetPageId },
    ruleset: "ranked_classic",
    source: "curated",
  };
}

function article(canonicalTitle: string, pageId: number): Article {
  return {
    canonicalTitle,
    pageId,
    revisionId: 3,
    sourceUrl: `https://en.wikipedia.org/wiki/${canonicalTitle}`,
    attributionUrl: `https://en.wikipedia.org/w/index.php?title=${canonicalTitle}&oldid=3`,
    attribution: "Wikipedia revision 3",
    links: [],
    sanitizedHtml: `<p>${canonicalTitle} is a useful and notable subject with plenty of interesting context to explore.</p>` as SanitizedWikipediaHtml,
  };
}

function wikipediaGateway(getArticle: WikipediaGateway["getArticle"]): WikipediaGateway {
  return { getArticle: vi.fn(getArticle), clear: vi.fn() };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((done) => { resolve = done; }),
    resolve,
  };
}
