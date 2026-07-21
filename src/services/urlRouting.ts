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
// is stamped with a LADDER DEPTH in HISTORY STATE - never a `?mode=`/URL
// param (the council explicitly rejected that route-param design for
// Stats/Browse/You - see url-policy's "overrides") - so popstate handlers
// can tell how many rungs from Home the current entry sits, without any of
// it leaking into the address bar or the permanent share-link contract.
//
// Adversarial-review fix (2026-07-21): this used to be a bare boolean
// (`vwrInApp`). A boolean can only say "in-app: yes/no" - it can't tell a
// rung whose FLOOR is Home (pushed straight off a Home departure) apart
// from a rung sitting on top of a still-live Detail entry. Both read
// "marked" under the boolean, so markInAppMode's "already marked ->
// replaceState" guard would reuse whichever rung happened to be current
// even when a stale `?challenge=` entry was buried directly beneath it.
// Confirmed repro: Home -> Challenges -> open Detail -> "<- Challenges" ->
// tap Stats -> Back reopened Challenge Detail - closeChallengeDetail used
// to PUSH a new bare entry on top of Detail's own `?challenge=` entry
// instead of collapsing it, so that entry was never popped; markInAppMode
// then replaced the pushed-on-top entry in place for the Stats tap,
// leaving the untouched `?challenge=` entry as the very next thing a
// single Back press would land on. The numeric depth alone doesn't close
// that hole - what actually fixes it is closeChallengeDetail now REPLACING
// Detail's entry in place (collapsing straight back to depth 1) instead of
// pushing a new one on top (see its own comment) - but depth is what lets
// every OTHER call site, and the popstate terminal-case chain below,
// make the right push/replace/chain call instead of guessing from a
// flattened yes/no bit.
interface AppHistoryState {
  /**
   * 0 (or absent) - Home floor, no ladder rung under the current entry.
   * 1 - one ladder rung away from Home: any non-Detail mode reached via a
   *     nav tap (Stats/Browse/You/Boards), or Detail collapsed back down
   *     on close/nav-away.
   * 2 - Detail depth: an entry carrying `?challenge=`, including a
   *     locked/recovering race pin.
   */
  vwrDepth?: number;
}

function readHistoryState(): AppHistoryState {
  if (typeof window === "undefined") return {};
  const state: unknown = window.history.state;
  return state && typeof state === "object" ? (state as AppHistoryState) : {};
}

function ladderDepth(): number {
  const depth = readHistoryState().vwrDepth;
  return typeof depth === "number" && depth > 0 ? depth : 0;
}

/** Whether the CURRENT history entry sits at some ladder depth beyond Home. */
export function isInAppHistoryState(): boolean {
  return ladderDepth() > 0;
}

/**
 * Owner-approved Back ladder (item 8): pushes exactly one depth-1 history
 * entry the first time the player leaves Home for any non-Home mode
 * (bottom-nav tap, or any other Home->elsewhere entry point, e.g. the
 * yesterday recap's "see full board" link) - so a single physical Back
 * press returns to Home instead of leaving the site outright. Self-guards
 * against stack pollution: once the CURRENT entry is already at some depth
 * beyond Home, further calls replaceState (still depth 1) instead of
 * pushing again, so heavy Home<->non-Home nav-tap round trips never grow
 * the stack past this one level. Rewrites the current URL verbatim (push
 * or replace) - this never changes what's in the address bar, only the
 * history state/entry count.
 *
 * ACCEPTED AS-IS (2026-07-21 adversarial review, no fix needed): a session
 * that starts on a share link (a single `?challenge=` entry with nothing
 * app-pushed beneath it - no prior Home departure to have pushed a rung)
 * gets browser-DEFAULT Back behavior - straight out of the site - since
 * there is no ladder rung under it at all. This matches ordinary browser
 * convention for a page's first/only history entry and is intentionally
 * left alone; the popstate terminal-case chain (App.tsx) only ever chains
 * through entries THIS module marked, never past the true floor.
 */
export function markInAppMode(): void {
  if (typeof window === "undefined") return;
  const url = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (ladderDepth() > 0) {
    window.history.replaceState({ vwrDepth: 1 }, "", url);
    return;
  }
  window.history.pushState({ vwrDepth: 1 }, "", url);
}

/**
 * Adversarial-review fix (2026-07-21, finding 1's Home-landing contributor):
 * normalizes the CURRENT history entry's ladder depth back to 0 (Home
 * floor) via replaceState, in place - never pushes. selectMode's explicit
 * "tap Home" branch calls this unconditionally so a stale depth left over
 * from whatever non-Home rung was last replaced in place (a Stats<->You
 * bounce, say) never survives landing on Home. Without this, the next
 * departure from Home would see "already at depth 1" and replaceState
 * instead of pushState, leaving nothing on the stack for THAT departure's
 * own Back press to land on - the flawed invariant the old
 * Stats<->You-round-trip test used to lock in. No-ops once already at
 * depth 0, so callers never need to read ladder state first.
 */
export function markHomeHistoryState(): void {
  if (typeof window === "undefined" || ladderDepth() === 0) return;
  const url = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  window.history.replaceState({}, "", url);
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
  // depth (item 8's Back ladder) - always stamp depth 2 alongside it,
  // regardless of push/replace, so later markInAppMode guard checks (and
  // popstate) see a consistent picture no matter which function last
  // touched history.
  if (historyMode === "replace") {
    window.history.replaceState({ vwrDepth: 2 }, "", nextUrl);
    return;
  }

  window.history.pushState({ vwrDepth: 2 }, "", nextUrl);
}

/**
 * Challenge Detail's "← Challenges" back link (migration note iv): drops
 * the `?challenge=` param so a reload/share of the URL lands back on Browse
 * instead of re-opening Detail, without touching the rest of the URL.
 *
 * Unlike syncChallengeUrl, clearing the param does NOT always mean "still
 * one rung away from Home" - it also fires when a stale/expired param
 * degrades straight to Home (item 2) and when a bottom-nav tap leaves
 * Detail for Home itself (item 3) - so the resulting ladder depth is the
 * CALLER's call, via `depth`, not an automatic 1. Getting this wrong either
 * way is real: stamping depth 1 on every clear would poison markInAppMode's
 * "already away from Home" guard on an entry that's actually Home again
 * (the next real departure would wrongly replace instead of push, leaving
 * nothing for Back to land on); always defaulting to depth 0 would leave
 * Browse - reached by the explicit "← Challenges" close - looking like Home
 * too (a later mode-nav tap from there would wrongly push a SECOND entry on
 * top of Detail's own entry instead of replacing it in place). Defaults to
 * depth 0 (Home) since that's the common/first-added caller (item 2's
 * expired-param cleanup).
 *
 * Adversarial-review fix (2026-07-21, finding 1): closeChallengeDetail is
 * the one caller that passes `historyMode: "replace"` here - it used to
 * push a fresh depth-1 entry ON TOP of Detail's own `?challenge=` entry
 * (a "clean paired push/push round trip", by the original design). That
 * left the Detail entry permanently buried one slot beneath whatever mode
 * got tapped next, since replaceState (used by every later same-depth
 * bounce) only ever rewrites the CURRENT entry, never reaches back to pop
 * one still sitting underneath it. Replacing here instead collapses
 * Detail's own entry directly into the depth-1 bare entry, so there is
 * never a dead `?challenge=` entry left for a later Back press to surface.
 */
export function clearChallengeUrl(
  historyMode: "push" | "replace" = "push",
  options?: { depth?: 0 | 1 },
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
  const state: AppHistoryState = options?.depth ? { vwrDepth: options.depth } : {};

  if (historyMode === "replace") {
    window.history.replaceState(state, "", nextUrl);
    return;
  }

  window.history.pushState(state, "", nextUrl);
}
