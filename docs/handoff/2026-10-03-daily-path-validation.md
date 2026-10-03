---
written: 2026-10-03
status: implementation and release guidance
---

# Automatic Daily rendered-path validation

## Scope and status

This change tightens automatic Daily selection only. It does not
modify existing challenges or Daily rows, queue decisions, difficulty floors,
identity, account data, or the on-demand random challenge contract. No schema
change or migration is involved.

The automatic scheduler still checks the approved queue first. A valid queued
challenge is accepted under the existing human-approval rules without running
the shallow automatic route search. Only a queue miss invokes automatic
selection with `requireVerifiedReferencePath: true`. The candidate does not
mutate `currentDaily`, existing challenges, or existing Daily rows.

## Behavior

- The existing `linkshere` / `prop=links` search remains a bounded way to
  propose a reference path of at most three clicks. Its optional best-effort
  API remains compatible: callers that request only `computeReferencePath`
  still receive a path or `null` without making candidate selection depend on
  it.
- When the new requirement is enabled, every proposed edge must appear in the
  rendered article link list produced by the same Worker Wikipedia gateway and
  sanitizer used by the game. A link removed with References, navigation,
  metadata, or another sanitizer rule cannot validate a route.
- Redirected intermediate pages are checked through their canonical rendered
  identity while saved routes retain the actual clicked link titles. The first
  page must retain the selected start page ID, and the last
  page must resolve to the selected target page ID and canonical title. Repeated
  page IDs and early arrival at the target are rejected.
- If a ranked pair has no proposed path or its rendered route fails, evaluation
  continues to the next ranked pair while the original shared ceiling remains
  available. If no pair verifies, selection fails closed with
  `daily_candidate_unavailable`; the durable Daily job records the failure and
  uses its existing bounded retry/backoff path.
- Automatic verified mode samples at most six targets, reserving physical
  request headroom for route rendering. Legacy/non-strict evaluator callers
  retain the existing ten-target cap. Both retain the global 40-request and
  25-second ceilings.
- The scheduler passes `job.attemptCount` as an automatic-only retry cursor.
  Target sampling is reproducible for each date/flavor/attempt tuple, and the
  bounded 50-title inbound window advances across retries. On-demand random
  generation omits the cursor. Its three Wikimedia random-start queries remain
  nondeterministic, so random starts and the final selected pair are not
  deterministic.
- A rendered witness of one click or fewer is ineligible for every automatic
  flavor. A Hard witness of two clicks or fewer is also ineligible. These are
  additional post-verification eligibility checks. Hard also retains its
  existing raw-link shortcut exclusion: a longer witness does not rule out a
  shorter route. Scoring formulas and inbound-link/pageview floors are unchanged.
- Automatic verified acceptance persists classifier metadata
  `editorial-v1+verified-path-v1`; queued human-approved acceptance continues
  to persist `editorial-v1`. The underlying `editorial-v1` scoring output is
  unchanged.
- A fresh Worker gateway and rendered-article cache are created per selection
  attempt. The gateway receives the evaluator's counted fetch, so first
  attempts and its one timed retry each consume the existing 40-request budget
  and remain inside the existing 25-second phase deadline. The editorial pool's
  established freshness cache is unchanged.
- Malformed graph responses cannot name an unrequested source page or an edge
  outside the target's validated namespace-0 inbound set.
- The on-demand random endpoint still omits both reference-path flags and uses
  its existing request-scoped gateway. It does not perform rendered route
  validation.

## Verification

Focused regressions cover sanitizer-removed links through the real Worker
gateway, canonical redirects, wrong final page identity, ranked fallback,
per-attempt cache scope, the six/ten target caps, retry-seeded target samples,
rotating inbound windows, verified route-length floors, classifier provenance,
malformed `linkshere` and `prop=links` payloads, abort handling, physical retry
budgeting, scheduler flagging, automatic-job retry behavior, queue-first
preservation, and best-effort/random compatibility.

Run before review or release:

```sh
npx vitest run src/server/dailyCandidateEvaluator.test.ts
npx vitest run --config vitest.worker.config.ts src/server/dailyChallengeJobs.worker.test.ts
npx tsc --noEmit
npm test
npm run test:worker
npm run build
```

## Limits and release notes

This validates one currently rendered, currently playable route found by the
existing shallow search. It does not prove a shortest path, a unique path,
general reachability, a difficulty rating, or permanence across future
Wikipedia revisions. A playable pair whose only route lies outside the bounded
search can be rejected and retried later. Retries explore a different bounded,
reproducible target sample/inbound window, but still may miss a playable pair.
Upstream qualification work or a gateway retry can also consume enough of the
unchanged budget that route verification has no room left; that is an
intentional fail-closed outcome.

Because Worker code changes, release review must deploy and smoke-test the API
Worker before any dependent client release. Do not invoke production cron as a smoke test or replace existing Dailies.
The deployment identifiers are obtained from the provider release receipts.
