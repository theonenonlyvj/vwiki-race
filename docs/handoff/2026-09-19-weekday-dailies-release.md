---
written: 2026-09-19
by: Codex; session 01a0b9c8-6b20-7fc1-8e84-cb9474b10f3c
supersedes: previous automatic Thursday/Friday weird schedule
---
# Weekday dailies release

Live on production, verified 2026-09-19. Owner approved “yes ship it” after the monthly audit.

- Monday-Friday now selects recognizable; weekends stay hard. Existing daily features and runs are unchanged.
- Teaching copy matches the schedule. New admin queue entries accept Recognizable or Hard; weird suggestions require an explicit override. Weird remains readable in historical data and existing queue listings.
- Full client suite: 1371 passing. Worker/D1 suite: 290 passing. Build and bundle verification pass. The new day mapping and scheduler tests failed before the schedule change; onboarding and dead-queue guards also have observed red/green checks.
- Independent reviewer identified stale teaching copy and potential stranded weird queue entries; both repaired and covered by tests.
- Production D1 ledger contains migrations 0001–0007, matching local inventory. No queued entries exist. No schema/data migration required.
- Live editorial pool read: 100 recognizable titles, 69 remaining after current exclusions, before quality/canonicalization filters. This is capacity evidence, not a guarantee that every remaining title passes evaluation.
- Cloudflare access restored through Wrangler OAuth. Non-interactive calls could not initiate login; the first browser attempt timed out, the renewed listener completed successfully. Do not assume a missing-token error means credentials cannot be refreshed.
- Dependency audit remains nonzero: baseline-browser-mapping, browserslist, nanoid, postcss (two high, two moderate). These are pre-existing dependencies, unchanged by this release; dependency upgrades remain follow-up. Client tests emit existing jsdom canvas/Node localStorage warnings without failing.
- Previous production Worker: 026219f7-db33-4f5c-ac99-48899c93b288. Previous Pages bundle: index-KtJcCDZ4.js. Live Pages bundle: index-KNJ3gN88.js.

Release completed:

- Runtime commit: `1daecd7`, pushed to `origin/main`.
- Worker version: `ff4c8704-7810-4181-b990-570a25ab6897`; deployment succeeded with all three existing cron schedules preserved.
- Pages deployment: `https://170c4491.vwikirace.pages.dev`; canonical production serves `index-KNJ3gN88.js`.
- Live catalog and challenge board return 200; unauthenticated admin moderation returns the expected 403.
- Live onboarding visibly says Recognizable Monday–Friday and Hard weekends.
- Browser gameplay smoke completed Moon → Gravity through a real article link; the result and expanded saved path showed one click. The named test account's run was then marked `board_excluded=1`; D1 confirmed completed status and exclusion. No active test run remains.
- Independent final review: ready to ship, no unresolved findings. Production cron was not manually invoked.
- No authenticated admin mutation was performed in production; queue restrictions are covered by client/API tests. Sanitizer-verified path gating remains separate follow-up work.

Rollback: restore the previous Worker version and Pages deployment; no D1 rollback. Do not manually trigger production cron.

Evidence and logs are local-only in `.private/audit-2026-09-19/`. The monthly audit is `docs/audits/2026-09-19-daily-performance.md`; its original Cloudflare-access limitation applies to that snapshot, not this release preflight.
