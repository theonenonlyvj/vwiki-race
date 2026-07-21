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

// Owner-approved Back ladder (item 8, addendum 2026-07-21): every history
// entry an app-driven push/replace creates beyond the very first page load
// is stamped with this marker in HISTORY STATE - never a `?mode=`/URL param
// (the council explicitly rejected that route-param design for Stats/
// Browse/You - see url-policy's "overrides") - so popstate handlers can
// tell "was this entry reached via in-app navigation" without it leaking
// into the address bar or the permanent share-link contract.
interface AppHistoryState {
  vwrInApp?: boolean;
}

function readHistoryState(): AppHistoryState {
  if (typeof window === "undefined") return {};
  const state: unknown = window.history.state;
  return state && typeof state === "object" ? (state as AppHistoryState) : {};
}

/** Whether the CURRENT history entry was reached via in-app navigation. */
export function isInAppHistoryState(): boolean {
  return readHistoryState().vwrInApp === true;
}

/**
 * Owner-approved Back ladder (item 8): pushes exactly one history entry the
 * first time the player leaves Home for any non-Home mode (bottom-nav tap,
 * or any other Home->elsewhere entry point, e.g. the yesterday recap's "see
 * full board" link) - so a single physical Back press returns to Home
 * instead of leaving the site outright. Self-guards against stack
 * pollution: once the CURRENT entry is already marked, further calls
 * replaceState instead of pushing again, so heavy Home<->non-Home nav-tap
 * round trips never grow the stack past this one level - Back from Home
 * still exits after exactly one press no matter how much bouncing happened
 * first. Rewrites the current URL verbatim (push or replace) - this never
 * changes what's in the address bar, only the history state/entry count.
 */
export function markInAppMode(): void {
  if (typeof window === "undefined") return;
  const url = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (isInAppHistoryState()) {
    window.history.replaceState({ vwrInApp: true }, "", url);
    return;
  }
  window.history.pushState({ vwrInApp: true }, "", url);
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

  // Every URL write this function makes is, by definition, at least Detail
  // depth (item 8's Back ladder) - always stamp the in-app marker (see
  // above) alongside it, regardless of push/replace, so later markInAppMode
  // guard checks (and popstate) see a consistent picture no matter which
  // function last touched history.
  if (historyMode === "replace") {
    window.history.replaceState({ vwrInApp: true }, "", nextUrl);
    return;
  }

  window.history.pushState({ vwrInApp: true }, "", nextUrl);
}

/**
 * Challenge Detail's "← Challenges" back link (migration note iv): drops
 * the `?challenge=` param so a reload/share of the URL lands back on Browse
 * instead of re-opening Detail, without touching the rest of the URL.
 *
 * Unlike syncChallengeUrl, clearing the param does NOT always mean "still
 * away from Home" - it also fires when a stale/expired param degrades
 * straight to Home (item 2) and when a bottom-nav tap leaves Detail for
 * Home itself (item 3) - so the in-app marker (item 8's Back ladder) is the
 * CALLER's call, via `markInApp`, not an automatic true. Getting this wrong
 * either way is real: stamping every clear would poison markInAppMode's
 * "already in-app" guard on an entry that's actually Home again (the next
 * real departure would wrongly replace instead of push, leaving nothing for
 * Back to land on); never stamping it would leave Browse - reached by the
 * explicit "← Challenges" close - looking like Home too (a later mode-nav
 * tap from there would wrongly push a SECOND entry on top of Detail's own
 * paired push/push round trip). Defaults to false (Home) since that's the
 * common/first-added caller (item 2's expired-param cleanup).
 */
export function clearChallengeUrl(
  historyMode: "push" | "replace" = "push",
  options?: { markInApp?: boolean },
): void {
  if (typeof window === "undefined") {
    return;
  }

  const url = new URL(window.location.href);
  if (!url.searchParams.has("challenge")) {
    return;
  }
  url.searchParams.delete("challenge");
  const nextUrl = `${url.pathname}${url.search}${url.hash}`;
  const state: AppHistoryState = options?.markInApp ? { vwrInApp: true } : {};

  if (historyMode === "replace") {
    window.history.replaceState(state, "", nextUrl);
    return;
  }

  window.history.pushState(state, "", nextUrl);
}
