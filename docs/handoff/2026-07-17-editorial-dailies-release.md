# VWiki Race Editorial Daily Release Handoff

Date: 2026-07-17

Status: implementation handoff prepared for deployment. Migration
`0005_editorial_dailies.sql` is pending until the production D1 ledger is
inspected. Fill the release record only from completed gates and deployment
output; do not infer runtime state from the local commit.

## Scope

This release replaces first-valid random Daily selection with an editorial
system while preserving existing challenges, runs, creators, leaderboards, and
historical Daily provenance.

- Central Monday-Wednesday flavor is `recognizable`, Thursday-Friday is
  `weird`, and Saturday-Sunday is `hard`.
- `recognizable` uses cached Vital Articles Levels 1-3 targets, `weird` uses
  cached Unusual Articles targets, and `hard` uses their union.
- Editorial pools refresh after 24 hours and may be used stale for up to seven
  days when Wikipedia is unavailable.
- Every flavor uses the same quality floor: canonical English mainspace
  articles, no redirects/disambiguation or list-like targets, at least 1,500
  target article bytes, an 80-character target lead, and 8-200 playable start
  links.
- Automatic evaluation is deterministic and versioned (`editorial-v1`). It
  samples at most 10 targets and 3 independent random starts, allows at most
  40 Wikimedia subrequests, and stops after 25 seconds.
- Upstream, queue-race, and persistence failures stay within the durable Daily
  job's bounded retry/backoff path. They do not trigger unbounded Wikipedia
  requests or repeated manual cron fan-out.
- `hard` is a bounded direct-edge/two-click-shortcut proxy. There is no full
  Wikipedia graph and the product must not claim exact shortest-path distance.

## Challenge And Queue Rules

- Challenge identity is the ordered `(start_page_id, target_page_id, ruleset)`
  tuple. Reverse direction is distinct.
- A duplicate pair returns the existing challenge and does not consume a global
  challenge number. A challenge can be featured as a Daily only once ever.
- Claimed VGames accounts may nominate only during challenge creation through
  the `nominateForDaily` checkbox. Guests can create challenges, but a requested
  guest nomination returns `account_required`.
- Repeated nominations are idempotent and each challenge has at most one
  nomination record. Approval creates a per-flavor FIFO queue entry.
- The protected `/admin/dailies` surface can review pending nominations, approve
  with a suggested or overridden flavor, decline nominations, remove queued
  entries, and directly promote an existing never-featured challenge.
- The scheduler consumes the oldest valid approved queue entry for the Central
  weekday flavor before invoking automatic editorial selection.

## Migration And Deployment

`0005_editorial_dailies.sql` is additive. It adds ordered-pair uniqueness,
`daily_features`, `daily_nominations`, and `daily_queue_entries`, with guarded
provenance constraints and a legacy-Daily backfill. It must not rewrite,
renumber, or delete existing history.

Use the generic procedure in
[`cloudflare-deployment-handoff.md`](cloudflare-deployment-handoff.md):

1. Run the local release gates and commit the reviewed tree.
2. List the remote D1 ledger. Treat `0005` as pending until the ledger says it
   is applied.
3. If pending, run the read-only ordered-pair audit documented in the Cloudflare
   handoff and record a zero-row result. Any duplicate blocks the migration;
   never delete or merge challenge history during deployment.
4. Make a private D1 backup/export. Never print, commit, or publish the backup.
   Apply the reviewed migration and verify the ledger again. If Wrangler 4.110
   rejects the trigger migration through `migrations apply`, use only the
   documented atomic file-import fallback and verify schema/backfill before
   recording its ledger row. Keep the Worker in reviewed maintenance mode from
   immediately before the import until the normal Worker passes its smoke test.
5. Deploy and smoke-test the API Worker from `wrangler.api.toml`.
6. Only after the Worker is healthy, push/allow Pages deployment and smoke-test
   the frontend. Preserve Worker-before-Pages order.

The Worker schedule remains `0 10 * * *`, `0 11 * * *`, and `17 * * * *` UTC.
Only the DST-safe 5:00 AM `America/Chicago` gate creates a new Daily date; the
minute-17 trigger retries an existing due job and does not contact Wikipedia
without one.

## API And Configuration Inventory

The current v2 contracts include:

- `POST /api/v2/challenges` with optional `nominateForDaily`, returning the
  challenge, `created`/`existing` disposition, and nomination disposition.
- `GET /api/v2/challenges` with authoritative `dailyFeature` metadata.
- `GET /api/v2/accounts/me/capabilities` returning `canManageDailies`.
- `GET /api/v2/admin/dailies` for pending nominations and queue entries.
- `POST /api/v2/admin/daily-nominations/:id/approve` with optional flavor
  override, and `/decline`.
- `POST /api/v2/admin/daily-queue` for direct promotion and
  `DELETE /api/v2/admin/daily-queue/:id` for removal.

The Worker uses `DAILY_ADMIN_ACCOUNT_IDS` for immutable claimed VGames account
authorization and `DAILY_ADMIN_RATE_LIMITER` for moderation routes. The
configured admin limiter is 30 requests per minute. Do not authorize by display
name, expose account IDs to public clients, or add a local identity namespace.

## Release Record

Complete these fields from the final verified release. Placeholders are
intentional until deployment and testing are complete.

- Runtime source commit SHA: `<final-runtime-sha>`
- Client tests: `<client-passed>/<client-total>`
- Worker tests: `<worker-passed>/<worker-total>`
- Production build/bundle result: `<final-build-result>`
- Dependency audit result: `<final-audit-result>`
- Remote migration ledger before deployment: `<ledger-before>`
- Remote migration ledger after deployment: `<ledger-after>`
- Private backup identifier/location: `<private-backup-reference>`
- Worker deployment/version ID and UTC time: `<worker-deployment-id>`, `<utc>`
- Pages deployment ID, URL, and UTC time: `<pages-deployment-id>`,
  `<pages-url>`, `<utc>`
- Production smoke result: `<final-smoke-result>`

Do not record credentials, session tokens, raw D1 exports, or unredacted
private backup paths in this file.

## Next Product Priority

After this release, the next explicit product priority is a screen reimagining
with distinct UX for Play, Leaderboard, Challenges, and Stats. It is separate
from the editorial Daily scheduler and moderation contracts.

## Historical Boundary

[`2026-07-16-friend-release-handoff.md`](2026-07-16-friend-release-handoff.md)
records the prior deployed release. Its test counts, runtime SHA, migration
ledger, and deployment claims are historical and should not be rewritten to
describe this release.
