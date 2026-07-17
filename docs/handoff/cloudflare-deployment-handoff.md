# VWiki Race Cloudflare Deployment Handoff

Date: 2026-07-17

Status: current release procedures and production inventory for the editorial
Daily and community nomination release. Migration `0005` remains pending until
the remote D1 ledger confirms whether it has been deployed. Verify the live
commit and deployment state before any rollout; this file is not an incident
log. The dated July 16 handoff remains the historical record for that release.

## Production Inventory

- GitHub: `https://github.com/theonenonlyvj/vwiki-race`
- Cloudflare Pages project: `vwikirace`
- Public Pages URL: `https://vwikirace.pages.dev`
- Canonical API Worker name: `vwikirace-api`
- D1 database: `vwiki-race`
- D1 binding: `VWIKI_RACE_DB`
- D1 database id: `bbd89b81-078a-47e0-9db4-5d170a3f78b4`
- Identity origin: `https://vgames-identity.theonenonlyvj.workers.dev`

VGames owns identity, unique names, ghost accounts, login, and account merges.
VWiki Race owns challenges, creator attribution, runs, accepted click events,
paths, account stats, and challenge leaderboards. Realtime rooms are not used.

## Architecture

1. Cloudflare Pages serves the static Vite build from `dist`.
2. The canonical `vwikirace-api` Worker owns authorization, validation, rate
   limits, run protocol, daily scheduling, and all D1 access.
3. Retained `functions/api/*` Pages Functions are bounded compatibility proxies
   for old `/api/*` clients. They do not bind D1 or duplicate game logic.
4. VGames issues and introspects account tokens. VWiki Race stores canonical
   VGames account IDs and aliases, never a separate player namespace.
5. The API Worker receives `0 10 * * *` and `0 11 * * *` UTC triggers for 5:00
   AM Central plus `17 * * * *` for due-job retries. Only the 5:00 AM event may
   create a new date. The alternate DST trigger exits before D1; the hourly
   retry performs one bounded D1 check and contacts Wikipedia only after
   claiming an existing due job.
6. Daily selection derives `recognizable`, `weird`, or `hard` from the Central
   weekday, consumes the oldest valid approved queue entry for that flavor
   first, and falls back to bounded cached editorial-pool evaluation.
7. `/admin/dailies` is a protected application route. The Worker authorizes
   claimed VGames accounts by immutable account ID from
   `DAILY_ADMIN_ACCOUNT_IDS`; display names are not credentials.

## Data And Game Guarantees

- Every run is stored server-side from its accepted start.
- Protocol 2 accepts only canonical transitions from the server-accepted current
  page and completes only through the accepted target click.
- Every terminal run remains in D1. Public leaderboards show every eligible
  finish and every abandonment with at least one accepted click. Finishes sort
  by active decision time, clicks, and accepted completion time. Meaningful
  abandons follow as `DNF`, later attempts are marked `Repeat run`, and
  zero-click abandons remain in account statistics. The v0 response is capped
  at the first 100 ordered terminal rows pending cursor pagination.
- Guest stats remain attached to the VGames ghost and survive a later claim or
  canonical account merge.
- Challenge creation accepts a Wikipedia title or English article URL, then
  validates canonical page IDs and a playable start before insertion.
- The pre-start target preview uses sanitized Wikipedia content, contains no
  playable article links, aborts stale selections, and never blocks Start when
  Wikipedia is unavailable.
- Manual and daily creation use one transactional global number sequence. Dates
  never determine numbers: an existing Challenge #15 makes the next accepted
  challenge #16.
- Daily targets use cached Vital Articles and Unusual Articles pools. Automatic
  evaluation samples at most 10 targets and 3 independent random starts,
  allows at most 40 Wikimedia subrequests, and stops at 25 seconds. Pool data
  is fresh for 24 hours and may be used stale for up to seven days.
- `recognizable` targets Vital Articles Levels 1-3, `weird` targets Unusual
  Articles, and `hard` uses their union. All flavors share the same quality
  floor. `hard` rejects direct edges and bounded two-click shortcuts it can
  detect, but it is not an exact shortest-path or full-graph computation.
- Ordered challenge-pair uniqueness prevents duplicate challenges, existing
  pairs are reused without consuming a global number, and a challenge can
  receive only one Daily feature ever.
- Claimed users can nominate only during challenge creation. Admin approval
  creates a community queue entry; admins can override flavor, decline/remove
  entries, or directly queue an existing never-featured challenge.

## Required Configuration

Canonical Worker variables:

```txt
VGAMES_URL=https://vgames-identity.theonenonlyvj.workers.dev
ALLOWED_ORIGINS=https://vwikirace.pages.dev
DAILY_ADMIN_ACCOUNT_IDS=<comma-separated immutable VGames account IDs>
```

Canonical Worker bindings:

```txt
VWIKI_RACE_DB -> D1 database vwiki-race
VGAMES_IDENTITY -> Worker service vgames-identity
CLICK_RATE_LIMITER -> configured rate-limit namespace
ACCOUNT_READ_RATE_LIMITER -> configured rate-limit namespace
CHALLENGE_CREATE_RATE_LIMITER -> configured rate-limit namespace
DAILY_ADMIN_RATE_LIMITER -> configured rate-limit namespace (30 requests/minute)
CLIENT_ERROR_RATE_LIMITER -> configured rate-limit namespace
```

Pages production environment:

```txt
VITE_VWIKI_RACE_API_URL=https://<canonical-worker-origin>
VWIKI_RACE_API_URL=https://<canonical-worker-origin>
```

The frontend production build rejects a missing, noncanonical, or non-HTTPS API
origin. Loopback HTTP is allowed only for local development.

Pages build settings:

```txt
Git provider: none (verified 2026-07-16; pushing main does not deploy Pages)
Root directory: /
Build command: npm run build
Build output directory: dist
Functions directory: functions
Manual deploy: npx wrangler pages deploy dist --project-name=vwikirace --branch=main
```

## Migrations

Expected migration inventory for this release:

```txt
d1/migrations/0001_vwiki_race_tracking.sql
d1/migrations/0002_challenge_creators.sql
d1/migrations/0003_hardening_protocol.sql
d1/migrations/0004_daily_challenges.sql
d1/migrations/0005_editorial_dailies.sql  # PENDING until this release is deployed
```

`0003` is an immutable historical artifact, not a safe populated-database
restore script. It contains superseded cutover DML that abandons active runs,
changes ranked eligibility, and deactivates challenges. Never edit an applied
migration and never replay `0003` against imported production data. Correct
history only through a new reviewed additive migration.

Before any rollout, list the remote ledger. Before applying a new migration,
inspect its SQL and create a private D1 backup/export that must never be printed
or committed. Migration `0005_editorial_dailies.sql` is additive: it adds
ordered-pair uniqueness plus `daily_features`, `daily_nominations`, and
`daily_queue_entries`, and backfills legacy Daily features without renumbering
or deleting history. Treat `0005` as pending until the remote ledger says it is
applied; do not claim deployment or skip the backup because the migration is
additive.

Remote ledger/apply commands:

```bash
npx wrangler d1 migrations list vwiki-race --remote --config wrangler.api.toml
npx wrangler d1 migrations apply vwiki-race --remote --config wrangler.api.toml
```

## Fixed Rollout Order

Do not reverse these steps.

1. Confirm the VGames identity Worker is healthy.
2. Run all local release gates listed below and commit the reviewed tree locally.
3. Inspect the remote D1 migration ledger and record it before mutation.
4. If `0005` is pending, create a private D1 backup/export, apply only the
   reviewed additive migration, and verify the remote ledger again.
5. Deploy the canonical API Worker from `wrangler.api.toml`.
6. Smoke-test the canonical Worker directly, including the v2 challenge catalog
   and Daily/admin routes.
7. Set both Pages API-origin environment values to that Worker origin.
8. Only now push `main`, then manually deploy Pages with the recorded CLI
   command. Re-verify the project still reports no Git provider before relying
   on this order in a future release.
9. Smoke-test a guest/claimed start, one click, completion, path disclosure,
   stats, direct challenge link, and challenge creation.
10. Confirm all three cron triggers are present. Do not manually fan out
   scheduled invocations; the Central-time gate creates dates and minute-17 may
   only retry due jobs.

This ordering prevents a new Worker from querying columns that are not yet in
D1 and prevents Pages from pointing at an unverified API deployment.

## Release Gates

From `/Users/vijayram/Cursor/vwiki-race`:

```bash
npm test
npm run test:worker
VITE_VWIKI_RACE_API_URL=https://vwikirace-api.example.workers.dev npm run build
npm run verify:bundle
npm audit --omit=dev
git diff --check
npx wrangler deploy --config wrangler.api.toml --dry-run
```

The placeholder HTTPS origin is for build validation only. A real deploy must
use the actual canonical Worker URL.

## V2 Routes

- `GET /api/v2/challenges`
- `POST /api/v2/challenges` (optional `nominateForDaily`; returns challenge,
  `created`/`existing` disposition, and nomination disposition)
- `GET /api/v2/accounts/me/capabilities`
- `GET /api/v2/admin/dailies`
- `POST /api/v2/admin/daily-nominations/:id/approve` (optional flavor override)
- `POST /api/v2/admin/daily-nominations/:id/decline`
- `POST /api/v2/admin/daily-queue` (direct promotion with challenge ID/flavor)
- `DELETE /api/v2/admin/daily-queue/:id`
- `POST /api/v2/runs/start`
- `GET /api/v2/runs/active`
- `POST /api/v2/runs/:runId/click`
- `POST /api/v2/runs/:runId/abandon`
- `GET /api/v2/runs/:runId/recovery-path` (authenticated active-run recovery)
- `GET /api/v2/runs/:runId/path`
- `GET /api/v2/challenges/:challengeId/leaderboard`
- `GET /api/v2/accounts/me/stats`

Identity compatibility routes remain under `/api/identity/*`. Old run and
challenge routes remain bounded compatibility surfaces, but new clients should
use v2.

## Production Smoke Test

1. Open `https://vwikirace.pages.dev/?challenge=challenge-0002` and confirm the
   header and selected row stay on Challenge #2. Confirm its target preview has
   a short lead and source attribution without playable links.
2. Start as an existing claimed account; it should not show the identity dialog.
3. Start as a returning ghost; Claim should be primary and Continue as Guest
   should preserve that ghost.
4. Confirm the start article appears only after the run is accepted and the
   timer begins at zero.
5. Click a table/prose/infobox game link. Syncing feedback should appear
   immediately. The sanitized destination may render while the mutation is in
   flight, but the official path/click count must remain unchanged until server
   acceptance; a rejected mutation must restore the accepted article.
6. Complete a run. Confirm speed, click count, personal-best context, and lazy
   winning-path disclosure on that challenge's leaderboard.
7. Open Stats and confirm server totals plus top starts, targets, and visited
   pages.
8. Create a challenge from two valid Wikipedia URLs. Confirm its canonical
   titles, creator, next global number, direct URL, and separate leaderboard.
9. Create a challenge as a claimed account with and without the nomination
   checkbox. Confirm guest nomination requests return `account_required`,
   duplicate pairs reuse the existing challenge without consuming a number, and
   repeated nominations are idempotent.
10. As the configured admin account, confirm capability, pending nomination
   review, suggested/override flavor approval, direct promotion, queue removal,
   and queue-first catalog provenance.
11. Confirm the catalog accepts both manual and current/historical Daily
   provenance rows.

## Failure Triage

- `no such table/column`: migration was skipped or Worker deployed too early.
- catalog rejected after daily creation: verify Pages is on the client build
  that accepts coherent `wikipedia_random` provenance.
- guest/login failures: verify `VGAMES_URL` and VGames health; do not create a
  local identity fallback.
- CORS failures: add the exact Pages origin to `ALLOWED_ORIGINS`.
- missing finish: confirm the run reached an accepted protocol-2 target click
  and is `ranked_eligible`. A DNF requires at least one accepted click.
- daily job retries: inspect structured `daily_challenge_job` and
  `daily_challenge_candidate` logs plus D1 job status. Candidate diagnostics are
  bounded to boundary/status/error metadata. Confirm the queue was checked
  first, then inspect pool cache age, candidate bounds, and the 25-second/40-
  request limits. Upstream and persistence failures must leave the durable job
  pending for bounded backoff/retry; do not loop cron calls or manually spray
  Wikipedia requests.
- admin `403`: verify the claimed account's immutable ID is present in
  `DAILY_ADMIN_ACCOUNT_IDS`; display names and ghost accounts are not accepted.
- queue selection conflict: the scheduler should skip the raced entry and try
  the bounded queue-selection retries before falling back to editorial pools.
- unexpectedly high request count: remove all three scheduled triggers in one
  reviewed Worker deploy, then inspect lease/job state. Never restore historical
  `7 * * * *` scheduling.

## Safety

Do not commit Cloudflare credentials, VGames secrets, session tokens, or D1
exports. Do not bind D1 to Pages Functions. Do not deploy, push, or mutate remote
data from an unreviewed dirty worktree.
