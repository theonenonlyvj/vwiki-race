---
written: 2026-09-19
by: Codex; session 01a0b9c8-6b20-7fc1-8e84-cb9474b10f3c
supersedes: none
---
# Temporary landing notice

Owner requested a one-week landing apology after the weekday schedule release.

Design: a compact, nonblocking notice above Home's daily card, including its loading state. Copy: “Sorry about the tough Thursday and Friday races—we’ve fixed the daily picks. Monday–Friday now uses Recognizable picks; weekends stay Hard.” Use existing Central date prop, inclusive September 19 through September 25, absent September 26 onward. Seven-day endpoint computed with Python date + timedelta(days=7). No storage or backend change.

- [x] Test visibility and absence at date boundaries, including missing hero.
- [x] Add notice with restrained existing palette and responsive wrapping.
- [x] Verify Home tests, client suite, build and review; publish frontend and verify live copy.

Review: ready to release. Expiry uses the existing app date lifecycle: new visits/rerenders hide the notice on September 26; a tab left untouched overnight can retain it until the scheduled 5 AM Central refresh. This limited stale-tab edge is accepted for the temporary notice. Existing onboarding tests now explicitly select the unnamed teaching note because the page also contains the named update note.

Shipped: runtime commit `ec209f2`; Pages `b48e0f6d`, bundle `index-BbYoRW7-.js`. All 1377 client tests pass; production build/bundle verification passes. Canonical live bundle and browser copy/layout verified. Worker and D1 unchanged from the preceding schedule release; no backend deployment or schema change needed.
