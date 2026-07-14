# Server-Tracked V0 Design

## Purpose

Vikipedia v0 must track every game on a server-owned database from the first
publicly playable challenge. Browser `localStorage` may keep convenience state
or a retry queue, but it is not the source of truth for runs, leaderboards, or
player stats.

VGames integration is explicitly deferred. V0 uses a separate Supabase project
for Vikipedia while keeping data shapes compatible with migration into a shared
game platform when that work starts.

**Superseded 2026-07-14:** Vikipedia should use VGames identity from v0 while
remaining challenge-leaderboard based and not using the VGames realtime/card
room layer. See `2026-07-14-vgames-identity-v0-design.md` before implementing
or deploying this spec.

## Product Scope

V0 is a public web app for friends to play ranked Wikipedia navigation
challenges.

In scope:

- Separate Vikipedia Supabase database.
- Cloudflare Pages frontend with Cloudflare Pages Functions as the server API.
- Display-name-only v0 players.
- Server-created challenge catalog.
- Challenge #1: `Moon` to `Gravity`.
- Per-challenge leaderboards.
- Server-side run, click, finish, and abandon tracking.
- Faithful Wikipedia article rendering with Viota-branded game chrome.
- Desktop and mobile responsive header states.

Out of scope:

- VGames account integration.
- Passwords, email login, invites, or access codes.
- Multiplayer rooms.
- Shortest-path solver.
- Full anti-cheat enforcement beyond server-side event timestamps and basic
  event validation.

## Architecture

The frontend remains a Vite React app hosted on Cloudflare Pages. Runtime data
writes go through Cloudflare Pages Functions under `/api/*`. Pages Functions use
server-side Supabase credentials to write to the separate Vikipedia Supabase
project, so no service key is exposed to the browser.

The browser calls the API to:

1. create or resolve a player after display-name entry;
2. list challenges;
3. start a run;
4. append click events;
5. complete or abandon a run;
6. read challenge leaderboards and paths.

The client may cache the current player id and failed event submissions locally,
but server rows determine the official run state.

## Data Model

### `players`

Display-name-only player identities for v0.

- `id`: UUID primary key.
- `display_name`: text, required, 1-24 visible characters.
- `created_at`: timestamptz, server default.
- `last_seen_at`: timestamptz.

Display names are not globally unique in v0. The UI can show duplicate names
as-is because the first friend group is small.

### `challenges`

Reusable challenge catalog.

- `id`: text primary key, e.g. `challenge-0001`.
- `label`: text, e.g. `Challenge #1`.
- `start_title`: text, e.g. `Moon`.
- `target_title`: text, e.g. `Gravity`.
- `ruleset`: text, initially `ranked_classic`.
- `sort_order`: integer, unique.
- `is_active`: boolean.
- `created_at`: timestamptz.

Seed data:

- `challenge-0001`, `Challenge #1`, `Moon`, `Gravity`, `ranked_classic`,
  `sort_order = 1`, active.

### `runs`

One row per attempt. This row is created before the start article loads into the
game view.

- `id`: UUID primary key.
- `challenge_id`: references `challenges.id`.
- `player_id`: references `players.id`.
- `status`: `active`, `completed`, or `abandoned`.
- `started_at`: timestamptz, server-set.
- `completed_at`: timestamptz nullable.
- `abandoned_at`: timestamptz nullable.
- `elapsed_ms`: integer nullable.
- `click_count`: integer, starts at 0.
- `start_title`: text snapshot.
- `target_title`: text snapshot.
- `final_title`: text nullable.
- `created_at`: timestamptz.
- `updated_at`: timestamptz.

### `run_events`

Append-only audit trail for reconstructing and debugging runs.

- `id`: UUID primary key.
- `run_id`: references `runs.id`.
- `event_type`: `run_started`, `page_clicked`, `run_completed`,
  `run_abandoned`.
- `step_number`: integer nullable. Click steps start at 1.
- `source_title`: text nullable.
- `clicked_anchor_text`: text nullable.
- `requested_title`: text nullable.
- `destination_title`: text nullable.
- `destination_page_id`: integer nullable.
- `client_timestamp_ms`: bigint nullable.
- `created_at`: timestamptz, server-set.

### `run_path_steps`

Normalized path rows for leaderboard popouts and stats queries.

- `run_id`: references `runs.id`.
- `step_number`: integer.
- `source_title`: text.
- `clicked_anchor_text`: text.
- `destination_title`: text.
- `destination_page_id`: integer nullable.
- `elapsed_since_start_ms`: integer nullable.
- `created_at`: timestamptz.

Primary key: `(run_id, step_number)`.

### Leaderboard View

The leaderboard is read per challenge from completed runs.

Sort order:

1. lowest `elapsed_ms`;
2. lowest `click_count`;
3. earliest `completed_at`.

Rows show rank, display name, elapsed time, click count, completion timestamp,
and a path popout action.

## API Contract

All write endpoints return structured errors with a stable `code` and
user-safe `message`.

### `GET /api/challenges`

Returns active challenges ordered by `sort_order`.

### `POST /api/players`

Input:

```json
{ "displayName": "Vijay" }
```

Creates a new v0 player or updates the existing locally cached player id when
the client sends one in a future extension. For v0, the returned player id is
stored locally by the browser.

Output:

```json
{ "player": { "id": "uuid", "displayName": "Vijay" } }
```

### `POST /api/runs/start`

Input:

```json
{ "challengeId": "challenge-0001", "playerId": "uuid" }
```

Creates `runs` and the initial `run_events` row. Returns the run id and the
challenge snapshot.

### `POST /api/runs/:runId/click`

Input:

```json
{
  "sourceTitle": "Moon",
  "clickedAnchorText": "orbit",
  "requestedTitle": "Orbit",
  "destinationTitle": "Orbit",
  "destinationPageId": 123,
  "clientTimestampMs": 1784000000000
}
```

Validates that the run is active, appends `run_events`, appends
`run_path_steps`, increments `runs.click_count`, and returns the authoritative
click count.

### `POST /api/runs/:runId/complete`

Input:

```json
{ "finalTitle": "Gravity", "clientTimestampMs": 1784000000000 }
```

Validates that `finalTitle` matches the challenge target after normalization,
sets `runs.status = completed`, sets `completed_at`, calculates `elapsed_ms`
from server timestamps, appends `run_completed`, and returns the leaderboard row
for the run.

### `POST /api/runs/:runId/abandon`

Marks an active run abandoned and appends `run_abandoned`.

### `GET /api/challenges/:challengeId/leaderboard`

Returns completed leaderboard rows plus enough path summary data to render the
popout without an additional request for the first page of users.

### `GET /api/runs/:runId/path`

Returns full path steps for a leaderboard replay popout.

## Gameplay Flow

Anyone can open the site and browse challenges and leaderboards. To start a
challenge, the player must enter a display name. When they press Start, the
client creates or resolves the v0 player, starts a server run, then loads the
Wikipedia start article.

During a run, each clicked Wikipedia article link sends a click event after the
destination article resolves. The client should keep gameplay moving if a write
briefly fails, but the UI must mark the run as syncing or unsynced until the
server accepts the event. Completed leaderboard placement is only official after
the server accepts completion.

If the player closes the tab or starts a different challenge before finishing,
the client should attempt to abandon the active run. Later recovery can mark
old active runs as abandoned by timeout, but v0 does not need a background job.

## UI Design

### Brand

Use Viota visual language for the application chrome:

- dark aurora-style background;
- cyan and coral accents;
- chunky friendly brand type treatment;
- chamfered controls and HUD containers.

Do not apply Viota styling inside the Wikipedia article body. The article
itself should remain visually close to Wikipedia.

### Article Renderer

The article view should preserve Wikipedia’s real structure as much as the
controlled view allows:

- title;
- lead paragraphs;
- body headings;
- infoboxes;
- images and captions;
- tables when manageable;
- normal Wikipedia link color and behavior.

Vikipedia may remove global Wikipedia chrome, search, edit controls, external
links, and unrelated navigation. It should not convert article content into
cards, chips, or rewritten summaries.

### Header States

Before a run starts, the header is expanded. It shows the Vikipedia brand,
challenge label, route, and display-name/start control.

During a run, the header compresses and remains sticky while scrolling. Desktop
shows compact brand, route, time, clicks, and rank. Mobile shows a more minimal
sticky row with mini brand, challenge route, timer, and click count. The mobile
header must remain visible but should not dominate the Wikipedia content.

After the target article is reached, the header expands again into a result
surface showing elapsed time, click count, current rank, and leaderboard/replay
actions.

### Path Strip

The path is horizontal on desktop and mobile.

Short paths show the full sequence. Long paths use the same compression rule on
desktop and mobile:

```text
... -> latest previous 3 pages -> target
```

The challenge route already shows the start and target, so compressed path
strips do not need to preserve the start page. The target should not be
duplicated if it is already the current visible page at completion. Leaderboard
popouts show the full path.

### Tabs

V0 includes visible navigation for:

- Play;
- Leaderboard;
- Challenges;
- Stats.

The leaderboard tab exists from v0 and can show only the current friend group’s
display names. Account names can replace display names when account work starts.

## Stats

Stats derive from server data. V0 should still support local display of stats,
but the model must treat Supabase as official. Stats include:

- total runs;
- completed and abandoned runs;
- best speed;
- average speed;
- average click count;
- top starts;
- top targets;
- most visited pages;
- bridge pages;
- common jumps.

## Error Handling

If challenge listing or leaderboard loading fails, show a recoverable error and
keep the app shell usable.

If starting a run fails, do not enter the article view.

If a click tracking write fails after the article loads, keep the player in the
run but show a syncing/unsynced warning. Retry the event before allowing an
official completion. Completion cannot be ranked until the server accepts all
prior click events.

If completion fails, keep the result locally visible with a pending-sync state
and keep retrying. The leaderboard should not show the pending result as
official.

## Testing

Unit tests should cover:

- challenge sorting and Challenge #1 seed shape;
- display-name validation;
- path compression;
- leaderboard sorting by speed, then click count, then completion time;
- API request/response adapters;
- sync failure state.

Integration or component tests should cover:

- display name required before starting;
- server run start called before article load enters play;
- click event sent with source, anchor text, destination, step number, and
  timestamp data;
- completion updates leaderboard;
- compact header during active runs and expanded header before/after runs.

Manual verification should include:

- desktop and mobile layout checks;
- real Wikipedia pages with images and infoboxes;
- Challenge #1 `Moon` to `Gravity`;
- at least two display names on the leaderboard.
