# VWiki Race Gameplay History, Speed, And Mobile Design

**Date:** 2026-07-16
**Status:** Approved by Vijay's explicit run-ahead instruction to optimize, fix, document, and ship while he is away.

## Goal

Make the current challenge-based game dependable and friend-ready without expanding its core rules: preserve every meaningful attempt, explain daily generation, make navigation feel immediate, keep the target referenceable, and remove the most material mobile friction.

## Product Decisions

### Attempt history

- A run is durable from the moment the server accepts `start`.
- Completed protocol-2 runs remain competitively ordered by elapsed decision time, then clicks, completion time, and run id.
- The leaderboard shows every completed attempt, not only one best run per account.
- An abandoned run with at least one accepted click appears after every completed run as `DNF`. Zero-click abandons remain in account stats but do not clutter the public leaderboard.
- DNF rows are participation history, not competitive ranks. They sort by time spent descending, then clicks descending, abandonment time, and run id.
- A run is a `Repeat run` when the same canonical account has any earlier started run for that challenge. The first attempt remains the first attempt even if it was a zero-click abandon.
- DNF paths are publicly disclosable under the same bounded path endpoint as completed paths.

This intentionally rejects two alternatives: keeping only personal bests cannot expose repeat attempts, while ranking DNFs alongside finishes gives non-finishes a misleading competitive rank.

### Daily challenges

- One `daily_date` is allowed per Central calendar day, and daily challenges consume the next global challenge number at acceptance time.
- The catalog badge says `Today` for the current Central daily and `Daily M/D` for historical dailies. Multiple historical daily rows are expected.
- The browser refreshes the catalog when a background tab becomes visible or the window regains focus. It does not poll, preserving Cloudflare and Wikimedia request budgets.
- Scheduled events more than five minutes in the future relative to Worker wall time are ignored. This prevents development tools from pre-creating tomorrow's daily with a synthetic scheduled timestamp while still allowing delayed real cron delivery.
- The `0 10 * * *` and `0 11 * * *` UTC triggers cover 05:00 Central across
  DST. A cheap `17 * * * *` trigger may claim only existing due retry jobs and
  contacts Wikipedia only after winning such a lease.

Random generation remains proper MediaWiki randomness: request one non-redirect mainspace page for the start and an independent page for the target. Reject missing, redirect, non-mainspace, disambiguation, duplicate, or malformed pages. Render the start and require at least one allowed game link. Try at most three pairs inside a 25-second phase, then leave the durable job pending for bounded retry. Do not replace this with a hand-maintained pseudo-random list.

### Navigation performance and authority

- Pointer-down and keyboard focus may prewarm only the one link the player is actively indicating. Do not prefetch every article link.
- Once the destination Wikipedia article is loaded and sanitized, reveal it immediately while the click mutation is syncing. Do not increment the click/path/timer result until the server accepts it.
- If the server rejects or cannot sync the click, roll back to the previously accepted article and retain the existing retry behavior.
- After server acceptance changes the accepted page id, scroll the new article heading below the sticky gameplay chrome and move focus there.
- Ctrl/Cmd+F is prevented only while a run is active or syncing. This is fair-play friction, not an anti-cheat security claim.
- Keep the current bounded per-run article cache and clear it between runs. A future measured performance pass may add an LRU, but speculative full-link prefetching is prohibited.

A server-side Wikipedia edge manifest is deferred. The current protocol proves sequence, identity, page continuity, and timing, but not that a submitted destination existed in the source revision's allowed link set. Prize-bearing or adversarial ranked play must add revision-keyed edge verification without a live Wikimedia fetch on every click.

### Target reference and mobile UX

- Retain the already-fetched, link-free target blurb during gameplay.
- The horizontal path keeps recent visited pages in a scrollable region and keeps a compact target disclosure fixed at the right. Opening it reveals the full target title and frozen blurb without a target-page navigation link.
- Mobile gameplay controls and tabs have at least 44 CSS-pixel hit areas.
- The compact header, path/target strip, and article heading must not overlap at 360px, 390px, or 430px widths.
- Identity/end-run modals lock background document scrolling and contain their own scrolling.
- The pre-start target panel is shorter and uses restrained type on mobile.
- Wikipedia tables remain horizontally scrollable; images and infoboxes remain width-bounded and single-column on mobile.

## Data And API Shape

`RankedLeaderboardRow` gains:

- `status: "completed" | "abandoned"`
- `isRepeatRun: boolean`
- `startedAt: string`
- optional `completedAt`
- optional `abandonedAt`

`rank` remains numeric for protocol compatibility, but the UI renders `DNF` instead of the numeric value for abandoned rows. No migration is required: repeat status is derived from existing runs, and abandonment duration is written into existing `elapsed_ms`/`wall_elapsed_ms` columns.

## Error Handling

- An optimistic article is never authoritative. Any failed mutation restores the last accepted article.
- A failed daily candidate leaves the durable job pending with existing backoff.
- A future-dated synthetic cron exits before D1 or Wikimedia access.
- Catalog refresh failures retain the current catalog and surface the existing error banner.
- Target preview failure leaves the target title available in the compact disclosure.

## Verification

- D1 Worker tests cover all-attempt ordering, DNF inclusion/exclusion, repeat derivation, DNF timing, path disclosure, and alias/canonical identity behavior.
- Controller/App tests cover prewarm de-duplication, optimistic reveal, rollback, accepted-page scrolling, Ctrl/Cmd+F, frozen target disclosure, daily badge labels, focus refresh, and modal scroll lock.
- Responsive browser checks cover 360x800, 390x844, 430x932, and desktop.
- Release gates remain `npm test`, `npm run test:worker`, `npm run build`, `npm audit --omit=dev`, `git diff --check`, and Worker dry-run.
- Ship order is commit, push, deploy API Worker, deploy Pages, then production smoke.

## Deferred Discussion

- Whether future daily competitions limit ranked attempts or continue allowing unlimited marked repeats.
- Whether DNF ordering should be removed entirely once enough volume exists for a separate activity feed.
- Revision-keyed edge verification and replay review before prizes, public tournaments, or adversarial ranking.
- A measured lead-only preview endpoint and bounded article-cache LRU if production timing spans show those are material.
