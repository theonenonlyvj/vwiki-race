# UX Redesign: Modes, Not Tabs — Design

Date: 2026-07-18 · Status: DRAFT, awaiting Vijay's review
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
  takeover with zero global chrome. Entered via any "Race" button; exits only
  via finish, End Run, or backing out of the preview.

The old Play/Challenges duplication disappears: Home owns "play today,"
Challenges owns the library.

## Global invariants (apply to every screen, present and future)

1. **Time AND clicks, always.** Any row or summary that shows a run shows both
   (`0:38 · 5 clk`). Matches the ranking order (time → clicks → completion).
2. **A completion is permanent.** Player-facing state chips show best-ever
   outcome with precedence `✓ best (time·clicks)` > `DNF` > `NEW`. A later DNF
   never demotes a prior ✓. (Server already ranks by best completed run;
   repeat attempts never hurt you.)
3. **No run exists until Start.** Browsing, previews, and backing out are
   consequence-free. (Pairs with the shipped 2-click resumability floor.)
4. **Identity is asked only at Start.** Never for browsing or previewing.
   Guest = real VGames ghost, claimable later.
5. **Paths stay hidden until you've played** that challenge (anti-spoiler).
6. **Cross-challenge raw times are never compared.** Aggregate boards are
   built on dailies (shared ground) using placement, not time.
7. **Casual framing until integrity lands.** No prizes/"official" language
   while leaderboards remain forgeable (START_HERE Known Limitation 3).

## Screens

### Home (stateful)

Two states, switching on "has this account finished today's daily?":

**Pre-play:** wordmark + avatar; DAILY hero card (flavor badge, pair title,
"time left today", primary **Race** button); slim stats row (🔥 streak ·
"30-day avg #2.4 (26 dailies)"); **yesterday's final board** as the recap card
(complete and interesting; the player has no stake in today's board yet, and
it discourages scouting); bottom nav.

**Post-play:** DAILY card flips to done state ("✓ DONE · You finished #2 ·
0:42 · 6 clk"); **today's live board** with the player highlighted;
**Share result** button; "Got a few more minutes?" card (see Play-another);
streak/trend row; bottom nav.

First-visit additions (until first finished race): rules strip
**"Two articles. Links only. Beat the clock." (how to play)** — the
parenthetical opens a quick-dismiss popup with fuller rules that uses today's
real pair as the example, defines links-only, and states the time-then-clicks
tie-break. Footer: "No account needed to look around."

Cut from earlier drafts: the rivalry/rematch strip (redundant — the board
already shows who beat you; "rematch" muddies a one-a-day ritual). Rivalry
features are a later update.

**Play-another suggestion logic:** suggest the most-popular challenge this
account has never started (played OR attempted excludes it). If none remain:
"Create a random new one" via the existing random-article generation
machinery. Presented as an inviting card ("Got a few more minutes?"), one
suggestion + "Browse all ›" — never a menu.

### Race flow (full-screen takeover, no global chrome)

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
("You're on the board as Guest-XXXX. Claim it so it stays yours."). First
finish adds the ritual hook: "🔥 Day 1 · New daily drops 5:00 AM — come
defend your spot."

### Boards

Segmented control: **[Today] [Yesterday] [7d] [30d]** (lifetime placement
TBD — behind 30d or a fifth segment; decide at implementation).

**Today/Yesterday (daily views):** full board for that daily — rank, name,
time · clicks; DNFs (≥1 click) listed below finishers per existing rules;
"paths hidden until you've played"; a Race CTA if the viewer hasn't played
today's.

**7d/30d (trends):** ranked by **average placement across that window's
dailies**, displayed as "avg #2.4 (26 dailies)" with a subtle trend arrow.
**Participation guard: must have played ≥⅓ of the window's dailies to be
ranked** (7d → ≥3, 30d → ≥10; lifetime → ≥10 total). Unranked players appear
in a muted section with their count ("4 dailies — needs ≥10 to rank"). A
drill-down under a row shows that player's recent dailies as placement +
time · clicks (invariant 1 holds at drill-down level).

### Challenges (library)

**Browse:** search field (accepts pasted share links); the daily pinned at
top but pointing to Home; challenge cards with pair title, meta ("N players ·
best 0:38 · 5 clk"), and a state chip per invariant 2 (`NEW` / `✓ 0:42·6clk`
/ `DNF`); "+ Create a challenge" card at the bottom (existing creation +
nomination flow unchanged).

**Detail:** back link; pair title; creator attribution; **Race this** button;
the challenge's own leaderboard (every challenge has one — rank/name/
time·clicks, DNFs, paths-hidden rule); "Your history" strip (or empty state);
"Copy link" share chip.

### You (profile/stats)

Not deeply designed this round (existing Stats content ports over: totals,
top articles, bridge pages, streak, trend chip). For guests, this is where
the persistent claim/log-in affordance lives. Design pass later.

## Data requirements (server work implied by this design)

- **Daily "done today" state** per account (exists — today's daily + own run).
- **Streaks:** consecutive-days-played counter → needs a small table or a
  derivation over daily_features × runs. New, small.
- **Rolling avg placement (7d/30d/lifetime + guard):** derivable from
  daily_features × runs (placement per daily per account). New query/endpoint;
  no schema change strictly required, but a materialized daily_placements
  table may be worth it. Decide at plan time.
- **Play-another suggestion:** popularity (run counts per challenge) ×
  "account never started" (runs table). Derivable now.
- **Random new challenge on demand:** exists (daily generator machinery);
  needs a user-triggered, rate-limited endpoint variant.
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

- Challenge share links (`/?challenge=challenge-000N`) must keep working:
  they land on Challenge detail (or its board) in the new IA.
- `/admin/dailies` (editorial moderation) is untouched.
- The Worker API is largely sufficient; this is primarily a client
  restructuring (App.tsx split into mode components) plus the new
  streaks/trends/suggestion endpoints above.
- All existing history/leaderboards preserved (permanent no-reset decision).

## Open questions (fine to resolve at plan time)

1. Lifetime board placement (fifth segment vs. behind 30d).
2. Whether trends deserve a materialized table vs. on-the-fly SQL.
3. "Time left today" countdown display on the daily hero (exact copy).
4. Whether Boards defaults to Today or Yesterday pre-play (Home already
   shows yesterday pre-play; leaning Today here to avoid duplication).
