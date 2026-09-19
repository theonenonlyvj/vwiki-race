import { describe, expect, it, vi } from "vitest";
import type { AuthorizedAccount } from "../domain/types";
import { createWorker, type Env, type WorkerTracking } from "./worker";

const ADMIN_ID = "owner-account";
const ORIGIN = "https://vwikirace.pages.dev";

function tracking(account: AuthorizedAccount = {
  accountId: ADMIN_ID,
  displayName: "Owner",
  status: "claimed",
  aliases: [],
}): WorkerTracking {
  return {
    authorize: vi.fn(async () => account),
  } as unknown as WorkerTracking;
}

function baseEnv(bindingFetch: ReturnType<typeof vi.fn>, overrides: Partial<Env> = {}): Env {
  return {
    VWIKI_RACE_DB: {} as D1Database,
    VGAMES_URL: "https://identity.example",
    VGAMES_SESSIONS: { fetch: bindingFetch },
    ALLOWED_ORIGINS: ORIGIN,
    DAILY_ADMIN_ACCOUNT_IDS: ADMIN_ID,
    CLICK_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
    ACCOUNT_READ_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
    DAILY_ADMIN_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
    PASSWORD_RESET_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
    ...overrides,
  } as Env;
}

function request(path: string, body: unknown, bearer = "access-token", origin = ORIGIN): Request {
  return new Request(`https://api.example${path}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${bearer}`,
      "Content-Type": "application/json",
      "Origin": origin,
      "CF-Connecting-IP": "203.0.113.9",
    },
    body: JSON.stringify(body),
  });
}

describe("VWiki password recovery routes", () => {
  it("lets only an existing Daily owner issue a reset and records that account as actor", async () => {
    const bindingFetch = vi.fn(async (input: RequestInfo | URL) => {
      const internal = input as Request;
      expect(new URL(internal.url).pathname).toBe("/auth/password-reset/issue");
      expect(await internal.json()).toEqual({ username: "casey", actor: `vwiki:${ADMIN_ID}` });
      return Response.json({
        accountId: "target-account",
        username: "casey",
        resetToken: "r".repeat(43),
        maxAgeSeconds: 604_800,
      });
    });
    const worker = createWorker({ createTracking: () => tracking() });

    const response = await worker.fetch(
      request("/api/v2/admin/password-resets", { username: "Casey" }),
      baseEnv(bindingFetch),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      username: "casey",
      resetToken: "r".repeat(43),
      maxAgeSeconds: 604_800,
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rejects a claimed non-owner before calling the identity binding", async () => {
    const bindingFetch = vi.fn();
    const worker = createWorker({
      createTracking: () => tracking({
        accountId: "non-owner",
        displayName: "Player",
        status: "claimed",
        aliases: [],
      }),
    });

    const response = await worker.fetch(
      request("/api/v2/admin/password-resets", { username: "casey" }),
      baseEnv(bindingFetch),
    );

    expect(response.status).toBe(403);
    expect(bindingFetch).not.toHaveBeenCalled();
  });

  it("consumes a reset through the private binding and applies the IP rate limit", async () => {
    const bindingFetch = vi.fn(async (input: RequestInfo | URL) => {
      const internal = input as Request;
      expect(new URL(internal.url).pathname).toBe("/auth/password-reset/consume");
      expect(await internal.json()).toEqual({ token: "t".repeat(43), password: "new-password" });
      return Response.json({ ok: true });
    });
    const limit = vi.fn(async () => ({ success: true }));
    const worker = createWorker({ createTracking: () => tracking() });

    const response = await worker.fetch(
      request("/api/v2/identity/password-reset", {
        token: "t".repeat(43),
        password: "new-password",
      }, "unused"),
      baseEnv(bindingFetch, { PASSWORD_RESET_RATE_LIMITER: { limit } }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(limit).toHaveBeenCalledWith({ key: "203.0.113.9" });
  });

  it("fails closed when the reset limiter is missing or rejects the request", async () => {
    const bindingFetch = vi.fn();
    const worker = createWorker({ createTracking: () => tracking() });
    const body = { token: "t".repeat(43), password: "new-password" };

    const missing = await worker.fetch(
      request("/api/v2/identity/password-reset", body),
      baseEnv(bindingFetch, { PASSWORD_RESET_RATE_LIMITER: undefined }),
    );
    expect(missing.status).toBe(503);

    const rejected = await worker.fetch(
      request("/api/v2/identity/password-reset", body),
      baseEnv(bindingFetch, {
        PASSWORD_RESET_RATE_LIMITER: { limit: vi.fn(async () => ({ success: false })) },
      }),
    );
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get("Retry-After")).toBe("60");
    expect(bindingFetch).not.toHaveBeenCalled();
  });

  it("rejects untrusted origins and malformed bodies without forwarding secrets", async () => {
    const bindingFetch = vi.fn();
    const worker = createWorker({ createTracking: () => tracking() });
    const env = baseEnv(bindingFetch);

    const wrongOrigin = await worker.fetch(
      request("/api/v2/identity/password-reset", {
        token: "t".repeat(43),
        password: "new-password",
      }, "unused", "https://evil.example"),
      env,
    );
    expect(wrongOrigin.status).toBe(403);

    for (const body of [null, [], { token: "short", password: "new-password" }, {
      token: "t".repeat(43), password: "short",
    }]) {
      const malformed = await worker.fetch(
        request("/api/v2/identity/password-reset", body),
        env,
      );
      expect(malformed.status).toBe(400);
    }
    expect(bindingFetch).not.toHaveBeenCalled();
  });

  it("maps an invalid or expired identity token to one generic public error", async () => {
    const bindingFetch = vi.fn(async () => Response.json(
      { error: "invalid_or_expired_reset" },
      { status: 400 },
    ));
    const worker = createWorker({ createTracking: () => tracking() });

    const response = await worker.fetch(
      request("/api/v2/identity/password-reset", {
        token: "t".repeat(43),
        password: "new-password",
      }),
      baseEnv(bindingFetch),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "invalid_or_expired_reset",
        message: "That reset link is invalid or has expired.",
      },
    });
  });

  it("accepts the configured Pages origin on the direct Worker fallback", async () => {
    const bindingFetch = vi.fn(async () => Response.json({ ok: true }));
    const worker = createWorker({ createTracking: () => tracking() });
    const fallbackRequest = request("/api/v2/identity/password-reset", {
      token: "t".repeat(43),
      password: "new-password",
    });
    fallbackRequest.headers.set("Sec-Fetch-Site", "cross-site");

    const response = await worker.fetch(fallbackRequest, baseEnv(bindingFetch));

    expect(response.status).toBe(200);
  });
});
