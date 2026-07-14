# VGames Identity V0 Design

## Purpose

Vikipedia should fit the VGames platform from the beginning without inheriting
the realtime/card-game room layer. The game is asynchronous and
challenge-leaderboard based: it does not matter whether two players press
Start at the same time. It only matters that every run is tracked against the
right identity and challenge.

This design supersedes the earlier standalone-Supabase identity assumption in
`2026-07-14-server-tracked-v0-design.md`.

## Locked Decisions

- Vikipedia uses VGames identity from v0.
- Vikipedia does not use VGames realtime rooms.
- Vikipedia does not use the card-game layer.
- Vikipedia owns its challenge/run/click/path data.
- The canonical public name is the unique VGames name/handle.
- Guests are real unclaimed VGames accounts, not local-only throwaway players.
- Guest stats must remain claimable when the user later secures a name.

## Product Model

The landing page should make account creation the preferred path while keeping
guest play available:

```txt
Vikipedia

Secure your display name.
Track your runs, leaderboards, and stats across challenges.

[ Secure display name / Log in ]

[ Play as guest ]
```

The primary call to action is securing a VGames name. `Play as guest` should be
visually available but secondary. A guest still gets server-tracked runs and can
later claim those runs into a secured VGames account.

## Identity States

### Guest

A guest is a VGames ghost account created through `/auth/quick`.

Client state:

- A 256-bit device credential in localStorage.
- A VGames JWT.
- The VGames `accountId`.
- A display label for local UI convenience.

Server state:

- `accounts.status = 'ghost'`.
- `origin_game = 'vikipedia'`.
- `device_credentials` maps the device credential hash to the ghost account.
- Vikipedia runs reference the VGames `account_id`.

Guest leaderboard entries should display a guest-safe name, not a permanent
claim to a unique VGames handle.

### Secured Account

A secured account is a claimed VGames account with a unique name/handle. That
unique VGames name takes priority on public leaderboards and profile surfaces.

The secure flow can be:

1. The user enters a unique VGames name/handle.
2. The user sets credentials.
3. The app calls `/auth/set-credentials` for the current ghost account, or
   `/auth/login` if they already have a secured account.
4. The same VGames `account_id`, or the canonical merged account id, remains the
   owner of their Vikipedia runs.

### Claiming Guest Stats

If the user has played as a guest and later secures that same browser/device,
the simplest path is in-place claim:

- Existing ghost account: `ghost`
- Action: `/auth/set-credentials`
- Result: same `account_id`, status becomes `claimed`
- Vikipedia stats require no migration because runs already point at that
  `account_id`.

If the user logs into an existing VGames account from a device that already has
a Vikipedia guest account, VGames' login ghost-fold behavior should merge the
device ghost into the logged-in canonical account. Vikipedia must store runs by
VGames account id and resolve leaderboard display through the canonical account
identity so stats follow the person.

## Data Ownership

VGames owns:

- Accounts
- Device credentials
- Unique names/handles
- Password login
- Ghost-to-claimed lifecycle
- Account merges/canonicalization

Vikipedia owns:

- Challenges
- Runs
- Click events
- Path steps
- Per-challenge leaderboards
- Vikipedia-specific stats such as top starts, top targets, most visited pages,
  bridge pages, common jumps, and completion speed.

## Data Model Direction

Do not create a Vikipedia-local `players` namespace for public launch. Replace
`player_id` with a VGames account reference.

Minimum Vikipedia tables:

- `challenges`
- `runs`
- `run_events`
- `run_path_steps`

`runs` should include:

- `account_id`: VGames account id.
- `challenge_id`.
- `status`.
- `started_at`, `completed_at`, `abandoned_at`.
- `elapsed_ms`, `click_count`.
- start/target/final title snapshots.

Leaderboards are per challenge. Sorting stays:

1. lowest `elapsed_ms`;
2. lowest `click_count`;
3. earliest `completed_at`.

VGames' current cross-game leaderboard views are not sufficient for Vikipedia
because they group by `game_type` and do not include a mode/challenge dimension.
Vikipedia should use its own leaderboard queries for v0.

## API Direction

Vikipedia API calls that create or mutate runs should require a VGames identity
token or server-verified account id.

Frontend identity calls:

- Guest start: call VGames `/auth/quick` with `{ deviceCredential, displayName,
  game: 'vikipedia' }`.
- Secure current guest: call VGames `/auth/set-credentials`.
- Existing user login: call VGames `/auth/login`.

Vikipedia run calls:

- `GET /api/challenges`
- `POST /api/challenges`
- `POST /api/runs/start`
- `POST /api/runs/:runId/click`
- `POST /api/runs/:runId/complete`
- `POST /api/runs/:runId/abandon`
- `GET /api/challenges/:challengeId/leaderboard`
- `GET /api/runs/:runId/path`

`POST /api/players` should be removed or replaced with an identity-bootstrap
flow that delegates to VGames.

## Platform Fit

This follows the VGames two-ring reframe:

- Ring 0 identity: shared now.
- Ring A realtime room primitive: not needed for Vikipedia v0.
- Ring B turn-based card-game layer: not applicable.

Vikipedia is a challenge leaderboard game, not a synchronous room game.

## Deployment Implication

Do not launch a new standalone Supabase identity/player project as the next
step. The next implementation plan should decide where Vikipedia challenge/run
tables live:

1. Prefer Cloudflare D1 if keeping the VGames stack cohesive is more important
   than Postgres conveniences.
2. Use Supabase only for Vikipedia-owned run data if there is a strong query or
   operations reason, and still key every run by VGames `account_id`.

Either way, VGames identity is the source of truth for player identity.

## Required VGames Change

The live VGames `/auth/quick` endpoint currently only recognizes `origin_game`
values `iota` and `jaipur`. Add `vikipedia` before launch so new ghost accounts
created from Vikipedia are stamped correctly.

## Open Implementation Questions

- Should the Vikipedia data store be Cloudflare D1 beside VGames, or Supabase
  keyed by VGames `account_id`?
- Should guests pick a temporary display label before playing, or default to a
  generated guest label until they secure a VGames name?
- Should public leaderboards hide guest labels behind `Guest ####` until the
  account is secured?
- Should securing a VGames name be required before creating new challenges?
