import { describe, expect, it, vi } from "vitest";
import { createRememberedSessionManager, handleIdentityStorageChange } from "./rememberedSession";
import type { VGamesIdentitySession } from "./vgamesIdentity";
const old: VGamesIdentitySession = { accountId: "a", displayName: "Alice", status: "claimed", token: "old" };
const renewed = { ...old, token: "renewed" };
function setup(fetcher: typeof fetch) {
  let current: VGamesIdentitySession | null = old;
  const onSession = vi.fn((s: VGamesIdentitySession) => {current = s;});
  const manager = createRememberedSessionManager({ fetchImpl: fetcher, apiOrigin: "https://game.test", getSession: () => current, onSession });
  return {manager, onSession};
}
it("renews once for concurrent unauthorized reads and retries with fresh token", async () => {
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    if (String(input).endsWith("/refresh")) return Response.json(renewed);
    return new Response("{}", {status: new Headers(init?.headers).get("Authorization") === "Bearer renewed" ? 200 : 401});
  });
  const {manager,onSession}=setup(fetcher);
  const responses = await Promise.all([1,2].map(() => manager.fetch("https://game.test/api/v2/account/stats", {headers:{Authorization:"Bearer old"}})));
  expect(responses.map(r=>r.status)).toEqual([200,200]);
  expect(fetcher.mock.calls.filter(([url])=>String(url).endsWith("/refresh"))).toHaveLength(1);
  expect(onSession).toHaveBeenCalledOnce();
});
it("keeps a temporary refresh failure from looking like a logout", async () => {
  const fetcher = vi.fn<typeof fetch>(async input => new Response("{}",{status:String(input).endsWith("/refresh")?503:401}));
  const {manager,onSession}=setup(fetcher);
  expect((await manager.fetch("https://game.test/api/v2/runs/active",{headers:{Authorization:"Bearer old"}})).status).toBe(503);
  expect(onSession).not.toHaveBeenCalled();
});
it("does not replay a request under a different account", async () => {
  const fetcher = vi.fn<typeof fetch>(async input=>String(input).endsWith("/refresh")?Response.json({...renewed,accountId:"b"}):new Response("{}",{status:401}));
  const {manager,onSession}=setup(fetcher);
  expect((await manager.fetch("https://game.test/api/v2/runs/start",{method:"POST",headers:{Authorization:"Bearer old"},body:"{}"})).status).toBe(401);
  expect(onSession).not.toHaveBeenCalled();
});
it("preserves the idempotency key and request body during an action retry", async () => {
  const fetcher=vi.fn<typeof fetch>(async (input,init)=>String(input).endsWith("/refresh")?Response.json(renewed):new Response("{}",{status:new Headers(init?.headers).get("Authorization")==="Bearer renewed"?200:401}));
  const {manager}=setup(fetcher);
  await manager.fetch("https://game.test/api/v2/runs/start",{method:"POST",headers:{Authorization:"Bearer old","Idempotency-Key":"same-key"},body:'{"challengeId":"x"}'});
  const final=fetcher.mock.calls.at(-1)![1]!;
  expect(new Headers(final.headers).get("Idempotency-Key")).toBe("same-key");
  expect(final.body).toBe('{"challengeId":"x"}');
});
it("does not apply a late renewal after logout", async () => {
  let resolve!: (r:Response)=>void;
  const fetcher=vi.fn<typeof fetch>(async input=>String(input).endsWith("/refresh")?new Promise(r=>{resolve=r;}):Response.json({ok:true}));
  const {manager,onSession}=setup(fetcher);
  const restoring=manager.restore("a");
  const logout=manager.logout();
  resolve(Response.json(renewed));
  await Promise.all([restoring,logout]);
  expect(onSession).not.toHaveBeenCalled();
});
it("does not send credentials to an unrelated origin", async () => {
  const fetcher=vi.fn<typeof fetch>(async()=>new Response("{}",{status:401}));
  const {manager}=setup(fetcher);
  await manager.fetch("https://other.test/api/v2/runs/start",{headers:{Authorization:"Bearer old"}});
  expect(fetcher).toHaveBeenCalledOnce();
});
it("does not silently re-enroll a previously remembered session after expiry", async () => {
  const fetcher=vi.fn<typeof fetch>(async()=>new Response("{}",{status:401}));
  const manager=createRememberedSessionManager({fetchImpl:fetcher,apiOrigin:"https://game.test",getSession:()=>({...old,remembered:true}),onSession:vi.fn()});
  await manager.bootstrap();
  expect(fetcher).toHaveBeenCalledOnce();
});
it("does not replace another tab's account cookie during bootstrap", async () => {
  const fetcher=vi.fn<typeof fetch>(async()=>Response.json({...renewed,accountId:"b"}));
  const {manager,onSession}=setup(fetcher);
  await manager.bootstrap();
  expect(fetcher).toHaveBeenCalledOnce(); expect(onSession).not.toHaveBeenCalled();
});
it.each([200,401])("suppresses late account-A responses after switching to B (status %s)", async status => {
  let current: VGamesIdentitySession | null = old;
  let resolve!: (r:Response)=>void;
  const fetcher=vi.fn<typeof fetch>(async()=>new Promise(r=>{resolve=r;}));
  const manager=createRememberedSessionManager({fetchImpl:fetcher,apiOrigin:"https://game.test",getSession:()=>current,onSession:s=>{current=s;}});
  const pending=manager.fetch("https://game.test/api/v2/runs/active",{headers:{Authorization:"Bearer old"}});
  current={...old,accountId:"b",token:"b-token"};
  resolve(Response.json({account:"a"},{status}));
  expect((await pending).status).toBe(409);
  expect(current.accountId).toBe("b"); expect(fetcher).toHaveBeenCalledOnce();
});
it("waits for an old renewal before establishing another account's cookie", async () => {
  let resolve!: (r:Response)=>void;
  const fetcher=vi.fn<typeof fetch>(async input=>String(input).endsWith("/refresh")?new Promise(r=>{resolve=r;}):Response.json({...renewed,accountId:"b"}));
  const {manager,onSession}=setup(fetcher);
  const restore=manager.restore("a");
  const remember=manager.remember({...old,accountId:"b"});
  await Promise.resolve(); expect(fetcher).toHaveBeenCalledOnce();
  resolve(Response.json(renewed));
  await restore; expect((await remember).accountId).toBe("b");
  expect(onSession).not.toHaveBeenCalled();
});
it("does not let an earlier logout clear a later explicit login", async () => {
  let resolve!: (r:Response)=>void;
  const fetcher=vi.fn<typeof fetch>(async input=>String(input).endsWith("/logout")?new Promise(r=>{resolve=r;}):Response.json({...renewed,accountId:"b"}));
  const {manager}=setup(fetcher);
  const logout=manager.logout();
  await vi.waitFor(()=>expect(fetcher).toHaveBeenCalledOnce());
  const login=manager.remember({...old,accountId:"b"});
  resolve(Response.json({ok:true}));
  expect(await logout).toBe(false);
  expect((await login).accountId).toBe("b");
});
it("invalidation from another tab prevents late session restoration", async () => {
  let resolve!: (r:Response)=>void;
  const fetcher=vi.fn<typeof fetch>(async()=>new Promise(r=>{resolve=r;}));
  const {manager,onSession}=setup(fetcher);
  const restore=manager.restore("a"); manager.invalidate();
  resolve(Response.json(renewed)); await restore;
  expect(onSession).not.toHaveBeenCalled();
});

it.each([
  {key:"vwiki-race:remembered-logged-out",newValue:"true"},
  {key:"vwiki-race:vgames-session",newValue:null},
])("exits the old tab on logout even when the repository already hides its session", event => {
  const actions={getSession:()=>null,invalidate:vi.fn(),reload:vi.fn()};
  handleIdentityStorageChange(event,actions);
  expect(actions.invalidate).toHaveBeenCalledOnce(); expect(actions.reload).toHaveBeenCalledOnce();
});
it("reloads on an external account switch but not a same-account renewal", () => {
  const actions={getSession:()=>old,invalidate:vi.fn(),reload:vi.fn()};
  handleIdentityStorageChange({key:"vwiki-race:vgames-session",newValue:JSON.stringify(renewed)},actions);
  expect(actions.reload).not.toHaveBeenCalled();
  handleIdentityStorageChange({key:"vwiki-race:vgames-session",newValue:JSON.stringify({...renewed,accountId:"b"})},actions);
  expect(actions.reload).toHaveBeenCalledOnce();
});
