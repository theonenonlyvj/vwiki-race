# Editorial Dailies And Community Nominations

**Date:** 2026-07-17
**Status:** Approved design, awaiting written-spec review

## Objective

Make each automatic Daily worth playing without building a complete Wikipedia
graph. Add a weekly editorial rhythm, prevent duplicate challenges and duplicate
Dailies, and let claimed players nominate a challenge only while submitting it.
Give the VWiki Race administrator a small protected surface for reviewing those
nominations and promoting any existing challenge into a future Daily.

The larger Play, Leaderboard, Challenges, and Stats screen redesign is a
separate project that begins after this release ships.

## Product Rules

### Weekly rhythm

The Central calendar date determines the Daily flavor:

- Monday through Wednesday: `recognizable`
- Thursday and Friday: `weird`
- Saturday and Sunday: `hard`

Every flavor shares one quality floor:

- The start and target are canonical English Wikipedia mainspace articles.
- Neither node is missing, redirected, a disambiguation page, or an
  administrative page. Titles beginning with `List of`, `Lists of`, `Outline
  of`, `Index of`, `Glossary of`, `Timeline of`, `Bibliography of`, or
  `Discography of` are list-like and ineligible.
- The target has a useful lead summary and enough article substance to be worth
  discovering: at least 1,500 article bytes and an 80-character plain-text lead.
  A thumbnail is a positive signal, not an absolute requirement.
- The start renders in the official game surface and exposes between 8 and 200
  allowed game links after sanitization.
- The ordered pair has never been featured as a Daily.

Flavor changes candidate weighting rather than bypassing the quality floor.

### Editorial target pools

Targets come from Wikipedia-maintained editorial sources rather than the first
valid page returned by the random endpoint:

- `recognizable`: English Wikipedia Vital Articles Levels 1-3, then ranked with
  pageviews from the latest 30 complete UTC days and preview quality.
- `weird`: entry articles from `Wikipedia:Unusual articles`, ranked with preview
  quality and a lower pageview floor so unusual does not become merely obscure.
- `hard`: the union of the recognizable and weird target pools. Hardness comes
  from pair selection, not from choosing a bad target.

The target-pool adapters parse only entry article links from the relevant
Wikipedia project pages. The Vital adapter accepts the Level 1-3 article entries.
The Unusual adapter accepts the first mainspace article link in each rendered
entry term and rejects explanatory/incidental links. Pool documents are cached
for 24 hours; stale cache data may be used for up to seven days when Wikipedia
is temporarily unavailable.

Starts continue to come from independent English Wikipedia random-mainspace
requests. Candidate starts must pass the existing rendered-link validation.

References:

- https://en.wikipedia.org/wiki/Wikipedia:Vital_articles
- https://en.wikipedia.org/wiki/Wikipedia:Unusual_articles
- https://www.mediawiki.org/wiki/API:Links
- https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/reference/page-views.html

### Lightweight scoring

The evaluator returns a ranked list of candidates. Scores are deterministic,
versioned, and explainable. They use integer components rather than an external
AI classifier.

Common target components include:

- editorial pool membership and level
- recent human pageviews
- lead-summary presence and length
- article length or substance
- thumbnail presence
- list/stub/title-pattern penalties

Pair components include:

- start allowed-link count
- direct-edge rejection
- same-page and same-pair rejection
- non-maintenance category overlap as a lightweight topical-similarity proxy
- for `hard`, rejection of any bounded two-click shortcut the evaluator can
  detect within its fixed request budget

Hard is explicitly a proxy in this release. Exact shortest-path distance waits
for a graph built from the same links the game actually permits. The UI must not
claim an exact shortest path.

For each automatic Daily attempt, the evaluator deterministically samples at
most 10 targets from the flavor pool using `daily_date` and classifier version
as the seed, fetches target metadata in batches, and samples at most three
independent random starts. It evaluates the resulting pairs until the fixed
subrequest or wall-clock budget is reached. Every quality-floor survivor is
eligible; flavor scores rank survivors rather than allowing a mediocre fallback
that bypasses the quality floor. Stable seeded hashes break ties.

The evaluator selects the highest eligible score and logs aggregate diagnostics.
It does not persist automatic runners-up. Its API returns a ranked list internally
so a short-lived candidate reserve can be added later without rewriting
selection.

### Human nominations

The challenge-creation form has an optional `Nominate for a future Daily`
checkbox. There is no ordinary-user nomination action on existing challenge
cards and no retroactive nomination flow.

- Only a claimed VGames account may nominate.
- There is no arbitrary per-account nomination cap beyond existing challenge
  creation rate limits and challenge-pair deduplication.
- A challenge has at most one nomination record. Repeated nomination requests
  are idempotent.
- A duplicate creation attempt may nominate the existing challenge if the
  checkbox was selected, the challenge has never been a Daily, and it has no
  prior nomination record.
- Challenge creator attribution and nomination attribution remain distinct.
- A nomination never enters the official Daily queue without administrator
  approval.

The classifier stores `recognizable`, `weird`, and `hard` scores plus a suggested
flavor and confidence. A challenge can score well in multiple dimensions. Low
confidence remains visible to the administrator instead of forcing a label.

## Challenge Identity And Deduplication

A challenge is unique by the ordered tuple:

`(start_page_id, target_page_id, ruleset)`

The reverse direction is a different challenge because Wikipedia navigation is
directed.

Creation canonicalizes and validates both articles before attempting the
database write. Database uniqueness is authoritative under concurrency.

If the ordered pair already exists:

- no challenge row is inserted
- no global challenge number is consumed
- the API returns the existing challenge with an `existing` disposition
- the client selects it and encourages the player to play it
- an eligible nomination requested in the same operation is applied to the
  existing challenge

Automatic generation follows the same rule. If it finds an existing pair that
has never been a Daily, it may feature that challenge. If the challenge was
already a Daily, the pair is rejected and another candidate is evaluated.

## Daily Featuring Model

`Daily` becomes a dated feature assignment, not challenge identity. An existing
manual challenge can become a Daily without cloning or renumbering it.

Create a `daily_features` table with these columns:

- `daily_date text primary key`
- `challenge_id text not null unique references challenges(id)`
- `flavor text not null` checked to `recognizable`, `weird`, or `hard`
- `selection_source text not null` checked to `automatic`, `community`, or
  `admin`
- `queue_entry_id text` nullable, unique when present, and references
  `daily_queue_entries(id)`
- `selected_by_account_id text` nullable for automatic selections
- `classifier_version text not null`
- `selected_score integer` nullable for administrator overrides
- `created_at text not null`

The unique `challenge_id` constraint means a challenge can be a Daily only once,
ever. The unique `daily_date` constraint means a date can have only one Daily.
Together with challenge-pair uniqueness, this prevents duplicate Dailies by
identity or pair.

Existing Daily challenges are backfilled into `daily_features` without
renumbering or deleting data. Existing `origin`, `daily_date`, and `source`
columns remain compatibility provenance during this release; new catalog logic
uses `daily_features` as the authoritative feature assignment.

Existing leaderboard behavior remains unchanged. This release does not create
a separate 5:00 AM-to-5:00 AM leaderboard window for an old challenge.

## Nomination And Queue Model

Create a `daily_nominations` table with these columns:

- `id text primary key`
- `challenge_id text not null unique references challenges(id)`
- `nominated_by_account_id text not null`
- `nominated_by_display_name text not null`
- `status text not null` checked to `pending`, `approved`, or `declined`
- nullable integer `recognizable_score`, `weird_score`, and `hard_score`
- nullable `suggested_flavor` checked to the three Daily flavors
- `confidence text not null` checked to `high`, `medium`, `low`, or
  `unclassified`
- `classifier_version text not null`
- nullable `reviewed_by_account_id` and `reviewed_at`
- `created_at text not null` and `updated_at text not null`

Create a separate `daily_queue_entries` table so moderation history and queue
state have independent lifecycles:

- `id text primary key`
- `challenge_id text not null references challenges(id)`
- `nomination_id text unique references daily_nominations(id)` nullable for
  direct administrator promotions
- `flavor text not null` checked to the three Daily flavors
- `source text not null` checked to `community` or `admin`
- `status text not null` checked to `queued`, `consumed`, `removed`, or `invalid`
- `queued_by_account_id text not null`
- `queued_at text not null`
- nullable `consumed_daily_date` and `consumed_at`
- `updated_at text not null`

A partial unique index permits only one `queued` entry per challenge. The unique
feature constraint remains the permanent protection after consumption. Pending
nominations form the review inbox. Queued entries form one FIFO queue per
flavor, ordered by `queued_at` and then ID.

The administrator may also promote any existing, never-featured challenge.
Direct promotion creates an admin-sourced queue entry even when the challenge
was not nominated by its creator.

The scheduler consumes the oldest valid approved entry matching the day's
flavor. Invalid, inactive, or already-featured entries cannot be consumed and
are recorded for review. The administrator can override the suggested flavor,
decline a nomination, or remove an approved entry.

## Scheduler Flow

The existing DST-safe 5:00 AM `America/Chicago` gate and durable retry job remain
authoritative.

For each claimed date:

1. Derive the flavor from the Central weekday.
2. Look for the oldest approved queue entry in that flavor.
3. Revalidate that queued challenge and atomically create its `daily_features`
   row. Do not call editorial pools when this succeeds.
4. If no queued challenge is usable, fetch a bounded editorial target pool and
   random start candidates.
5. Evaluate the bounded candidate set and select the highest eligible score.
6. Reuse an existing never-featured challenge when the pair already exists;
   otherwise atomically allocate the next global challenge number and create it.
7. Atomically create the `daily_features` row and accept the durable job.
8. On bounded upstream or persistence failure, preserve existing retry behavior.

Queue consumption, feature assignment, challenge creation, and job acceptance
must be safe under concurrent scheduler and administrator requests. Database
constraints are the final authority; application checks provide friendly errors.

## Administrator Authorization And UI

The admin surface is part of the existing VWiki Race application, not a second
deployment or repository. Its protected client route is `/admin/dailies`.

The Worker authorizes administrators by immutable VGames account ID from the
`DAILY_ADMIN_ACCOUNT_IDS` environment configuration. A claimed display name is
not an authorization credential. The server enforces every admin operation even
if the UI is hidden.

The admin surface includes:

- pending nominations with creator, nominator, route, target preview, scores,
  suggestion, and confidence
- approve with suggested flavor
- override flavor with a segmented control
- decline nomination
- approved FIFO queues grouped by flavor
- remove an approved entry
- directly promote any existing never-featured challenge
- counts by suggested category to reveal submission patterns

Normal users see only the creation-time checkbox and clear success, duplicate,
already-nominated, or previously-featured feedback.

## API Shape

Use these v2 contracts:

- `POST /api/v2/challenges` accepts `nominateForDaily: boolean` and returns
  `{ challenge, disposition, nomination }`, where disposition is `created` or
  `existing` and nomination is `not_requested`, `pending`, `already_exists`,
  `previously_featured`, or `account_required`.
- `GET /api/v2/challenges` includes nullable `dailyFeature` metadata sourced
  from `daily_features`; the existing compatibility fields remain during this
  release.
- `GET /api/v2/accounts/me/capabilities` returns
  `{ canManageDailies: boolean }` for the authorized account.
- `GET /api/v2/admin/dailies` returns pending nominations and queued entries.
- `POST /api/v2/admin/daily-nominations/:id/approve` accepts a flavor override
  or uses the suggested flavor and creates a community queue entry.
- `POST /api/v2/admin/daily-nominations/:id/decline` declines a nomination.
- `POST /api/v2/admin/daily-queue` accepts an existing challenge ID and flavor
  for direct administrator promotion.
- `DELETE /api/v2/admin/daily-queue/:id` marks a queued entry removed.

All state-changing operations require idempotency keys. Admin and nomination
operations receive explicit rate limits appropriate to their low volume.

## Failure Behavior

- Editorial source unavailable: retry the durable Daily job; never silently
  fall back to the first structurally valid random target.
- Pageviews unavailable: continue with editorial membership and content signals
  at reduced confidence.
- Queue challenge changed or became invalid: retain it for admin review and
  continue to the next valid queue entry or automatic selection.
- Duplicate pair race: return the winning existing challenge and do not consume
  another number.
- Duplicate Daily race: return the existing feature assignment and do not create
  or overwrite another.
- Classification failure during creation: preserve the valid challenge and
  nomination as pending with `unclassified`; creation itself must not be lost.
- Unauthorized admin request: return a generic forbidden response without
  leaking configured administrator IDs.

## Request And Cost Guardrails

- Keep selection inside a 25-second wall-clock phase and at most 40 Wikimedia
  subrequests per invocation.
- Cache editorial source documents for 24 hours, retain stale data for seven
  days, and use conditional requests when available.
- Batch MediaWiki metadata requests by title.
- Do not crawl Wikipedia, process dumps, or perform open-ended BFS in the Worker.
- Do not persist automatic runners-up in this release.
- Emit structured counters for candidates sampled, rejected by reason, selected
  score, flavor, queue hit/miss, upstream requests, and elapsed time.

## Testing

### Domain tests

- weekday-to-flavor mapping across Central dates
- deterministic scoring and tie breaking
- quality-floor rejection reasons
- direct and bounded two-click hard rejection
- classifier suggestion and low-confidence behavior

### Repository and Worker tests

- ordered-pair uniqueness under sequential and concurrent creation
- duplicate creation consumes no challenge number
- duplicate creation can nominate the existing eligible challenge
- one nomination per challenge and idempotent retries
- one Daily per date and one Daily ever per challenge
- old manual challenge can be featured without cloning or renumbering
- approved matching queue entry wins over automatic generation
- FIFO ordering within each flavor
- invalid queue entry does not block automatic fallback
- existing never-featured automatic pair is reused
- previously featured pair is rejected
- migration backfills existing Dailies without losing runs or leaderboards
- admin authorization uses account ID and rejects name impersonation
- scheduler retries remain DST-safe and bounded

### Client tests

- nomination checkbox appears only in challenge creation for claimed accounts
- duplicate response selects and promotes the existing challenge to play
- nomination outcomes are explained without exposing internal identifiers
- non-admin users cannot discover admin navigation through ordinary UI
- admin inbox, approve/override/decline, queue removal, and direct promotion
  work on desktop and mobile

### Release verification

- full client, Worker, and production build gates
- read-only production D1 migration audit before apply
- apply-only-new migration sequence
- Worker-first deploy and API smoke tests
- Git push and Pages deploy after Worker compatibility is confirmed
- stateful smoke for duplicate creation, nomination, approval, and queue
  consumption against the local Worker test D1 database
- read-only production smoke for catalog feature metadata, capabilities, admin
  authorization rejection, queue listing as the configured admin, and existing
  leaderboard preservation

Production smoke must not create synthetic public challenges or runs. Use
read-only checks or explicitly approved real records for state-changing tests.

## Deferred

- exact Wikipedia graph and exact shortest paths
- persisted automatic candidate reserve
- community voting or automatic nomination approval
- per-Daily time-window leaderboards for old challenges
- nomination after creation for ordinary users
- full screen and information-architecture redesign
