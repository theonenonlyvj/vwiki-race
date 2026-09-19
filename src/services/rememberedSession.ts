import type { VGamesIdentitySession } from "./vgamesIdentity";

class SessionUnavailable extends Error {
  constructor() { super("Couldn't keep you signed in. Please try again."); }
}
function sessionChanged(): Response {
  return Response.json({error:{code:"session_changed",message:"Your account changed. Please try again."}}, {status:409});
}
function isSession(value: unknown): value is VGamesIdentitySession {
  const s = value as Partial<VGamesIdentitySession> | null;
  return Boolean(s && typeof s.accountId === "string" && s.accountId && typeof s.token === "string" && s.token &&
    typeof s.displayName === "string" && (s.status === "claimed" || s.status === "ghost"));
}

/** Same-origin cookie renewal. Only explicit bearer-authenticated game requests
 * participate; a different account can never inherit an in-flight action. */
export function createRememberedSessionManager(options: {
  apiOrigin: string;
  fetchImpl: typeof fetch;
  getSession: () => VGamesIdentitySession | null;
  onSession: (session: VGamesIdentitySession) => void;
}) {
  const origin = options.apiOrigin.replace(/\/$/, "");
  let generation = 0;
  let stopped = false;
  let refreshMissing = false;
  let renewing: Promise<VGamesIdentitySession | null> | null = null;
  let writes: Promise<unknown> = Promise.resolve();
  const knownTokens = new Set<string>();

  async function call(suffix: string, token?: string): Promise<VGamesIdentitySession | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await options.fetchImpl(`${origin}/api/v2/identity/session${suffix}`, {
        method: "POST", credentials: "same-origin", headers: {"Content-Type": "application/json", ...(token ? {Authorization: `Bearer ${token}`} : {})},
        body: "{}", signal: controller.signal,
      });
      if (response.status === 401) return null;
      if (!response.ok) throw new SessionUnavailable();
      if (suffix === "/logout") return null;
      const session: unknown = await response.json();
      if (!isSession(session)) throw new SessionUnavailable();
      return session;
    } catch { throw new SessionUnavailable(); }
    finally { clearTimeout(timeout); }
  }
  function apply(session: VGamesIdentitySession, expected: string | undefined, version: number): VGamesIdentitySession | null {
    if (stopped || version !== generation || (expected && session.accountId !== expected)) return null;
    const current = options.getSession();
    if (current && current.accountId !== session.accountId) return null;
    if (current) knownTokens.add(current.token);
    knownTokens.add(session.token);
    const remembered = { ...session, remembered: true };
    options.onSession(remembered);
    return remembered;
  }
  function restore(expectedAccountId?: string): Promise<VGamesIdentitySession | null> {
    if (stopped) return Promise.resolve(null);
    if (renewing) return renewing;
    const version = generation;
    renewing = call("/refresh").then(session => {
      refreshMissing = session === null;
      return session ? apply(session, expectedAccountId, version) : null;
    })
      .finally(() => { renewing = null; });
    return renewing;
  }
  function remember(session: VGamesIdentitySession): Promise<VGamesIdentitySession> {
    const version = ++generation;
    stopped = false;
    const previous = writes;
    const pendingRenewal = renewing;
    writes = Promise.allSettled([previous, ...(pendingRenewal ? [pendingRenewal] : [])]).then(async () => {
      if (version !== generation || stopped) throw new SessionUnavailable();
      const fresh = await call("", session.token);
      if (!fresh || fresh.accountId !== session.accountId || version !== generation || stopped) throw new SessionUnavailable();
      knownTokens.clear(); knownTokens.add(session.token); knownTokens.add(fresh.token);
      return { ...fresh, remembered: true };
    });
    return writes as Promise<VGamesIdentitySession>;
  }
  async function bootstrap(): Promise<void> {
    const version = generation;
    const cached = options.getSession();
    const result = await restore(cached?.accountId);
    if (!result && refreshMissing && cached && !cached.remembered && version === generation && !stopped && options.getSession()?.token === cached.token) {
      const fresh = await remember(cached);
      if (options.getSession()?.token === cached.token) apply(fresh, cached.accountId, generation);
    }
  }
  async function logout(): Promise<boolean> {
    const version = ++generation;
    stopped = true; knownTokens.clear();
    const previous = writes;
    const pendingRenewal = renewing;
    const operation = Promise.allSettled([previous, ...(pendingRenewal ? [pendingRenewal] : [])]).then(async () => {
      if (version !== generation) return false;
      try { await call("/logout"); }
      catch (error) { if (version === generation) stopped = false; throw error; }
      return version === generation;
    });
    writes = operation;
    return operation;
  }
  const managedFetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const originalToken = headers.get("Authorization")?.replace(/^Bearer /i, "");
    const current = options.getSession();
    const eligible = !stopped && new URL(url, origin).origin === origin && new URL(url, origin).pathname.startsWith("/api/v2/") &&
      !new URL(url, origin).pathname.startsWith("/api/v2/identity/") && Boolean(current && originalToken &&
      (originalToken === current.token || knownTokens.has(originalToken)));
    const gameRequest = new URL(url, origin).origin === origin && new URL(url, origin).pathname.startsWith("/api/v2/") &&
      !new URL(url, origin).pathname.startsWith("/api/v2/identity/");
    if (gameRequest && originalToken && !eligible) return sessionChanged();
    if (!eligible || !current) return options.fetchImpl(input, init);
    const retryInput = input instanceof Request ? input.clone() : input;
    headers.set("Authorization", `Bearer ${current.token}`);
    const requestInit = {...init, headers};
    const response = await options.fetchImpl(input, requestInit);
    if (stopped || options.getSession()?.accountId !== current.accountId) return sessionChanged();
    if (response.status !== 401) return response;
    try {
      // Another request may have finished renewal before this 401 arrived.
      const latest = options.getSession();
      const renewed = latest && latest.accountId === current.accountId && latest.token !== current.token
        ? latest : await restore(current.accountId);
      if (stopped || options.getSession()?.accountId !== current.accountId) return sessionChanged();
      if (!renewed) return response;
      headers.set("Authorization", `Bearer ${renewed.token}`);
      const retried = await options.fetchImpl(retryInput as Parameters<typeof fetch>[0], {...init, headers});
      return stopped || options.getSession()?.accountId !== current.accountId ? sessionChanged() : retried;
    } catch {
      // An outage must not trigger the app's deliberate 401 session teardown.
      return Response.json({error:{code:"session_unavailable",message:"Couldn't reconnect right now. Try again."}}, {status:503});
    }
  };
  function invalidate() { generation += 1; stopped = true; knownTokens.clear(); }
  return { fetch: managedFetch, restore, remember, bootstrap, logout, invalidate };
}


/** A cross-tab account change must exit the old account's race. Same-account
 * access-token renewal is harmless and must not interrupt play. */
export function handleIdentityStorageChange(event: Pick<StorageEvent, "key" | "newValue">, actions: {
  getSession: () => VGamesIdentitySession | null;
  invalidate: () => void;
  reload: () => void;
}): void {
  const logout = event.key === "vwiki-race:remembered-logged-out" && event.newValue === "true";
  const sessionChanged = event.key === "vwiki-race:vgames-session" || event.key === null;
  if (!logout && !sessionChanged) return;
  if (logout || event.newValue === null) { actions.invalidate(); actions.reload(); return; }
  let incoming: Partial<VGamesIdentitySession> | null;
  try { incoming = JSON.parse(event.newValue); } catch { return; }
  const current = actions.getSession();
  if (incoming?.accountId === current?.accountId && incoming?.status === current?.status) return;
  actions.invalidate(); actions.reload();
}
