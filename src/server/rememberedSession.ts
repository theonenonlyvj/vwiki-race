const COOKIE = "__Host-vwiki-session";
const MAX_IDLE_SECONDS = 30 * 24 * 60 * 60;

type SessionEnv = { VGAMES_SESSIONS?: { fetch(request: Request): Promise<Response> } };
function reply(body: unknown, status: number, cookie?: string): Response {
  return new Response(JSON.stringify(body), { status, headers: {
    "Content-Type": "application/json", "Cache-Control": "no-store",
    ...(cookie ? { "Set-Cookie": cookie } : {}),
  } });
}
function sessionCookie(value: string, maxAge: number): string {
  return `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}
function failure(status: number, clear = false): Response {
  return reply({ error: { code: status === 401 ? "unauthorized" : "session_unavailable",
    message: status === 401 ? "Please log in again." : "Couldn't reconnect right now. Try again." } },
  status, clear ? sessionCookie("", 0) : undefined);
}

/** Cookie authentication is confined to these same-origin POST endpoints.
 * Game endpoints continue to require their normal explicit bearer token. */
export async function handleRememberedSession(request: Request, env: SessionEnv): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "POST" || request.headers.get("Origin") !== url.origin ||
      request.headers.get("Sec-Fetch-Site") === "cross-site") return failure(403);
  const suffix = url.pathname.slice("/api/v2/identity/session".length);
  if (!["", "/refresh", "/logout"].includes(suffix)) return failure(404);
  const matches = (request.headers.get("Cookie") ?? "").split(";").map(v => v.trim())
    .filter(v => v.startsWith(`${COOKIE}=`));
  const secret = matches.length === 1 ? matches[0].slice(COOKIE.length + 1) : "";
  const session = /^[A-Za-z0-9_-]{43}$/.test(secret) ? secret : "";
  const bearer = request.headers.get("Authorization");
  if (!suffix && !/^Bearer \S+$/i.test(bearer ?? "")) return failure(401);
  if (suffix && !session) return suffix === "/logout" ? reply({ ok: true }, 200, sessionCookie("", 0)) : failure(401, true);
  if (!env.VGAMES_SESSIONS) return failure(503);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await env.VGAMES_SESSIONS.fetch(new Request(`https://identity.internal/auth/session${suffix}`, {
      method: "POST", headers: { "Content-Type": "application/json", ...(!suffix ? { Authorization: bearer! } : {}) },
      body: JSON.stringify(suffix ? { session } : { ...(session ? { previousSession: session } : {}) }),
      signal: controller.signal,
    }));
    if (!response.ok) return failure(response.status === 401 ? 401 : 503, response.status === 401);
    if (suffix === "/logout") return reply({ ok: true }, 200, sessionCookie("", 0));
    const value = await response.json() as Record<string, unknown>;
    if (typeof value.accountId !== "string" || !value.accountId || typeof value.displayName !== "string" ||
        !["claimed", "ghost"].includes(String(value.status)) || typeof value.token !== "string" || !value.token ||
        typeof value.session !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.session) ||
        typeof value.maxAgeSeconds !== "number" || !Number.isFinite(value.maxAgeSeconds) || value.maxAgeSeconds <= 0) return failure(502);
    return reply({ accountId: value.accountId, displayName: value.displayName, status: value.status, token: value.token }, 200,
      sessionCookie(value.session, Math.min(MAX_IDLE_SECONDS, Math.floor(value.maxAgeSeconds))));
  } catch { return failure(503); }
  finally { clearTimeout(timeout); }
}
