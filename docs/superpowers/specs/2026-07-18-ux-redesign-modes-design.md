# UX Redesign: Modes, Not Tabs — Design

Date: 2026-07-18 · Status: DRAFT, awaiting Vijay's review
Council-reviewed 2026-07-18: SHIP_WITH_FIXES → all 12 amendments incorporated.
Owner: Claude session (Codex on break) · Brainstormed interactively with Vijay
(visual mockups in session scratchpad; this document is self-contained)

This is the design for the sanctioned "next product project" named in
`docs/handoff/START_HERE.md` §Known Limitations 1: reimagining the
Play/Leaderboard/Challenges/Stats tab shell as distinct, purpose-built
experiences. Server contracts are not changed by this document except where
§Data Requirements says so.

## Product lens (governs every decision)

**The player is on the app for a few minutes, once per day.** VWiki Race is a
Wordle-style daily ritual, not a browse-y game hub. Every screen optimizes a
~3-minute loop: open → race today's daily → see where you stand → share/leave
→ come back tomorrow.

North star qualities, in priority order: feels like a real game (purpose-built
modes), competition & return play (dailies, boards, streaks), mobile-first
(thumb-reach, full-height screens; desktop is a scale-up).

## Information architecture

Distinct modes replace the persistent 4-tab shell:

- **Home** (stateful daily hub) — bottom-nav item 1
- **Boards** (daily boards + rolling trends) — bottom-nav item 2
- **Challenges** (library: browse → detail → race; create) — bottom-nav item 3
- **You** (profile/stats; claim/log in) — bottom-nav item 4
- **Race flow** (preview → race → results) — NOT in the nav; a full-screen
  takeover with zero global chrome. Entered via any "Race" button, or
  automatically on app load if an active run needs recovery (see Race flow);
  exits only via finish, End Run, or backing out of the preview.

The old Play/Challenges duplication disappears: Home owns "play today,"
Challenges owns the library.

## Global invariants (apply to every screen, present and future)

1. **Time AND clicks, always.** Any row or summary that shows a run shows both
   (`0:38 · 5 clk`). Matches the ranking order (time → clicks → completion).
2. **A completion is permanent.** Player-facing state chips show best-ever
   outcome with precedence `✓ best (time·clicks)` > `DNF` > `NEW`. A later DNF
   never demotes a prior ✓. A player's **placement** for a given daily is
   their best (lowest) rank among that day's eligible runs — `GROUP BY
   account_id, MIN(rank)`, one row per account, not a raw leaderboard row per
   attempt. (The current `listLeaderboard` query ranks every eligible row per
   account with no dedup; "repeat attempts never hurt you" is false as
   written and is corrected by this rule.) This same best-rank-per-account
   definition governs Boards Today/Yesterday, the avg-placement/trend
   queries, and the participation guard's "played" denominator (≥1
   eligible/leaderboard-visible run — matching current public-leaderboard
   visibility).
3. **No run exists until Start.** Browsing, previews, and backing out are
   consequence-free. (Pairs with the shipped 2-click resumability floor.)
   Exception: active-run recovery on app load — see Race flow.
4. **Identity is asked only at Start or Create.** Never for browsing or
   previewing. Guest = real VGames ghost, claimable later. Exception:
   active-run recovery on app load — see Race flow.
5. **Paths stay hidden until you've played** that challenge (anti-spoiler).
   "Played" here means **finished**, not merely started/DNF'd — a retry
   after an abandon still shows the sanitized, link-free preview.
6. **Cross-challenge raw times are never compared.** Aggregate boards are
   built on dailies (shared ground) using placement, not time.
7. **Casual framing until integrity lands.** No prizes/"official" language
   while leaderboards remain forgeable (START_HERE Known Limitation 3).

## Screens

### Home (stateful)

Home reads today's daily state as one of three conditions: **not attempted**,
**attempted, not finished (DNF)**, and **finished**. The first two share the
Pre-play shell; the third is Post-play.

**Pre-play:** wordmark + avatar; DAILY hero card (flavor badge, pair title,
"time left today", primary **Race** button); slim stats row (🔥 streak ·
"30-day avg #2.4 (26 dailies)"); **yesterday's final board** as the recap card
(complete and interesting; the player has no stake in today's board yet, and
it discourages scouting); bottom nav.

**DNF sub-state (attempted, not finished today):** the DAILY hero replaces
the bare fresh Race CTA with an acknowledgment — "Last try: DNF · Try
again" — instead of presenting as if nothing happened. The first-visit rules
strip (below) must not silently re-trigger on this sub-state.

**Post-play:** DAILY card flips to done state ("✓ DONE · You finished #2 ·
0:42 · 6 clk"); **today's live board** with the player highlighted;
**Share result** button; "Got a few more minutes?" card (see Play-another);
streak/trend row (inherits the Boards §7d/30d participation guard: streak
only, avg-placement number muted/hidden until the account clears the ranking
threshold — otherwise a day-1 player sees a statistically meaningless
ranking on the app's highest-traffic screen); bottom nav.

**First-visit teaching gate (app-shell level, not Home-specific):** until an
account's first finished race, whichever screen it first lands on — Home or
Challenge Detail — shows the rules strip **"Two articles. Links only. Beat
the clock." (how to play)** — the parenthetical opens a quick-dismiss popup
with fuller rules that uses today's real pair as the example, defines
links-only, and states the time-then-clicks tie-break. Footer: "No account
needed to look around." This must fire on Challenge Detail too: Migration
notes route share links there, making Detail the actual most-likely entry
point during active friend rollout, not Home.

Cut from earlier drafts: the rivalry/rematch strip (redundant — the board
already shows who beat you; "rematch" muddies a one-a-day ritual). Rivalry
features are a later update.

**Play-another suggestion logic:** suggest the most-popular challenge this
account has never started (played OR attempted excludes it). If none remain:
"Create a random new one" via the existing random-article generation
machinery. Presented as an inviting card ("Got a few more minutes?"), one
suggestion + "Browse all ›" — never a menu.

### Race flow (full-screen takeover, no global chrome)

**On load, recovery takes priority over everything else.** The existing
`recoverActiveRun` check runs before any mode shell renders: if it returns
`recovered`, force-navigate straight into full-screen Race mode 2 (mid-run) —
no Home, no bottom nav, no Pre-race preview. If it returns
`recovery-required` (a legacy protocol-1 run, or a run whose challenge no
longer exists), force a lightweight interstitial that reuses the existing
End-Run/legacy-run resolution UI; control is not released to Home/bottom-nav
until it resolves. This is an explicit exception to "entered via any Race
button" (IA above) and to invariants 3 and 4: a recovering account already
has a run and an established identity before this screen renders.

**1 · Pre-race target preview.** "YOUR TARGET" + sanitized link-free lead +
source-revision/CC BY-SA attribution + start-article name. Primary **Start
race** (timer starts at Start, per existing timing rules). Escape hatches:
`← Back` (top-left) and **"Not feeling it? See other challenges ›"** (link to
the library). Backing out is free (invariant 3).

**2 · Race mode.** Zero tabs/nav — this deletes the "why are Leaderboard/
Stats visible-but-disabled mid-race?" problem at the root (supersedes the
"R1 pt2" backlog item). Slim HUD: live timer + click count (always visible),
compact "🎯 Target ▾" disclosure (the preloaded link-free target blurb,
one tap away at all times), prominent coral **End Run** (existing confirm →
abandons → returns Home). Below HUD: muted path breadcrumb (ellipsized).
Body: the existing sanitized article surface, unchanged mechanics.

**3 · Results.** "You reached it" + placement + time · clicks; collapsed path
recap ("see path ›"); today's board snippet with the player highlighted;
**Share result**; the Play-another card. For unclaimed guests, a claim CTA
sits **directly above Share result**: "Keep your spot — Make a name / Log in"
("You're on the board as Guest-XXXX. Claim it so it stays yours."). The
account's **first finish of any kind — not daily-specific** — adds the
ritual hook: "🔥 Day 1 · New daily drops 5:00 AM — come defend your spot."
(so a friend-link arrival who races a non-daily challenge first still gets
pointed at tomorrow's daily).

### Boards

Segmented control: **[Today] [Yesterday] [7d] [30d]** (lifetime placement
TBD — behind 30d or a fifth segment; decide at implementation).

**Today/Yesterday (daily views):** full board for that daily — rank, name,
time · clicks, **collapsed to one row per account** (a player's placement is
their best/lowest rank among that day's eligible runs, per invariant 2 — no
duplicate rows for repeat attempts); DNFs (≥1 click) listed below finishers
per existing rules; "paths hidden until you've played"; a Race CTA if the
viewer hasn't played today's.

**7d/30d/lifetime (trends):** ranked by **average placement across that
window's dailies** (same best-rank-per-account-per-daily definition as
above), displayed as "avg #2.4 (26 dailies)" with a subtle trend arrow.
**Participation guard: must have played ≥⅓ of the window's dailies to be
ranked** (7d → ≥3, 30d → ≥10; lifetime → ≥10 total) — "played" means ≥1
eligible/leaderboard-visible run (invariant 2). Unranked players appear in a
muted section with their count ("4 dailies — needs ≥10 to rank"). A
drill-down under a row shows that player's recent dailies as placement +
time · clicks (invariant 1 holds at drill-down level). Durable rolling
trends ship only alongside the Data requirements containment flag (manual
"exclude run" admin override) — a forged run must not become a permanent,
compounding penalty on everyone else's number instead of a one-board blip.

### Challenges (library)

**Browse:** search field (accepts pasted share links) — must not sit in a
dvh-sized container whose geometry shifts on keyboard dismiss; reuse the
svh/top-anchored pattern already proven and scoped on the identity dialog
rather than rediscovering the same tap-swallow bug on new UI. The daily
pinned at top but pointing to Home; challenge cards with pair title, meta
("N players · best 0:38 · 5 clk") and a state chip per invariant 2 (`NEW` /
`✓ 0:42·6clk` / `DNF`) — the per-card aggregate (player count, best
time·clicks) and the bulk per-account outcome powering the state chips
across the whole catalog are not derivable from `listChallenges`/
`getAccountStats` today; both require a new query/endpoint (see Data
requirements). "+ Create a challenge" card at the bottom (existing creation +
nomination flow unchanged).

**Detail:** back link; pair title; creator attribution; **Race this** button;
the challenge's own leaderboard (every challenge has one — rank/name/
time·clicks, DNFs, paths-hidden rule); "Your history" strip (or empty state);
"Copy link" share chip. First-visit teaching gate: if a brand-new account's
first-ever landing is here — e.g. via a share link — rather than Home,
Detail shows the same rules strip/popup described under Home (the gate is
app-shell level, not Home-specific).

### You (profile/stats)

Not deeply designed this round (existing Stats content ports over: totals,
top articles, bridge pages, streak, trend chip). For guests, this is where
the persistent claim/log-in affordance lives. Design pass later.

## Data requirements (server work implied by this design)

- **Daily "done today" state** per account (exists — today's daily + own run).
- **Streaks:** consecutive-days-played counter → needs a small table or a
  derivation over daily_features × runs. New, small. Streak-break rule:
  missing a day is a **silent reset, no grace period** — simplest version,
  shipped as a deliberate choice rather than an implementation-time
  accident.
- **Rolling avg placement (7d/30d/lifetime + guard):** derivable from
  daily_features × runs, using best (lowest) rank per account per daily —
  `GROUP BY account_id, MIN(rank)`, matching the corrected invariant 2, not
  raw leaderboard rows. New query/endpoint; no schema change strictly
  required, but a materialized daily_placements table may be worth it — this
  decision is on the critical path for Increment 4, not a low-priority
  deferral, since Home's post-play streak/avg chip depends on it too (see
  Open Questions #2).
- **Containment flag:** a manual "exclude this run from boards/placement"
  admin flag (reuse the `/admin/dailies` actor pattern), shipped alongside
  rolling trends — not deferred to the full integrity project — because
  rolling 7d/30d/lifetime placement turns one forged run into a durable,
  compounding penalty on every other player's number instead of a
  one-board blip.
- **Play-another suggestion:** popularity (run counts per challenge) ×
  "account never started" (runs table). Derivable now.
- **Random new challenge on demand:** exists (daily generator machinery);
  needs a user-triggered endpoint variant with its own rate-limit tier,
  distinct from `CHALLENGE_CREATE_RATE_LIMITER` — an explicit low limit
  (e.g. 2-3/hour per account), a conservative global/IP ceiling, and a
  per-account concurrency cap of 1 in-flight request — plus loading/timeout
  UX for the endpoint's up-to-~25s wall time (this is not the near-instant
  "inviting card" action the current framing implies).
- **Browse aggregate + bulk per-account outcome:** per-challenge aggregate
  card data (player count, best time·clicks) and bulk per-account
  outcome-per-challenge (for state chips across the whole catalog) are not
  derivable from `listChallenges`/`getAccountStats` today. New
  query/endpoint required; decide per-card vs. bulk-endpoint at plan time.
- **Yesterday's board:** exists (challenge board for yesterday's daily).
- Claim CTA: existing ghost-claim flow, surfaced on Results.

## Explicitly out of scope / deferred

- **Friends/social graph** — a VGames platform project (requests, privacy,
  cross-game). The design gets social value now from public boards; friend
  filters bolt on later without IA changes.
- **Rivalry features** (beat-your-time nudges, rematch) — later update.
- **Colors/visual style** — RESOLVED (Vijay, 2026-07-18): keep the viota /
  VGames family identity the app already ships — Luckiest Guy display,
  Fredoka body, dark near-black ground, teal + coral accents (coral reserved
  for primary/destructive race actions: Start, End Run). New modes apply this
  existing identity consistently; no new palette. Fine-grained per-screen
  styling decisions still land piece by piece during implementation.
- **Leaderboard integrity (forgeable runs)** — separate track; this design
  keeps casual framing until it lands (invariant 7).
- **Daily archive/calendar, reminders, notifications** — backlog unchanged.

## Migration/compat notes

- Challenge share links (`/?challenge=challenge-000N`) land definitively on
  Challenge Detail in the new IA (resolved — not "or its board").
- `/admin/dailies` (editorial moderation) is untouched; its pathname-gated
  route bypasses the new bottom-nav shell entirely rather than becoming a
  fifth nav item.
- The Worker API is largely sufficient for most screens, but not all: Browse
  needs a new aggregate/bulk-outcome endpoint (see Data requirements). This
  is primarily a client restructuring (App.tsx split into mode components)
  plus the new streaks/trends/suggestion/browse endpoints above.
- All existing history/leaderboards preserved (permanent no-reset decision).
- **Concrete client behaviors that must survive the App.tsx restructuring**
  (the "primarily a client restructuring" line above understates the risk):
  (i) the mobile back-gesture/history lock during an active run must
  re-anchor to Race mode rather than exit; (ii) `/admin/dailies`' bypass of
  the bottom-nav shell (above) must hold through the restructuring; (iii)
  the first-finish teaching gate must be derived from account stats (races
  completed > 0), not device-local storage; (iv) challenge share links'
  landing on Challenge Detail (above) must hold through the restructuring.

## Build increments (council-ratified)

Ship in this order; each is independently mergeable and safe to pause after.

0. **Server-side correctness + safety prerequisites (no UI change).** Ships
   the fixed placement dedup (best-rank-per-account-per-daily), the
   containment flag, the random-challenge rate-limit tier, and a Codex
   merge-window agreement before touching App.tsx. Why safe: pure
   server/infra hardening, zero player-visible change, closes both
   data-integrity gaps before trends can make them worse.
1. **Race-flow extraction (Preview → Race → Results), inside the existing
   tab shell.** Ships the full-screen zero-chrome takeover, the active-run
   recovery interstitial, preserved back-gesture lock, and DNF-aware End
   Run/Results copy. Why safe: isolates the highest-merge-conflict surface
   (App.tsx run/HUD JSX) and resolves both BLOCKING findings before the
   nav/IA underneath it changes.
2. **Bottom-nav mode shell + Home v1 + Challenges/Browse v1 + You.** Ships
   the 4-item nav, Home pre/post-play plus the DNF sub-state on data that
   exists today, the app-shell-level teaching gate, the first-finish ritual
   hook, the `/admin/dailies` bypass, and the invariant-4 reword. Why safe:
   the real IA shift, but needs zero new server endpoints — validates with
   real friend-rollout traffic before trends/streaks land.
3. **Boards, daily views only (Today/Yesterday).** Ships full-board
   Today/Yesterday on the corrected dedup query; no 7d/30d/lifetime yet.
   Why safe: a straightforward read over existing (now-corrected) data —
   validates the Boards shell independent of the one increment that
   actually needs new backend work.
4. **Streaks + rolling avg-placement backend, then Home v2 + Boards
   trends.** Ships the streaks table with the miss-a-day rule, the rolling
   avg-placement query/materialization (Open Question 2), the participation
   guard, Home's guarded streak/avg chip, and Boards 7d/30d/lifetime. Why
   safe: isolates the one increment genuinely gated on new server work —
   every other screen is already live and battle-tested first, and
   Increment 0's containment flag already bounds a forged run's blast
   radius.
5. **Challenges/Browse full card spec + Play-another polish.** Ships the
   aggregate + bulk-outcome endpoint powering Browse's full meta/chips, the
   dvh-safe search field, and a hardened (account_aliases-resolved,
   account-days-floored) Play-another suggestion. Why safe: purely additive
   on top of Increment 2's basic Browse — can slip a cycle without blocking
   the daily-ritual loop or any other screen.

## Implementation notes (council)

- Results: Share/claim CTA pinned vs. scroll-reachable is an implementation
  layout call, not a spec defect — flag it to whoever builds Results, since
  Share is the product's only virality lever.
- Browse cards at 320-375px: keep title + state chip always-visible; the
  meta line (N players · best time·clicks) may truncate/omit player count
  first under width pressure.
- Race HUD: keep End Run top-anchored (matches today) unless the builder has
  a specific reason to move it — make that call explicitly, not by default.
- Boards segmented control: reuse the existing tabbar's narrow-width
  font/padding pattern for [Today][Yesterday][7d][30d]; "Yesterday" (9
  chars) and a possible 5th "Lifetime" segment factor into Open Question 1.
- Play-another's "never started" query must resolve `canonical_account_id`
  via `account_aliases` (same as `getAccountStats`/`listLeaderboard`), or
  claimed-from-guest accounts get wrongly suggested challenges they already
  played.
- Popularity-ranked play-another has no covering index for a global
  ORDER BY across the full challenge table; fine at current scale (few
  hundred challenges), revisit with a cache/index at low thousands.
- Boards/Home "not enough data" muted state should read as progress toward a
  goal ("4/10 dailies"), not a bare rejection, on a primary nav destination.
- Claim CTA label "Make a name / Log in" is a pun that may not parse for
  first-time readers; consider splitting into clear primary/secondary
  buttons — a copy nit within the implementation-time styling carve-out.
- "NEW" chip will increasingly misread as "recently added to catalog" as
  challenges age; consider "Unplayed"/"Try it" if it causes confusion
  post-launch — not urgent enough to block build.
- Fold into Increment 0's containment work: the participation guard on
  Boards trends is a display-noise filter, not integrity protection; and
  Play-another's popularity ranking and Browse's "N players" meta are
  exactly as forgeable as leaderboard rank — floor them by distinct
  account-days, or gate behind a similar participation guard.
- Pre-existing infra gap, not caused by this redesign: guest-identity
  creation and run-start have no rate limiting, unlike clicks/challenge-
  create/admin actions. Worth cheap hardening alongside Increment 0's
  containment-flag work, but it's orthogonal infra debt, not a spec blocker.
- Rolling-avg-placement materialization (Open Question 2) should be decided
  during Increment 0/4 planning, not treated as low-priority — Home's v2
  chip depends on it, not just Boards trends, so it's on the critical path
  earlier than the spec's original phrasing implied.
- Coordinate the App.tsx split with Codex's concurrent work in the main
  checkout via the repo's standing convention (clean tree, pushed merge
  window, ff-only merge) before starting Increment 1 — the single highest
  merge-conflict-risk piece of the whole project, independent of design
  correctness.

## Open questions (fine to resolve at plan time)

1. Lifetime board placement (fifth segment vs. behind 30d).
2. Whether trends deserve a materialized table vs. on-the-fly SQL — **on the
   critical path for Increment 4** (Home's streak/avg chip depends on this
   too, not just Boards trends); decide during Increment 0/4 planning, not
   as a low-priority deferral.
3. "Time left today" countdown display on the daily hero (exact copy).
4. Whether Boards defaults to Today or Yesterday pre-play (Home already
   shows yesterday pre-play; leaning Today here to avoid duplication).

Resolved during council review (2026-07-18): streak-break behavior (missing
a day) — silent reset, no grace period, simplest version. See Data
requirements · Streaks.

## Ratified invariant addendum (2026-07-21, owner)

**DNF finality:** an abandoned run (End Run or expiry) is terminal — it can never be resumed or continued. "Try again" always starts a fresh run with a fresh clock. Rationale: a continuable DNF is a pause button that freezes the competitive clock. The only continuation that exists is resuming a still-ACTIVE run after leaving the page (same attempt, clock still counting). Owner re-confirmed 2026-07-21: "i like that rule."
