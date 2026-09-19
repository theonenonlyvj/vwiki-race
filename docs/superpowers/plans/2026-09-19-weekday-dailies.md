---
written: 2026-09-19
by: Codex; session 01a0b9c8-6b20-7fc1-8e84-cb9474b10f3c
supersedes: prior Thursday/Friday automatic flavor schedule
---
# Weekday recognizable dailies implementation plan

Approved by the owner's “yes ship it” following the September 19 audit recommendation.

Goal: recognizable selection Monday–Friday; hard on weekends. Preserve historical flavor metadata and weird classification. Prevent new unscheduled weird queue entries; editorial unusual picks must be explicitly queued as recognizable or hard. No schema change or rewrite of existing dailies. The separate sanitizer-verified path gate remains follow-up work.

- [x] Update the full-week domain assertion and Thursday/Friday scheduler regression; observe expected failures.
- [x] Remove the Thursday/Friday weird branch in `src/domain/dailyEditorial.ts`; update current schedule documentation.
- [x] Verify targeted tests, full client/Worker suites, build, dependency audit, dry-run deployment and independent review.
- [x] Restore Cloudflare login; read the migration ledger, queued flavors and recognizable pool capacity before release.
- [ ] Commit, deploy and smoke Worker, push main, deploy/smoke Pages if its artifact changes; record exact deployment evidence and rollback.

Implementation: retain `if (weekday === 0 || weekday === 6) return "hard";`, then `return "recognizable";`. Test the actual `scheduled` handler for both Thursday and Friday, asserting evaluator flavor and persisted daily feature. Do not invoke production cron to test.

Rollback: revert the schedule commit and redeploy the previous verified Worker version. No database rollback is needed; already published daily metadata remains immutable.
