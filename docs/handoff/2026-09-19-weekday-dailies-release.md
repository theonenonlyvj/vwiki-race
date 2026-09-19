---
written: 2026-09-19
by: Codex; session 01a0b9c8-6b20-7fc1-8e84-cb9474b10f3c
supersedes: previous automatic Thursday/Friday weird schedule
---
# Weekday dailies release

Candidate release, not yet deployed. Owner approved “yes ship it” after the monthly audit.

- Monday-Friday now selects recognizable; weekends stay hard. Existing daily features and runs are unchanged.
- Teaching copy matches the schedule. New admin queue entries accept Recognizable or Hard; weird suggestions require an explicit override. Weird remains readable in historical data and existing queue listings.
- Full client suite: 1371 passing. Worker/D1 suite: 290 passing. Build and bundle verification pass. The new day mapping and scheduler tests failed before the schedule change; onboarding and dead-queue guards also have observed red/green checks.
- Independent reviewer identified stale teaching copy and potential stranded weird queue entries; both repaired and covered by tests.
- Production D1 ledger contains migrations 0001–0007, matching local inventory. No queued entries exist. No schema/data migration required.
- Live editorial pool read: 100 recognizable titles, 69 remaining after current exclusions, before quality/canonicalization filters. This is capacity evidence, not a guarantee that every remaining title passes evaluation.
- Cloudflare access restored through Wrangler OAuth. Non-interactive calls could not initiate login; the first browser attempt timed out, the renewed listener completed successfully. Do not assume a missing-token error means credentials cannot be refreshed.
- Dependency audit remains nonzero: baseline-browser-mapping, browserslist, nanoid, postcss (two high, two moderate). These are pre-existing dependencies, unchanged by this release; dependency upgrades remain follow-up. Client tests emit existing jsdom canvas/Node localStorage warnings without failing.
- Previous production Worker: 026219f7-db33-4f5c-ac99-48899c93b288. Previous Pages bundle: index-KtJcCDZ4.js. Candidate Pages bundle: index-KNJ3gN88.js.

Remaining release steps: final review, commit, fresh migration ledger, Worker deploy/smoke, push main, Pages deploy/smoke, record final versions. Rollback: restore the previous Worker version and Pages deployment; no D1 rollback. Do not manually trigger production cron.

Evidence and logs are local-only in `.private/audit-2026-09-19/`. The monthly audit is `docs/audits/2026-09-19-daily-performance.md`; its original Cloudflare-access limitation applies to that snapshot, not this release preflight.
