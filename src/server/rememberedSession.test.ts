import { describe, expect, it, vi } from "vitest";
import { handleRememberedSession } from "./rememberedSession";

const origin = "https://vwikirace.pages.dev";
const cookie = "__Host-vwiki-session=" + "a".repeat(43);
function request(path = "/refresh", headers: Record<string, string> = {}) {
  return new Request(origin + "/api/v2/identity/session" + path, {
    method: "POST", headers: { Origin: origin, Cookie: cookie, ...headers }, body: "{}",
  });
}
function env(status = 200) {
  return { VGAMES_SESSIONS: { fetch: vi.fn(async (_request: Request) => new Response(JSON.stringify(status === 200 ? {
    accountId: "account", displayName: "Player", status: "claimed", token: "access-token",
    session: "b".repeat(43), maxAgeSeconds: 2592000,
  } : { error: "unauthorized" }), { status })) } };
}
describe("remembered session proxy", () => {
  it("keeps the renewal credential in an HttpOnly cookie, never response JSON", async () => {
    const e = env(); const res = await handleRememberedSession(request(), e);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accountId: "account", displayName: "Player", status: "claimed", token: "access-token" });
    expect(res.headers.get("Set-Cookie")).toContain("HttpOnly; Secure; SameSite=Lax");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const upstream = e.VGAMES_SESSIONS.fetch.mock.calls[0][0] as Request;
    expect(await upstream.json()).toEqual({ session: "a".repeat(43) });
  });
  it("rejects cross-origin and missing-origin requests before upstream", async () => {
    for (const originValue of ["https://example.org", "null", ""]) {
      const e = env();
      expect((await handleRememberedSession(request("/refresh", {Origin: originValue}), e)).status).toBe(403);
      expect(e.VGAMES_SESSIONS.fetch).not.toHaveBeenCalled();
    }
  });
  it("requires a bearer token to establish persistence", async () => {
    const e = env();
    expect((await handleRememberedSession(request(""), e)).status).toBe(401);
    expect(e.VGAMES_SESSIONS.fetch).not.toHaveBeenCalled();
  });
  it("clears an invalid cookie but preserves it on temporary upstream failure", async () => {
    expect((await handleRememberedSession(request(), env(401))).headers.get("Set-Cookie")).toContain("Max-Age=0");
    const res = await handleRememberedSession(request(), env(503));
    expect(res.status).toBe(503); expect(res.headers.has("Set-Cookie")).toBe(false);
  });
  it("requires upstream logout confirmation before clearing the cookie", async () => {
    expect((await handleRememberedSession(request("/logout"), env())).headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect((await handleRememberedSession(request("/logout"), env(503))).headers.has("Set-Cookie")).toBe(false);
  });
});

import { createWorker, type Env, type WorkerTracking } from "./worker";
it("routes session renewal through the Worker and its identity rate limiter", async () => {
  const e = {...env(), IDENTITY_RATE_LIMITER:{limit:vi.fn(async()=>({success:true}))}} as unknown as Env;
  const worker = createWorker({createTracking:()=>({} as WorkerTracking)});
  expect((await worker.fetch(request(),e)).status).toBe(200);
  expect(e.IDENTITY_RATE_LIMITER!.limit).toHaveBeenCalled();
  e.IDENTITY_RATE_LIMITER!.limit=vi.fn(async()=>({success:false}));
  expect((await worker.fetch(request(),e)).status).toBe(429);
});
it("keeps session mutation closed in maintenance mode", async () => {
  const upstream=env();
  const e={...upstream,MAINTENANCE_MODE:"true"} as unknown as Env;
  const worker=createWorker({createTracking:()=>({} as WorkerTracking)});
  expect((await worker.fetch(request(),e)).status).toBe(503);
  expect(upstream.VGAMES_SESSIONS.fetch).not.toHaveBeenCalled();
});
