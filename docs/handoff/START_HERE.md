# VWiki Race: Start Here

Last updated: 2026-07-18 America/Chicago / 2026-07-18 UTC

This is the canonical resume point after the July 2026 friend-ready,
editorial Daily, and **UX redesign (modes, not tabs)** releases. Read this
file before changing the product. Dated handoffs remain the evidence for
individual releases; this file describes the current whole system and
points to the authoritative detail.

## Current Status

- Production: <https://vwikirace.pages.dev>
- GitHub: <https://github.com/theonenonlyvj/vwiki-race>
- Canonical API: <https://vwikirace-api.theonenonlyvj.workers.dev>
- VGames identity: <https://vgames-identity.theonenonlyvj.workers.dev>
- Protected Daily moderation route: <https://vwikirace.pages.dev/admin/dailies>
- Deployed runtime source: `7bb6199`
- Latest release-record commit: `6b70c23` ("docs: record UX redesign release
  (increments 1-5)")
- Production Worker version: `341fe0b9` — the chain across this release was
  `32185d48` (Increment 0) → `5193900f` (Increment 3) → `1fbbd2a3`
  (Increment 4) → `341fe0b9` (Increment 5). Increments 1-2 were client-only
  (Pages-only releases, zero `src/server/` diff) and shipped under
  `32185d48`.
- Production Pages deployment bundle: `index-Bhdi9PEr.js` (confirmed live on
  `vwikirace.pages.dev` at doc time).
- D1 migrations `0001` through `0006` are applied. `0006_board_exclusions.sql`
  (Increment 0) is the only schema change since `0005`; Increments 1-5 added
  zero further migrations. Never replay an applied migration.
- Normal production mode is restored: `MAINTENANCE_MODE=false`.
- **The UX redesign is COMPLETE.** All six council-ratified increments (0-5)
  of `docs/superpowers/specs/2026-07-18-ux-redesign-modes-design.md` are
  merged to `main` and deployed. The Play/Leaderboard/Challenges/Stats tab
  shell this file previously described as the "next product project" no
  longer exists — see Current User Experience below. Release evidence:
  `docs/handoff/2026-07-18-increment-0-release.md` (server prerequisites) and
  `docs/handoff/2026-07-18-ux-redesign-release.md` (Increments 1-5).

The repository was clean and `main` matched `origin/main` at
`7bb6199` before this documentation closeout. Production challenge/run
counts continue to grow as people play and the Daily scheduler runs; treat
any specific count as a point-in-time snapshot from the release record that
recorded it, not a target to reconcile against here.

## Product In One Paragraph

VWiki Race is an asynchronous Wikipedia navigation game, designed as a
Wordle-style daily ritual rather than a browse-y game hub: open, race
today's daily, see where you stand, share or leave, come back tomorrow. A
challenge has a canonical start article and target article; a player wins by
reaching the target through allowed links rendered inside the game.
Challenges have stable numbers and share per-challenge leaderboards and
boards. VGames owns identity and ghost claiming; VWiki Race owns challenges,
creators, runs, accepted clicks, paths, stats, streaks, trends, Daily
provenance, nominations, and leaderboards in Cloudflare D1. There is no
realtime room layer.

## Decisions That Are Settled

- The product name is **VWiki Race**; repository/deployment key is
  `vwiki-race` / `vwikirace`.
- VGames is the only account namespace. Do not add local usernames or a local
  player table.
- A VGames username is the canonical public display name and is unique.
- A guest is a VGames ghost. Its device credential persists locally and its
  server-side stats can follow a later claim or account merge.
- Identity is requested before Start or Create, not merely to browse the
  site. Signed-in players are not prompted again. Returning ghosts are
  encouraged to claim but may continue as the same guest. The one exception
  is active-run recovery on app load, which resolves before any identity
  prompt or mode shell renders (see Race flow).
- `Create New` is the default identity tab, with one username/display-name
  field and password confirmation. `Guest` is first; `Log In / Existing` is
  the other VGames account path.
- Every accepted run is server-tracked from game 0. localStorage is not the
  source of truth for scores, paths, challenges, or stats.
- Challenge links are stable: `/?challenge=challenge-000N`, and now land
  definitively on Challenge Detail (not a board or the old shared-selection
  behavior).
- Challenge identity is ordered
  `(start_page_id, target_page_id, ruleset)`. Recreating an existing pair
  returns that challenge and consumes no number. The reverse direction is a
  different challenge.
- Manual and automatic challenges use one transactional sequence. A Daily gets
  whatever the next global challenge number is; the date never determines the
  number. An account-triggered random challenge (Play-another's fallback)
  uses the same sequence and machinery, tagged `source='wikipedia_random'`.
- A challenge can be featured as a Daily only once ever. Daily dates and Daily
  challenge IDs are unique.
- Users may nominate a challenge only as part of challenge creation. If the
  entered pair already exists and is eligible, nomination may still attach to
  that existing challenge. Repeated nominations are idempotent.
- A claimed VGames account is required to nominate. Guests may still create
  normal challenges.
- The admin can approve, decline, remove, override flavor, or directly queue a
  never-featured human challenge. This is the protected `/admin/dailies`
  surface, not a separate application, and it bypasses the bottom-nav shell
  entirely rather than becoming a nav item.
- Daily generation is asynchronous and leaderboard-based. It does not matter
  when different people press Start.

### Redesign global invariants (binding, apply to every screen present and future)

Council-ratified in `docs/superpowers/specs/2026-07-18-ux-redesign-modes-design.md`:

- **Time and clicks, always.** Any row or summary showing a run shows both
  (`0:38 · 5 clk`, `formatTimeAndClicks` is the one source of this string),
  matching the ranking order (time → clicks → completion).
- **A completion is permanent.** Player-facing state chips show best-ever
  outcome with precedence `✓ best (time·clicks)` > `DNF` > `NEW`. A later
  DNF never demotes a prior finish.
- **Placement is best-rank-per-account.** A player's placement for a given
  daily/board is their best (lowest) rank among that day's eligible runs —
  `GROUP BY account_id, MIN(rank)` — not a raw leaderboard row per attempt.
  This governs Boards (Today/Yesterday/trends) and the participation guard's
  "played" denominator. It does **not** retroactively change Challenge
  Detail's own per-challenge leaderboard, which still lists every eligible
  attempt via the original `listLeaderboard` (each attempt after the first
  labeled `Repeat run`) — Boards and Detail are deliberately two different,
  documented views of the same underlying runs.
- **No run exists until Start.** Browsing, previews, and backing out are
  consequence-free. Exception: active-run recovery on app load.
- **Identity is asked only at Start or Create**, never for browsing or
  previewing (same exception as above).
- **Paths stay hidden until you've played** a challenge, meaning finished —
  not merely started or DNF'd. A retry after an abandon still shows the
  sanitized, link-free preview.
- **Casual framing until integrity lands.** No prizes/"official" language
  while leaderboards remain forgeable (see Known Limitations).

## Current User Experience

The four-tab shell (Play/Leaderboard/Challenges/Stats) is gone. Distinct
modes replace it, per the redesign spec's "modes, not tabs" IA:

### Bottom-nav modes: Home, Boards, Challenges, You

- **Home** — the stateful daily hub, bottom-nav item 1. Reads today's daily
  as one of three states: **not attempted** (DAILY hero card with flavor
  badge, pair title, primary Race button, slim streak/avg stats row,
  yesterday's final board as a recap card — the player has no stake in
  today's board yet, which discourages scouting); **attempted, not
  finished** (the hero acknowledges "Last try: DNF · Try again" instead of
  presenting as if nothing happened, and does not silently re-trigger the
  teaching gate); **finished** (hero flips to done state with placement/
  time/clicks, today's live board with the player highlighted, Share
  result, a Play-another suggestion card, and a guarded streak/trend row).
  Home's yesterday recap and today's-board snippet are both backed by the
  same `getChallengeBoard` endpoint Boards uses, so they can never disagree.
- **Race flow** — NOT a nav item; a full-screen, zero-chrome takeover
  entered via any "Race" button, or automatically on app load if an active
  run needs recovery. **Recovery takes priority over everything else**:
  `recoverActiveRun`'s outcome runs before any mode shell is interactive —
  `recovered` force-navigates straight into the mid-run HUD, `recovery-
  required` (a legacy protocol-1 run, or one whose challenge no longer
  exists) forces a blocking interstitial before control returns to Home/the
  bottom nav. This is an explicit exception to "no run until Start" and
  "identity only at Start/Create." Beats: **1. Pre-race preview** ("YOUR
  TARGET," sanitized link-free lead, attribution, Back / "See other
  challenges" escape hatches — backing out starts no run) → **2. Race
  mode** (slim always-visible timer/click-count HUD, compact target
  disclosure, prominent coral End Run, muted path breadcrumb; zero tabs/nav
  while mounted) → **3. Results** ("You reached it," this run's placement +
  time·clicks, collapsed path recap, today's board snippet, Share result, a
  guest claim CTA directly above Share, the Play-another card, and — on an
  account's first finish of any kind, daily or not — a ritual hook pointing
  at tomorrow's 5:00 AM drop).
- **Boards** — bottom-nav item 2. Segmented control `[Today] [Yesterday]
  [7d] [30d] [Lifetime]`, cold-starts on Today. Today/Yesterday show the
  full deduped board (rank, name, time·clicks, one row per account per
  invariant 2) plus a muted DNF section below finishers, a Race CTA on
  Today only if unplayed, and never disclose a path (Detail-only). 7d/30d/
  Lifetime rank by average placement across that window's dailies
  (`"avg #2.4 (26 dailies)"`, with a muted ▲/▼/– trend arrow vs. the prior
  same-length window; no arrow on Lifetime). **Participation guard:** must
  have played ≥⅓ of the window to rank — 7d → ≥3, 30d → ≥10, lifetime →
  ≥10 total — where "played" includes a board-visible DNF (≥1 click), not
  completions only. Below-guard players appear in a muted section framed as
  progress (`"4/10 dailies"`, never a bare rejection). Tapping your own
  ranked row expands a drill-down of your last 3 dailies as placement/DNF +
  time·clicks.
- **Challenges** (library) — bottom-nav item 3. **Browse**: svh-safe
  top-anchored search field (accepts pasted share links/ids, jumps straight
  to Detail), today's daily pinned at top pointing to Home, challenge cards
  with pair title, a meta line (`"N players · best 0:38 · 5 clk"`,
  `playerCount` floored to distinct account-days, forgery-resistant like
  leaderboard rank), a state chip per invariant 2 (`NEW` / `✓ best` / `DNF`,
  omitted for anonymous visitors), and a "+ Create a challenge" card at the
  bottom (existing creation + nomination flow, plus a new "Create a random
  new one" path — see below). **Detail**: back link, pair title, creator
  attribution, "Race this," the challenge's own (non-deduped, every-attempt)
  leaderboard, "Your history" strip, "Copy link." The app-shell-level
  first-visit teaching gate ("Two articles. Links only. Beat the clock.")
  fires on whichever of Home or Detail an account lands on first — derived
  from `accountStats.totals.completed`, never device-local storage — since
  share links make Detail the actual most-likely entry point during active
  friend rollout.
- **You** — bottom-nav item 4. Existing Stats content (totals, top
  articles, bridge pages) plus the streak/trend chip; the persistent claim/
  log-in affordance for guests lives here.
- `/admin/dailies` bypasses the bottom-nav shell entirely as a pathname-
  gated route, unchanged by the redesign — it is not a fifth nav item.

### Play-another and on-demand random challenges

Home's post-play card and Results' Play-another slot share one suggestion:
the most-popular challenge (account-day-floored `playerCount`) the account
has never started, `account_aliases`-resolved so a claimed-from-guest
account isn't wrongly re-suggested something it already played, excluding
today's daily. When none remain, the card offers "Create a random new one,"
which calls `POST /api/v2/challenges/random` (reuses the daily-generator
candidate machinery). Guardrails: `RANDOM_CHALLENGE_RATE_LIMITER` (1/60s per
account) plus an always-enforced D1 quota of 3 `wikipedia_random` creations
per account per hour (429 + `Retry-After 3600`), a per-account in-flight
concurrency cap of 1, and `RANDOM_CHALLENGE_IP_RATE_LIMITER` (2/60s per IP,
enforced before the per-account guard) to close the ghost-farm gap where one
IP mints many guest accounts to bypass per-account limits. The request takes
up to ~25s (a real Wikipedia crawl, not an instant action); the client shows
bounded loading/timeout copy and shares one busy/lock/error state across
Browse, Home, and Results so it can't double-fire.

### Gameplay (unchanged by the redesign)

- The article surface is intentionally close to Wikipedia and keeps useful
  tables and images while stripping navigation/search/unsafe controls.
- Only allowed internal English mainspace links become moves. Categories,
  references, language links, file/license links, navboxes, portals, red
  links, non-article namespaces, and See-also/further-reading sections are
  excluded.
- Clicking a valid link freezes decision time immediately. Wikipedia fetch
  and server synchronization time are excluded. The next page scrolls to
  the top and decision time resumes only when the accepted article is
  interactive.
- Browser find is blocked in the official client, but fair play ultimately
  relies on server-verifiable transitions rather than invasive browser
  policing.
- A player must click the target and load it; merely seeing its link is not
  a win.

### Results, leaderboards, boards, and stats

- Completed runs rank by accepted active decision time, then clicks, then
  accepted completion time.
- Abandons with at least one accepted click appear below finishers as `DNF`
  on both the per-challenge leaderboard and Boards. Zero-click abandons
  remain in account stats but never mint a leaderboard/board row.
- Every attempt after an account's first stored start on the same challenge
  is labeled `Repeat run` on Challenge Detail's own leaderboard,
  regardless of the first attempt's outcome. Boards collapse repeats to one
  row per account per invariant 2.
- Paths are stored for every run and disclosed on demand rather than
  embedded in every leaderboard/board response; Boards never discloses a
  path at all (Detail-only).
- Challenge Detail's own leaderboard is capped at 100 terminal rows pending
  cursor pagination; Boards' daily/trend queries inherit the same cap
  (flagged in review, not fixed this release — see Known Limitations).
- Stats aggregate the canonical VGames account, including merged guest
  history, plus the new daily streak (consecutive days played, silent reset
  on a missed day, no grace period) and 30-day rolling average placement
  (guarded — hidden until the account clears the ranking threshold).

## Challenge Creation

1. A player enters an English Wikipedia title or article URL for start and
   target (or triggers Play-another's on-demand random path, above).
2. The Worker resolves redirects, validates canonical page IDs, rejects
   invalid namespaces/disambiguation/nonexistent nodes, and checks that the
   start is playable.
3. The D1 repository atomically reuses an existing ordered pair or assigns
   the next global challenge number.
4. Creator attribution stores the canonical VGames account ID and public
   name.
5. A claimed creator can check `Nominate for a future Daily` only in this
   flow (not on the random-challenge path).
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
`weird` targets come from cached Unusual Articles; `hard` uses their union
with additional shortcut rejection. Pools are fresh for 24 hours and may be
used stale for up to seven days when Wikipedia is unavailable.

Automatic evaluation is deterministic and versioned (`editorial-v1`). It
tests at most 10 targets and 3 independent random starts, permits at most 40
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
- **Capability gap, unchanged by the redesign:** the admin surface can
  approve/decline/remove queue entries and directly promote a
  never-featured challenge into a future slot, but there is no operation to
  swap or retract an *already-featured* daily once the scheduler has run
  for that Central date. A bad live daily has no in-app undo.

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
- Same-origin API routing (2026-07-23): production clients call `/api/*` on
  their OWN origin. `functions/api/[[path]].ts` catches everything the
  retained legacy routes do not claim and forwards it to the Worker over the
  `VWIKI_API` service binding declared in the root `wrangler.toml`
  (Cloudflare-internal - no public `workers.dev` hop on the client path;
  that hostname intermittently stalls from some ISPs). The client resolves
  its API origin at RUNTIME: explicit `VITE_VWIKI_RACE_API_URL` override >
  own origin on any `*.pages.dev` host > legacy
  `https://vwikirace-api.theonenonlyvj.workers.dev` fallback
  (`src/services/apiOrigin.ts`). Build production with the variable UNSET;
  setting it pins every client to that origin and bypasses the same-origin
  path (that is the rollback lever, not the default).
- VGames owns credentials, uniqueness, ghost accounts, sessions, and account
  merging. VWiki Race stores only canonical IDs/aliases needed to own game
  history.

### Source Map

The redesign split the old monolithic `App.tsx` (2,258 lines pre-redesign)
into `src/race/` and `src/modes/`, progressively, across Increments 1-2.
`App.tsx` (1,744 lines) is now a bootstrap: it owns `apiClient`/
`identityClient`/`useRaceController` wiring, catalog fetch/refresh (incl.
the visibilitychange-triggered staleness refetch), identity session state,
account stats, the Play-another suggestion fetch, admin-route detection, and
renders `<AppShell>` — it no longer owns any tab/panel JSX itself.

- `src/App.tsx`: bootstrap/wiring only, described above.
- `src/modes/AppShell.tsx`: bottom-nav state, mode router, `/admin/dailies`
  pathname bypass, the app-shell-level teaching-gate mount point; mounts one
  mode component plus `<RaceFlow>` as a full-screen override.
- `src/modes/Home.tsx`, `Boards.tsx`, `You.tsx`,
  `challenges/Browse.tsx`, `challenges/ChallengeDetail.tsx`: the four
  bottom-nav modes described under Current User Experience.
- `src/race/RaceFlow.tsx` (orchestrator), `PreRacePreview.tsx`,
  `RaceMode.tsx` (HUD), `RaceResults.tsx`, `RaceRecoveryInterstitial.tsx`,
  `shared.tsx` (`formatElapsed`, `ChallengeShareButton`,
  `useClipboardShare`): the full-screen race takeover.
- `src/components/`: `AdminDailies.tsx` (protected moderation UI),
  `BoardSnippet.tsx`, `LeaderboardList.tsx`, `ModalDialog.tsx`,
  `PlayAnotherCard.tsx`, `StateChip.tsx`, `TeachingGate.tsx` — shared
  presentational pieces used across modes/race.
- `src/domain/`: pure logic and wire types, including the redesign's
  additions — `formatting.ts` (invariant-1 `formatTimeAndClicks`),
  `teachingGate.ts`, `dailyTrends.ts` (guard/window math), `challengeCard.ts`
  and `challengeSearch.ts` (Browse), `playAnother.ts` — alongside the
  pre-existing `challengeSelection.ts`, `challenges.ts`, `gameSession.ts`,
  `leaderboard.ts`, `pathCompression.ts`, `rules.ts`, `serverLeaderboard.ts`,
  `stats.ts`, `types.ts`.
- `src/hooks/useRaceController.ts`: authoritative client run state,
  recovery, click sequencing, timing, and abandon/finish transitions —
  unmoved by the redesign, only its consuming JSX moved. `useTargetPreview.ts`
  likewise.
- `src/services/wikipediaGateway.ts` and `wikipediaSanitizer.ts`: article
  fetch, faithful rendering, attribution, and playable-link filtering.
- `src/services/vgamesIdentity.ts`: persisted browser identity/session flow.
- `src/services/urlRouting.ts`: challenge-share-link (`?challenge=`) URL
  parsing (new this redesign).
- `src/services/vwikiRaceApiClient.ts`: typed client methods for every v2
  route, including the redesign's board/trends/summary/outcomes/suggestion/
  random-challenge endpoints.
- `src/server/worker.ts`: canonical Worker routing, bindings, CORS, rate
  limits, maintenance gate, and cron entry point.
- `src/server/apiHandlers.ts`: API orchestration, creation-time nomination
  classification, board/trends/browse composition.
- `src/server/d1TrackingRepository.ts`: D1 transactions and all durable game,
  leaderboard, board, streak/trend, stats, Daily, nomination, and queue
  operations.
- `src/server/dailyCandidateEvaluator.ts`, `dailyCandidateScoring.ts`,
  `editorialTargetPools.ts`, and `dailyChallengeCandidates.ts`: bounded
  editorial Daily selection, now also reused by the on-demand random-
  challenge endpoint.
- `d1/migrations/`: immutable schema history, `0001` through `0006`. Add a
  new numbered migration for future schema changes; never edit or replay an
  applied migration.

### Durable Data

The migrations define account profiles/aliases, challenges, global challenge
sequence, runs, run events, path steps, idempotency records, durable Daily
jobs, Daily features, nominations, queue entries, and (`0006`) a
board-exclusion flag on runs. D1 is authoritative. Streaks and rolling
avg-placement are derived on the fly over existing tables (no new table;
materialize only past ~500 `daily_features` rows or a slow-query signal,
per the redesign plan). Browser storage is limited to identity/session
continuity and recoverable client state.

## Deployment And Safety

In this repository, Vijay saying **ship it** means all of the following:

1. Finish, review, and verify the change locally.
2. Commit locally.
3. Inspect the remote D1 migration ledger and back up before any new
   migration.
4. Apply and verify required migrations.
5. Deploy and smoke-test the Worker first.
6. Push `main`.
7. Build and manually deploy Pages.
8. Smoke-test canonical production and confirm D1 counts/invariants.

Do not reverse Worker-before-Pages when both change. Do not run manual cron
fan-out as a test. Do not print/commit D1 exports, credentials, tokens,
Wrangler logs, or Time Travel bookmarks.

Migration `0005_editorial_dailies.sql` and `0006_board_exclusions.sql` are
already applied. `0005`'s recovery via D1's atomic file-import fallback
(Wrangler 4.110 couldn't parse its compound triggers through the normal
remote migration path) is historical evidence, not an instruction to
reapply it; the full procedure is preserved in
`docs/handoff/cloudflare-deployment-handoff.md`. `0006` applied cleanly
through the normal path with a private backup — see
`docs/handoff/2026-07-18-increment-0-release.md`.

Normal release gates:

```bash
npm test
npm run test:worker
npm run build
npm audit --omit=dev
npx wrangler deploy --dry-run --config wrangler.api.toml
```

Since 2026-07-23 the production build runs with NO `VITE_VWIKI_RACE_API_URL`
(same-origin runtime resolution; `verify:bundle` checks both runtime
branches shipped). Prefixing the build with
`VITE_VWIKI_RACE_API_URL=https://vwikirace-api.theonenonlyvj.workers.dev`
pins clients to the public Worker origin - use only as a deliberate
rollback of same-origin routing.

Current verified totals for runtime `7bb6199` were 664/664 client tests and
187/187 Worker/D1 tests, `tsc --noEmit` clean, and zero production
dependency vulnerabilities.

Production commands, migration preflights, smoke checks, failure triage, and
the maintenance-mode procedure are authoritative in
`docs/handoff/cloudflare-deployment-handoff.md`.

## Known Limitations

1. **Graph/difficulty:** there is no full Wikipedia graph, exact
   reachability, challenge par, or shortest-path comparison.
2. **Competitive transition proof:** the server does not yet prove every
   click against the exact stored source revision. Do not attach prizes or
   claim tournament-grade anti-cheat — this is also why the redesign keeps
   casual framing (global invariant 7) until it lands.
3. **Historical reproducibility:** live Wikipedia changes. Immutable
   snapshots or cached revision sets are required for tournament claims.
4. **Pagination:** the public/Detail leaderboard response stops at 100
   terminal rows, applied pre-dedup; Boards' daily/trend queries inherit
   the same cap (non-issue at current scale — few hundred challenges,
   dozens of runs — but explicitly not fixed, flagged for revisit if a
   single daily's finisher count approaches it).
5. **Community operations:** reporting, moderation, deactivation, and
   creator deletion for ordinary challenges are undecided.
6. **Retention loops:** streaks and rolling avg-placement trends shipped
   (Increment 4); a Daily archive/calendar, reminders, and notifications
   remain unbuilt.
7. **Social layer:** no friend filters until VGames exposes a social graph.
8. **Localization:** English Wikipedia only; language editions need
   separate namespace rules, graphs, validation, and attribution.
9. **Daily swap:** the admin surface cannot retract or swap an
   already-featured daily (see Daily System · Queue And Moderation).
10. **Browse/Play-another scaling:** Browse's popularity `ORDER BY` and the
    Play-another suggestion query have no covering index; fine at current
    scale, revisit with a cache/index once the catalog reaches low
    thousands of challenges.
11. **Catalog staleness:** the client's visibilitychange-triggered catalog
    refetch isn't tied to a bundle-version check, so a tab left open across
    a Pages deploy can serve a stale catalog snapshot until its next focus
    event. Noted in review, not fixed this release.

## Next Session

1. Read `/Users/vijayram/Cursor/AGENTS.md`, this file, `docs/backlog.md`,
   and the two latest dated release records
   (`docs/handoff/2026-07-18-increment-0-release.md` and
   `docs/handoff/2026-07-18-ux-redesign-release.md`).
2. From `/Users/vijayram/Cursor/vwiki-race`, run `git status` and `git log`.
   Do not work from the umbrella folder. The redesign work happened in
   `.worktrees/redesign` on branch `claude/redesign`, merged ff-only into
   `main`; do not resume from that worktree unless picking up unmerged
   redesign follow-ups.
3. Check the canonical Pages and Worker URLs. Expect challenge/run counts to
   be higher than any historical record, since production and the Daily
   scheduler continue.
4. List the remote D1 ledger before any future deployment. `0006` should not
   be pending; stop and investigate rather than replaying it if the ledger
   says otherwise.
5. The sanctioned "next product project" that motivated the redesign is now
   shipped. For the next product cycle, start from `docs/backlog.md` and the
   Known Limitations above rather than re-opening the modes IA — read
   `docs/superpowers/specs/2026-07-18-ux-redesign-modes-design.md`'s
   "Explicitly out of scope / deferred" section (friends/social graph,
   rivalry features, leaderboard integrity) for what was deliberately left
   for later.
6. Preserve all user data and existing leaderboard history. Never reset D1 to
   make a new interface easier.

## Documentation Map

- `README.md`: short public project overview and local commands.
- `docs/game-principles-and-rules.md`: normative game rules and timing.
- `docs/backlog.md`: prioritized future work and explicit non-goals.
- `docs/handoff/cloudflare-deployment-handoff.md`: operational source of
  truth.
- `docs/superpowers/specs/2026-07-18-ux-redesign-modes-design.md`:
  council-ratified design for the modes-not-tabs IA (product lens, global
  invariants, per-screen specs, data requirements, build increments).
- `docs/superpowers/plans/2026-07-18-increment-0-server-prereqs.md` and
  `2026-07-18-increments-1-5-execution.md`: the execution plans the
  redesign was built from, grounded in real file paths/line numbers.
- `docs/handoff/2026-07-18-increment-0-release.md` and
  `2026-07-18-ux-redesign-release.md`: exact release evidence for the
  redesign (Increment 0, then 1-5).
- `docs/handoff/2026-07-17-editorial-dailies-release.md`: prior release,
  editorial Daily selection and creation-time nomination.
- `docs/handoff/2026-07-16-friend-release-handoff.md`: prior friend-ready
  flow and historical incident context.
- `docs/decisions/2026-07-15-no-history-reset-at-cutover.md`: permanent data
  preservation decision.
- `docs/superpowers/specs/` and `docs/superpowers/plans/`: historical design
  and implementation provenance beyond the redesign. Reconcile them with
  this file and current code; do not execute them blindly.

## Secrets And Private Recovery Material

No credentials or raw recovery artifacts belong in this repository. Private
D1 exports are git-ignored and only their checksums are recorded in dated
release records. Future agents should use the configured Wrangler session
and Cloudflare bindings without printing secrets. If access is missing, ask
Vijay rather than inventing replacement infrastructure.
