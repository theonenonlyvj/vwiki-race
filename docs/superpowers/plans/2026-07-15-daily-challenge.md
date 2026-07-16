# Daily Challenge Implementation Plan

> Historical implementation plan. Do not restore its hourly UTC cron; the
> current contract is the DST-safe 5:00 AM Central schedule.

**Repository:** `/Users/vijayram/Cursor/vwiki-race`

**Design:** `docs/superpowers/specs/2026-07-15-daily-challenge-design.md`

## Task 1: Extend Challenge Persistence

- Add `origin`, nullable unique `daily_date`, and `source` challenge provenance,
  plus `daily_challenge_jobs` and a transactional challenge-number sequence in
  a new D1 migration.
- Extend challenge contracts and catalog mapping without changing existing IDs.
- Replace every legacy/v2 `MAX(sort_order)+1` path with the same sequence
  primitive used by daily acceptance. Failed/rejected transactions consume no
  number. The UTC date never determines the number; daily acceptance takes the
  next global challenge number after every manual or prior daily challenge.
- Add conditional claim/reclaim, failure-backoff, and atomic acceptance
  operations keyed by UTC date and lease token.
- Test fresh/upgrade migrations, claim races/expiry, backlog across date change,
  all three creation paths, and rollback behavior with real local D1.

## Task 2: Add Wikipedia Random Candidate Selection

- Add a bounded server-only random candidate source using the English
  Wikipedia Action API `generator=random`, namespace 0, and non-redirect pages.
- Make separate one-result requests for start and target; consume returned
  page ID/title metadata and render-validate only the start through
  `WikipediaGateway.getArticle` from Task 5 of the council-hardening plan,
  requiring at least one move accepted by the shared `isAllowedArticleHref`
  predicate.
- Limit one job to three pairs, nine Wikipedia calls, five seconds per request,
  and a 25-second generation deadline.
- Test exact parameters, malformed/redirect/duplicate/dead candidates, bounded
  calls/timeouts, and typed failure behavior with injected fetch.

## Task 3: Add Scheduled Worker Entry Point

- Add `scheduled()` beside the existing module `fetch()` handler.
- Derive the current date key from `scheduledTime`, insert its pending job, and
  claim at most one oldest due backlog job. Only the lease winner may fetch.
- Add `[triggers] crons = ["7 * * * *"]` to the API Worker configuration.
- Add structured redacted claim/success/failure logs and local scheduled-handler
  tests including concurrent delivery and expired-lease recovery.

## Task 4: Surface The Daily Challenge

- Include `origin`, `dailyDate`, and `source` in catalog/client validators.
- Apply precedence: active run, direct URL, today's daily row, first catalog row.
- Add a compact Daily/date marker in existing challenge surfaces.
- Test URL precedence, active-run precedence, empty/missing daily behavior, and
  desktop/mobile layout during the final frontend QA task.

## Verification

Run focused domain/repository/Worker/client tests, the real local D1 suite,
`npm test`, `npm run build`, `git diff --check`, and local scheduled-handler
requests. Leave changes uncommitted and do not touch remote D1 or deploy.
