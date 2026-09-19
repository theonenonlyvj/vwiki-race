---
written: 2026-09-19
by: Codex; session 01a0b9c8-6b20-7fc1-8e84-cb9474b10f3c
supersedes: measurement recommendation following player continuity release
---
# Measurement and visual UX release

Status: shipped and verified on canonical production.

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
- Production build and bundle verification passed; candidate bundle `index-BXGAJ9M9.js`. Full client suite passed: 96 files, 1470 tests. The final report formatting change also passed all 14 report/CLI tests independently. Independent analytics and visual review passed with no remaining blocker. Canonical production executed the expected bundle; Home route cards and instructions rendered, Browse loaded live challenge data, and selecting a long-title challenge reached its detail page with spoiler gates intact. No race was started for this visual smoke check.

## Release identifiers

- Runtime commit: `e7b001c`, pushed to `origin/main`.
- Pages deployment: `8e22f1b0` (`https://8e22f1b0.vwikirace.pages.dev`).
- Executed canonical production bundle: `index-BXGAJ9M9.js`.
- API Worker unchanged: `7262fcf4-3424-4631-a4f8-5ce719e6d22d`.
- Identity and recovery behavior remain as documented in the preceding player-continuity receipt.

Rollback: redeploy the previous Pages artifact/commit `438901b` (previous deployment `4d37610f`, bundle `index-CuLFgSQb.js`). No schema or server rollback is needed for this UI/report release. Build with `VITE_VWIKI_RACE_API_URL` unset. Do not replay any migration.

Follow-up: run the report after meaningful new play has accumulated and compare against the private final baseline. Do not infer a release effect from today's baseline or treat matching names as permission to merge. Dependency upgrades remain a separate follow-up.


## Session closeout and next-session instructions

The owner asked to document the work thoroughly and stop for now. All authorized release work is complete. Do not start further UX changes, schedule a monitor, upgrade dependencies, replace a daily, or merge more identities from this handoff alone.

Read this receipt first, then `docs/handoff/2026-09-19-player-continuity-release.md` for identity merges/reset behavior, and `docs/handoff/START_HERE.md` for game invariants. The sibling identity repository is `../vgames-platform`; this last release changed no identity code. Earlier daily-schedule and remembered-login changes are already shipped, not a backlog to execute again.

### Settled owner decisions

- New automatic weekday picks use Recognizable; weekends use Hard. Historical Weird labels remain readable. The apology is temporary, September 19–25 Central, and expires through the existing app date lifecycle.
- Owner-issued password reset links last seven days from issuance, single use; reissue invalidates the prior link. The owner chose this over automated email recovery and rejected a short email-unfriendly window.
- Confirmed identity merges are complete. Preserve history and aliases. Similar names alone do not authorize another merge.
- The owner welcomes feedback; the existing visible invitation links to the contact page.
- The owner does not currently use the admin console for daily replacement. Defer replacement UI and queued backup races; hot swaps are requested from an agent.
- Measurement is on demand. No recurring job, alert, browser event collector, or external analytics service was installed.

### Next measurement, when requested

From the game repository, compare fresh data with the final baseline:

```sh
npm run report:health -- --previous .private/measure-ux-2026-09-19/final-baseline/snapshot.json
```

The default output directory is newly dated and ignored. Read the resulting Markdown and JSON together if investigating individual daily cohorts. Keep the source snapshot, pseudonymous snapshot, report, and operator logs private. Existing output files deliberately refuse overwrite. Baseline results and exact artifact pointers are also summarized in ignored `.private/measure-ux-2026-09-19/SESSION-CLOSEOUT.md`.

Do not label returning-player share as visitor retention. Do not call partial-day pending starts DNFs. Compare both mature-start completion and engaged finish rate, and keep counts visible. Current aliases and archive replays can revise historical daily results; a fresh backdated report is not an event-history reconstruction. Matching names are review candidates, not confirmed ownership. The baseline cannot establish an effect from changes deployed later that day.

### Implementation and verification lessons

- Home's min-content grid caused a real 320px overflow. The explicit `minmax(0, 1fr)` track and min-width guards fixed it; removing only endpoint width constraints was insufficient.
- At very narrow widths, only the arrow pseudo-element rotates on Home. Rotating both the wrapper and pseudo-element had pointed the arrow backward.
- Browse routes stack at widths up to 400px: a real long article title was unreadable in two narrow columns. Desktop remains horizontal.
- Coral is reserved by existing product rules; the new decorative treatment uses neutral/teal. Preserve the single accessible route announcement on Browse and the existing outcome/spoiler gates.
- The readable measurement table includes early exits, counted DNFs, expired active runs, uncounted terminal starts, pending starts, and finishes so its denominators reconcile. Do not simplify it into a flattering finish-only ratio.
- Use Wrangler's read-only `--command` SELECT path for this report. A prior `--file` collection attempt took an unsuitable authorization/import path. Never print raw production query responses.
- Explicit Pages deployment is required. A Git push alone does not deploy this project. Build with `VITE_VWIKI_RACE_API_URL` unset and verify the executed production bundle, not just deployment success text.

### Remaining follow-ups and shutdown

Dependency advisories and sanitizer-verified daily path gating remain separate follow-ups, not release blockers that were silently resolved. The previous receipt records the limited lifetime of already-issued Viota access JWTs after reset; do not claim immediate global logout.

Local Vite and read-only preview adapter processes were stopped. Agent-created verification tabs were closed and the temporary viewport override was reset. No synthetic race was created by this final visual/report release. Private test/baseline artifacts were retained rather than destructively cleaned up.

The LAN task registry at `vmachine1.local:8080` refused connections during release closeout. This did not affect Cloudflare deployment or Git pushes; canonical project docs and the shared local worklog are the continuity record. No background work remains scheduled from this session.
