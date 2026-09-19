---
written: 2026-09-19
by: Codex; session 01a0b9c8-6b20-7fc1-8e84-cb9474b10f3c
supersedes: measurement recommendation following player continuity release
---
# Measurement and visual UX release

Status: candidate; release verification in progress. Do not infer deployed state from this document until the release identifiers below are populated.

## Scope

The owner approved existing-data measurement and further visual UX polish. Home now presents distinct Start and Target article cards, a directional connector, a compact explanation of racing, a stronger primary button, and a secondary countdown. Challenge cards show labeled routes and clearer outcome states. Narrow phone layouts stack routes so long titles remain readable; the archive instruction is now “Pick a date to race or revisit.” Existing identity gates, callbacks, gameplay, spoiler rules, and feedback invitation remain intact.

Measurement is a repeatable read-only agent report from existing D1 records. It introduces no browser tracking, third-party analytics service, database writes, migration, admin dashboard, or scheduled monitoring. Raw input and generated reports remain ignored under `.private/`; no account names or identifiers belong in this release receipt.

The owner explicitly deferred replacement-today admin UI and queued backup races. For now, daily hot swaps remain an agent task requested by the owner.

## Verification

- Independent visual source review passed. Parent inspected desktop Home and mobile Home/archive; final long-title archive cards were checked at 320 and 390 pixels. At 320 pixels, document scroll width was 305 pixels, with no horizontal overflow.
- Existing keyboard focus and reduced-motion rules remain applicable; no new animation was added.
- Worker tests: 290 passed. Worker dry run passed. Remote migration ledger: no migrations to apply. Server code is unchanged, so this release does not redeploy the Worker.
- Dependency audit: four pre-existing advisories, unchanged (two high, two moderate).
- Read-only CLI ran against production successfully; its weekday aggregates matched the separately captured private source baseline. The final baseline lives in ignored `.private/measure-ux-2026-09-19/final-baseline/`; use its snapshot for future comparisons. The report is documented in `docs/product-health-report.md`.
- Production build and bundle verification passed; candidate bundle `index-BXGAJ9M9.js`. Full client suite passed: 96 files, 1470 tests. The final report formatting change also passed all 14 report/CLI tests independently. Independent analytics and visual review passed with no remaining blocker. Live deployment verification is pending.

## Release identifiers

Pending. Previous runtime and identity recovery receipts remain authoritative until this release is verified.
