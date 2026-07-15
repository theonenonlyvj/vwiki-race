import { afterEach, describe, expect, it, vi } from "vitest";
import * as challenges from "./challenges";
import * as leaderboard from "./challenges/[challengeId]/leaderboard";
import * as guest from "./identity/guest";
import * as login from "./identity/login";
import * as secure from "./identity/secure";
import * as abandon from "./runs/[runId]/abandon";
import * as click from "./runs/[runId]/click";
import * as complete from "./runs/[runId]/complete";
import * as path from "./runs/[runId]/path";
import * as start from "./runs/start";

const canonicalOrigin = "https://canonical.example";

afterEach(() => {
  vi.unstubAllGlobals();
});

function context(
  request: Request,
  env: Record<string, unknown> = { VWIKI_RACE_API_URL: canonicalOrigin },
): EventContext<Record<string, unknown>, string, unknown> {
  return {
    request,
    env,
    params: {},
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    next: vi.fn(),
    data: {},
    functionPath: "/api/test",
  };
}

describe("retained Pages API proxy", () => {
  it("preserves method, path, query, credentials, idempotency key, body, and response", async () => {
    const fetchImpl = vi.fn(async (request: Request) => new Response(
      await request.text(),
      {
        status: 202,
        headers: { "Retry-After": "17", "X-Upstream": "worker" },
      },
    ));
    vi.stubGlobal("fetch", fetchImpl);
    const body = JSON.stringify({ sourceTitle: "Moon" });
    const request = new Request(
      "https://pages.example/api/runs/run-1/click?source=stale-client",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer legacy-token",
          "Content-Type": "application/json",
          "Idempotency-Key": "legacy-key",
        },
        body,
      },
    );

    const response = await click.onRequestPost(context(request));

    expect(response.status).toBe(202);
    expect(response.headers.get("Retry-After")).toBe("17");
    await expect(response.text()).resolves.toBe(body);
    const forwarded = fetchImpl.mock.calls[0]?.[0] as Request;
    expect(forwarded.url).toBe(
      "https://canonical.example/api/runs/run-1/click?source=stale-client",
    );
    expect(forwarded.method).toBe("POST");
    expect(forwarded.headers.get("Authorization")).toBe("Bearer legacy-token");
    expect(forwarded.headers.get("Idempotency-Key")).toBe("legacy-key");
  });

  it("forwards every retained stale-client route without D1 bindings", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ proxied: true }));
    vi.stubGlobal("fetch", fetchImpl);
    const routes: Array<[
      (context: EventContext<Record<string, unknown>, string, unknown>) => Response | Promise<Response>,
      "GET" | "POST",
      string,
    ]> = [
      [challenges.onRequestGet, "GET", "/api/challenges"],
      [challenges.onRequestPost, "POST", "/api/challenges"],
      [leaderboard.onRequestGet, "GET", "/api/challenges/challenge-0001/leaderboard"],
      [guest.onRequestPost, "POST", "/api/identity/guest"],
      [login.onRequestPost, "POST", "/api/identity/login"],
      [secure.onRequestPost, "POST", "/api/identity/secure"],
      [start.onRequestPost, "POST", "/api/runs/start"],
      [click.onRequestPost, "POST", "/api/runs/run-1/click"],
      [complete.onRequestPost, "POST", "/api/runs/run-1/complete"],
      [abandon.onRequestPost, "POST", "/api/runs/run-1/abandon"],
      [path.onRequestGet, "GET", "/api/runs/run-1/path"],
    ];

    for (const [handler, method, route] of routes) {
      const response = await handler(context(new Request(`https://pages.example${route}`, {
        method,
        body: method === "POST" ? "{}" : undefined,
      })));
      expect(response.status, `${method} ${route}`).toBe(200);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(routes.length);
  });

  it("rejects declared and observed bodies above 16 KiB before forwarding", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ bypassed: true }));
    vi.stubGlobal("fetch", fetchImpl);
    const declared = await challenges.onRequestPost(context(new Request(
      "https://pages.example/api/challenges",
      {
        method: "POST",
        headers: { "Content-Length": String(16 * 1024 + 1) },
        body: "{}",
      },
    )));
    expect(declared.status).toBe(413);
    await expect(declared.json()).resolves.toMatchObject({
      error: { code: "body_too_large" },
    });

    const observed = await challenges.onRequestPost(context(new Request(
      "https://pages.example/api/challenges",
      { method: "POST", body: "x".repeat(16 * 1024 + 1) },
    )));
    expect(observed.status).toBe(413);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("passes canonical rate and path policy errors through unchanged", async () => {
    const responses = [
      Response.json(
        { error: { code: "click_rate_limited", message: "Slow down." } },
        { status: 429, headers: { "Retry-After": "60" } },
      ),
      Response.json(
        { error: { code: "run_path_not_found", message: "Not found." } },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      ),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => responses.shift() as Response));

    const rate = await click.onRequestPost(context(new Request(
      "https://pages.example/api/runs/run-1/click",
      { method: "POST", body: "{}" },
    )));
    expect(rate.status).toBe(429);
    expect(rate.headers.get("Retry-After")).toBe("60");

    const hiddenPath = await path.onRequestGet(context(new Request(
      "https://pages.example/api/runs/run-1/path",
    )));
    expect(hiddenPath.status).toBe(404);
    await expect(hiddenPath.json()).resolves.toMatchObject({
      error: { code: "run_path_not_found" },
    });
  });

  it("fails closed when the canonical Worker origin is missing", async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    const response = await challenges.onRequestGet(context(
      new Request("https://pages.example/api/challenges"),
      {},
    ));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "canonical_api_unconfigured" },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
