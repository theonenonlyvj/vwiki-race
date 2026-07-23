import { describe, expect, it, vi } from "vitest";
import { resolveApiOrigin } from "./apiOrigin";
import { requestJson, type ApiRequestError } from "./apiRequest";

interface ChallengesResponse {
  challenges: Array<{ id: string }>;
}

function isChallenges(value: unknown): value is ChallengesResponse {
  return (
    value !== null &&
    typeof value === "object" &&
    "challenges" in value &&
    Array.isArray(value.challenges)
  );
}

const requestOptions = {
  timeoutMs: 50,
  retry: "never" as const,
  validate: isChallenges,
};
const requestUrl = "http://localhost:8787/api/v2/challenges";

describe("API origin", () => {
  it("removes trailing slashes from the configured Worker origin", () => {
    expect(resolveApiOrigin("https://vwikirace-api.example.workers.dev/")).toBe(
      "https://vwikirace-api.example.workers.dev",
    );
  });

  it("requires an explicit production origin to be a canonical HTTPS Worker origin", () => {
    // An EMPTY production origin no longer throws - it resolves same-origin
    // on *.pages.dev hosts or the legacy Worker fallback elsewhere (see
    // apiOrigin.test.ts for the full resolution matrix).
    expect(() => resolveApiOrigin("http://localhost:8787", { production: true }))
      .toThrow("VITE_VWIKI_RACE_API_URL");
  });

  it.each([
    "http://localhost:8787",
    "http://127.0.0.1:8787/",
    "http://[::1]:8787",
  ])("allows a canonical loopback HTTP origin during local development: %s", (value) => {
    expect(resolveApiOrigin(value)).toBe(new URL(value).origin);
  });

  it.each([
    "http://api.example.com",
    "http://192.168.1.20:8787",
    "http://0.0.0.0:8787",
  ])("rejects a non-loopback HTTP origin during development: %s", (value) => {
    expect(() => resolveApiOrigin(value)).toThrow("canonical HTTPS or loopback HTTP origin");
  });

  it.each([
    "https://user:secret@api.example.com",
    "https://api.example.com/v2",
    "https://api.example.com//",
    "https://api.example.com?region=us",
    "https://api.example.com#worker",
  ])("rejects a non-canonical API origin: %s", (value) => {
    expect(() => resolveApiOrigin(value)).toThrow("canonical HTTPS or loopback HTTP origin");
  });
});

describe("requestJson", () => {
  it("rejects an HTML success response as an invalid upstream response", async () => {
    const fetchHtml = vi.fn(async () =>
      new Response("<html>not an API response</html>", {
        headers: { "Content-Type": "text/html" },
      }),
    );

    await expect(
      requestJson(fetchHtml, requestUrl, requestOptions),
    ).rejects.toMatchObject({ code: "invalid_response", status: 502 });
  });

  it("preserves a bounded Retry-After value on rate limiting", async () => {
    const fetch429 = vi.fn(async () =>
      Response.json(
        { error: { code: "rate_limited", message: "Slow down." } },
        { status: 429, headers: { "Retry-After": "2" } },
      ),
    );

    await expect(
      requestJson(fetch429, requestUrl, requestOptions),
    ).rejects.toMatchObject({
      code: "rate_limited",
      status: 429,
      retryAfterMs: 2000,
    });
  });

  it("retries one transient GET failure before returning typed JSON", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: { code: "unavailable" } }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ challenges: [{ id: "challenge-1" }] }));

    await expect(
      requestJson(fetchImpl, requestUrl, {
        ...requestOptions,
        retry: "read-once",
      }),
    ).resolves.toEqual({ challenges: [{ id: "challenge-1" }] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("surfaces a long Retry-After immediately instead of locking the UI", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(async () => Response.json(
        { error: { code: "unavailable", message: "Try later." } },
        { status: 503, headers: { "Retry-After": "60" } },
      ));
      let outcome: ApiRequestError | null = null;
      void requestJson(fetchImpl, requestUrl, {
        ...requestOptions,
        retry: "read-once",
      }).catch((error: ApiRequestError) => {
        outcome = error;
      });

      await vi.advanceTimersByTimeAsync(2_001);

      expect(outcome).toMatchObject({
        code: "unavailable",
        retryAfterMs: 60_000,
        status: 503,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts a request that exceeds its timeout", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
    );

    const request = requestJson(fetchImpl, requestUrl, {
      ...requestOptions,
      timeoutMs: 10,
    });
    const assertion = expect(request).rejects.toMatchObject({
      code: "timeout",
      status: 504,
    });
    await vi.advanceTimersByTimeAsync(10);

    await assertion;
    vi.useRealTimers();
  });

  it("fails a stalled first attempt over to the retry at the shorter first-attempt leash", async () => {
    vi.useFakeTimers();
    try {
      const aborted: boolean[] = [];
      const fetchImpl = vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            const attempt = fetchImpl.mock.calls.length;
            init?.signal?.addEventListener("abort", () => {
              aborted.push(true);
              reject(new DOMException("Aborted", "AbortError"));
            });
            if (attempt === 2) {
              resolve(Response.json({ challenges: [{ id: "challenge-1" }] }));
            }
          }),
      );
      const onRetry = vi.fn();

      const request = requestJson(fetchImpl, requestUrl, {
        ...requestOptions,
        timeoutMs: 15_000,
        firstAttemptTimeoutMs: 4_000,
        retry: "idempotent-once",
        idempotencyKey: "op-1",
        onRetry,
      });
      const assertion = expect(request).resolves.toEqual({
        challenges: [{ id: "challenge-1" }],
      });

      // First attempt aborts at the 4s leash, NOT the full 15s budget...
      await vi.advanceTimersByTimeAsync(4_000);
      expect(aborted).toHaveLength(1);
      expect(onRetry).toHaveBeenCalledTimes(1);
      // ...and the retry fires after the standard delay.
      await vi.advanceTimersByTimeAsync(250);
      expect(fetchImpl).toHaveBeenCalledTimes(2);

      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the full timeout for the retry attempt after a short first leash", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          }),
      );

      const request = requestJson(fetchImpl, requestUrl, {
        ...requestOptions,
        timeoutMs: 15_000,
        firstAttemptTimeoutMs: 4_000,
        retry: "idempotent-once",
        idempotencyKey: "op-1",
      });
      const assertion = expect(request).rejects.toMatchObject({
        code: "timeout",
        status: 504,
      });

      await vi.advanceTimersByTimeAsync(4_250); // leash + retry delay
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      // The retry is still pending at what would have been a second 4s
      // leash - it holds the full 15s window.
      await vi.advanceTimersByTimeAsync(4_000);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(11_000);

      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores the first-attempt leash when no retry is armed", async () => {
    vi.useFakeTimers();
    try {
      let rejected = false;
      const fetchImpl = vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          }),
      );

      const request = requestJson(fetchImpl, requestUrl, {
        ...requestOptions,
        timeoutMs: 10_000,
        firstAttemptTimeoutMs: 4_000,
        retry: "never",
      }).catch((error: ApiRequestError) => {
        rejected = true;
        throw error;
      });
      const assertion = expect(request).rejects.toMatchObject({ code: "timeout" });

      await vi.advanceTimersByTimeAsync(4_000);
      expect(rejected).toBe(false); // the lone attempt keeps its full window
      await vi.advanceTimersByTimeAsync(6_000);

      await assertion;
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("LR-2: runs a full 3-attempt ladder with widening timeouts, a stable idempotency key, and 1-based retry ordinals", async () => {
    vi.useFakeTimers();
    try {
      const aborted: number[] = [];
      const fetchImpl = vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            const attempt = fetchImpl.mock.calls.length;
            init?.signal?.addEventListener("abort", () => {
              aborted.push(attempt);
              reject(new DOMException("Aborted", "AbortError"));
            });
            if (attempt === 3) {
              resolve(Response.json({ challenges: [{ id: "challenge-1" }] }));
            }
          }),
      );
      const onRetry = vi.fn();

      const request = requestJson(fetchImpl, requestUrl, {
        ...requestOptions,
        timeoutMs: 999_999, // unused when the ladder is armed - every attempt uses attemptTimeoutsMs
        attemptTimeoutsMs: [4_000, 8_000, 15_000],
        retry: "idempotent-once",
        idempotencyKey: "op-1",
        onRetry,
      });
      const assertion = expect(request).resolves.toEqual({
        challenges: [{ id: "challenge-1" }],
      });

      // Attempt 1 aborts at 4s (not the 15s legacy default) and reports the
      // upcoming retry as ordinal 1.
      await vi.advanceTimersByTimeAsync(4_000);
      expect(aborted).toEqual([1]);
      expect(onRetry).toHaveBeenNthCalledWith(1, 1);
      // Jittered gap (350-650ms) before attempt 2 fires.
      await vi.advanceTimersByTimeAsync(650);
      expect(fetchImpl).toHaveBeenCalledTimes(2);

      // Attempt 2 aborts at 8s and reports ordinal 2.
      await vi.advanceTimersByTimeAsync(8_000);
      expect(aborted).toEqual([1, 2]);
      expect(onRetry).toHaveBeenNthCalledWith(2, 2);
      await vi.advanceTimersByTimeAsync(650);
      expect(fetchImpl).toHaveBeenCalledTimes(3);

      // Same idempotency key across all three attempts - one logical
      // operation, however many attempts it takes.
      const keys = fetchImpl.mock.calls.map(
        ([, init]) => (init?.headers as Record<string, string>)["Idempotency-Key"],
      );
      expect(new Set(keys)).toEqual(new Set(["op-1"]));

      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("LR-2: keeps the final ladder attempt's full timeout and throws the mapped error once exhausted", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          }),
      );
      const onRetry = vi.fn();

      const request = requestJson(fetchImpl, requestUrl, {
        ...requestOptions,
        timeoutMs: 999_999,
        attemptTimeoutsMs: [4_000, 8_000, 15_000],
        retry: "idempotent-once",
        idempotencyKey: "op-1",
        onRetry,
      });
      const assertion = expect(request).rejects.toMatchObject({
        code: "timeout",
        status: 504,
      });

      await vi.advanceTimersByTimeAsync(4_650); // attempt 1 (4s) + jittered gap
      await vi.advanceTimersByTimeAsync(8_650); // attempt 2 (8s) + jittered gap
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(onRetry).toHaveBeenCalledTimes(2);
      // Final (3rd) attempt keeps its own 15s entry rather than being cut
      // short - no further retry is armed once it also fails.
      await vi.advanceTimersByTimeAsync(15_000);

      await assertion;
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(onRetry).toHaveBeenCalledTimes(2); // never called for the final, non-retried failure
    } finally {
      vi.useRealTimers();
    }
  });

  it("LR-2: a ladder attempt succeeding mid-ladder stops further attempts", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            const attempt = fetchImpl.mock.calls.length;
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
            if (attempt === 1) {
              // First attempt answers with a real (non-retryable-class)
              // failure - the ladder must not keep burning attempts on it.
              resolve(
                Response.json(
                  { error: { code: "invalid_credentials", message: "nope" } },
                  { status: 401 },
                ),
              );
            }
          }),
      );

      await expect(
        requestJson(fetchImpl, requestUrl, {
          ...requestOptions,
          timeoutMs: 999_999,
          attemptTimeoutsMs: [4_000, 8_000, 15_000],
          retry: "idempotent-once",
          idempotencyKey: "op-1",
        }),
      ).rejects.toMatchObject({ code: "invalid_credentials", status: 401 });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("LR-2: ignores attemptTimeoutsMs entirely when no retry is armed", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          }),
      );

      const request = requestJson(fetchImpl, requestUrl, {
        ...requestOptions,
        timeoutMs: 10_000,
        attemptTimeoutsMs: [4_000, 8_000, 15_000],
        retry: "never",
      });
      const assertion = expect(request).rejects.toMatchObject({ code: "timeout" });

      await vi.advanceTimersByTimeAsync(4_000);
      expect(fetchImpl).toHaveBeenCalledTimes(1); // still mid-flight - the lone attempt keeps the full 10s
      await vi.advanceTimersByTimeAsync(6_000);

      await assertion;
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a relative API URL before calling fetch", async () => {
    const fetchImpl = vi.fn();

    await expect(
      requestJson(fetchImpl, "/api/v2/challenges", requestOptions),
    ).rejects.toMatchObject({
      code: "invalid_url",
      status: 500,
      message: expect.stringContaining("VWIKI_ABSOLUTE_API_URL_REQUIRED"),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
