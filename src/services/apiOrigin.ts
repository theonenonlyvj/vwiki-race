export interface ResolveApiOriginOptions {
  production?: boolean;
  /** The web origin the app is currently served from. Defaults to the live
   *  browser location's origin; injectable for tests. Pass null to model a
   *  context with no location (for example Node build-time validation),
   *  which resolves to the legacy Worker origin. */
  locationOrigin?: string | null;
}

/** The canonical Worker's public origin - the pre-2026-07-23 default the
 *  client called directly. Kept as the production fallback for any host that
 *  is NOT a *.pages.dev deployment (and therefore has no /api/* Pages
 *  Function in front of it), and as the rollback path: the Worker stays live
 *  on this origin with unchanged CORS, so builds pinned here keep working. */
export const LEGACY_WORKER_API_ORIGIN = "https://vwikirace-api.theonenonlyvj.workers.dev";

export function resolveApiOrigin(
  value: string | undefined,
  options: ResolveApiOriginOptions = {},
): string {
  const configured = (value ?? "").trim();

  if (!configured) {
    if (!options.production) {
      return "";
    }
    // Same-origin first (2026-07-23): on any *.pages.dev deployment the
    // production client calls /api/* on its OWN origin, where the Pages
    // Function catch-all forwards to the Worker over a service binding -
    // the public workers.dev hostname (which some ISPs intermittently
    // stall on) never appears on the client path. The origin stays
    // ABSOLUTE (the page's own origin, not ""), preserving requestJson's
    // absolute-URL invariant. Everywhere else - custom hosts, local
    // previews of the production bundle, build-time validation in Node -
    // falls back to the legacy Worker origin.
    return sameOriginApiOrigin(options) ?? LEGACY_WORKER_API_ORIGIN;
  }
  const origin = readCanonicalApiOrigin(configured, !options.production);
  if (!origin) {
    throw new Error(
      options.production
        ? "VITE_VWIKI_RACE_API_URL must be a configured HTTPS Worker origin for production builds."
        : "VITE_VWIKI_RACE_API_URL must be a canonical HTTPS or loopback HTTP origin.",
    );
  }

  return origin;
}

function sameOriginApiOrigin(options: ResolveApiOriginOptions): string | null {
  const candidate = options.locationOrigin !== undefined
    ? options.locationOrigin
    : globalThis.location?.origin ?? null;
  if (!candidate) {
    return null;
  }
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" && isPagesDevHostname(url.hostname)
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

function isPagesDevHostname(hostname: string): boolean {
  // endsWith(".pages.dev") requires the label boundary dot, so the bare
  // "pages.dev" apex and lookalikes such as "evilpages.dev" both miss.
  return hostname.endsWith(".pages.dev");
}

function readCanonicalApiOrigin(value: string, allowLoopbackHttp: boolean): string | null {
  try {
    const url = new URL(value);
    const validProtocol = url.protocol === "https:" ||
      (allowLoopbackHttp && url.protocol === "http:" && isLoopback(url.hostname));
    const valid = validProtocol &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      (value === url.origin || value === `${url.origin}/`);
    return valid ? url.origin : null;
  } catch {
    return null;
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
