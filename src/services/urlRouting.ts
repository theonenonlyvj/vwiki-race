/**
 * Pure `window.location`/`window.history` helpers shared by App.tsx's
 * bootstrap and src/modes/AppShell.tsx. Extracted verbatim (plus two new
 * helpers - clearChallengeUrl, exitAdminDailiesUrl) from App.tsx as part of
 * the Increment 2 mode-shell split, so both the bootstrap (popstate/catalog
 * routing) and AppShell (admin-bypass detection) read the same source of
 * truth instead of duplicating pathname/search parsing.
 */

export function readChallengeIdFromUrl(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  return new URLSearchParams(window.location.search).get("challenge");
}

export function isAdminDailiesRoute(): boolean {
  return typeof window !== "undefined" && window.location.pathname === "/admin/dailies";
}

/**
 * The admin route's exit affordance (migration note ii: the pathname-gated
 * bypass has no fifth nav item to leave through anymore). Mirrors
 * syncAdminDailiesUrl's shape in reverse - preserves the current search/hash
 * (e.g. a `?challenge=` carried in from before the admin visit) while
 * dropping the pathname back to "/".
 */
export function exitAdminDailiesUrl(): void {
  if (typeof window === "undefined" || !isAdminDailiesRoute()) {
    return;
  }
  const url = new URL(window.location.href);
  url.pathname = "/";
  window.history.pushState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

export function syncChallengeUrl(
  challengeId: string,
  historyMode: "push" | "replace" = "push",
): void {
  if (typeof window === "undefined" || !challengeId) {
    return;
  }

  if (isAdminDailiesRoute()) {
    return;
  }

  const url = new URL(window.location.href);
  url.searchParams.set("challenge", challengeId);
  const nextUrl = `${url.pathname}${url.search}${url.hash}`;
  const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (nextUrl === currentUrl) {
    return;
  }

  if (historyMode === "replace") {
    window.history.replaceState({}, "", nextUrl);
    return;
  }

  window.history.pushState({}, "", nextUrl);
}

/**
 * Challenge Detail's "← Challenges" back link (migration note iv): drops
 * the `?challenge=` param so a reload/share of the URL lands back on Browse
 * instead of re-opening Detail, without touching the rest of the URL.
 */
export function clearChallengeUrl(historyMode: "push" | "replace" = "push"): void {
  if (typeof window === "undefined") {
    return;
  }

  const url = new URL(window.location.href);
  if (!url.searchParams.has("challenge")) {
    return;
  }
  url.searchParams.delete("challenge");
  const nextUrl = `${url.pathname}${url.search}${url.hash}`;

  if (historyMode === "replace") {
    window.history.replaceState({}, "", nextUrl);
    return;
  }

  window.history.pushState({}, "", nextUrl);
}
