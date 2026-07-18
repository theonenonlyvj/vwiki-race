import type { AccountStats } from "./types";

/**
 * First-visit teaching gate (UX redesign spec, Home §First-visit teaching
 * gate; migration note iii). Whether the rules strip shows is derived
 * entirely from server-tracked account stats - never device-local storage -
 * so it fires correctly for a brand-new guest on any device/browser and
 * disappears the instant the account's first race is recorded anywhere.
 * `null` covers both "stats haven't loaded yet" and "no account exists yet"
 * (a guest with no session at all has nothing to fetch) - both read as "the
 * gate shows," matching "Guests with no account yet = no stats = gate
 * shows."
 */
export function shouldShowTeachingGate(stats: AccountStats | null): boolean {
  return (stats?.totals.completed ?? 0) <= 0;
}
