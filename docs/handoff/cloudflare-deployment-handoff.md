# VWiki Race Cloudflare Deployment Handoff

Date: 2026-07-15

Status: release procedures and production inventory for the current hardening
release. Verify the live commit and deployment state before any future rollout;
this file is not an incident log.

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
5. The API Worker runs `7 * * * *` in UTC. Only a claimed D1 daily-job lease may
   contact Wikipedia; accepted days make no Wikipedia request.

## Data And Game Guarantees

- Every run is stored server-side from its accepted start.
- Protocol 2 accepts only canonical transitions from the server-accepted current
  page and completes only through the accepted target click.
- Leaderboards sort by active decision time, then clicks, then accepted
  completion time.
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
- Daily generation uses two separate MediaWiki random requests and one start
  render per pair, at most three pairs/nine Wikipedia calls, with five-second
  request and 25-second phase limits.

## Required Configuration

Canonical Worker variables:

```txt
VGAMES_URL=https://vgames-identity.theonenonlyvj.workers.dev
ALLOWED_ORIGINS=https://vwikirace.pages.dev
```

Canonical Worker bindings:

```txt
VWIKI_RACE_DB -> D1 database vwiki-race
VGAMES_IDENTITY -> Worker service vgames-identity
CLICK_RATE_LIMITER -> configured rate-limit namespace
ACCOUNT_READ_RATE_LIMITER -> configured rate-limit namespace
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
Production branch: main
Root directory: /
Build command: npm run build
Build output directory: dist
Functions directory: functions
```

## Migrations

Apply all files in order:

```txt
d1/migrations/0001_vwiki_race_tracking.sql
d1/migrations/0002_challenge_creators.sql
d1/migrations/0003_hardening_protocol.sql
d1/migrations/0004_daily_challenges.sql
```

`0003` has already been applied and must remain unchanged. `0004` adds challenge
provenance, the shared number sequence, daily jobs, and daily-date uniqueness.
Apply migrations before deploying Worker code that references their tables or
columns.

Remote command:

```bash
npx wrangler d1 migrations apply vwiki-race --remote --config wrangler.api.toml
```

## Fixed Rollout Order

Do not reverse these steps.

1. Confirm the VGames identity Worker is healthy.
2. Run all local release gates listed below.
3. Apply D1 migrations remotely and inspect the migration result.
4. Deploy the canonical API Worker from `wrangler.api.toml`.
5. Smoke-test the canonical Worker directly, including the v2 challenge catalog.
6. Set both Pages API-origin environment values to that Worker origin.
7. Deploy the Pages project from the reviewed commit.
8. Smoke-test a guest/claimed start, one click, completion, path disclosure,
   stats, direct challenge link, and challenge creation.
9. Confirm the cron trigger is present. Do not manually fan out scheduled
   invocations; one normal invocation is enough for a smoke test.

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
- `POST /api/v2/challenges`
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
   immediately, and the old article must remain until server acceptance.
6. Complete a run. Confirm speed, click count, personal-best context, and lazy
   winning-path disclosure on that challenge's leaderboard.
7. Open Stats and confirm server totals plus top starts, targets, and visited
   pages.
8. Create a challenge from two valid Wikipedia URLs. Confirm its canonical
   titles, creator, next global number, direct URL, and separate leaderboard.
9. Confirm the catalog accepts both manual and daily provenance rows.

## Failure Triage

- `no such table/column`: migration was skipped or Worker deployed too early.
- catalog rejected after daily creation: verify Pages is on the client build
  that accepts coherent `wikipedia_random` provenance.
- guest/login failures: verify `VGAMES_URL` and VGames health; do not create a
  local identity fallback.
- CORS failures: add the exact Pages origin to `ALLOWED_ORIGINS`.
- empty leaderboard: confirm the run reached an accepted protocol-2 target click
  and is `ranked_eligible`.
- daily job retries: inspect structured `daily_challenge_job` and
  `daily_challenge_candidate` logs plus D1 job status. Candidate diagnostics are
  bounded to boundary/status/error metadata. Do not loop cron calls or manually
  spray Wikipedia requests.
- unexpectedly high request count: disable the cron trigger in a reviewed Worker
  deploy and inspect lease/job state before testing again.

## Safety

Do not commit Cloudflare credentials, VGames secrets, session tokens, or D1
exports. Do not bind D1 to Pages Functions. Do not deploy, push, or mutate remote
data from an unreviewed dirty worktree.
