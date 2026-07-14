# Vikipedia Cloudflare Deployment Handoff

Date: 2026-07-14

## Current State

- GitHub repo: `https://github.com/theonenonlyvj/vikipedia.git`
- Production branch: `main`
- Last pushed app commit before this handoff: `64772e4`
- Deployment status: not deployed yet
- Intended host: Cloudflare Pages
- Intended identity: VGames identity worker
- Intended run data store: undecided; prefer Cloudflare D1 unless Supabase is
  intentionally retained only for Vikipedia-owned run data
- VGames realtime rooms: not needed for Vikipedia v0

The current v0 is designed to be tracked from game 0. VGames owns account
identity, including ghost guests and secured unique names. Vikipedia owns
challenges, runs, clicks, completions, paths, and per-challenge leaderboards.
Guest play must be claimable later into a secured VGames name without losing
stats.

## Superseding Note

The earlier standalone Supabase launch path is paused. Do not create the
Vikipedia Supabase project as the next step unless Vijay explicitly decides to
keep Supabase only for Vikipedia-owned run data. The next implementation should
use VGames identity from day one and remove the Vikipedia-local `players`
namespace before public launch.

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
- Identity: VGames worker at `https://viota-worker.theonenonlyvj.workers.dev`
- Vikipedia data: challenge/run/click/path tables keyed by VGames `account_id`
- Realtime rooms: not applicable

Do not duplicate VGames accounts with a standalone Vikipedia player identity.

## Step 1: Fit Vikipedia To VGames Identity

Before deployment, update the app/API so:

1. Guest play calls VGames `/auth/quick`.
2. New VGames ghost accounts are created with `game: 'vikipedia'`.
3. Securing a display name claims the current ghost through VGames
   `/auth/set-credentials`.
4. Existing users can use VGames `/auth/login`.
5. Vikipedia run rows store VGames `account_id`, not a local `players.id`.
6. Leaderboards display the secured VGames unique name/handle when available.
7. Guest stats remain claimable when the guest later secures or logs into an
   account.

Required VGames-side change: add `vikipedia` to the allowed `origin_game`
values in viota's identity worker before launch.

## Step 2: Choose Vikipedia Run Data Store

Recommended default: Cloudflare D1, to stay aligned with VGames' Cloudflare/D1
platform direction.

Acceptable alternative: Supabase only for Vikipedia-owned challenge/run/click
data, keyed by VGames `account_id`. Do not use Supabase for a separate player
identity namespace.

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

Exact values depend on the implementation plan. At minimum the app needs the
VGames identity origin:

```txt
VGAMES_URL = https://viota-worker.theonenonlyvj.workers.dev
```

If Vikipedia run data is stored in D1, bind that D1 database to the Pages
Functions project. If it is intentionally stored in Supabase, use server-only
Supabase secrets and do not expose the service role key to the browser.

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
- Guest auth fails: confirm VGames worker CORS allows the Vikipedia Pages origin
  and that `/auth/quick` accepts `game: 'vikipedia'`.
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

Do not commit real Supabase keys, Cloudflare tokens, or VGames secrets.

## Recommended Next Work

1. Update implementation to use VGames identity and remove local `players`.
2. Decide D1 vs Supabase for Vikipedia-owned run data.
3. Deploy to Cloudflare Pages using the checklist above.
4. Verify guest play, secure-name claim, `/api/challenges`, and a full run in
   production.
5. Add a custom domain if Vijay wants one.
