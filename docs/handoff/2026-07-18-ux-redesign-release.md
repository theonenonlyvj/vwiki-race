# Release Record: UX Redesign Increments 1-5 (Modes, Not Tabs)

Date: 2026-07-18 (UTC) · Runtime source commit: `7bb6199` · Released by:
Claude session (Codex on break)

Implements the council-ratified Increments 1-5 of
`docs/superpowers/specs/2026-07-18-ux-redesign-modes-design.md` via
`docs/superpowers/plans/2026-07-18-increments-1-5-execution.md`. Increment 0
(server prerequisites) has its own record:
`docs/handoff/2026-07-18-increment-0-release.md`, runtime `0a684aa`. This
record covers everything built on top of that baseline through `7bb6199`,
merged to `main` and deployed. `main` == this branch tip == production.

## What shipped

### Increment 1 — Race takeover: preview, race, results, recovery-first

Commits `bb06ab2`, `6208b6d`, `0f958d9`, `7acca11`, `7c06d52`, `e88f2e0`.

- New `src/race/` module: `PreRacePreview`, `RaceMode` (HUD), `RaceResults`,
  `RaceFlow` orchestrator, `RaceRecoveryInterstitial`, `shared.tsx`
  (`formatElapsed`, `ChallengeShareButton`, `useClipboardShare`).
- Full-screen, zero-chrome takeover: pressing Start opens a client-only
  preview (`raceStage='preview'`, no run created — invariant 3); the
  takeover replaces the whole app shell for preview/active/results, so
  Leaderboard/Stats can no longer render visible-but-disabled mid-race.
- `formatTimeAndClicks`/`formatMinutesSeconds` (`src/domain/formatting.ts`)
  is the single source of the invariant-1 `0:38 · 5 clk` string.
- Results rebuilt: placement always shown (server `leaderboardContext.rank`,
  not gated on personal-best), collapsed path recap, top-3 board snippet
  with own row highlighted, guest claim CTA directly above Share result, a
  named `PlayAnotherSlot` seam for Increment 5, and a DNF-specific variant
  ("That one got away — DNF · N clk") for End Run with ≥1 click.
- Recovery-first routing: identity session read synchronously at mount;
  `recoverActiveRun`'s `recovered` outcome force-navigates into the HUD,
  `recovery-required` renders the blocking `RaceRecoveryInterstitial` before
  any tab becomes interactive — explicit exception to invariants 3/4.
- App.tsx net -325 lines this increment. Client-only; zero `src/server/`
  diff. **Pages-only** release.

### Increment 2 — Bottom-nav mode shell, stateful Home, teaching gate

Commits `1c164a0`, `21e3aca`, `7d99648`.

- `src/modes/AppShell.tsx` replaces the top tabbar with the real
  Home/Boards/Challenges/You bottom nav; `src/modes/` gains `Home.tsx`,
  `Boards.tsx` (v0 stub), `You.tsx`, `challenges/Browse.tsx`,
  `challenges/ChallengeDetail.tsx` (new — no prior detail view existed).
  `/admin/dailies` keeps its pathname-gated bypass, no nav item.
- Home v2: three daily states (not-attempted / DNF / finished) derived from
  the challenge's own leaderboard row plus a session-local DNF flag;
  pre-play yesterday recap; post-play done hero, today's board, Share
  result, Play-another card, ritual line.
- App-shell-level first-visit teaching gate, derived from
  `accountStats.totals.completed`, never device storage — fires on Home
  and Challenge Detail, disappears after the account's first race.
- First-finish ritual hook ("Day 1... come defend your spot") on Results,
  fired from account stats regardless of whether the finished run was a
  daily.
- Challenge share links (`?challenge=challenge-000N`) land on Detail on
  initial load and popstate.
- Zero new server endpoints (council-ratified constraint for this
  increment). **Pages-only** release. 543 client / 123 worker tests at
  `21e3aca`.
- Pre-release fix `7d99648` (**B1**, URL-routing blocker): the
  `initialUrlRouteApplied` latch only set on the branch that honored a
  requested `?challenge=` id, not on every first catalog pass. A plain
  load (no query param) left the latch false forever, so the next
  focus/visibilitychange catalog refresh re-read the app's own
  URL-synced daily id, treated it as a fresh "honored" request, and
  force-navigated to Challenges/Detail out from under the player —
  including mid-race, under the active takeover. Fixed by latching on the
  first pass unconditionally. Same commit: **M1** (teaching gate flashed
  for a returning account while stats were still loading — gate now also
  checks `hasIdentifiedSession`) and **M2** (ritual-hook completion count
  snapshotted at run start via `preRaceCompletionsRef`, not read live off
  `accountStats` at Results-render time).

### Increment 3 — Board endpoint + Boards Today/Yesterday

Commits `cef2087`, `9d6a27f`.

- `listChallengeDnfs` (server): alias-resolved, `board_excluded`-aware,
  one row per canonical account (most-progressed abandon), excluding any
  account with a completed eligible run (invariant 2: completion
  supersedes DNF).
- New unauthenticated route `GET /api/v2/challenges/{id}/board` ->
  `{ challengeId, placements, dnfs }`; typed client method
  `getChallengeBoard`.
- Boards rebuilt on the new endpoint: `[Today] [Yesterday]` segmented
  control only (trends are Increment 4); deduped placements, own-row
  highlight, muted DNF section, no path disclosure anywhere in Boards
  (invariant 5); Race CTA on Today only when unplayed. Boards cold-starts
  on Today (Open Question 4). `LeaderboardPanel` retired.
- **Worker-then-Pages** release.

### Increment 4 — Trends + streaks backend, guards, arrows, Home chip

Commits `0be863d`, `e916901`, `21ec5bf`, `5d61951`, `efbe85d`.

- On-the-fly SQL, no new migration (friend-scale; materialize only past
  ~500 `daily_features` rows or a slow-query signal, per the plan).
  `listDailyTrends(windowDays, todayCentral)`: best-rank-per-account-per-
  daily over a window, ranked (played ≥ guard: 7d→3, 30d→10,
  lifetime→10) vs. unranked (played ≥1). `getAccountDailyStreak`: walks
  `daily_features` backward, silent reset on a missed day, no grace
  period; today not-yet-played doesn't break the streak until the day
  passes.
- New routes: `GET /api/v2/boards/trends?window=7|30|lifetime`,
  streak/`trend30` folded into `getAccountStats`.
- Boards segmented control grows to
  `[Today][Yesterday][7d][30d][Lifetime]`; ranked rows, muted
  "not yet ranked" section framed as progress (`"M/{guard} dailies"`, not
  a bare rejection); own-row drill-down into last-3 dailies
  (placement/DNF + time·clicks) by re-fetching `getChallengeBoard` per
  drilled challenge rather than a bespoke endpoint. Home's slim stats row
  and post-play streak/trend row now render real data, guarded (avg
  number hidden until the account clears the ranking threshold).
- **Worker-then-Pages** release. Client suite reached 586 at `5d61951`.
- Pre-release fix `efbe85d`:
  - **F1 (D1 bind-cap streak fuse):** the original streak query bound one
    parameter per fetched `daily_features` row (`IN (...)` over up to 500
    ids). D1 caps bound parameters at ~100/statement — Miniflare doesn't
    enforce the cap, so it never surfaced locally, but real D1 would 500
    on every stats read once ~100 dailies had ever been played. Rewritten
    as a single join with exactly 2 fixed binds regardless of catalog
    size; covered by a 150-`daily_features`-row regression test.
  - **F2 (DNF-counts-as-played ruling):** the spec's "played" for the
    participation guard and streak means "≥1 eligible/leaderboard-visible
    run," which includes a board-visible DNF (≥1 click abandon), not only
    completions. `listDailyTrends`'s `played_count` and the streak walk
    were extended to count DNF days; `avg_placement` still derives from
    completions (`placements`) only, so an account can clear the guard on
    DNFs alone and render unranked-with-progress (no fabricated average)
    rather than a ranked row with nothing to average.
  - **F3 (trend arrows):** added a muted ▲/▼/– arrow per ranked row,
    comparing `avgPlacement` against the immediately preceding
    same-length window via a second `listDailyTrends` call reusing the
    same guard-filtered `ranked` list. No arrow on Lifetime (no previous
    window).
  - Same commit also tightened the trends route's error handling (honest
    errors) and echoed the guard value used for the ranked/unranked split
    in the response.

### Increment 5 — Browse cards, play-another, on-demand random

Commits `8c16cd0`, `100c286`, `b62d66d`, `56c4482`, `7bb6199`.

- New endpoints: `GET /api/v2/challenges/summary` (unauthenticated,
  per-challenge `playerCount`/`best` via one GROUP BY, no N+1),
  `GET /api/v2/account/challenge-outcomes` (auth, bulk per-challenge state
  chip data, invariant-2 precedence), `GET /api/v2/challenges/suggestion`
  (auth, most-popular never-started challenge, `account_aliases`-resolved,
  excludes today's daily), `POST /api/v2/challenges/random` (auth,
  reuses the daily-generator candidate machinery via an injected
  `findRandomCandidate`, `origin='manual'`/`source='wikipedia_random'`).
- `playerCount` is a distinct-account-day floor, not raw run rows —
  council's forgeability-floor note applied to Browse meta and
  Play-another's popularity ranking the same way leaderboard rank is
  floored.
- Random-challenge protections: `RANDOM_CHALLENGE_RATE_LIMITER` (ns 51008,
  1/60s per account, fail-open when absent) + an always-enforced D1 hourly
  quota (3 `wikipedia_random` creations/hour/account, 429 + `Retry-After
  3600`) + per-account concurrency cap of 1 via an
  `operation_idempotency`-backed lock (60s stale TTL) + candidate failure
  -> retryable 503.
- Client: Browse cards get the meta line + state chip
  (`NEW`/`✓ best`/`DNF`, invariant-2 precedence) from the summary/outcomes
  endpoints (anonymous visitors get neither); svh-safe top-anchored search
  container reusing the identity-dialog dvh/svh fix; `PlayAnotherCard`
  shared between Home's post-play card and Results' slot, backed by one
  App.tsx-owned suggestion fetch so the two screens can't disagree; a
  shared busy/lock/error state across Browse/Home/Results prevents a
  double-fire on create-random; 429/503 get friendly, `Retry-After`-aware
  copy.
- Along the way, fixed a latent client validation bug: `isChallenge`'s
  provenance check rejected the exact `origin:"manual"` +
  `source:"wikipedia_random"` shape `createRandomChallenge`'s own server
  mapping produces; corrected the validator and the stale test that had
  asserted the opposite.
- **Worker-then-Pages** release (`wrangler deploy --dry-run` confirmed the
  new binding first).
- Pre-release fix `7bb6199` (per-IP random ceiling): the per-account
  rate limit and D1 hourly quota alone don't stop a ghost farm — an
  attacker can mint many fresh guest accounts from one IP, each with its
  own untouched per-account quota, and still drive ~10 25-second
  Wikipedia crawls a minute from a single machine. Added
  `RANDOM_CHALLENGE_IP_RATE_LIMITER` (ns 51009, 2/60s keyed on
  `CF-Connecting-IP`, fail-open when absent), enforced *before* the
  per-account guard on `POST /api/v2/challenges/random`.

## Gates (at `7bb6199`)

- `npm test`: 664/664 passed (44 files)
- `npm run test:worker`: 187/187 passed (3 files)
- `npx tsc --noEmit`: clean
- `npm run build` + `verify:bundle`: pass; production bundle
  `index-Bhdi9PEr.js` / `index-BZfCJn44.css`
- `npm audit --omit=dev`: 0 vulnerabilities

All four numbers reproduced locally against the merged tip at documentation
time.

## Deploy evidence

- Worker version chain across the release: `32185d48` (Increment 0,
  carried through Increments 1-2, which were Pages-only and shipped no
  server diff) → `5193900f` (Increment 3: board endpoint) → `1fbbd2a3`
  (Increment 4: streak/trends endpoints, landed with the F1-F3 fixes) →
  `341fe0b9` (Increment 5: summary/outcomes/suggestion/random endpoints,
  landed with the per-IP ceiling fix).
- Final Pages bundle: `index-Bhdi9PEr.js` (matches the local build above).
- Schema: migration `0006_board_exclusions.sql` (Increment 0) is the only
  schema change across the entire redesign — Increments 1-5 shipped zero
  additional migrations. It was applied with a private D1 backup before
  application; the backup identifier/checksum is recorded in
  `docs/handoff/2026-07-18-increment-0-release.md` and is not repeated
  here.

## Known follow-ups (from review, not blocking)

- Catalog-refresh staleness window: the visibilitychange-triggered catalog
  refetch (`App.tsx` `catalogRefreshQueued`) isn't tied to a bundle-version
  check, so a tab left open across a Pages deploy can serve a stale
  catalog snapshot until its next focus event.
- Play-another suggestion refetch (`statsRefreshVersion`-driven) is
  correct but has a noted timing nit versus the stats refetch it piggybacks
  on — flagged LOW, not reworked this release.
- Trend arrows (F3) double `listDailyTrends`'s query cost for the 7d/30d
  windows (one extra call for the previous-window comparison); non-issue
  at current volume, flagged for revisit if trend-window traffic grows.
- `LIMIT 100` (Increment 0) is inherited by Increment 3's board query and,
  through it, Increment 4's trend windows (Task 3.1/4.1 PR notes); still
  a non-issue at current scale (few hundred challenges, dozens of runs)
  but explicitly not fixed this release.
- Browse's popularity `ORDER BY` has no covering index; fine at current
  scale, revisit with a cache/index at low thousands of challenges
  (council note, Increment 5).
- Assorted LOW-severity copy/consistency nits noted during increment
  reviews (e.g. "NEW" chip aging into "recently added" misreading, claim
  CTA pun copy) were left as implementation-time carve-outs per the spec
  and are not tracked further here.

## Next

`docs/backlog.md` and `docs/handoff/START_HERE.md` Known Limitations carry
forward what's left (integrity/reproducibility/pagination unchanged by this
release; the screen-reimagining item this release closes out).
