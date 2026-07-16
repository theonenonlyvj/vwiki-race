# VWiki Race

VWiki Race is a Wikipedia navigation game: players start on one article and race
to a target article by clicking valid internal Wikipedia links.

Every run is server-tracked from game 0 with VGames identity and a VWiki
Race-owned Cloudflare D1 database. The game is challenge-leaderboard based; it
does not need VGames realtime rooms or the card-game layer.

## Operational Docs

- [Game Principles and Rules](docs/game-principles-and-rules.md)
- [Cloudflare Deployment Handoff](docs/handoff/cloudflare-deployment-handoff.md)
- [2026-07-16 Friend Release Handoff](docs/handoff/2026-07-16-friend-release-handoff.md)
- [Backlog](docs/backlog.md)

Dated files under `docs/superpowers/` are historical design records. Preserve
them for provenance, but do not execute one without reconciling it against the
current source, configuration, and operational handoffs above.

## V0 Product Shape

- `challenge-0001` is `Challenge #1`: `Moon` to `Gravity`.
- Players can create challenges from Wikipedia titles or article URLs. The
  Worker canonicalizes and validates both nodes before an atomic D1 insert.
- Manual and daily challenges share one global transactional number sequence.
  If `#15` exists, the next accepted challenge is `#16`, regardless of date or
  creator.
- A DST-safe 5:00 AM `America/Chicago` job eventually creates one random,
  validated challenge per Central date. The date is provenance, never the
  challenge number.
- The unique VGames name/handle is the canonical public identity.
- Guests can play through a VGames ghost account and claim their stats later.
- The identity prompt appears only before Start or Create. Returning ghosts are
  encouraged to claim their name but can continue as the same guest.
- Runs, clicks, path steps, challenge creators, and leaderboard rows are written
  through the canonical Cloudflare Worker to D1, not localStorage.
- The timer measures accepted player decision time. Wikipedia fetch and server
  synchronization latency are excluded.
- Every terminal run remains in D1. Public leaderboards show every eligible
  finish plus abandons with at least one accepted click. Finishes rank by
  fastest decision time, then fewest clicks, then earliest accepted completion;
  meaningful abandons follow as `DNF`, and later attempts are marked
  `Repeat run`. Zero-click abandons remain in account statistics. Paths load
  only when disclosed.
- Each click records source title, anchor text, requested title, resolved
  destination, page/revision identity, cumulative decision time, and timestamps.
- The official client submits only links rendered by the sanitized, attributed
  game surface. Friend v0 does not yet prove server-side that a submitted
  destination was an allowed edge in the recorded source revision.
- Before a run starts, the selected target shows a short, read-only Wikipedia
  lead. Preview failure never blocks Start, and preview links cannot become
  game moves. An already-loaded link-free blurb remains available from a compact
  target disclosure during play.
- Challenge links use `/?challenge=challenge-000N` and remain stable. The
  selected challenge exposes a Copy challenge link action before play and on
  the result screen.

## Local Development

Install dependencies:

```bash
npm install
```

Run tests:

```bash
npm test
```

Run the frontend against a local Worker:

```bash
VITE_VWIKI_RACE_API_URL=http://127.0.0.1:8787 npm run dev -- --host 127.0.0.1
```

Production builds require an HTTPS canonical Worker origin:

```bash
VITE_VWIKI_RACE_API_URL=https://vwikirace-api.example.workers.dev npm run build
```

Run the complete test gates:

```bash
npm test
npm run test:worker
npm run build
```

The canonical Worker needs:

- `VGAMES_URL`
- `ALLOWED_ORIGINS`
- D1 binding `VWIKI_RACE_DB`
- rate-limit bindings `CLICK_RATE_LIMITER` and `ACCOUNT_READ_RATE_LIMITER`
- rate-limit binding `CHALLENGE_CREATE_RATE_LIMITER`

## Identity And Data

VGames owns accounts, unique names/handles, guest ghosts, login, and account
merges. VWiki Race should own challenges, runs, click events, path steps, and
per-challenge leaderboards keyed by VGames `account_id` in D1.

Do not create a VWiki Race-local `players` namespace. The removed local
prototype repositories were intentionally replaced by VGames sessions and D1.

## Cloudflare Architecture

- Pages hosts the static Vite build at `vwikirace.pages.dev`.
- `vwikirace-api` is the only canonical API and the only process with D1.
- Retained Pages Functions are bounded compatibility proxies for old `/api/*`
  clients; they do not bind D1 or duplicate authorization logic.
- The API Worker has `0 10 * * *` and `0 11 * * *` UTC triggers for 5:00 AM
  Central plus `17 * * * *` for due-job retries. Only the 5:00 AM event may
  create a new date; the retry trigger never contacts Wikipedia without a due
  D1 job.

Pages build settings:

- Build command: `npm run build`
- Build output directory: `dist`
- Functions directory: `functions`

Apply every migration in order from `d1/migrations/` before deploying the
Worker that depends on it. Never rewrite an already-applied migration.

## VGames

VGames integration is in scope for v0 identity. Realtime rooms are not in scope
for VWiki Race v0 because gameplay is asynchronous challenge attempts.
