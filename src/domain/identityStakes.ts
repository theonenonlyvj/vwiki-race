import type { AccountStats } from "./types";
import type { VGamesIdentitySession } from "../services/vgamesIdentity";

/**
 * "Honest You" (Option B, hardened) - the one new domain module for the
 * account-UX package (spec: acct-option-b.json). Two predicates, both pure.
 *
 * `guestHasStakes` answers "does this guest session have something to
 * lose?" - used for ambient chrome (the nav dot, §3) that should stay
 * silent unless we POSITIVELY know there's a real streak/attempt count to
 * protect. `ghostGuardRequired` answers the fail-safe question for the
 * destructive-path guard (§2.2/§2.3): while stats are unresolved we cannot
 * prove the ghost is stakes-free, so the guard fires anyway.
 *
 * Note (judge amendment, 2026-07-20): `mostVisited` (formerly also
 * `topStarts`/`topTargets`, dropped when the profile page collapsed to one
 * "Most visited pages" list) is populated from ungated `owner_runs`
 * server-side (no
 * MIN_COUNTED_DNF_CLICKS filter - d1TrackingRepository.ts ~2965-2977), so a
 * ghost can carry real-looking browse history even when `attempts === 0`.
 * That's consistent with the existing FB-7 ruling that a sub-threshold run
 * is a "non-attempt" - `guestHasStakes`/`ghostGuardRequired` intentionally
 * key off `totals.attempts`/`dailyStreak` only, not "this ghost has zero
 * data of any kind."
 */

/** True only when we POSITIVELY know this guest session has something to lose.
 * `stats.totals.attempts` is already FB-7-gated server-side (completed runs +
 * abandoned runs with click_count >= MIN_COUNTED_DNF_CLICKS - see
 * d1TrackingRepository.ts ~line 2950), so "counted run" needs no client math.
 * dailyStreak > 0 is belt-and-suspenders (a streak implies a counted run). */
export function guestHasStakes(
  session: VGamesIdentitySession | null,
  stats: AccountStats | null,
): boolean {
  return session?.status === "ghost" && stats !== null &&
    (stats.totals.attempts > 0 || stats.dailyStreak > 0);
}

/** Fail-safe variant for the destructive-path guard: while stats are
 * UNRESOLVED (App.tsx's accountStats is null during load AND on fetch error -
 * see accountStatsProjection, App.tsx ~lines 380-383 and 645-654) we cannot
 * prove the ghost is stakes-free, so the guard fires. Warning a stakes-free
 * guest once is cheap; silently orphaning a real streak is the confirmed
 * data-loss trap this whole package exists to close. */
export function ghostGuardRequired(
  session: VGamesIdentitySession | null,
  stats: AccountStats | null,
): boolean {
  return session?.status === "ghost" &&
    (stats === null || guestHasStakes(session, stats));
}
