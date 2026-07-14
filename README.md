# Vikipedia

Vikipedia is a Wikipedia navigation game: players start on one article and race
to a target article by clicking valid internal Wikipedia links.

The current v0 direction is server-tracked from game 0 and should use VGames
identity from the beginning. Vikipedia remains challenge-leaderboard based; it
does not need VGames realtime rooms or the card-game layer.

## Current Docs

- [Game Principles and Rules](docs/game-principles-and-rules.md)
- [Server-Tracked V0 Spec](docs/superpowers/specs/2026-07-14-server-tracked-v0-design.md)
- [VGames Identity V0 Spec](docs/superpowers/specs/2026-07-14-vgames-identity-v0-design.md)
- [Server-Tracked V0 Plan](docs/superpowers/plans/2026-07-14-server-tracked-v0.md)
- [Cloudflare Deployment Handoff](docs/handoff/cloudflare-deployment-handoff.md)

## V0 Product Shape

- `challenge-0001` is `Challenge #1`: `Moon` to `Gravity`.
- Players can create new challenges by entering start and target article titles;
  the server assigns the next `Challenge #N` number.
- The unique VGames name/handle is the canonical public identity.
- Guests can play through a VGames ghost account and claim their stats later.
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

The frontend expects `/api/*` routes. The previously documented standalone
Supabase launch is paused while Vikipedia is fitted to VGames identity.

```bash
npm run build
```

## Identity And Data

VGames owns accounts, unique names/handles, guest ghosts, login, and account
merges. Vikipedia should own challenges, runs, click events, path steps, and
per-challenge leaderboards keyed by VGames `account_id`.

Do not create a Vikipedia-local `players` namespace for public launch unless a
later implementation plan explicitly justifies it.

## Cloudflare Pages

For Cloudflare Pages:

- Build command: `npm run build`
- Build output directory: `dist`
- Functions directory: `functions`
- Identity origin: `https://viota-worker.theonenonlyvj.workers.dev`

## VGames

VGames integration is in scope for v0 identity. Realtime rooms are not in scope
for Vikipedia v0 because gameplay is asynchronous challenge attempts.
