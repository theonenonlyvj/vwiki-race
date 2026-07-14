# Vikipedia Cloudflare Deployment Handoff

Date: 2026-07-14

## Current State

- GitHub repo: `https://github.com/theonenonlyvj/vikipedia.git`
- Production branch: `main`
- Last pushed app commit before this handoff: `64772e4`
- Deployment status: not deployed yet
- Intended host: Cloudflare Pages
- Intended database: Supabase
- VGames integration: intentionally deferred to v1/v2

The current v0 is designed to be tracked from game 0. The browser stores only a
player id and display name. Challenges, runs, clicks, completions, paths, and
leaderboards are stored server-side through Cloudflare Pages Functions and
Supabase.

## Verified Before Handoff

These commands passed locally on 2026-07-14:

```bash
npm test
npm run build
```

Last known results:

- `npm test`: 18 test files passed, 48 tests passed
- `npm run build`: TypeScript and Vite production build passed

## Deployment Architecture

- Static app: Vite/React build output in `dist`
- API layer: Cloudflare Pages Functions in `functions/api/*`
- Database: Supabase Postgres
- Migration: `supabase/migrations/0001_vikipedia_v0_tracking.sql`
- Server-only secrets:
  - `SUPABASE_URL`
  - `SUPABASE_SERVICE_ROLE_KEY`

Do not expose `SUPABASE_SERVICE_ROLE_KEY` to the browser. It must be configured
as a Cloudflare Pages secret/environment value for Functions only.

## Step 1: Prepare Supabase

1. Open Supabase.
2. Create or select the Vikipedia Supabase project.
3. Open SQL Editor.
4. Run the full contents of:

```txt
supabase/migrations/0001_vikipedia_v0_tracking.sql
```

5. In Supabase Project Settings > API, copy:
   - Project URL as `SUPABASE_URL`
   - Service role key as `SUPABASE_SERVICE_ROLE_KEY`

## Step 2: Create Cloudflare Pages Project

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

## Step 3: Add Cloudflare Environment Values

In the Cloudflare Pages project:

1. Go to Settings.
2. Open Variables and Secrets, or Environment variables depending on dashboard
   wording.
3. Add production values:

```txt
SUPABASE_URL = <Supabase project URL>
SUPABASE_SERVICE_ROLE_KEY = <Supabase service role key>
```

Make `SUPABASE_SERVICE_ROLE_KEY` encrypted/secret if the dashboard offers a
choice.

If the first deploy was started before adding these values, redeploy after
adding them.

## Step 4: Deploy

Trigger the production deploy from Cloudflare Pages. Cloudflare should:

1. Install npm dependencies.
2. Run `npm run build`.
3. Upload `dist`.
4. Attach Pages Functions from `functions/api/*`.

The first live URL should be similar to:

```txt
https://vikipedia.pages.dev
```

## Step 5: Smoke Test Production

After deploy completes, test:

```txt
https://vikipedia.pages.dev/api/challenges
```

Expected result: JSON with at least `challenge-0001`.

Then test the app flow:

1. Open `https://vikipedia.pages.dev`.
2. Enter a display name.
3. Confirm `Challenge #1` shows `Moon -> Gravity`.
4. Start the challenge.
5. Click one Wikipedia link.
6. Check that the click path updates.
7. Open the Leaderboard tab.

If API requests fail, check Cloudflare deployment logs first, then verify that
both Supabase secrets exist in the Pages production environment.

## Useful Routes

- `GET /api/challenges`
- `POST /api/challenges`
- `GET /api/challenges/:challengeId/leaderboard`
- `POST /api/players`
- `POST /api/runs/start`
- `POST /api/runs/:runId/click`
- `GET /api/runs/:runId/path`
- `POST /api/runs/:runId/complete`
- `POST /api/runs/:runId/abandon`

## Common Failure Modes

- Build fails: confirm Cloudflare is running from repo root and using
  `npm run build` with output directory `dist`.
- `/api/challenges` returns a config error: add or fix `SUPABASE_URL` and
  `SUPABASE_SERVICE_ROLE_KEY`, then redeploy.
- `/api/challenges` returns a database/table error: run the Supabase migration.
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
- `docs/superpowers/specs/2026-07-14-server-tracked-v0-design.md`
- `docs/superpowers/plans/2026-07-14-server-tracked-v0.md`

Do not commit real Supabase keys or Cloudflare tokens. Keep VGames integration
out of v0 unless Vijay explicitly reopens that scope.

## Recommended Next Work

1. Deploy to Cloudflare Pages using the checklist above.
2. Verify `/api/challenges` and a full run in production.
3. Add a custom domain if Vijay wants one.
4. Add basic production observability after friends start playing.
5. Revisit VGames account integration only after the standalone v0 is playable.
