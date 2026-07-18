# VWiki Race: Start Here

Last updated: 2026-07-17 America/Chicago / 2026-07-18 UTC

This is the canonical resume point after the July 2026 friend-ready and
editorial Daily releases. Read this file before changing the product. Dated
handoffs remain the evidence for individual releases; this file describes the
current whole system and points to the authoritative detail.

## Current Status

- Production: <https://vwikirace.pages.dev>
- GitHub: <https://github.com/theonenonlyvj/vwiki-race>
- Canonical API: <https://vwikirace-api.theonenonlyvj.workers.dev>
- VGames identity: <https://vgames-identity.theonenonlyvj.workers.dev>
- Protected Daily moderation route: <https://vwikirace.pages.dev/admin/dailies>
- Deployed runtime source: `320f2f6`
- Latest release-record commit before this pause handoff: `868c057`
- Production Worker version: `33bd5b92-1758-434c-b424-cce437df1f12`
- Production Pages deployment:
  `a446d93c-180a-4ec4-b9c2-92694050ba4f`
- D1 migrations `0001` through `0005` are applied. At the release check, D1
  reported no pending migrations. Never replay an applied migration.
- Normal production mode is restored: `MAINTENANCE_MODE=false`.

At the final 2026-07-18 UTC smoke check, production contained 6 challenges, 30
runs, and 3 backfilled Daily features. Challenge #3 still showed both completed
friend runs (`theonenonlyvj` and `FranTheGreat`). These counts are a snapshot,
not a target: runs will grow as people play, and the scheduler should append one
new numbered Daily per Central date.

The repository was clean and `main` matched `origin/main` before this
documentation closeout. A clean linked worktree remains at
`.worktrees/feat-editorial-dailies` on the fully merged runtime commit
`320f2f6`; it is not active release work and does not need to be resumed.

## Product In One Paragraph

VWiki Race is an asynchronous Wikipedia navigation game. A challenge has a
canonical start article and target article; a player wins by reaching the
target through allowed links rendered inside the game. Challenges have stable
numbers and share per-challenge leaderboards. VGames owns identity and ghost
claiming; VWiki Race owns challenges, creators, runs, accepted clicks, paths,
stats, Daily provenance, nominations, and leaderboards in Cloudflare D1. There
is no realtime room layer.

## Decisions That Are Settled

- The product name is **VWiki Race**; repository/deployment key is
  `vwiki-race` / `vwikirace`.
- VGames is the only account namespace. Do not add local usernames or a local
  player table.
- A VGames username is the canonical public display name and is unique.
- A guest is a VGames ghost. Its device credential persists locally and its
  server-side stats can follow a later claim or account merge.
- Identity is requested before Start or Create, not merely to browse the site.
  Signed-in players are not prompted again. Returning ghosts are encouraged to
  claim but may continue as the same guest.
- `Create New` is the default identity tab, with one username/display-name
  field and password confirmation. `Guest` is first; `Log In / Existing` is
  the other VGames account path.
- Every accepted run is server-tracked from game 0. localStorage is not the
  source of truth for scores, paths, challenges, or stats.
- Challenge links are stable: `/?challenge=challenge-000N`.
- Challenge identity is ordered
  `(start_page_id, target_page_id, ruleset)`. Recreating an existing pair
  returns that challenge and consumes no number. The reverse direction is a
  different challenge.
- Manual and automatic challenges use one transactional sequence. A Daily gets
  whatever the next global challenge number is; the date never determines the
  number.
- A challenge can be featured as a Daily only once ever. Daily dates and Daily
  challenge IDs are unique.
- Users may nominate a challenge only as part of challenge creation. If the
  entered pair already exists and is eligible, nomination may still attach to
  that existing challenge. Repeated nominations are idempotent.
- A claimed VGames account is required to nominate. Guests may still create
  normal challenges.
- The admin can approve, decline, remove, override flavor, or directly queue a
  never-featured human challenge. This is the protected `/admin/dailies`
  surface, not a separate application.
- Daily generation is asynchronous and leaderboard-based. It does not matter
  when different people press Start.

## Current User Experience

### Browse And Select

- The app opens on the playable product, not a marketing landing page.
- The main shell currently exposes Play, Leaderboard, Challenges, and Stats as
  tabs. Play and Challenges still share substantial screen content; separating
  these into distinct experiences is the next product project.
- Challenge cards select the authoritative server challenge. Query-string
  selection is preserved, including direct friend links.
- Before Start, the target shows a short sanitized Wikipedia lead with source
  revision and CC BY-SA attribution. Failure to load the preview never blocks
  play.

### Start And Identity

- Pressing Start first opens the identity prompt when there is no claimed or
  guest session.
- After the server accepts the run, the preloaded start article becomes
  interactive and decision time begins at zero.
- A returning account/ghost can recover its active run from the server.
- Closing the identity prompt does not start a run.

### Gameplay

- The article surface is intentionally close to Wikipedia and keeps useful
  tables and images while stripping navigation/search/unsafe controls.
- Only allowed internal English mainspace links become moves. Categories,
  references, language links, file/license links, navboxes, portals, red links,
  non-article namespaces, and See-also/further-reading sections are excluded.
- Clicking a valid link freezes decision time immediately. Wikipedia fetch and
  server synchronization time are excluded. The next page scrolls to the top
  and decision time resumes only when the accepted article is interactive.
- The compact in-run target disclosure keeps the preloaded, link-free target
  blurb available for reference.
- Browser find is blocked in the official client, but fair play ultimately
  relies on server-verifiable transitions rather than invasive browser
  policing.
- A player must click the target and load it; merely seeing its link is not a
  win.

### Results, Leaderboards, And Stats

- Completed runs rank by accepted active decision time, then clicks, then
  accepted completion time.
- Abandons with at least one accepted click appear below finishes as `DNF`.
  Zero-click abandons remain in account stats but not the public leaderboard.
- Every attempt after an account's first stored start on the same challenge is
  labeled `Repeat run`, regardless of the first attempt's outcome.
- Paths are stored for every run and disclosed on demand rather than embedded
  in every leaderboard response.
- Leaderboards are challenge-specific. The current public response is capped at
  100 terminal rows pending cursor pagination.
- Stats aggregate the canonical VGames account, including merged guest history.

## Challenge Creation

1. A player enters an English Wikipedia title or article URL for start and
   target.
2. The Worker resolves redirects, validates canonical page IDs, rejects invalid
   namespaces/disambiguation/nonexistent nodes, and checks that the start is
   playable.
3. The D1 repository atomically reuses an existing ordered pair or assigns the
   next global challenge number.
4. Creator attribution stores the canonical VGames account ID and public name.
5. A claimed creator can check `Nominate for a future Daily` only in this flow.
6. A nominated challenge is classified into a suggested Daily flavor when the
   bounded evaluator has enough evidence; otherwise it remains explicitly
   unclassified for admin choice.

There is no deletion flow for ordinary users. Moderation/reporting and
deactivation policy remain backlog decisions.

## Daily System

### Schedule

- The intended creation time is 5:00 AM `America/Chicago` every day.
- Cloudflare invokes `0 10 * * *` and `0 11 * * *` so one matches Central time
  across DST. The alternate trigger exits before touching D1.
- `17 * * * *` checks once for an existing due job. It does not create a new
  date and does not contact Wikipedia unless it successfully claims due work.
- The scheduler is durable and idempotent. A Central date gets at most one
  Daily and every accepted Daily consumes the next global challenge number.

### Editorial Flavors

- Monday-Wednesday: `recognizable`
- Thursday-Friday: `weird`
- Saturday-Sunday: `hard`

`recognizable` targets come from cached Wikipedia Vital Articles Levels 1-3;
`weird` targets come from cached Unusual Articles; `hard` uses their union with
additional shortcut rejection. Pools are fresh for 24 hours and may be used
stale for up to seven days when Wikipedia is unavailable.

Automatic evaluation is deterministic and versioned (`editorial-v1`). It tests
at most 10 targets and 3 independent random starts, permits at most 40
Wikimedia subrequests, and stops after 25 seconds. Every flavor still requires
a canonical English mainspace target, no redirect/disambiguation/list-like
target, at least 1,500 target bytes, an 80-character lead, and a start with
8-200 playable links.

`hard` is a bounded difficulty proxy. It rejects direct edges and detectable
two-click shortcuts; it is not a Wikipedia graph or an exact shortest-path
claim.

### Queue And Moderation

- Approved nominations enter a FIFO queue for their flavor.
- The scheduler consumes the oldest still-valid queued challenge for that
  day's flavor before running automatic selection.
- Admin direct promotion uses the same queue/provenance constraints.
- A queued/featured challenge cannot be silently repurposed across sources;
  migration `0005` enforces provenance through D1 constraints and triggers.
- At the release snapshot, nomination and queue tables were empty. That may
  legitimately change as users nominate and the admin moderates.

## Architecture And Ownership

```text
Browser
  -> Cloudflare Pages (Vite/React UI)
  -> canonical vwikirace-api Worker
       -> VGames service binding for identity
       -> D1 vwiki-race for game state
       -> Wikipedia/Wikimedia for validated article content and bounded Daily work
```

- Pages project: `vwikirace`; production is manually deployed from `dist`.
  There is no Git provider, so pushing `main` does not deploy Pages.
- Worker: `vwikirace-api`; configuration is `wrangler.api.toml`.
- D1: `vwiki-race`, binding `VWIKI_RACE_DB`, database ID
  `bbd89b81-078a-47e0-9db4-5d170a3f78b4`.
- Retained `functions/api/*` handlers are compatibility proxies for old
  `/api/*` clients. They do not bind D1 or own authorization/game logic.
- VGames owns credentials, uniqueness, ghost accounts, sessions, and account
  merging. VWiki Race stores only canonical IDs/aliases needed to own game
  history.

### Source Map

- `src/App.tsx`: current product shell and the four tab views.
- `src/components/AdminDailies.tsx`: protected nomination/queue moderation UI.
- `src/hooks/useRaceController.ts`: authoritative client run state, recovery,
  click sequencing, timing, and abandon/finish transitions.
- `src/services/wikipediaGateway.ts` and `wikipediaSanitizer.ts`: article fetch,
  faithful rendering, attribution, and playable-link filtering.
- `src/services/vgamesIdentity.ts`: persisted browser identity/session flow.
- `src/server/worker.ts`: canonical Worker routing, bindings, CORS, rate limits,
  maintenance gate, and cron entry point.
- `src/server/apiHandlers.ts`: API orchestration and creation-time nomination
  classification.
- `src/server/d1TrackingRepository.ts`: D1 transactions and all durable game,
  leaderboard, stats, Daily, nomination, and queue operations.
- `src/server/dailyCandidateEvaluator.ts`, `dailyCandidateScoring.ts`,
  `editorialTargetPools.ts`, and `dailyChallengeCandidates.ts`: bounded
  editorial Daily selection.
- `d1/migrations/`: immutable schema history. Add a new numbered migration for
  future schema changes; never edit or replay an applied migration.

### Durable Data

The migrations define account profiles/aliases, challenges, global challenge
sequence, runs, run events, path steps, idempotency records, durable Daily jobs,
Daily features, nominations, and queue entries. D1 is authoritative. Browser
storage is limited to identity/session continuity and recoverable client state.

## Deployment And Safety

In this repository, Vijay saying **ship it** means all of the following:

1. Finish, review, and verify the change locally.
2. Commit locally.
3. Inspect the remote D1 migration ledger and back up before any new migration.
4. Apply and verify required migrations.
5. Deploy and smoke-test the Worker first.
6. Push `main`.
7. Build and manually deploy Pages.
8. Smoke-test canonical production and confirm D1 counts/invariants.

Do not reverse Worker-before-Pages when both change. Do not run manual cron
fan-out as a test. Do not print/commit D1 exports, credentials, tokens, Wrangler
logs, or Time Travel bookmarks.

Migration `0005_editorial_dailies.sql` is already applied. Wrangler 4.110's
normal remote migration path could not parse its compound triggers, so the
reviewed release used D1's atomic file-import path under maintenance mode,
verified schema/backfill/foreign keys/counts, then inserted exactly one ledger
row. This is historical recovery evidence, not an instruction to reapply
`0005`. The full procedure is preserved in
`docs/handoff/cloudflare-deployment-handoff.md`.

Normal release gates:

```bash
npm test
npm run test:worker
VITE_VWIKI_RACE_API_URL=https://vwikirace-api.theonenonlyvj.workers.dev npm run build
npm audit --omit=dev
npx wrangler deploy --dry-run --config wrangler.api.toml
```

Current verified totals for runtime `320f2f6` were 488/488 regular tests and
112/112 Worker/D1 tests, with zero production dependency vulnerabilities.

Production commands, migration preflights, smoke checks, failure triage, and
the maintenance-mode procedure are authoritative in
`docs/handoff/cloudflare-deployment-handoff.md`.

## Known Limitations

1. **Screen structure:** Play, Leaderboard, Challenges, and Stats repeat the
   same shell/content patterns. Reimagining these as distinct, purpose-built
   experiences is the explicit next project.
2. **Graph/difficulty:** there is no full Wikipedia graph, exact reachability,
   challenge par, or shortest-path comparison.
3. **Competitive transition proof:** friend v0 validates canonical page
   identity, sequence, ownership, idempotency, and source continuity, but the
   server does not yet prove every click against the exact stored source
   revision. Do not attach prizes or claim tournament-grade anti-cheat.
4. **Historical reproducibility:** live Wikipedia changes. Immutable snapshots
   or cached revision sets are required for tournament claims.
5. **Pagination:** the public leaderboard response stops at 100 terminal rows.
6. **Community operations:** reporting, moderation, deactivation, and creator
   deletion for ordinary challenges are undecided.
7. **Retention loops:** no Daily archive/calendar, streaks, reminders, or
   notifications yet.
8. **Social layer:** no friend filters until VGames exposes a social graph.
9. **Localization:** English Wikipedia only; language editions need separate
   namespace rules, graphs, validation, and attribution.
10. **UI file size:** `src/App.tsx` is large. The screen reimagining should
    establish clearer view/component boundaries without changing server
    contracts incidentally.

## Next Session

1. Read `/Users/vijayram/Cursor/AGENTS.md`, this file,
   `docs/backlog.md`, and the latest dated release record.
2. From `/Users/vijayram/Cursor/vwiki-race`, run `git status` and `git log`.
   Do not work from the umbrella folder or the old linked feature worktree.
3. Check the canonical Pages and Worker URLs. Expect challenge/run counts to be
   higher after the break because production and the Daily scheduler continue.
4. List the remote D1 ledger before any future deployment. `0005` should not be
   pending; stop and investigate rather than replaying it if the ledger says
   otherwise.
5. Start the next product cycle by brainstorming the Play/Leaderboard/
   Challenges/Stats screen reimagining. Keep Daily scheduler and database
   behavior out of that UI scope unless an actual contract gap is found.
6. Preserve all user data and existing leaderboard history. Never reset D1 to
   make a new interface easier.

## Documentation Map

- `README.md`: short public project overview and local commands.
- `docs/game-principles-and-rules.md`: normative game rules and timing.
- `docs/backlog.md`: prioritized future work and explicit non-goals.
- `docs/handoff/cloudflare-deployment-handoff.md`: operational source of truth.
- `docs/handoff/2026-07-17-editorial-dailies-release.md`: exact latest release
  evidence, IDs, checks, and production snapshot.
- `docs/handoff/2026-07-16-friend-release-handoff.md`: prior friend-ready flow
  and historical incident context.
- `docs/decisions/2026-07-15-no-history-reset-at-cutover.md`: permanent data
  preservation decision.
- `docs/superpowers/specs/` and `docs/superpowers/plans/`: historical design and
  implementation provenance. Reconcile them with this file and current code;
  do not execute them blindly.

## Secrets And Private Recovery Material

No credentials or raw recovery artifacts belong in this repository. The July
17 release created a private ignored D1 export and recorded only its checksum
in the dated release record. Future agents should use the configured Wrangler
session and Cloudflare bindings without printing secrets. If access is missing,
ask Vijay rather than inventing replacement infrastructure.
