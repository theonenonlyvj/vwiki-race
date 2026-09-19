---
written: 2026-09-19
by: Codex; session 01a0b9c8-6b20-7fc1-8e84-cb9474b10f3c
supersedes: unimplemented measurement recommendation after player continuity release
---
# Measurement and visual UX implementation plan

Owner explicitly requested shipping measurement of weekday finish rates, returning players, and new duplicate-account trends, plus further visual UX improvements. Owner deferred daily replacement UI and pre-vetted backup races; current preference is to ask an agent for hot swaps. Do not build replacement tooling in this pass.

Goal: make progress measurable using existing first-party data, and make daily play/discovery easier to scan.
Architecture: a read-only agent CLI queries minimal game D1 fields and computes a private dated JSON/Markdown report. No new browser tracking, provider, DB writes, admin-console dependency or scheduled job. UI reuses current React callbacks and established teal/coral palette, with scoped CSS.

Alternative: new event instrumentation could measure visits but adds complexity and historical gaps; admin dashboard would require a surface the owner does not use. Chosen existing-data report measures players/races honestly, not site visitors or causal retention effects.

- [x] Measurement builder: scripts/product-health.mjs plus pure report module and meaningful tests. npm run report:health; --input fixture/offline mode; --output only under ignored .private by default; --days defaults 28, optional fixed --as-of for repeatability. Remote collection through existing Wrangler, SELECT only, minimal columns/no credentials or paths. Canonical alias resolution, exclude synthetic names/board-excluded runs, one player per challenge for finish rates. Separate unfinished active/pending from mature failure; report completed daily cohorts by Central date/weekday. Returning players means active players in current complete window who played earlier; report explicit denominator and 7-day repeat-play cohorts only where full follow-up exists. Duplicate names are candidates, not confirmed people: casefold/trim and distinct canonical accounts, creation/activity attribution defined, no auto-merges. Show counts with rates, missing/zero samples as unavailable. Snapshot baseline to ignored files; document observational limits and next repeat command.
- [x] UI builder: Home.tsx/new scoped Home polish CSS and Browse.tsx/Browse.css only. Strong start/target hierarchy, directional route graphic rendered in CSS, readable hero CTA and secondary countdown; add compact plain-language how-it-works cue without duplicating modal. Browse cards/status differentiation and spacing improve scanability; replace awkward archive copy with “Pick a date to race or revisit.” Preserve callbacks, spoiler rules, identity loading, errors, no fabricated social proof. Mobile320/390 + desktop, keyboard focus, reduced motion.
- [x] Independent review: verify report definitions, exclusions, maturity/canonical handling and privacy; review UI behavior and responsive screenshots. Parent runs live baseline and inspects report, verifies UI in browser, then full client/Worker/build/audit/dry-run gates as applicable.
- [x] Ship: commit/push authorized changes; no Worker deploy unless server changes. Explicit Pages deployment with actual runtime commit. Verify executed live bundle; update canonical handoff/release receipt/shared worklog and record deferred replacement decision.
