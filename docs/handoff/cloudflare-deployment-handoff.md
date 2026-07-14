# Vikipedia Cloudflare Deployment Handoff

Date: 2026-07-14

## Current State

- GitHub repo: `https://github.com/theonenonlyvj/vikipedia.git`
- Production branch: `main`
- Latest pushed app commit for this handoff: `09a30b1`
- Current implementation: VGames identity + D1 tracking is pushed to
  `main`
- Deployment status: not deployed yet
- Intended host: Cloudflare Pages
- Intended identity: VGames identity worker
- Intended run data store: Cloudflare D1
- VGames realtime rooms: not needed for Vikipedia v0

The current v0 is designed to be tracked from game 0. VGames owns account
identity, including ghost guests and secured unique names. Vikipedia owns
challenges, runs, clicks, completions, paths, and per-challenge leaderboards.
Guest play must be claimable later into a secured VGames name without losing
stats.

## Superseding Note

The earlier standalone Supabase launch path is superseded. Supabase code,
migration files, and the Vikipedia-local `players` namespace have been removed
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
- API layer: Cloudflare Pages Functions in `functions/api/*`
- Identity: VGames worker at `https://viota-worker.theonenonlyvj.workers.dev`
- Vikipedia data: Cloudflare D1 tables keyed by VGames `account_id`
- Realtime rooms: not applicable

Do not duplicate VGames accounts with a standalone Vikipedia player identity.

## Step 1: VGames Identity Fit

Implemented locally:

1. Guest play calls VGames `/auth/quick`.
2. New VGames ghost accounts are created with `game: 'vikipedia'`.
3. Securing a display name claims the current ghost through VGames
   `/auth/set-credentials`.
4. Existing users can use VGames `/auth/login`.
5. Vikipedia run rows store VGames `account_id`, not a local `players.id`.
6. Leaderboards display the secured VGames unique name/handle when available.
7. Guest stats remain claimable when the guest later secures or logs into an
   account.

VGames-side change made locally in `/Users/vijayram/Cursor/viota`: `vikipedia`
was added to the allowed `origin_game` values and covered by
`packages/worker/test/accounts.test.ts`. That viota worker change still needs
to be committed, pushed, and deployed before the production Vikipedia launch.

## Step 2: Create D1

Use one D1 database for Vikipedia-owned data.

Recommended database name:

```txt
vikipedia
```

Required Pages binding name:

```txt
VIKIPEDIA_DB
```

Migration file:

```txt
d1/migrations/0001_vikipedia_tracking.sql
```

Dashboard path: Workers & Pages -> D1 SQL Database -> Create database, then
apply the SQL migration. CLI equivalent if wrangler is available:

```bash
wrangler d1 create vikipedia
wrangler d1 migrations apply vikipedia --remote --migrations-dir d1/migrations
```

## Step 3: Create Cloudflare Pages Project

1. Open Cloudflare dashboard.
2. Go to Workers & Pages.
3. Select Create application.
4. Select Pages.
5. Select Import from an existing Git repository.
6. Connect GitHub if prompted.
7. Choose repo: `theonenonlyvj/vikipedia`.

Use these build settings:

```txt
Project name: vikipedia
Production branch: main
Framework preset: React / Vite, or None if entering manually
Root directory: /
Build command: npm run build
Build output directory: dist
Functions directory: functions
```

The repo root is already the Vikipedia app, so do not set a nested root
directory.

## Step 4: Add Cloudflare Environment Values

Set the VGames identity origin:

```txt
VGAMES_URL = https://viota-worker.theonenonlyvj.workers.dev
```

Bind the D1 database to the Pages Functions project:

```txt
Binding name: VIKIPEDIA_DB
Database: vikipedia
```

## Step 5: Deploy

Trigger the production deploy from Cloudflare Pages. Cloudflare should:

1. Install npm dependencies.
2. Run `npm run build`.
3. Upload `dist`.
4. Attach Pages Functions from `functions/api/*`.

The first live URL should be similar to:

```txt
https://vikipedia.pages.dev
```

## Step 6: Smoke Test Production

After deploy completes, test:

```txt
https://vikipedia.pages.dev/api/challenges
```

Expected result: JSON with at least `challenge-0001`.

Then test the app flow:

1. Open `https://vikipedia.pages.dev`.
2. Choose Secure display name / Log in, or Play as guest.
3. Confirm `Challenge #1` shows `Moon -> Gravity`.
4. Start the challenge.
5. Click one Wikipedia link.
6. Check that the click path updates.
7. Open the Leaderboard tab.
8. Confirm the leaderboard row is associated with the VGames identity.

If API requests fail, check Cloudflare deployment logs first, then verify that
`VGAMES_URL` and the `VIKIPEDIA_DB` binding exist in the Pages production
environment.

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
  viota worker deployment includes `game: 'vikipedia'`.
- D1 errors: confirm the Pages Function binding is exactly `VIKIPEDIA_DB` and
  the migration has been applied.
- Leaderboard identity is wrong: confirm runs are keyed by VGames `account_id`
  and display uses the canonical secured VGames name/handle when present.
- The frontend loads but cannot play: inspect browser network requests to
  `/api/*` and Cloudflare Pages Function logs.
- Leaderboard is empty: complete at least one run; localStorage alone does not
  create leaderboard rows in v0.

## Handoff Notes For The Next Agent

Start with:

```bash
cd /Users/vijayram/Cursor/vikipedia
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

1. Commit and push/deploy the viota worker origin-game allowlist change.
2. Create/apply the Vikipedia D1 database migration.
3. Deploy to Cloudflare Pages using the checklist above.
4. Verify guest play, secure-name claim, `/api/challenges`, and a full run in
   production.
5. Add a custom domain if Vijay wants one.
