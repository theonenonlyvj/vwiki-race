# 2026-07-15 Overnight — council critique + fixes landed on this branch

**Context for the next agent (or the in-flight Codex session).** A 36-agent council reviewed the
whole VGames estate (accounts, stats, competitiveness, unified plan) on 2026-07-15. Full verified
critique: `../../../vgames-platform/docs/council/2026-07-15-account-stats-critique.md`; live
program map: `../../../vgames-platform/docs/CURRENT-STATE.md`.

## What happened in THIS repo tonight (branch `codex/council-hardening`, local commits, no push)

1. **`dda2f2b` — checkpoint commit.** The ~6.7k-line in-flight "council hardening" working tree
   (from a prior/concurrent Codex session) was committed AS-IS so it can't be lost. Test state at
   checkpoint: client 159/159, worker 49/49 — all green (the previously reported cross-test
   pollution did not reproduce). Follow-up owed: slice this into reviewable commits.
2. **`6413cb5` — introspect-payload tolerance.** `readIntrospectionPayload` no longer 502s when
   the VGames worker omits `displayName`/`aliases` (i.e. against today's LIVE viota worker);
   defaults: `displayName := accountId`, `aliases := []`. Auth checks (accountId/status/merged
   rejection) unchanged. Invariant comments added: **aliases are opaque internal merge-graph
   account UUIDs — server-to-server only, never serialize to a client.**
3. **`4fa78eb` — public-name disclosure.** Both display-name inputs now hint
   "Your name and winning paths appear on the public leaderboard — use a nickname…" +
   `placeholder="e.g. a nickname"`. Deliberately did NOT auth the public leaderboard GETs.

After these: client 162/162, worker 49/49, `tsc --noEmit` clean.

**Not committed (not ours):** `src/server/wikipediaChallengeValidator.{ts,test.ts}` were modified
by a live concurrent Codex session minutes after the checkpoint (log-redaction hardening). Left
for that session to commit.

## DEPLOY ORDERING (do not violate)

This branch consumes `displayName`/`aliases` from `/auth/introspect`. Those fields are committed
in viota (`viota` repo, commit `d1ead5a`) but **NOT deployed** to the live worker yet.
**Deploy order: (1) viota worker, verify live introspect returns the new fields, (2) this app.**
The tolerance fix in `6413cb5` makes a mis-ordering degrade gracefully (re-attribution dormant)
instead of 502ing — keep the order anyway. Also recorded in
`vgames-platform/docs/RUNBOOK-P1-cutover.md` (header).

## Council findings specific to vwiki-race (ranked; see the critique appendix for full plans)

1. **Leaderboard integrity is the #1 competitive blocker (CRITICAL):** runs are client-timed and
   clicks are not validated against Wikipedia's real link graph — a devtools user can post a
   1-click 0ms "win" and own every board permanently. Fix direction: per-click adjacency
   validation (link cache table, fail-closed for ranked runs, async `ranked_eligible` promotion).
   Everything competitive here is gated on this.
2. **Migration 0003 resets competitive history at cutover** (legacy runs → `ranked_eligible=0`,
   only 3 challenges survive). Vijay must accept or mitigate before this branch deploys.
3. **Race-the-ghost** (replay a rival's public path as a pace ghost + finish delta) is the
   council's top engagement feature for this game — zero new data, and it doubles as visible
   anti-cheat. Build only after #1.
4. Claim CTA should also appear at the post-run / personal-best moment (today it's only on
   Start/Create).
