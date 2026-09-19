---
written: 2026-09-19
by: Codex; session 01a0b9c8-6b20-7fc1-8e84-cb9474b10f3c
supersedes: candidate next-UX audit
---
# Player continuity implementation plan

Owner approved all five priorities in docs/audits/2026-09-19-next-ux-pass.md and confirmed repeated names are the same people, including kaymck/Kayden. Owner selected owner-issued reset links over email recovery. No public same-name auto-merge.

Goal: preserve confirmed players' history, provide simple one-use password recovery, and improve discovery/returning-player UX.

Architecture: existing shared identity owns merges/passwords; VWiki owns UI and game alias reconciliation. Existing server auth and spoiler gates remain authoritative. No game engine changes or email service. Use focused subagents for independent implementation, independent review, then sequential production deployment.

## Task 1: password recovery and truthful admin attribution
- [ ] Identity agent adds tested actor-from-verified-admin-sub merge provenance (no hardcoded principal).
- [ ] Add owner-issued single-use 256-bit reset token, hash-only persistence, 7-day expiry, claimed-account only, atomic consume+password update+epoch invalidation. No secret in logs or URLs sent to third parties; consume link token from URL fragment in client. Reissue invalidates prior token; existing sessions invalidated on reset.
- [ ] Add authenticated owner-only issuance through VWiki's existing admin authorization and private identity binding, browser reset UI and Forgot password contact instructions. No username-only reset, no automatic messages, no principal sign-in by agent.
- [ ] Regression tests: owner authorization, expiry/one-use/reissue, password hashing, session revocation, unknown account handling, loading/error/success UI. Red then green.

## Task 2: challenge discovery
- [ ] UX agent adds Past dailies filter/date-based navigation using existing dailyDate and outcome data, explicit completed/unfinished/not-played states and normal detail links (existing gated graph there).
- [ ] Move Create into a discoverable secondary top action with collapsible form; keep today's race primary.
- [ ] Respect spoiler gates in catalog best metrics; do not expose hidden time/clicks before existing completion/give-up eligibility.
- [ ] Tests for filters, sorted dates, outcomes, creation access, spoiler boundaries and screen sizes.

## Task 3: result/guest clarity
- [ ] Second UI agent improves existing guest ClaimCta and result hierarchy without duplicate prompts, includes existing-account login route, prominent sharing/invitation, truthful persisted result status.
- [ ] Explain locked board metrics once; distinguish DNF from hidden completed time. Preserve canonical result/board source of truth and finish-or-give-up rule.
- [ ] Focused component tests, reduced-motion compliance, no gameplay/ranking changes.

## Task 4: consolidate confirmed identities (parent)
- [ ] Fresh source reads; exact reviewed mapping, claimed canonical preference for morgue/plannank, most-recent useful ghost for remaining groups, Kayden+kaymck one group.
- [ ] Back up both production D1s; inspect cross-game external links and same-challenge overlaps; preserve all runs and provenance.
- [ ] Use dry-run then actual canonical merge with truthful agent actor and approved reason. Reconcile VWiki aliases immediately; do not reset history or aggregate best scores incorrectly. Remove temporary admin secret and confirm absence.
- [ ] Verify all source identities resolve to canonical, run counts unchanged, public boards deduped and no active-run conflicts. Keep exact IDs and rollback manifests local-only.

## Task 5: review, release, records
- [ ] Independent review of all code and merge mapping. Run complete client/Worker/identity suites, build, dry runs, migration-ledger checks.
- [ ] Identity additive migration and Worker first; VWiki Worker next; Pages last. Browser checks on desktop and phones; normal reset flow using synthetic test account only; no principal account manipulation.
- [ ] Push authorized release, update handoffs and shared worklog; report actual outcomes and limitations.

Owner correction: 30 minutes is too short for asynchronous email requests. Reset links now expire seven days after issuance, remain one-use, and are invalidated by replacement issuance. Seven days = 604800 seconds (computed).
