import { describe, expect, it, vi } from "vitest";
import { resolveApiOrigin } from "./apiOrigin";
import { requestJson } from "./apiRequest";

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

  it("requires a configured HTTPS Worker origin for production", () => {
    expect(() => resolveApiOrigin("", { production: true })).toThrow(
      "VITE_VWIKI_RACE_API_URL",
    );
    expect(() => resolveApiOrigin("http://localhost:8787", { production: true }))
      .toThrow("VITE_VWIKI_RACE_API_URL");
  });

  it.each([
    "https://user:secret@api.example.com",
    "https://api.example.com/v2",
    "https://api.example.com//",
    "https://api.example.com?region=us",
    "https://api.example.com#worker",
  ])("rejects a non-canonical API origin: %s", (value) => {
    expect(() => resolveApiOrigin(value)).toThrow("canonical HTTPS origin");
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
