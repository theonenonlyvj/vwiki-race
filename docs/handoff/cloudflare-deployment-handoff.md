# VWiki Race Cloudflare Deployment Handoff

Date: 2026-07-14

## Current State

- GitHub repo: `https://github.com/theonenonlyvj/vwiki-race.git`
- Production branch: `main`
- Current implementation: VGames identity + D1 tracking is in `main`
- Cloudflare Pages project: `vwikirace`
- Production URL: `https://vwikirace.pages.dev`
- Identity: VGames identity worker
- Run data store: Cloudflare D1 database `vwiki-race`
- VGames realtime rooms: not needed for VWiki Race v0

The current v0 is designed to be tracked from game 0. VGames owns account
identity, including ghost guests and secured unique names. VWiki Race owns
challenges, runs, clicks, completions, paths, and per-challenge leaderboards.
Guest play must be claimable later into a secured VGames name without losing
stats.

## Superseding Note

The earlier standalone Supabase launch path is superseded. Supabase code,
migration files, and the VWiki Race-local `players` namespace have been removed
from the current implementation. Do not recreate them for v0.

## Verified Before Handoff

These commands passed locally on 2026-07-14:

```bash
npm test
npm run build
```

Last known results:

- `npm test`: 16 test files passed, 59 tests passed
- `npm run build`: TypeScript and Vite production build passed
- viota targeted worker test: `pnpm exec vitest run test/accounts.test.ts
  --reporter=verbose` passed outside the sandbox

## Deployment Architecture

- Static app: Vite/React build output in `dist`
- Canonical API layer: Cloudflare Worker in `src/server/worker.ts`
- Compatibility API layer: bounded Pages proxies in `functions/api/*`
- Identity: VGames worker at `https://viota-worker.theonenonlyvj.workers.dev`
- VWiki Race data: Cloudflare D1 tables keyed by VGames `account_id`
- Realtime rooms: not applicable

Do not duplicate VGames accounts with a standalone VWiki Race player identity.

## Step 1: VGames Identity Fit

Implemented locally:

1. Guest play calls VGames `/auth/quick`.
2. New VGames ghost accounts are created with `game: 'vwiki-race'`.
3. Securing a display name claims the current ghost through VGames
   `/auth/set-credentials`.
4. Existing users can use VGames `/auth/login`.
5. VWiki Race run rows store VGames `account_id`, not a local `players.id`.
6. Leaderboards display the secured VGames unique name/handle when available.
7. Guest stats remain claimable when the guest later secures or logs into an
   account.

VGames-side change in `/Users/vijayram/Cursor/viota`: `vwiki-race` was added to
the allowed `origin_game` values and covered by
`packages/worker/test/accounts.test.ts`. That change is pushed to viota `main`
as `899520f` and deployed to the viota worker as version
`ba23146a-71c1-4ffe-814a-429cdff4cb08`.

## Step 2: Create D1

Use one D1 database for VWiki Race-owned data.

Recommended database name:

```txt
vwiki-race
```

Required canonical Worker binding name:

```txt
VWIKI_RACE_DB
```

Migration file:

```txt
d1/migrations/0001_vwiki_race_tracking.sql
```

Created database id:

```txt
bbd89b81-078a-47e0-9db4-5d170a3f78b4
```

Dashboard path: Workers & Pages -> D1 SQL Database -> Create database, then
apply the SQL migration. CLI equivalent if wrangler is available:

```bash
wrangler d1 create vwiki-race
wrangler d1 migrations apply vwiki-race --remote --migrations-dir d1/migrations
```

## Step 3: Cloudflare Pages Project

The `vwikirace` Pages project has been created. If rebuilding manually:

1. Open Cloudflare dashboard.
2. Go to Workers & Pages.
3. Select Create application.
4. Select Pages.
5. Select Import from an existing Git repository.
6. Connect GitHub if prompted.
7. Choose repo: `theonenonlyvj/vwiki-race`.

Use these build settings:

```txt
Project name: vwikirace
Production branch: main
Framework preset: React / Vite, or None if entering manually
Root directory: /
Build command: npm run build
Build output directory: dist
Functions directory: functions
```

The repo root is already the VWiki Race app, so do not set a nested root
directory.

## Step 4: Add Cloudflare Environment Values

Set the VGames identity origin and D1 binding on the canonical API Worker:

```txt
VGAMES_URL = https://viota-worker.theonenonlyvj.workers.dev
```

Bind the D1 database to that Worker:

```txt
Binding name: VWIKI_RACE_DB
Database: vwiki-race
```

Set both frontend and retained Pages compatibility routing to the same
canonical Worker origin:

```txt
VITE_VWIKI_RACE_API_URL = https://<vwiki-race-api-worker>
VWIKI_RACE_API_URL = https://<vwiki-race-api-worker>
```

Do not bind D1 or `VGAMES_URL` to the Pages Functions. Retained `/api/*`
Functions enforce the 16 KiB request limit and proxy to the Worker so stale
clients cannot bypass canonical authorization, quotas, rate limits, or path
disclosure policy.

## Step 5: Deploy

Trigger the production deploy from Cloudflare Pages. Cloudflare should:

1. Install npm dependencies.
2. Run `npm run build`.
3. Upload `dist`.
4. Attach Pages Functions from `functions/api/*`.

The first live URL should be similar to:

```txt
https://vwikirace.pages.dev
```

## Step 6: Smoke Test Production

After deploy completes, test:

```txt
https://vwikirace.pages.dev/api/challenges
```

Expected result: JSON with at least `challenge-0001`.

Then test the app flow:

1. Open `https://vwikirace.pages.dev`.
2. Enter a display name.
3. Confirm `Challenge #1` shows `Moon -> Gravity`.
4. Start the challenge.
5. Click one Wikipedia link.
6. Check that the click path updates.
7. Open the Leaderboard tab.
8. Confirm the leaderboard row is associated with the VGames identity.

If API requests fail, check Worker and Pages deployment logs first, then verify
that `VGAMES_URL` and `VWIKI_RACE_DB` exist on the Worker and
`VWIKI_RACE_API_URL` exists on Pages.

## Useful Routes

- `GET /api/challenges`
- `POST /api/challenges`
- `GET /api/challenges/:challengeId/leaderboard`
- `POST /api/identity/guest`
- `POST /api/identity/secure`
- `POST /api/identity/login`
- `POST /api/runs/start`
- `POST /api/runs/:runId/click`
- `GET /api/runs/:runId/path`
- `POST /api/runs/:runId/complete`
- `POST /api/runs/:runId/abandon`

## Common Failure Modes

- Build fails: confirm Cloudflare is running from repo root and using
  `npm run build` with output directory `dist`.
- Guest auth fails: confirm `VGAMES_URL` points at the viota worker and that the
  viota worker deployment includes `game: 'vwiki-race'`.
- D1 errors: confirm the canonical Worker binding is exactly `VWIKI_RACE_DB`
  and the migration has been applied; Pages must not have direct D1 access.
- Leaderboard identity is wrong: confirm runs are keyed by VGames `account_id`
  and display uses the canonical secured VGames name/handle when present.
- The frontend loads but cannot play: inspect browser network requests to
  `/api/*` and Cloudflare Pages Function logs.
- Leaderboard is empty: complete at least one run; localStorage alone does not
  create leaderboard rows in v0.

## Handoff Notes For The Next Agent

Start with:

```bash
cd /Users/vijayram/Cursor/vwiki-race
git status --short --branch
npm test
npm run build
```

Before changing deployment code, read:

- `README.md`
- `AGENTS.md`
- `docs/game-principles-and-rules.md`
- `docs/superpowers/specs/2026-07-14-vgames-identity-v0-design.md`
- `docs/superpowers/specs/2026-07-14-server-tracked-v0-design.md`
- `docs/superpowers/plans/2026-07-14-server-tracked-v0.md`

Do not commit Cloudflare tokens or VGames secrets.

## Recommended Next Work

1. Inspect the latest Cloudflare Pages deployment and logs if production
   behavior differs from local.
2. Verify guest play, `/api/challenges`, and a full run in
   production.
3. Implement challenge deep links and Wikipedia node validation from
   `docs/backlog.md`.
4. Add a custom domain if Vijay wants one.
