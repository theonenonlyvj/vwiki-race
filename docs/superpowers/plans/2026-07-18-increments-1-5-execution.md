# UX Redesign: Increments 1-5 Execution Plan

Date: 2026-07-18 · Status: DRAFT, ready to hand to an executing agent
Source: `docs/superpowers/specs/2026-07-18-ux-redesign-modes-design.md`
(council-ratified). Increment 0 is DONE (`docs/superpowers/plans/
2026-07-18-increment-0-server-prereqs.md`, runtime `0a684aa`) — this plan
starts from that baseline; it grounds each task in real file paths rather
than restating the spec.

## Conventions

- Work in `.worktrees/redesign`, branch `claude/redesign`. Never touch the
  main checkout `/Users/vijayram/Cursor/vwiki-race`.
- Both suites green before every commit (`npm test`, `npm run test:worker`);
  `npm run build` before any release. Commits end with `Co-Authored-By:
  Claude Fable 5 <noreply@anthropic.com>`.
- Before Increment 1 and again before Increment 2, get a Codex merge-window
  agreement (clean tree, pushed, ff-only) — App.tsx is "the single highest
  merge-conflict-risk piece of the whole project" (council).
- Release ladder: **Pages-only** = `npm run build` → `npx wrangler pages
  deploy dist --project-name=vwikirace --branch=main` (client-only change).
  **Worker-then-Pages** = `npx wrangler deploy --config wrangler.api.toml`,
  smoke the new route, then the Pages command above — never reversed. No
  increment 1-5 ships a migration.

## Client file structure (progressive App.tsx split)

`src/App.tsx` is 2,258 lines today: one component owns tab state, race
wiring, and every panel. Target layout, built incrementally:

```
src/race/            RaceFlow.tsx, RacePreview.tsx, RaceHud.tsx, RaceResults.tsx,
  (Increment 1)       RaceRecoveryInterstitial.tsx, PathStrip.tsx, useRaceNavigationLock.ts
src/modes/            AppShell.tsx (nav/router/admin-bypass/teaching-gate),
  (Increment 2+)      Home.tsx, Boards.tsx, challenges/Browse.tsx,
                      challenges/ChallengeDetail.tsx, You.tsx
src/components/       ChallengeShareButton.tsx, TimeClicks.tsx (invariant-1 formatter),
                      StateChip.tsx, TeachingGate.tsx, PlayAnotherCard.tsx
src/domain/           formatting.ts, teachingGate.ts, playAnother.ts
src/App.tsx           shrinks each increment to a thin bootstrap
```

`LeaderboardPanel` retires in Increment 3, `ChallengeBrowser` in Increment
2 (`AppShell` replaces `TabKey`). `useRaceController.ts`/
`useTargetPreview.ts` stay in `src/hooks/` — only consuming JSX moves.

---

## Increment 1 — Race-flow extraction, inside the existing tab shell

Isolates the highest-merge-conflict surface before the nav/IA changes
underneath it. Tabs stay; `RaceFlow` overlays them full-screen whenever
`race.phase` is active.

### Task 1.1: `RaceFlow` shell + Pre-race preview + shared formatting

**Goal:** Pull mid-run/preview JSX out of `PlayPanel`/`TargetPreviewPanel`
into `src/race/`, rendered as a zero-chrome full-screen takeover. Add
`formatTimeAndClicks`, the one source of truth for the time+clicks string
used everywhere from here on.

**Files:** create `src/race/RaceFlow.tsx`, `RacePreview.tsx`, `PathStrip.tsx`
(from `App.tsx:1834`), `src/components/ChallengeShareButton.tsx` (from
`App.tsx:1696`), `src/domain/formatting.ts` (`formatTimeAndClicks`;
relocate `formatElapsed`, whose current `38.4s` output must become `m:ss`
to match the spec). Modify `App.tsx`: delete `PlayPanel`'s mid-run branch
(~1547-1605), `TargetPreviewPanel` (1642-1694), `PathStrip` (1834-1868);
mount `<RaceFlow>` when `race.phase` is `preparing|active|syncing|
abandoning`, overlaid above the tab body. Test: `src/race/RaceFlow.test.tsx`.

**Acceptance criteria:**
- Pre-race preview: "YOUR TARGET" + sanitized lead + attribution; escape
  hatches `← Back` and "Not feeling it? See other challenges ›"; backing
  out starts no run (invariant 3).
- Invariant 1: "Time AND clicks, always... (`0:38 · 5 clk`)" —
  `formatTimeAndClicks` is the only place this string is built.
- "Zero tabs/nav" while mounted — no `role="tablist"` during `active` phase.

### Task 1.2: Race mode 2 (HUD) + Results, DNF-aware copy

**Goal:** Build the mid-run HUD and Results as their own components,
carrying today's exact End Run/DNF copy into the takeover's own exit
surface instead of the current floating `run-notice` paragraph.

**Files:** create `src/race/RaceHud.tsx`, `RaceResults.tsx`. Modify
`App.tsx`: move the completed-result panel (1550-1584) and End Run confirm
dialog (~1120-1131) in; preserve exact copy — `"Run ended. Your DNF and
path were saved."` / `"Run ended. The attempt was saved to your stats."`
(`App.tsx:812-813`). Modify `styles.css` for HUD layout.

**Acceptance criteria:**
- HUD: "live timer + click count (always visible), compact '🎯 Target ▾'
  disclosure... prominent coral **End Run**... muted path breadcrumb
  (ellipsized)" — reuse `PathStrip`'s existing `<details>` disclosure.
- Results: "'You reached it' + placement + time · clicks; collapsed path
  recap; today's board snippet... Share result; the Play-another card" —
  Play-another is Increment 2 scope; leave a named `<PlayAnotherSlot />`
  component, not a TBD comment.
- Guest claim CTA sits directly above Share result: "You're on the board
  as Guest-XXXX. Claim it so it stays yours." Council: Share/claim
  pinned-vs-scroll-reachable is an implementation call, not a spec defect
  — record the choice made (Share is the product's only virality lever).

### Task 1.3: Recovery-first routing + back-gesture lock

**Goal:** Make `recoverActiveRun`'s outcome the first thing that runs on
load, before tabs become interactive, carrying the existing popstate
re-anchoring into the extracted race module.

**Files:** create `src/race/RaceRecoveryInterstitial.tsx`,
`useRaceNavigationLock.ts` (from the `popstate` handler at `App.tsx:
362-386` and `challengeIsLocked`/`syncChallengeUrl`, 191-193, 353-359).
Modify `App.tsx`: recovery effect (344-352) gates `RaceFlow`/
`RaceRecoveryInterstitial` mount before tabs are interactive.

**Acceptance criteria:**
- "Recovery takes priority over everything else... `recovered` ->
  force-navigate straight into full-screen Race mode 2... `recovery-
  required` -> force a lightweight interstitial that reuses the existing
  End-Run/legacy-run resolution UI; control is not released... until it
  resolves" (tabs stand in for Home/bottom-nav this increment) — "an
  explicit exception to... invariants 3 and 4."
- Migration note (i): back-gesture lock "must re-anchor to Race mode
  rather than exit" — port `challengeIsLocked`'s re-anchor verbatim; add a
  regression test.

### Release — Increment 1

Pure client restructuring, no server/migration diff. **Pages-only.** Smoke:
mid-run reload recovers into Race mode 2; a legacy run triggers the
blocking interstitial; abandon shows DNF copy inside the takeover. Push
`main`; record release evidence.

---

## Increment 2 — Bottom-nav mode shell + Home v1 + Challenges/Browse v1 + You

**Zero new server endpoints** (council-ratified constraint for this
increment — every task below must hold to it).

### Task 2.1: `AppShell` — bottom nav, mode router, admin bypass

**Goal:** Replace `TabKey`'s four tabs with the real Home/Boards/
Challenges/You nav, preserving `/admin/dailies` exactly as a pathname-gated
bypass, not a fifth nav item.

**Files:** create `src/modes/AppShell.tsx` (nav state, mounts one mode +
`RaceFlow` as full-screen override). Modify `App.tsx`: shrink to a
bootstrap wiring `apiClient`/`identityClient`/`race`/`challenges`,
rendering `<AppShell>`; move `isAdminDailiesRoute`/`syncAdminDailiesUrl`
(2171-2183) in unchanged. Modify `styles.css` for the bottom-nav bar.
Boards ships as a "Coming soon" stub — Increment 3 fills it in.

**Acceptance criteria:**
- "Distinct modes replace the persistent 4-tab shell... Race flow... NOT
  in the nav; a full-screen takeover with zero global chrome."
- Migration note (ii): admin bypass "must hold through the restructuring"
  — regression test confirms no bottom nav on that route.
- Migration note (iv): share links land on Detail "through the
  restructuring" — `?challenge=challenge-000N` routes there on load.

### Task 2.2: Home v1 (pre-play / DNF / post-play) + teaching gate + ritual hook

**Goal:** Build Home's three daily states from data already fetched:
today's daily (client-derivable via `dailyDateForChallenge`) and that
challenge's own leaderboard row for the account (`GET /api/v2/challenges/
{id}/leaderboard` already includes DNF rows by `status`) — no new endpoint.

**Files:** create `src/modes/Home.tsx`, `src/components/TeachingGate.tsx`,
`src/domain/teachingGate.ts` (gate derives from `stats.totals.completed >
0`, not local storage). `AppShell.tsx`: teaching-gate mount is app-shell
level (fires on Home or Detail, whichever comes first).

**Acceptance criteria:**
- Three states (not attempted / DNF / finished). Pre-play stats row ("🔥
  streak · '30-day avg #2.4 (26 dailies)'") is Increment 4 data — v1 omits
  the row rather than showing a fabricated number.
- DNF sub-state: "'Last try: DNF · Try again'... the first-visit rules
  strip... must not silently re-trigger on this sub-state."
- Teaching gate: "'Two articles. Links only. Beat the clock.'... Footer:
  'No account needed to look around.'... must fire on Challenge Detail
  too." Migration note (iii): derived from `stats.totals.completed`, never
  device-local storage.
- Ritual hook: "first finish of any kind — not daily-specific" adds "🔥
  Day 1 · New daily drops 5:00 AM — come defend your spot" (wired into
  `RaceResults`). No rivalry/rematch strip.

### Task 2.3: Challenges/Browse v1 + Challenge Detail + You

**Goal:** Port `ChallengeBrowser` into `Browse.tsx` unchanged in behavior,
add a new `ChallengeDetail.tsx` (today's browser has no detail view), and
port `StatsPanel` into `You.tsx` as-is.

**Files:** create `src/modes/challenges/Browse.tsx` (from `App.tsx:
1870-1993`), `ChallengeDetail.tsx` (new), `src/modes/You.tsx` (from
`StatsPanel`/`StatsList`, `App.tsx:2099-2162`). Modify `App.tsx`: delete
`ChallengeBrowser`, `StatsPanel`, `StatsList`; `LeaderboardPanel` stays
until Increment 3.

**Acceptance criteria:**
- The dvh-safe search-field rework is **Increment 5 scope** — ship the
  existing input as-is; don't attempt the svh pattern yet.
- "N players · best 0:38 · 5 clk" meta and the `NEW`/`✓`/`DNF` state chip
  are not derivable from `listChallenges`/`getAccountStats` today (Data
  requirements) and are Increment 5 scope — v1 cards ship title + creator
  only; do not fabricate counts.
- "'+ Create a challenge' card at the bottom (existing creation +
  nomination flow unchanged)" — reuse the form verbatim.
- Detail: back link, pair title, creator attribution, **Race this**, the
  challenge's own leaderboard, "Your history" strip, "Copy link" — built
  entirely on existing `listLeaderboard` + `ChallengeShareButton`. You:
  existing Stats content ports over unchanged; streak/trend fields render
  only once Increment 4 supplies the data.

### Release — Increment 2

Confirm zero `src/server/` diff before release. **Pages-only.** Smoke: cold
load lands on Home in the correct daily state; DNF sub-state doesn't
re-trigger the teaching gate; admin route unaffected; share link lands on
Detail. Push `main`; record release evidence.

---

## Increment 3 — Boards, daily views only (Today/Yesterday)

A straightforward read over Increment 0's corrected data, independent of
the one increment needing new backend work (Increment 4).

### Task 3.1: Server — full daily board (finishers + DNFs, one row per account)

**Goal:** `listChallengePlacements` (Increment 0, "not yet routed") is
completions-only; Boards also needs DNFs. Generalize it to mirror
`listLeaderboard`'s `result_group` precedence (completed=0, abandoned=1)
but collapsed to one row per account **within each group**.

**Files:** modify `src/server/d1TrackingRepository.ts`: extend
`listChallengePlacements` (~2314) into `listChallengeBoard(challengeId) ->
{ finishers, dnf }`, adding a second best-per-account CTE over abandoned
rows for accounts with no finish. Modify `trackingRepository.ts`,
`worker.ts` (new route `GET /api/v2/challenges/{id}/board`),
`apiHandlers.ts`. Modify `vwikiRaceApiClient.ts`: `getChallengeBoard(id)`.
Test: an account with a completed run AND a later DNF appears once, in
`finishers`, never in `dnf`.

**Acceptance criteria:**
- Invariant 2: "A later DNF never demotes a prior ✓... one row per
  account... `GROUP BY account_id, MIN(rank)`" — matches "Today/
  Yesterday... full board... collapsed to one row per account... DNFs
  (≥1 click) listed below finishers per existing rules."
- Reuses Increment 0's `board_excluded = 0` filter and `account_aliases`
  resolution unchanged — don't re-derive those CTE fragments.
- **`LIMIT 100` revisit for trends:** this query inherits Increment 0's
  `LIMIT 100` cap, applied pre-dedup. Flag it in the PR as "revisit at
  Increment 4" rather than silently inheriting it — Increment 4's rolling
  trends aggregate this query across many dailies, where the cap compounds
  into a durable distortion, not a one-board blip.

### Task 3.2: Client — Boards screen, Today/Yesterday segments

**Goal:** Fill in the Boards stub with the real Today/Yesterday segmented
board; retire `LeaderboardPanel`.

**Files:** modify `src/modes/Boards.tsx` (segmented control `[Today]
[Yesterday]` only — 7d/30d/lifetime hidden until Increment 4). Modify
`App.tsx`: delete `LeaderboardPanel` (2036-2098); its row/DNF-row
rendering (2051-2079) moves into `Boards.tsx`. Modify `src/modes/Home.tsx`:
point the pre-play "yesterday's board" recap and post-play "today's board"
snippet at `getChallengeBoard` instead of raw `listLeaderboard`, so Home
and Boards can never disagree.

**Acceptance criteria:**
- "'paths hidden until you've played'... 'played' means **finished**, not
  merely started/DNF'd."
- "a Race CTA if the viewer hasn't played today's" (Yesterday has none).
- Open Question 4 resolved: Boards defaults to **Today** on entry, to
  avoid duplicating Home's yesterday pre-play card.

### Release — Increment 3

New endpoint, no migration. **Worker-then-Pages.** Smoke `GET /api/v2/
challenges/{id}/board` against a challenge with both finishers and a DNF,
then Pages deploy. Push `main`; record release evidence, flagging the
inherited `LIMIT 100` as a tracked constraint.

---

## Increment 4 — Streaks + rolling avg-placement backend, then Home v2 + Boards trends

The one increment gated on new server work; every other screen is already
live first, and Increment 0's containment flag already bounds a forged
run's blast radius.

### Task 4.1: Streak + rolling-placement queries (on-the-fly, no new table)

**Goal:** Resolve Open Question 2 now: ship streaks and rolling
avg-placement as on-the-fly SQL over `daily_features` × the Increment 3
board query, **not** a materialized table. At current scale (6 challenges,
~34 runs, 3 daily features, +1/day per `START_HERE.md`) a backward walk
over a few hundred rows is trivial; materialize only once `daily_features`
exceeds ~500 rows or the query shows up in slow-query logs — that trigger,
not a deferral, is the decision.

**Files:** modify `src/server/d1TrackingRepository.ts`: `getAccountStreak
(accountId) -> { currentStreak, playedToday }` (walks `daily_features`
backward; "played" = a row in that day's `listChallengeBoard`
finishers-or-dnf); `getAccountTrend(accountId, window: "30d") ->
{ dailiesPlayed, avgPlacement, guardMet, requiredDailies }`;
`listBoardsTrend(window: "7d"|"30d"|"lifetime") -> { ranked, unranked }` —
all three share one internal walk so they can't disagree. Modify
`worker.ts`/`apiHandlers.ts`: `GET /api/v2/accounts/me/streak`, `GET
/api/v2/accounts/me/trend?window=30d`, `GET /api/v2/boards/trend?
window=7d|30d|lifetime`. Modify `vwikiRaceApiClient.ts` accordingly. Test:
silent-reset across a gap; guard-boundary at exactly 3/7 and 10/30; a DNF
day counts toward "played" but not toward improving average.

**Acceptance criteria:**
- "Streak-break rule: missing a day is a silent reset, no grace period."
- "Rolling avg placement... using best (lowest) rank per account per
  daily — `GROUP BY account_id, MIN(rank)`, matching the corrected
  invariant 2, not raw leaderboard rows."
- Participation guard: "must have played ≥⅓ of the window's dailies to be
  ranked (**7d → ≥3, 30d → ≥10; lifetime → ≥10 total**) — 'played' means
  ≥1 eligible/leaderboard-visible run" (a DNF day counts). Council: it "is
  a display-noise filter, not integrity protection" — a simple count
  threshold, not behind the admin containment surface.
- Flag in the PR: `listBoardsTrend`'s windows walk through Task 3.1's
  inherited `LIMIT 100` per daily — non-issue at current volume, noted so
  a future high-traffic daily doesn't silently truncate a trend input.

### Task 4.2: Home v2 — guarded streak/avg chip

**Goal:** Fill in the streak/avg row Increment 2 shipped hidden, respecting
the guard so a day-1 player never sees a meaningless rank on Home.

**Files:** modify `src/modes/Home.tsx`: pre/post-play rows call
`getAccountStreak` + `getAccountTrend(window: "30d")`.

**Acceptance criteria:**
- "streak/trend row... streak only, avg-placement number muted/hidden
  until the account clears the ranking threshold — otherwise a day-1
  player sees a statistically meaningless ranking on the app's
  highest-traffic screen."
- **Guard copy framing (council):** below-guard state "should read as
  progress toward a goal ('4/10 dailies'), not a bare rejection, on a
  primary nav destination" — render `"{dailiesPlayed}/{requiredDailies}
  dailies"` exactly, never a bare "not ranked" or blank state.

### Task 4.3: Boards trends — 7d/30d/lifetime segments + drill-down

**Goal:** Add trend segments to the Increment 3 Boards screen, with
per-player drill-down into recent dailies.

**Files:** modify `src/modes/Boards.tsx`: enable `[7d] [30d]`; ship
Lifetime as a 5th segment (Open Question 1) rather than folding under 30d,
since `listBoardsTrend` already supports `window: "lifetime"` from Task
4.1 at no extra backend cost. Create `src/modes/BoardsTrendDrilldown.tsx`.

**Acceptance criteria:**
- "ranked by average placement... 'avg #2.4 (26 dailies)' with a subtle
  trend arrow."
- "Unranked players appear in a muted section with their count ('4
  dailies — needs ≥10 to rank')" — same guard-copy framing as Task 4.2.
- "A drill-down under a row shows... placement + time · clicks (invariant
  1 holds at drill-down level)" — reuse `formatTimeAndClicks`. Rolling
  trends "ship only alongside the... containment flag" — already shipped
  in Increment 0; the trend query inherits `board_excluded` filtering by
  construction (built on the Increment 3 board query) — confirm in the PR
  rather than re-testing from scratch.

### Release — Increment 4

New endpoints, no migration. **Worker-then-Pages.** Smoke all three routes
against an account with ≥10 daily plays, then Pages deploy. Push `main`;
record release evidence including the `LIMIT 100` flag from Task 4.1.

---

## Increment 5 — Challenges/Browse full card spec + Play-another polish

Purely additive on top of Increment 2's basic Browse — can slip a cycle
without blocking the daily-ritual loop.

### Task 5.1: Browse aggregate + bulk-outcome endpoint

**Goal:** Add the per-challenge aggregate (player count, best time·clicks)
and bulk per-account outcome data Browse v1 deferred, floored against
forgery per the council's containment note.

**Files:** modify `src/server/d1TrackingRepository.ts`:
`listChallengesWithOutcomes(accountId?) -> ChallengeCard[]` —
per-challenge `{ playerCount, bestElapsedMs, bestClickCount }` via `GROUP
BY challenge_id` over the same best-per-account CTE shape used elsewhere,
plus, when `accountId` is present, that account's state chip per challenge
in the same response (bulk, not N calls). Modify `worker.ts`/
`apiHandlers.ts`: extend `GET /api/v2/challenges` with an authenticated
variant, or add `GET /api/v2/challenges/browse` if the shape diverges
enough — either is fine; don't change the existing unauthenticated
`listChallenges` contract. Modify `src/modes/challenges/Browse.tsx`:
render meta line + state chip.

**Acceptance criteria:**
- "the per-card aggregate... and the bulk per-account outcome... are not
  derivable from `listChallenges`/`getAccountStats` today; both require a
  new query/endpoint."
- **Forgeability floor (council):** "Play-another's popularity ranking and
  Browse's 'N players' meta are exactly as forgeable as leaderboard rank —
  floor them by distinct account-days, or gate behind a similar
  participation guard." — `playerCount` counts distinct account-days, not
  raw run rows.
- Council: no covering index exists for the global `ORDER BY`; "fine at
  current scale... revisit with a cache/index at low thousands" — no index
  migration this increment, note the trigger in the PR. Chip precedence
  follows invariant 2: `✓ best (time·clicks)` > `DNF` > `NEW`.

### Task 5.2: Hardened Play-another + on-demand random-challenge endpoint

**Goal:** Replace Increment 2's title-matched approximation with the real
`account_aliases`-resolved query, and add the missing on-demand
random-challenge endpoint with its own rate-limit tier.

**Files:** modify `src/server/d1TrackingRepository.ts`:
`getPlayAnotherSuggestion(accountId) -> { challengeId } | null` —
popularity (Task 5.1's account-day-floored `playerCount`) × never-started.
Modify `worker.ts`: new `POST /api/v2/challenges/random` (reuses the
existing daily-generator machinery); Env addition
`RANDOM_CHALLENGE_RATE_LIMITER` (distinct from
`CHALLENGE_CREATE_RATE_LIMITER`) plus a D1-side hourly quota (Cloudflare
rate-limit bindings only support 10s/60s periods, per Increment 0) and a
per-account in-flight concurrency cap of 1. Modify `wrangler.api.toml`:
the new binding. Modify `src/components/PlayAnotherCard.tsx`,
`src/domain/playAnother.ts`: swap in the real suggestion; add
loading/timeout UX for the fallback.

**Acceptance criteria:**
- **account_aliases resolution (council):** "Play-another's 'never
  started' query must resolve `canonical_account_id` via `account_aliases`
  (same as `getAccountStats`/`listLeaderboard`), or claimed-from-guest
  accounts get wrongly suggested challenges they already played" — the
  concrete fix over Increment 2's title-matched approximation.
- "an explicit low limit (e.g. 2-3/hour per account), a conservative
  global/IP ceiling, and a per-account concurrency cap of 1 in-flight
  request — plus loading/timeout UX for the endpoint's up-to-~25s wall
  time (this is not the near-instant 'inviting card' action the current
  framing implies)." Card framing itself is unchanged: "one suggestion +
  'Browse all ›' — never a menu," now backed by real data.

### Task 5.3: dvh-safe Browse search field

**Goal:** Fix Browse's search input before it ships the same iOS Safari
tap-swallow bug already diagnosed and fixed on the identity dialog — reuse
that fix, don't rediscover it.

**Files:** modify `src/styles.css`: apply the `.modal-backdrop:has(...)` /
`100svh`, top-anchored pattern at `src/styles.css:1964-1997` (the
identity-dialog fix) to Browse's search field container. Modify
`src/modes/challenges/Browse.tsx`: container structure to match the
`:has()` selector scoping.

**Acceptance criteria:**
- **dvh/svh input rule (council):** the search field "must not sit in a
  dvh-sized container whose geometry shifts on keyboard dismiss; reuse the
  svh/top-anchored pattern already proven and scoped on the identity
  dialog rather than rediscovering the same tap-swallow bug on new UI."
- `dvh` tracks the visual viewport and shrinks the instant the keyboard
  starts dismissing, re-anchoring a bottom-sheet layout mid-tap; `svh` is
  the stable, keyboard-independent minimum — top-anchor, don't
  bottom-sheet, the container. Verify manually on an iOS Safari device
  before release (not reproducible in jsdom).

### Release — Increment 5

New endpoints + one new rate-limit binding, no migration.
**Worker-then-Pages** (`wrangler deploy --dry-run` first to confirm
`RANDOM_CHALLENGE_RATE_LIMITER` is present), smoke the browse-aggregate
route and a random-challenge request (expect ~25s, not instant), then
Pages deploy. Push `main`; record release evidence and close out the
redesign entry in `docs/handoff/START_HERE.md`'s Known Limitations.
