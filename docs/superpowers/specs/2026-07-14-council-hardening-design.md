# VWiki Race Council Hardening Design

Date: 2026-07-14

## Status

Approved and authoritative v0 direction: preserve the current product shape while removing
correctness failures, operational hazards, and avoidable interaction friction.
This is a hardening pass, not a feature expansion.

Where older VWiki Race documents or helpers disagree with this specification,
this specification governs. The contradictory rules and helpers are updated or
removed in the same implementation pass.

## Goal

Make the existing challenge-based Wikipedia race trustworthy and intuitive for
a small group of friends:

- a player can choose a challenge, identify themselves, race, finish, and read
  the leaderboard without ambiguous state;
- each accepted run has a contiguous, server-owned path and stable score;
- routine failures cannot create fake wins, orphan the interface, or amplify
  into uncontrolled Cloudflare usage;
- the same flow works at normal desktop and mobile widths;
- Wikipedia content remains recognizable, useful, and properly attributed.

## Non-Goals

This pass will not add realtime rooms, new game modes, matchmaking, hints,
social features, moderation systems, a full static Wikipedia snapshot, or
adversarial proof of every Wikipedia edge against a pinned revision.

The `ranked_classic` v0 integrity contract is explicitly trust-based and
friends-first. The server will enforce identity,
run ownership, path continuity, sequence order, idempotency, canonical target
identity, and completion from the final accepted click. It will not make a new
Wikimedia request for every click to prove that a hostile client did not invent
an edge. The server owns the immutable ledger over client-declared edges; it does
not claim that every edge is independently proven. Revision-pinned edge and
prompt-reachability verification remain later prerequisites before the
leaderboard is presented as an adversarial public competition.

## Product Decisions

### Scoring

The leaderboard ranks by:

1. shortest elapsed time;
2. fewest clicks;
3. earliest completion;
4. lexicographically smallest run ID as a deterministic final tie-break.

This matches the already-approved product behavior. The older clicks-first
domain helper and contradictory prose will be removed or updated.

Each account receives one visible leaderboard position per challenge: its best
completed run under the ordering above. All attempts remain stored for stats
and audit history.

### Timing

The published elapsed time is active decision time, not network time. This is
the fairest useful speed measure for a friends-first game whose article payloads
vary greatly in size.

1. The client loads and prepares the start article without revealing it, then
   creates the server run.
2. On the accepted start response, the client reveals the article, records a
   monotonic `performance.now()` segment start, and begins the visible timer at
   zero. Start preload and response transit are excluded.
3. Activating an allowed link immediately ends the current decision segment and
   pauses the timer. Destination fetch and click-sync time are excluded. A
   failed move resumes a new segment on the unchanged article.
4. Each click sends cumulative integer `decisionElapsedMs`. The server requires
   it to be nondecreasing, at least the previously accepted value, and no greater
   than server wall elapsed plus five seconds. The server stores both decision
   elapsed and wall elapsed at every accepted event.
5. After a non-target click is accepted, the new article is revealed and a new
   decision segment begins. A target click completes with the cumulative value
   captured at activation, so final-response latency does not change the score.

`runs.elapsed_ms` is the published decision metric and
`runs.wall_elapsed_ms` is the server-receipt audit metric. This friends-first
contract already trusts client-declared Wikipedia edges; it likewise treats the
monotonic decision samples as declared observations constrained by the server
wall clock. A later adversarial mode requires a stronger timing trust model.
Article cache scope is one active run: the start article may be preloaded, failed
requests are evicted, and fetched destinations are discarded when the run ends.
There is no separate client-authoritative completion action.

### Active Run Navigation

While a run is active, the current challenge is immutable and the interface is
focused on Play. Challenge selection and challenge creation cannot replace or
relabel the active run. A visible End Run command abandons it before returning
the player to challenge discovery. End Run requires confirmation. The interface
does not expose another Start action until the active run completes or the
player confirms abandonment.

Browser close cannot be guaranteed to deliver an abandonment request. Active
runs expire after 24 hours. Each run mutation and new start lazily marks expired
runs abandoned. A nonexpired active run makes a different start return
`409 active_run_exists`; only an idempotent replay, explicit End Run, identity
merge, or expiry may end it. Active and abandoned runs never appear on
leaderboards, though account stats count them as attempts.

`GET /api/v2/runs/active` is authenticated and returns either `{ run: null }` or
the canonical account's one active run with challenge snapshot, last canonical
page, accepted click count, accepted decision elapsed, and accepted path. On
startup with a valid session, the client checks this route before exposing a
Start action. It offers Resume Run or End Run. Resume loads the last article,
uses the accepted decision elapsed as its timer base, starts a new monotonic
segment only when that article is interactive, and excludes reload downtime and
recovery loading. End Run uses the normal confirmed idempotent abandonment. An
expired run is lazily abandoned and returned as null.

Active discovery is intentionally cross-version and includes
`protocolVersion`. A protocol-1 run lacks comparable decision timing, so the new
client offers only confirmed End Old Run, not Resume. V2 abandonment may end
that owned protocol-1 run solely as this explicit recovery action; it preserves
unranked status. No v2 click or completion behavior can mutate protocol 1.

### Allowed Article Surface

Ranked v0 allows main-namespace links in lead prose, article prose, infoboxes,
and substantive article tables/lists. Site navigation, external links,
citations, references, bibliography sections, categories, language links,
files, navboxes, portals, and other namespaces are not game moves.

"See also" remains excluded from the v0 renderer to match the existing product
behavior and prior playtest feedback. The game rules document will be corrected
so it no longer claims otherwise.

Disabled File or media links retain their child image content; only navigation
is removed. Wide article content receives local horizontal scrolling rather
than being clipped.

## Architecture

### Canonical Deployment

Cloudflare Pages hosts static Vite assets plus the temporary same-origin
identity Functions required by the currently deployed asset. The dedicated
`vwikirace-api` Worker is the canonical API origin for challenges, identity
proxy routes, runs, leaderboards, and run paths. The old asset's compiled
tracking base URL already points at that Worker, so its `/api` tracking calls
reach the Worker adapters; only its fixed relative identity calls reach Pages
Functions.

Both new tracking and VGames identity clients use `/api/v2` on the same
configured base URL through one injected API-origin helper. Production builds require a
valid HTTPS `VITE_VWIKI_RACE_API_URL`; a missing or malformed value fails the
build instead of falling back to same-origin `/api`. Local tests may explicitly
inject a relative origin. Worker route-matrix tests cover every v2 identity,
challenge, run, leaderboard, and path route before cutover.

The existing `/api` Worker routes remain temporary legacy adapters for the
currently deployed static asset. The existing same-origin Pages identity
functions also remain for that asset. Legacy adapters accept the old envelopes,
generate internal event keys where absent, and mark all resulting runs
`ranked_eligible = 0`; they preserve play and tracking but cannot contaminate the
hardened leaderboard. No new client calls those routes. They are removed in a
later release after the old immutable asset has aged out, not in this pass.
Deployment and primary smoke-test docs otherwise reference the v2 Worker API.

Worker CORS allows the exact production Pages origin plus origins listed in the
`ALLOWED_ORIGINS` environment value for previews or local development. It never
uses `Access-Control-Allow-Origin: *` in production.

The production build must not silently fall back to HTML for API requests. API
clients validate response shape and content type and return a typed error rather
than passing malformed data into React state.

### Client Boundaries

The current monolithic `App.tsx` will be split only where this pass needs stable
boundaries:

- an API client with typed errors, response validation, timeouts, and request
  deduplication for catalog/leaderboard reads;
- a race controller or hook that owns the run state machine and prevents
  selected-challenge state from diverging from the active run;
- a small elapsed-time hook used only while a run is active.

Presentational extraction is not required. `App.tsx` may retain its panels while
the protocol and state boundaries are stabilized. Existing visual language,
components, and copy remain unless they directly cause confusion or overflow.

### Server Boundaries

The Worker routes call one handler layer and one D1 repository. The handler
validates payload shape and ownership. The repository owns atomic state
transitions and score derivation.

VGames introspection already resolves merge chains and returns the canonical
account ID and status. The Viota worker extends its successful response to:

```ts
{
  valid: true;
  accountId: string;
  status: "ghost" | "claimed";
  displayName: string;
  aliases: string[];
}
```

`displayName` is the unique username for a claimed account and the stored
display name for a ghost. `aliases` is a sorted, deduplicated list of every
merged account whose `merged_into` path resolves to `accountId`; it excludes the
canonical ID. VGames derives this durable merge receipt from stored account
merge state on every introspection, so a lost login response cannot lose the
mapping. The additive response remains compatible with existing introspection
consumers.

Every authenticated VWiki Race mutation idempotently path-compresses those
aliases into its local alias table and upserts the canonical profile name before
performing the requested operation. Historical run ownership, challenge creator
attribution, stats, and leaderboard grouping resolve through the local alias
table. Claiming a guest in place produces no alias; logging a guest into a
different claimed account produces the durable VGames alias set. This is an
integration with VGames' existing merge contract, not a second identity system.

Alias ingestion also abandons active runs owned by former aliases. The UI does
not expose identity changes during an active race, so a merge is an identity
boundary that ends any stale ghost run before the claimed account starts a new
one.

## Data Model

Migration `0003_hardening_protocol.sql` is forward-only and performs the safe
compatibility phase:

- add nullable `start_page_id`, `target_page_id`, and
  `validation_status` (`pending`, `ready`, `disabled`) to challenges;
- add nullable start, target, and last page IDs plus `last_title`, `expires_at`,
  `wall_elapsed_ms`, materialized `canonical_account_id`, `ranked_eligible`, and
  `protocol_version INTEGER NOT NULL DEFAULT 1 CHECK (protocol_version IN
  (1, 2))` to runs; migrated runs and any intervening old Pages inserts receive
  protocol 1 from the database default, while every new v2 run explicitly uses
  protocol 2;
- add nullable `client_event_id`, `request_fingerprint`, `source_page_id`,
  `source_revision_id`, and response snapshot fields to run events;
- add unique partial indexes for `(run_id, client_event_id)` and the existing
  `(run_id, step_number)` path identity;
- add a partial unique index on materialized `runs.canonical_account_id` for
  direct-account active-run protection; alias ingestion abandons former-alias
  active runs before canonical insertion;
- add `account_aliases(alias_account_id primary key, canonical_account_id,
  updated_at)`; local aliases always point directly to the latest canonical ID;
- add `operation_idempotency(operation, idempotency_key,
  canonical_account_id, request_fingerprint, resource_id, outcome_status,
  response_json, error_code, created_at)` with `(operation, idempotency_key)` as
  its globally unique primary key and `outcome_status` constrained to `pending`,
  `accepted`, or `rejected`, so a retry survives an account merge; replay
  authorization resolves the stored account through the alias table;
- add indexes supporting bounded best-per-account leaderboard queries.

The migration abandons every legacy active run and marks every legacy completed
run `ranked_eligible = 0`. Legacy completions remain available for historical
stats and audit paths but do not compete with protocol-hardened runs.

Migration `0003` embeds this update set, verified against English Wikipedia on
2026-07-14:

| ID | Start title | Start page ID | Target title | Target page ID |
| --- | --- | ---: | --- | ---: |
| `challenge-0001` | `Moon` | 19331 | `Gravity` | 38579 |
| `challenge-0002` | `Maraba coffee` | 5478840 | `Moon landing conspiracy theories` | 80740 |
| `challenge-0003` | `FedEx` | 77543 | `Vladimir Lenin` | 11015252 |

Those three rows become active with `validation_status = 'ready'`. Every other
legacy challenge ID, regardless of its prior active or validation fields, is set
inactive with `validation_status = 'disabled'` and reported by the migration
verification query. Verification expects exactly three ready active challenges,
zero other active challenges, zero legacy active runs, and zero ranked-eligible
legacy completions. There is no network access inside a migration and no
partially backfilled ranked state.

New challenge creation stores canonical titles and page IDs returned by
validation. Start and target cannot have the same page ID. Starts must expose at
least one allowed outgoing link. Reachability between arbitrary pairs is not
proven in the trust-based v0 ruleset.

Challenge IDs are opaque UUID-based identifiers; the user-facing sequential
number remains `sort_order`/`label`. One `INSERT ... SELECT
COALESCE(MAX(sort_order), 0) + 1 ... RETURNING` statement allocates the visible
number under D1's serialized write transaction. Before mutation, an existing
authorized operation with the same fingerprint replays its accepted or rejected
outcome; a different fingerprint returns `409 idempotency_conflict`. For a new
key, one D1 batch inserts a pending idempotency row, conditionally inserts the
challenge through that row when the daily quota allows it, and finalizes the
operation as accepted with its response or rejected with `challenge_quota`.
Zero inserted resource rows are a stored deterministic rejection, not a claimed
rollback. Actual SQL failure rolls the entire batch back. The repository checks
`batch()` change metadata and reads the finalized operation, so a pending row is
never exposed as a completed result.

## Run Protocol

### Start

`POST /api/v2/runs/start` accepts the selected challenge ID and an idempotency key.
The authenticated canonical account, name, and aliases come from VGames
introspection. The request fingerprint is the canonical serialization of the
challenge ID. The server rejects inactive, unresolved, or missing challenges.
V2 start creates only protocol 2 and v2 click requires protocol 2. Active-run
discovery and confirmed abandonment are the narrow cross-version recovery
exceptions described above.

Before validating active-run state, the server looks up the operation key. An
authorized matching accepted or rejected operation replays its stored outcome;
a different fingerprint returns `409 idempotency_conflict`. For a new key, the
server precomputes a run UUID and uses one D1 batch to insert the pending
idempotency row, lazily abandon expired and alias-owned runs, conditionally
insert a protocol-2 run only when no nonexpired direct active run exists, insert
its start event through that run, and finalize the idempotency row as accepted
or as rejected with `active_run_exists`, `challenge_not_found`, or
`challenge_unavailable`. No zero-row statement is treated as a rollback. The
repository classifies `batch()` metadata and then reads the finalized operation;
every deterministic no-op is a stored rejection, while an actual SQL failure
rolls back the entire batch. Replaying the same key and fingerprint returns the
stored run even after an account merge when the current canonical account owns
the stored alias.

The client loads the article before this request. If article loading fails, no
run exists. Rejected article promises are evicted from the gateway cache so a
retry can recover.

### Click

`POST /api/v2/runs/:runId/click` accepts:

- `clientEventId`;
- `expectedStepNumber`;
- source canonical title and page ID;
- clicked anchor text and requested title;
- resolved destination canonical title and page ID;
- source revision ID when available;
- cumulative integer `decisionElapsedMs` captured when the link was activated;
- client observation timestamp for diagnostics only.

The click operation key is the run-scoped composite
`click:${runId}:${clientEventId}`; `clientEventId` itself must be a UUID. The
server validates and canonically serializes the request, computes its
fingerprint, then looks up `(run_id, clientEventId)` under the authorized
canonical account. A matching fingerprint returns the immutable stored
transition even when that event completed the run; a different fingerprint
returns `409 idempotency_conflict`. Only an unseen event proceeds to validation.
The server then verifies protocol version 2, ownership and active status, that
the expected sequence is next, that the source page ID equals the run's stored
last page ID, that decision elapsed is valid, that the run has not expired, and
that it remains below 250 clicks.

The server computes a receipt timestamp, then executes one D1 batch. It
inserts-or-ignores a pending `operation_idempotency` row for operation `click`,
then inserts the
run event only through a `SELECT ... FROM runs` whose protocol, owner, status,
expiry, sequence, source, decision-time, and click-limit predicates all match.
A zero-row event insert is a clean rejected CAS. The path insert and run update
both select through that exact newly inserted event ID; they cannot run for a
replay or rejected CAS. D1 executes the batch as one serialized transaction, so
no other click can change the run between those statements. The update advances
the counter, last page, decision elapsed, and wall elapsed and, when destination
page ID equals the snapshotted target page ID, sets completed status in that
same batch. Every event, path, run, and finalization statement is conditional on
the exact operation row still being `pending`, owned by the authorized canonical
account, and carrying the same run resource ID and fingerprint. The batch then
finalizes the operation as accepted through the new
event, or as rejected with a stable typed error code when no event was inserted;
no pending outcome is returned. Actual statement or constraint failure rolls
back the operation, event, path, and run changes together. After the batch, the
repository reads the winning finalized operation; a concurrent duplicate whose
insert changed zero rows performs no downstream writes and reads that same
outcome. Rejected replays
return the same stored error even if run state later changes. Tests assert the
operation, event, path, and run counters remain coherent for every zero-row and
SQL-failure path.

The event stores the request fingerprint, receipt timestamp, accepted click
count, resulting run status, completion timestamp, and elapsed time. After the
batch, the repository reads the event. Repeating the same event ID and
fingerprint returns that stored response. The same event ID with a different
fingerprint, a stale sequence, wrong source, expired run, or competing terminal
transition returns a typed `409` without mutation.

The idempotent event snapshot contains only the immutable transition result:

```ts
{
  runId: string;
  clickCount: number;
  runStatus: "active" | "completed";
  completedAt?: string;
  elapsedMs?: number;
}
```

When the transition completes the response also contains a separately computed
`leaderboardContext` of `{ isPersonalBest: boolean; rank: number | null }`.
Retries replay the immutable transition exactly, then recompute current
leaderboard context because rank can legitimately change as later attempts are
completed. Completion requires at least one accepted click and derives only
from the accepted destination page ID. A slower repeated attempt completes
successfully with `isPersonalBest: false` and `rank: null`; leaderboard
placement is never a precondition for completion.

The client may fetch the destination before the click write for perceived
responsiveness, but it keeps the move in a visible syncing state, blocks another
move, and does not commit the new article/path as authoritative until the server
accepts it. A retry resends the same event ID. A terminal rejection restores the
previous article and gives a specific recovery message.

### Abandon

Abandonment requires an idempotency key. The server computes its fingerprint
and performs authorized operation-key replay before checking run status. For a
new key, one D1 batch inserts a pending `abandon` operation, conditionally
updates an owned active protocol-2 run, records the abandon event through that
transition, and finalizes the operation with the resulting abandoned or already
completed terminal state. The same route has one narrower predicate for an
owned active protocol-1 run: it is accepted only when the request declares
`recoveryProtocolVersion: 1`, transitions that run to abandoned/unranked, and
stores a `legacy_recovery_abandoned` outcome. The new client sends that field
only from the End Old Run action produced by active discovery; it never invokes
a legacy route. A final fallback statement converts any remaining pending row
to a stable rejected outcome such as `run_not_found` or `protocol_mismatch`; no
pending outcome is returned. Replaying returns the stored terminal state or
rejection. It cannot overwrite a completed run; if completion wins
serialization, abandonment stores and returns the completed state. The client
only sends abandonment after the player confirms End Run.

### Legacy Complete Compatibility

The canonical v2 contract removes client-authoritative completion. Protocol-1
adapters preserve the exact old request envelopes needed by the currently
deployed asset:

- legacy start accepts `{ challengeId, publicName }`, authenticates the session,
  ignores the client name for attribution, and treats every repeated request
  for the same owned active protocol-1 challenge as the same harmless operation
  because the old envelope cannot distinguish a network retry from a deliberate
  second click. It returns that run; otherwise it creates one protocol-1
  unranked run with an internal event key;
- legacy click accepts the old title-based event, appends it sequentially on a
  best-effort basis, and can never make the run ranked-eligible;
- legacy complete may complete only a protocol-1 run after at least one legacy
  click and an observed target title; the result remains unranked;
- legacy abandon accepts the old keyless envelope, conditionally abandons only
  an owned active protocol-1 run, and returns its terminal state on replay;
- a legacy complete request for an active protocol-2 run returns
  `409 completion_requires_target_click` and never changes it.

Every legacy run route includes `protocol_version = 1` in its ownership and
mutation predicates. Cross-version run IDs return `409 protocol_mismatch`
without mutation.

The one-active-run check is account-wide, not version-specific. A v2 start sees
any protocol-1 or protocol-2 active run. A legacy start may return only the same
owned active protocol-1 challenge described above; any other active run,
including protocol 2, returns `409 active_run_exists`.

The existing same-origin Pages identity Functions remain available to the old
asset during this compatibility release. All legacy routes, client methods, and
contracts are marked deprecated and are removed only in an explicit later
release after traffic confirms they are no longer needed. New code cannot call
legacy routes.

## Leaderboards And Paths

Leaderboard SQL uses a CTE that resolves each run's account through the
path-compressed alias table and applies:

```sql
ROW_NUMBER() OVER (
  PARTITION BY canonical_account_id
  ORDER BY elapsed_ms, click_count, completed_at, id
)
```

It keeps row number one, orders by the same four keys, and bounds the result to
100 rows. Only `ranked_eligible = 1` completed runs participate. The row contains
score metadata only; it does not perform one path query per run.

Opening a row's path disclosure calls the existing run-path endpoint once and
caches the result in client memory. Only completed public leaderboard runs may
be read through that route.

Completion uses one bounded SQL query to determine whether the new attempt is
the canonical account's personal best and, if so, its rank among all personal
bests. It returns attempt metrics even when the result is not a personal best or
falls outside the visible top 100. The client does not immediately issue a
second full leaderboard read merely to discover the same result. A later
leaderboard refresh remains available and is deduplicated. Idempotent completion
replays keep their stored transition fields while this leaderboard context is
recomputed from current results.

Public catalog and leaderboard reads use a short cache policy appropriate for
shared challenge data. Mutations remain `no-store`.

## Account Stats

`GET /api/v2/accounts/me/stats` is authenticated and alias-aware. It returns
server-derived lifetime data from all protocol versions so tracking really does
begin with the first stored run:

```ts
{
  totals: {
    attempts: number;
    completed: number;
    abandoned: number;
    timedCompleted: number;
    totalClicks: number;
    bestClicks: number | null;
    bestElapsedMs: number | null;
    averageClicks: number;
    averageElapsedMs: number;
  };
  topStarts: Array<{ title: string; count: number }>;
  topTargets: Array<{ title: string; count: number }>;
  mostVisited: Array<{ title: string; count: number }>;
}
```

Starts and targets count every attempt; clicks count every completed attempt.
`timedCompleted`, `bestElapsedMs`, and `averageElapsedMs` use only protocol-2
decision-time completions because protocol-1 wall time is not comparable.
Visited pages include each run start and accepted path destinations. Each ranked
list is deterministically ordered by count descending then title ascending and
limited to five rows in SQL. The Stats tab has its own
loading, empty, and failure states and never derives lifetime totals from the
currently selected challenge's leaderboard. Legacy merged identities are
grouped under the current canonical account.

## Request And Abuse Safety

The system adds defense in depth:

- the client memoizes stable clients and deduplicates identical in-flight
  catalog and leaderboard requests;
- API reads have 10-second timeouts, mutations have 15-second timeouts, and all
  errors preserve status/code/`Retry-After`;
- UI actions disable while their mutation is in flight;
- the Worker rejects declared or observed request bodies over 16 KiB before
  JSON handling; challenge inputs allow 2,048 characters, article titles 512,
  display names 24, and anchor text 512;
- runs have a maximum of 250 accepted clicks;
- an account has at most one active run; a new non-replay start returns
  `409 active_run_exists` until the old run is explicitly abandoned or expires;
- challenge creation is limited to 10 accepted challenges per account per day;
- the ten-per-day accepted challenge quota is enforced in D1 using the
  server-derived canonical account and the same atomic creation operation;
- Cloudflare IP/origin rules protect guest identity creation and coarse abuse;
- structured redacted logs include route, status, request ID, latency, and
  failure boundary without tokens, passwords, or article bodies.

The initial Cloudflare edge threshold is 20 guest creations per IP per hour.
After VGames introspection, exact D1 operation counts enforce 20 challenge-create
attempts per canonical account per rolling hour and 120 run-start attempts per
canonical account per rolling hour; both count accepted and rejected finalized
idempotency operations. A Worker Rate Limiting binding named
`CLICK_RATE_LIMITER`, namespace `51001`, enforces 180 click attempts per account
per 60 seconds. Cloudflare's binding supports only 10- or 60-second periods, so
it is not misrepresented as an hourly counter. These controls are documented
next to deployment, and application invariants do not depend only on them.

### Retry Matrix

- Catalog, leaderboard, path, and Wikipedia GETs retry once after a network
  failure, `429`, `502`, `503`, or `504`. They honor `Retry-After` up to five
  seconds; otherwise they wait 250 milliseconds.
- Idempotent create, start, click, and abandon mutations retry once after a
  network failure, timeout, `502`, `503`, or `504`, reusing the exact same
  idempotency key and body. They do not automatically retry `409`, `422`, or
  other client errors. A `429` is surfaced with its retry time for deliberate
  user retry rather than holding the game UI indefinitely.
- Guest, claim, and login identity mutations never retry automatically because
  VGames owns their side effects. A timeout returns a recoverable identity error
  and the next deliberate submission reconciles through the durable VGames
  account/device state.
- Aborting a browser wait does not assert that the Worker aborted. Every
  mutation reconciliation therefore uses its original idempotency key.

## User Experience

### Discovery

The initial state distinguishes loading, loaded, empty, and failed catalog
states. Once a challenge is automatically selected, copy describes that
challenge instead of saying "Pick a challenge."

Existing challenges lead the discovery view. Creation remains available under
the Challenges tab but no longer appears as the dominant first action on the
Play view. Selecting a challenge updates `?challenge=`. Invalid IDs are replaced
with the fallback challenge, and browser back/forward updates the selection when
no run is active.

### Identity

The identity prompt still appears only when starting or creating while no valid
session exists. It contains its own busy and error states, traps keyboard focus,
supports Escape/close, and uses a labeled button group with `aria-pressed` for
Guest, Claim, and Log in; it does not use tab roles. A first-time prompt focuses
the display-name field. A returning ghost prompt defaults to Claim and focuses
the username field. Escape closes only while no request is active. Closing
restores focus to the exact Start or Create control that opened the prompt.

An expired session clears safely and returns the player to the same pending
intent instead of losing the selected challenge.

### Active Race

The compact sticky desktop header displays challenge, target, live elapsed
time, click count, player name, and End Run without horizontal clipping.
Navigation outside the race is unavailable until completion or abandonment.

At widths up to 640px, the sticky header uses two fixed rows. Row one contains
the compact brand, ellipsized target, and End Run. Row two contains timer and
click count. Player name and challenge number are omitted from the active mobile
header and remain available in the completed/idle state. At 320px, no control
extends outside the viewport; target text yields space before timer, clicks, or
End Run can shrink.

Link activation gives immediate feedback. After an accepted move, the new
article begins at its heading, with focus/announcement appropriate for keyboard
and screen-reader users. Only one move can sync at a time.

### Completion

Completion is announced immediately in the sticky header and through a live
region. The result summary appears before the long target article on mobile and
desktop. The expanded result state includes elapsed time, clicks, path, rank,
and existing navigation to leaderboard/challenges. Rank is shown only when the
attempt is the player's current personal best; otherwise the summary says
"Not a personal best" without inventing a leaderboard position.

### Responsive Layout

At every supported width:

- the shell fills the viewport without hidden horizontal content;
- all primary navigation remains reachable;
- long challenge titles wrap instead of pushing actions offscreen;
- fixed-format controls have stable dimensions;
- article tables, math, and preformatted blocks scroll within the article;
- dialogs scroll in short landscape viewports;
- visible focus styles and live-region announcements cover all state changes.

Browser QA covers 1440x900, 1024x768, 390x844, 320x568, and 844x390, including
maximum-length challenge titles.

## Wikipedia Correctness

All candidate links are parsed with `URL` against the English Wikipedia base.
The parser:

- resolves against `https://en.wikipedia.org/wiki/`, accepts only the exact
  `en.wikipedia.org` hostname over HTTPS, and requires a `/wiki/` pathname;
- rejects any nonempty search string before title extraction and strips the
  fragment because a section jump is not a new article move;
- decodes each path segment once, joins the title path with `/`, converts
  underscores to spaces, and accepts valid mainspace slash titles such as
  `AC/DC`; malformed percent escapes are rejected;
- rejects red links, external hosts, unsupported languages, and every title
  whose first segment uses a recognized non-main namespace, case-insensitively,
  including Talk, User, User talk, Wikipedia, Wikipedia talk, File, File talk,
  MediaWiki, MediaWiki talk, Template, Template talk, Help, Help talk, Category,
  Category talk, Portal, Portal talk, Draft, Draft talk, TimedText, Module,
  Module talk, Special, and Media;
- preserves canonical destination page IDs returned by Wikipedia.

Challenge inputs allow full English Wikipedia URLs or titles at realistic URL
lengths. Only exact supported hosts are accepted; suffix matches such as
`notwikipedia.org` are rejected.

Wikipedia requests use a production `Api-User-Agent`, bounded retry behavior
for `429`/transient failures, and failed-cache eviction. Rendered articles link
to the source revision and the applicable license attribution without turning
File or external links into game moves.

When an anchor is disallowed, the sanitizer unwraps the anchor and preserves
all child nodes rather than replacing it with `textContent`; linked thumbnails
therefore remain visible. Tables, math, and preformatted content use an inner
overflow container. The parser tests include encoded and decoded slash titles,
queries, fragments, protocol-relative and absolute hosts, malformed escapes,
all namespace families, and anchors that wrap nested images.

## Error Handling

Errors are typed by boundary: identity, catalog, challenge validation, article
load, run start, click sync, completion, abandonment, leaderboard, and path.
The UI never reports a tracking failure as an article-load failure.

Read failures preserve the last correctly keyed data only when that is not
misleading. Stale leaderboard responses cannot overwrite a newer challenge.
Malformed successful API responses are treated as upstream errors, not cast
into application state.

## Testing And Verification

Implementation follows red-green-refactor. Required coverage includes:

- default client stability and duplicate-request guards;
- malformed/HTML API responses, timeout, `401`, `429`, and retry behavior;
- start timing after article readiness;
- failed article retry without an orphan run;
- click idempotency, sequence conflict, source continuity, atomic failure, and
  target auto-completion;
- zero-click completion rejection and removal of client-authoritative complete;
- concurrent click/abandon/complete state transitions against real local D1,
  including immutable transition replay with recomputed leaderboard context;
- canonical page ID creation and renamed-target completion;
- best-per-account, speed-first bounded leaderboard queries with no N+1 path
  reads;
- lazy path loading;
- active-run challenge lock and explicit abandonment;
- identity modal error, focus, Escape, and focus restoration;
- loading/empty/error copy, stale leaderboard protection, URL history;
- valid slash titles, namespace rejection, strict hosts, images, tables, and
  excluded sections;
- desktop and mobile browser screenshots for idle, identity, active, syncing,
  complete, leaderboard, and challenge creation states;
- horizontal overflow checks and article canvas/content checks;
- production build inspection proving both clients point to the canonical
  Worker and do not contain the unstable default-fetch pattern.

The repository exposes named verification commands:

- `npm test` for domain, client, React, handler, and repository unit tests;
- `npm run test:worker` for the exported Worker's complete route matrix and real
  local-D1 idempotency/concurrency tests using Cloudflare's Vitest pool;
- `npm run build` for TypeScript and production Vite output;
- `npm run verify:bundle` for required API origin, forbidden same-origin API
  fallback, and unstable-fetch-pattern inspection;
- `npm run dev:worker` for the local full-stack Worker/D1 smoke target.

Browser screenshots and viewport overflow checks are recorded as manual browser
QA evidence because the repository does not add a second browser-automation
framework solely for this pass.

Before deployment, run the complete test suite, type-check Worker routes, build
the production bundle, execute local full-stack smoke tests, and inspect desktop
and mobile browser states. Production receives one deliberate deployment and a
small fixed set of smoke requests; no polling or repeated curl loops are used.

## Implementation Phases

1. Extend and test VGames introspection with canonical names and durable aliases.
2. Add Worker route-matrix/local-D1 harnesses, the fail-closed shared API origin,
   and typed client errors before stopping new code from using duplicate Pages
   Functions.
3. Apply the compatibility migration and implement challenge/start/click/
   abandon idempotency, compare-and-swap transitions, completion metrics, and
   bounded leaderboards.
4. Harden Wikipedia parsing/rendering and canonical challenge page IDs.
5. Move the React flow to the authoritative protocol, then fix identity,
   responsive, loading, navigation, and completion UX.
6. Reconcile rules/docs, remove deprecated completion calls from the new client,
   retain clearly marked protocol-1 compatibility routes, run complete automated
   verification, then perform browser QA.

Each phase is independently testable. Protocol/schema and identity/cutover work
must pass before visual refactoring begins.

## Documentation And Rollout

README, game rules, backlog, and deployment handoff are updated together.
Migration instructions apply every migration in order. The live site remains a
hold until the stale request-loop bundle is replaced by a verified build.

Rollout order is fixed:

1. deploy the backward-compatible VGames introspection response;
2. apply VWiki Race migration `0003` and verify challenge/legacy-run counts;
3. deploy the canonical API Worker, retaining protocol-1 start, click, complete,
   abandon, and identity compatibility adapters while serving the strict
   protocol at `/api/v2`; smoke-test one request per retained route without
   creating a polling loop;
4. deploy the static Pages build exactly once with the required Worker origin;
5. run the fixed smoke checklist and verify request volume;
6. remove the compatibility route in a later release only after old static
   assets are no longer served.

Commits, pushes, and Cloudflare deployment remain separate explicit actions
under the workspace rules.
