// Same-origin API path (2026-07-23): production clients now call /api/* on
// their OWN origin (vwikirace.pages.dev / *.pages.dev previews) instead of
// the public vwikirace-api.theonenonlyvj.workers.dev hostname, which
// intermittently stalls from some ISPs' resolvers/paths while the pages.dev
// site itself stays fast. This catch-all claims every /api/* request that no
// more-specific retained legacy route file claims (Pages routes specific
// files like ./challenges.ts ahead of [[path]]) and forwards it to the
// canonical Worker over the VWIKI_API SERVICE BINDING - a Cloudflare-internal
// hop with no public workers.dev DNS/route on the client path.
import { proxyCanonicalApi, type Env as CanonicalProxyEnv } from "../_shared/createTrackingContext";

interface WorkerServiceBinding {
  fetch(request: Request): Promise<Response>;
}

export interface Env extends CanonicalProxyEnv {
  VWIKI_API?: WorkerServiceBinding;
}

export const onRequest: PagesFunction<Env> = (context) => {
  const { request, env } = context;
  if (env.VWIKI_API && typeof env.VWIKI_API.fetch === "function") {
    // Forward the ORIGINAL request verbatim - method, URL (the Worker
    // dispatches on new URL(request.url).pathname and ignores the hostname,
    // so the pages.dev URL passes through unchanged), headers (including
    // Authorization, Idempotency-Key, Content-Type, and the edge-stamped
    // CF-Connecting-IP the Worker's rate limiters key on), and body.
    // new Request(request) re-wraps the incoming immutable request as a
    // plain unconsumed request for the binding fetch. No response tampering:
    // the Worker's response is returned as-is.
    return env.VWIKI_API.fetch(new Request(request));
  }
  // Deploy-ordering safety net: if this Function is ever live before the
  // VWIKI_API service binding exists on the Pages project, fall back to the
  // same public-origin proxy the retained legacy routes use (the Pages-edge
  // -> workers.dev hop runs inside Cloudflare, unaffected by any client
  // ISP). proxyCanonicalApi fails closed with a 503
  // canonical_api_unconfigured when VWIKI_RACE_API_URL is missing too.
  return proxyCanonicalApi(request, env);
};
