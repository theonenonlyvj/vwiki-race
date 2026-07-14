# Vikipedia

Vikipedia is a Wikipedia navigation game: players start on one article and race
to a target article by clicking valid internal Wikipedia links.

The current v0 is server-tracked from game 0. Challenges, players, runs, click
events, paths, completions, and leaderboard rows go through Cloudflare Pages
Functions and are stored in Supabase. Browser storage is used only to remember a
player id and display name.

## Current Docs

- [Game Principles and Rules](docs/game-principles-and-rules.md)
- [Server-Tracked V0 Spec](docs/superpowers/specs/2026-07-14-server-tracked-v0-design.md)
- [Server-Tracked V0 Plan](docs/superpowers/plans/2026-07-14-server-tracked-v0.md)
- [Cloudflare Deployment Handoff](docs/handoff/cloudflare-deployment-handoff.md)

## V0 Product Shape

- `challenge-0001` is `Challenge #1`: `Moon` to `Gravity`.
- Players can create new challenges by entering start and target article titles;
  the server assigns the next `Challenge #N` number.
- Display name is required before starting a run.
- Leaderboards rank by fastest elapsed time, then fewest clicks, then earliest
  completion.
- Each click records source title, anchor text, requested title, resolved
  destination, destination page id, and timestamps.
- The article body is rendered from live Wikipedia HTML with app chrome around
  it.

## Local Development

Install dependencies:

```bash
npm install
```

Run tests:

```bash
npm test
```

Run the frontend only:

```bash
npm run dev -- --host 127.0.0.1
```

The frontend expects `/api/*` routes. To exercise the tracked app locally, apply
the Supabase migration, set the Cloudflare environment variables below, build,
and run the site with Cloudflare Pages Functions:

```bash
npm run build
npx wrangler pages dev dist
```

## Supabase

Create a separate Supabase project for Vikipedia v0, then run:

```bash
supabase/migrations/0001_vikipedia_v0_tracking.sql
```

Required server-only environment variables:

```bash
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=replace-with-cloudflare-secret
```

Do not expose `SUPABASE_SERVICE_ROLE_KEY` to the browser.

## Cloudflare Pages

For Cloudflare Pages:

- Build command: `npm run build`
- Build output directory: `dist`
- Functions directory: `functions`
- Secrets: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`

## VGames

VGames integration is intentionally out of scope for v0. The current player
model is a display-name player record that can later be linked or migrated into
the VGames account platform.
