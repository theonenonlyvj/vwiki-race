# VWiki Race: 2026-07-26 Agent Handoff — Narrative + Reference

This is the deep-dive companion to `docs/handoff/START_HERE.md`. START_HERE is
the cold-start orientation doc — read it first. This document is where the
*why*, the incidents, the exact procedures, and the open decisions live. It
covers everything that happened between the UX redesign shipping
(`0a684aa`, 2026-07-18) and this commit. Read it before touching ship
procedure, the invariants below, or the open decisions — several of them
encode a bug that cost real time to find, twice.

Vijay's own framing, verbatim, from when he handed this project over: **"Claude
is in charge of this game."** He reviews screenshots personally, texts real
friends for feedback, and expects the agent to run the full council →
implement → adversarial-review → ship loop without hand-holding. He decides
fast when given ladders/options with a recommendation; he does not want to be
asked to re-derive something already decided in this document or its cited
sources.

## 0. How to use this document

- Section 1 is the narrative arc, in order, condensed from ~150 commits and
  the session chronicle. Read it once to understand how the current code got
  this way.
- Sections 2-6 are load-bearing reference: ship procedure, invariants, trap
  classes, operations. Re-read the relevant section before touching that
  surface, every time — several of these have been broken twice by different
  sessions making the same plausible-looking mistake.
- Sections 7-10 are the state of things the owner hasn't ruled on yet — the
  actual to-do list once you're oriented.

## 1. The narrative arc since the redesign shipped

### Two UX councils, one day (2026-07-19)

Vijay: *"launch a full council review with every expert lens… take feedback
and run with it and fix it"*, then, after seeing it, *"when done, review again
with more diverse lenses."*

**Round 1** — 12 lenses (ux-flow, visual-hierarchy, art-direction,
design-system, gameplay, data-viz, mobile-ergonomics, desktop-adaptation,
accessibility, copy-voice, spec-fidelity, first-time-user,
competitive-benchmark) reviewed 39 live prod screenshots plus the ratified
mockups and code. 121 raw findings merged into 13 judged fix packages (PKG-13
added same-night from the daily-pipeline incident below), each verified by 2
independent judges. Records and briefs with judge amendments and binding
owner-proxy rulings: `docs/superpowers/council/2026-07-19-ux-council/`.

The council's own systemic diagnosis (worth re-reading in full at that
README) was that v0 drifted for five structural reasons: no shared
component/class for repeated ideas (three leaderboard renderers, five race-verb
labels), deliberate incremental scoping shipping as visible contradiction (two
nav tabs naming two different "today's daily"s), mockups treated as
inspiration rather than contract (whole elements silently missing), the
stylesheet growing by copy-paste (~35 raw-hex palette bypasses), and "desktop
is a scale-up" being an assumption with nothing to scale from (every mockup
was a phone frame). All ~20 commits from PKG-01 through PKG-15 plus the
REMAINDERS sweep and Wave 1/2 reviews are `1db2286`..`56be8e7`. PKG-14/15 came
from Vijay's own live feedback after the rest shipped: Boards renamed to
**Stats**, the Lifetime board became "Everyone who's played" with
reality-scaled guards (`ceil(dailies/3)` capped at 3/10/10), and the Fredoka
root-font bug (root was falling through to Inter/system) was fixed.

Same night: the **daily pipeline incident** (see Trap Class 1) was found and
fixed as PKG-13, and separately the `ebbc76a` / `bcc503f` pair fixed the
`workerd` "Illegal invocation" root cause across every fetch boundary,
detailed in Trap Class 1 below.

**Round 2** — 15 mostly-new lenses (motion, typography, color theory,
performance, retention, social dynamics, IA, edge-case QA, content curation,
non-gamer usability, power user, cold critic, spec-fidelity anchor, brand,
onboarding) reviewed fresh prod screenshots after Round 1 shipped. 102
findings → 10 quickfix packages, **all built and shipped the same day**
(`afbaa18`..`0cefc7f`, `8d6128c` review fixes), plus a 12-item owner-decision
backlog and 8 deliberate drops. Full verdict, backlog, and drops:
`docs/superpowers/council/2026-07-19-ux-council-round2/README.md`. The
synthesizer's verdict, verbatim: **"solid B for craft, still C+ as a
habit."** Notable ships: returning ghosts default to the Guest identity tab
(QF-01), real HTTP caching via `_headers` (QF-02), DNF rendered as salmon
instead of go-teal (QF-04), a native share sheet on mobile (QF-10), a motion
floor on dialogs/results/hovers (QF-08), and a single You-tab empty state
(QF-09).

Vijay then answered the 12-item decision backlog same night — the full ledger
is `docs/superpowers/council/2026-07-19-ux-council-round2/DECISIONS.md`, and
the load-bearing rulings are summarized in §8 below where they're still
actionable. The immediately-shipped ones (`fcc9dc7`..`9f2f721`, tagged
FB-1 through FB-6): the coral **VGames** kicker restored above the wordmark
(his ask — family brand, not the mode's own name), guest-first identity for
everyone, recognizable daily pool restricted to Wikipedia Vital Levels 1-2,
emoji click-trail share text, a private-browsing/blocked-storage notice, and
path comparison on finished placements.

### FB-7: sub-2-click DNFs are not attempts (2026-07-19)

Vijay, reviewing DNF rows on a board: *"hide DNF runs [that] don't involve >1
click from the start. those dont really even count, no?"* This became a
standing rule, not a one-off fix: a DNF only counts as a real attempt —
board-visible, and counted toward played/streak/participation-guard/roster —
at `MIN_COUNTED_DNF_CLICKS` (= 2) clicks or more. Below that, it's treated as
an accidental open. See Invariant 6 below for the full mechanics and why this
constant is *not* interchangeable with the similarly-valued
`MIN_RESUMABLE_CLICKS` — conflating the two killed run recovery for a week in
the runtime cycle (§1, RC cycle below, and Trap Class 4).

Landed as `2629a8e` (feature) → `9b8692b`/`45e01af` (review clarifications:
FB-7 does not touch `RaceResults`' own-DNF gate) → `1679c08` (docs record).

### FB-8/9/10 (2026-07-20)

Three more owner-decision items shipped same day: body text de-bolded
everywhere (≤500/400 weight; chrome keeps its weight) — FB-8, `4e14e19`;
Browse's played-state chips fixed (was rendering a premature "NEW" while
outcomes were still loading) plus reverse-chronological catalog ordering —
FB-9, `bcd028b`; and Stats' 7d/30d/Lifetime windows changed to aggregate
**all** challenges, not just dailies (windowed by challenge creation date,
active-only denominators, still gated by the FB-7 threshold; the daily streak
itself stays daily-only) — FB-10, `2cc50f9`. Review pass `82287f2` caught a
second D1 100-bind-param `IN`-list bomb during this work — see Trap Class 2.
Record: `7a51e5d`.

### Graph modal, Honest You, preview fix, redirect surfacing (2026-07-20/21)

The path graph (`083f0c1` single-chain path rendering → `f84784f` server
`/challenges/{id}/paths` endpoint, finisher-gated, best-run-per-account →
`0e03cef` the "View graph" modal itself) started life as a prototype on the
`visualize-graph` branch (still present, `0cd6d41`, worktree retired), was
council-iterated to a v2 merged-braid SVG with per-player focus and
draw-on-entrance animation, then ported to `main`.

"Honest You" (`1e519af`) shipped 3 explicit session states on the You tab, a
Log Out action, and ghost-orphan guards on every path that could silently lose
a guest's local identity (logout, logging in over an active ghost, "play as
someone else"). The spec for this was hardened by 3 judges before build, and
review (`eb85bec`) caught a waiver-scoping gap that would have lost data on
one of the guard paths.

Same wave: the pre-race preview's blurb picker was rewritten to prefer the
first real prose paragraph over sidebar/hatnote fragments (`af1a21a`) — the
bug that made "Life" show the sidebar caption "Life on Earth:" instead of an
actual sentence about the article — and desktop preview composition was
tuned at 680px. Separately, `9246da8` added the **"(redirected from X)"**
line under the article heading: a friend reported a "wrong link," which
turned out to be Wikipedia's own silent redirects — 54% of organic clicks on
this game resolve through a redirect, and the client was swapping titles
without telling the player why the page they landed on didn't match what
they clicked.

Review pass `eb85bec` on this wave also caught and closed an unauthenticated
legacy-route bypass on the path-comparison feature.

### URL policy + Back ladder + graph render fix (2026-07-21)

A 5-lens routing council (0 open questions left at the end) ratified:

- **`?challenge=` is Detail's address, iff.** The param sits in the address
  bar if and only if the player is on that challenge's own Detail screen (or
  a locked/recovering race). Entry-intent (a share link) is honored forever;
  self-sync (the app rewriting the URL to match whatever challenge happens to
  be selected) is killed outright — it was teleporting a background catalog
  refresh into Detail out from under whatever the player was actually doing.
  Nav taps clear the param; a stale/expired link degrades gracefully to Home;
  a plain Home refresh is stable; the mode tabs themselves (Boards/Challenges/
  You) stay URL-less by design (the council explicitly rejected a `?mode=`
  route-param design).
- **An in-app Back ladder** via a history-state `vwrDepth` counter, not a
  route param. See Invariant 5 below — review caught a real poisoning bug in
  this same cycle, so read that section before touching `urlRouting.ts`.
- **The graph modal fix**: `.leaderboard-panel`'s `clip-path` was creating a
  CSS stacking context that trapped the fixed backdrop's z-index, making the
  graph modal invisible in production (but not in local dev, where that panel
  wasn't mounted the same way). Fixed by portaling the modal to `document.body`
  (`ModalDialog`'s opt-in `portal` prop, referenced in code as "GX-1"). See
  Trap Class 3. Canvas height was also made lane-count-driven instead of
  fixed.

Commits: `ac64d49` (URL iff-invariant) → `c538955` (Back ladder) → `9c272de`
(graph modal chrome/canvas fix) → `83db0a5` (Back ladder depth-counter fix,
review-driven) → `5fdc5b1` (record).

**Operational note baked into this cycle**: prod smoke checks can hit a stale
Cloudflare colo for several minutes after a deploy, serving old HTML. Always
assert the *executed* bundle hash in the live page (view source / Network tab
/ curl for the `index-*.js` filename) before diagnosing a "bug" that might
just be an unpropagated edge cache.

### DT-1, NV-1, DNF-finality ratification (2026-07-21/22)

`1363cb2` (DT-1): Challenge Detail leaderboard polish — proper table rows,
"View path" affordance, headings promoted from `--text-bright` to the new
`--text-dim` token (they were reading too close to "winner white"), empty-DNF
sections hidden. `7ac0be1`/`289e86d` (NV-1): nav shows "Log In" when signed
out, You tab surfaces a discoverable login affordance, and Fredoka's usable
weight ceiling was capped at 600 app-wide (the unused 700 weight file was
dropped entirely — `font-synthesis: none` means anything the CSS asked for at
700+ had been silently faked by the browser's weight-fallback search landing
on 700 anyway; this made ~40 magic numbers pixel-identical by construction and
removed the ambiguity). `2d0fa3e` ratified **DNF finality** as a binding spec
invariant — see Invariant 7.

### Login-hang P0, round 2 (2026-07-21/22)

Vijay reported occasional multi-second-to-30-second login hangs. A live
13-login evidence table (Cloudflare Workers Logs, queried directly since the
CLI can't) showed the auth chain itself was healthy — PBKDF2 hashing at
27-34ms CPU — so the stall was transient network/connectivity, not a logic
bug. Fix: a 4-second leash on the first login attempt, then an automatic
idempotent retry with "Still connecting…" copy, cutting the worst case from
~30s to ~5s. Commits `6d54452` → `2fa95cb` (retry ladder + proxy-side retry).
This is the ladder later formalized as `IDENTITY_ATTEMPT_TIMEOUTS_MS = [4000,
8000, 15000]` in `src/services/vgamesIdentity.ts` and hardened further in the
MB-1/LR-2 pass below. The actual root cause of the *bursty* stalls wasn't
found until the same-origin-API cycle two days later (§ below) — this pass
made the symptom tolerable, not fixed.

### RC-1: target chip + sticky HUD (2026-07-22)

`0d7512f` added a target chip with a preview popover directly in the sticky
race HUD. Keeping the HUD sticky while adding this chrome required moving the
clip-path-driven visual chrome from the HUD's own wrapper to a `::before`
pseudo-element (`.race-hud::before`) — `clip-path` on a sticky element's own
wrapper breaks `position: sticky` outright. See Trap Class 3. Scroll-margins
were live-measured and left unchanged in this pass (they moved twice more
later — see Invariant 8).

### MB-1 + LR-2 (2026-07-22)

Real device reports from lollerskates (old iPhone / small screen) drove this
pass. `0a42dc0`: wide Wikipedia tables got their own per-table `.table-scroll`
wrapper at sanitize time — the real bug was the *whole article pane* sharing
one scroll region, not page zoom as first hypothesized; the repro overturned
the original theory. `3e561a9`: the article fetch had **no timeout** at all,
so a slow/failed Wikipedia fetch produced an infinite "stuck loading" wedge —
fixed with a 5-second leash and retry; also found and fixed genuine
old-Safari breaks (`Array.at()` throws on Safari ≤15.3, and the iOS
tap-swallow fix had gone silently absent on old iOS because it was hidden
behind a `:has()` selector old Safari doesn't support — the load-bearing half
was moved to `align-self`, proven with a regression screenshot on the actual
old-Safari rig). Login also got the full `[4s, 8s, 15s]` idempotency-keyed
ladder plus a proxy-side single retry scoped to connectivity-class failures
only (`secureGuest` was verified non-idempotent and deliberately left
unladdered), with exhaustion beacons via `/api/client-error` and structured
`vgames_identity_call` proxy logs so a future stall self-names in the logs.
A 30-minute soak afterward measured 90/90 logins at ≤672ms — the stall is
bursty/rare, not constant.

### HD-1: one-row sticky HUD (2026-07-22)

`689d3e1` collapsed the race HUD to one row (RUN metrics left, TARGET chip
right) and moved End Run into the path-strip row. This caught RC-1's preview
popover hiding behind the path strip via a grid z-index issue (fixed), and
required re-measuring the scroll-margin floors **downward** again — see
Invariant 8's full history; this is the fix that actually matters if you
touch that CSS.

### The same-origin-API breakthrough (2026-07-23)

The bursty login/API stalls were finally root-caused by **Vijay's own
screenshot**: a catalog fetch was failing from his network while
`pages.dev` loaded fine and the API was fast from elsewhere, and D1 latency
averaged 1.2ms server-side — meaning the problem was `workers.dev`
DNS/routing flakiness specific to some client ISPs, not the app, not the
Worker, not the database. Fix (`16768bd`): production clients now call
`/api/*` on their **own origin** (`vwikirace.pages.dev/api/*`), which
`functions/api/[[path]].ts` forwards to the Worker over the `VWIKI_API`
Cloudflare service binding declared in the root `wrangler.toml` — a
Cloudflare-internal hop with no public `workers.dev` DNS lookup on the client
path at all. This also incidentally kills CORS preflights. `workers.dev`
stays live as a fallback/rollback path — see §2 (ship procedure) for the
exact env-var mechanics, since getting this backwards silently un-ships the
fix.

### The runtime cycle, RC-01..10 (2026-07-23/24)

Vijay: *"fix all the clunky runtime shit."* A tracer walked 9 real user
journeys across 2 viewports; 8 runtime-focused lenses reviewed the results;
10 packages (RC-01 through RC-10) were built and shipped the same cycle,
`081d29e`..`9d7fde1`.

**The flagship finding: run recovery had been silently dead since 2026-07-17.**
A Codex "harden" commit (`8a4835f0`, part of the same commit family
implicated in the daily-pipeline outage — see Trap Class 4) had added
`click_count >= 2` as a filter inside `findActiveRun`, so `GET
/api/v2/runs/active` returned `null` for any live run under 2 clicks. Every
mid-race page reload during that window silently ate the run with no error,
no recovery prompt — just a fresh Home as if nothing had happened. `7b364f5`
(RC-02) removed the click-count predicate from the *read* path — the fix was
root-cause, not symptomatic, per Vijay's own ruling: "no silent run loss."
A journey-8 re-trace afterward proved silent resume actually works again.
This is now Invariant 3 below, and its own trap class (Trap Class 4) because
the underlying commit family caused two separate incidents.

The other nine packages, briefly: `081d29e` (RC-01) — the catalog gate always
offers a Retry, no dead ends; `5d0dc12` (RC-05, first pass) — Today's board
shows all finishers plus an always-present "see full board" link; `13fa331`
(RC-07) — one shared screen-selector function replaces ad-hoc conditionals
that were producing transient impossible screen states; `96f1f6e` (RC-03) —
one shared read-cache group in the API client (cut tab-cycle request churn
from 28→12, duplicate requests from 11→0 in one measured journey; **trends
were deliberately left uncached** — a finisher must see their own just-played
run immediately, and this is still true today, see §10); `f4269ef` (RC-04) —
stale-while-revalidate semantics so a background cache refresh never blanks
already-rendered live UI; `296eee2` (RC-06) — one tri-state
loading/error/ready system used everywhere data gates content; `d7c2b97`
(RC-08) — "click-promise" fixes, buttons now navigate to where their label
says; `a2b4af5` (RC-09) — shared entrance transitions, shimmer skeletons, a
measured (not clipped) identity dialog; `c8ce4f8`/`c8efa6e` (RC-10) — mobile
runtime hardening protecting the critical path. `52ef02d` and `9d7fde1` are
wave-review fixup passes (the latter also made End-Run copy honest against
FB-7 and added an `requestIdleCallback` timeout). Full ship record with
re-trace proof: `ac4c9c9`.

Tests at the close of this cycle: 1110 client + 226 worker (both have grown
since — see §2 for current counts). One known flake noted here and not yet
chased down: `App.test` occasionally fails a 401-stats assertion under
parallel execution (~1-in-4); root-caused and fixed later in the session
persistence pass below, in fact — the flake was `NV-1`'s You→"Log In" nav
swap racing the test's own click, not a real app bug.

Note left in the repo from this cycle: **`git stash@{0}`** holds an earlier,
unverified client-side RC-02 defense attempt, superseded by the root-cause
server fix that actually shipped. See §10 — do not pop it blindly.

### BD-1: windowed boards (2026-07-25)

`bd3d517` — compact board snippets now show the top 2 rows plus the viewer's
own ±2 neighborhood, with inline "… N more" expanders; boards with ≤7 total
rows just show everything; anonymous viewers get a flat top-6 cap. Pure
function (`windowBoardRows`), merge-on-touch rendering.

### Ranking council + floor batch (2026-07-25)

A council simulated 6 candidate ranking metrics against real production data.
Vijay's own instinct — rank by raw average time/clicks — was **disproven by
the data**: it would crown `chase3` (zero wins) #1, because raw times have no
difficulty normalization across challenges of wildly different hardness. The
council landed on three real options, detailed in §8 (this is now the top
open owner decision). What *did* ship, because it's metric-independent:
`471dc32` — the ranked-inclusion floor was set to a flat 2 completions (guard
copy echoes "2"), a "Finish 1 more race to rank" runway row for players just
under it, average time+clicks display columns added to ranked rows (sort
itself untouched pending the metric decision), and — separately — the
**auto zz-sweep** was wired into the existing hourly `17 * * * *` cron
(`try`/`finally`-isolated so its own failure can never mask a daily-job
outcome). See §7 for the zz* convention this maintains.

### Session persistence (2026-07-25)

`c36803f` — an audit of session persistence found sessions were already
transient-failure-proof (all 9 storage-clearing call sites were correctly
gated on a *true* 401, not any network hiccup). The actual felt-loss reports
traced to two real bugs: a true-401 wipe also blanked the player's
last-typed display-name draft (compounded by a one-time event on 2026-07-15
where a JWT-secret rotation invalidated every outstanding token at once), and
password-manager autofill attributes had never actually been verified in a
real browser. Fixed: the last display name now survives wipes/logout;
autocomplete/name attributes were verified end-to-end in real Chromium
(22/22 — native form submission with a filled password produces the shape
Chrome's save-password prompt expects); password drafts now clear on dialog
close, not on submit. This pass also root-caused and fixed the RC-cycle's
known 401-stats test flake (an NV-1 nav-label race, not an app bug).

### HRD-1: daily difficulty floors (2026-07-26)

A `hard`-flavored daily (mosques → "Southern TV interruption," 23 inbound
links) drew **zero finishers**. The evaluator now enforces per-flavor target
inbound-link floors, calibrated against all 12 dailies run to date:
**recognizable 150, weird 30, hard 150** — `hard` needed the *highest* floor
of the three, because "hard" is supposed to mean "connected but obscure," not
"needle in a haystack"; `weird` thrives even down at 24 inbound links because
being weird is the point. The `linkshere` Wikipedia API check is budgeted at
`lhlimit = floor + 1` and degrades-passes (doesn't block generation) if that
check itself fails. Four sub-floor entries already in the target pools were
purged. A zero-finisher board now reads "No one has cracked this one yet."
instead of an empty table, and a same-day escape hatch ("Try an easier one ›"
via the existing suggestion engine, `590c0d6`) lets a player bail to something
more tractable without waiting for tomorrow.

Same day, a separate **opus-run metric validation** tested 8 candidate
difficulty proxies against actual finish-rate across all 12 dailies. Raw
inbound-link count won outright (Spearman 0.55); the "hub distance" hypothesis
some earlier reasoning assumed was **falsified** on its own best
counter-example (Voynich Manuscript is better-connected than Crooked House by
every measure tried, yet performed worse) — the zero-finisher days turn out
to be small-sample noise plus at least one real outage day, not a clean
signal. Applied from this: a recognizable-only *pageviews* floor of ≥1000/mo
(`736eab5`, `RECOGNIZABLE_PAGEVIEWS_FLOOR` in
`src/server/dailyCandidateEvaluator.ts`) — this is a different axis from the
inbound-link floor above; it kills "technically Vital-Level-2 but nobody has
heard of them" misclassifications (the canonical bad case being an obscure
minor royal or peer) at zero extra request cost, since pageviews were already
fetched. The floor comments in that file were also rewritten to be honest
about what they are: **needle-hunt tail removal, not a solvability
prediction** — do not retune them without materially more data, and exclude
known outage days when you do.

## 2. Ship procedure (exact — read before shipping anything)

This is the sequence Vijay means by "ship it." Two mistakes have burned real
time here and are called out explicitly below; both are still easy to make
by copying an old shell history line.

1. Finish, review, and locally verify the change.
2. Run the full local gate **checking actual exit codes, not eyeballing
   piped output**:
   ```bash
   npm test              # vitest run — client, currently 1163 passing
   npm run test:worker   # vitest --config vitest.worker.config.ts — 236 passing
   npm run build          # tsc --noEmit && vite build && verify:bundle
   npm audit --omit=dev
   npx wrangler deploy --dry-run --config wrangler.api.toml
   ```
   **Piping any of these to `grep`/`tail`/`head` has silently eaten a real
   failure twice.** Run them plain and check `$?`, or let the harness's own
   pass/fail summary line be the source of truth — do not truncate the
   output before you've seen the final status line.
3. Commit locally.
4. If the change touches D1 schema: inspect the remote migration ledger and
   take a private backup before applying anything new. There have been no new
   migrations since `0006_board_exclusions.sql` (Increment 0) — everything
   since (streaks, trends, windowed boards, zz-sweep, floors) is
   read-side/derived or cron logic with no schema change. Never replay an
   applied migration.
5. **If both server and client changed, deploy the Worker before Pages.**
   Reversing this order means Pages briefly calls a Worker that doesn't yet
   have the contract the new client expects.
   ```bash
   npx wrangler deploy --config wrangler.api.toml
   ```
   Smoke-test the Worker directly before touching Pages.
6. Push `main`.
7. Build and manually deploy Pages. **Pages is NOT git-connected** — pushing
   `main` alone does not deploy anything to `vwikirace.pages.dev`.
   ```bash
   npm run build
   npx wrangler pages deploy dist --project-name vwikirace --branch main \
     --commit-hash "$(git rev-parse HEAD)"
   ```
   Use the **real** `--commit-hash` from `git rev-parse HEAD` — a missing or
   stale hash here is how a later session ends up unable to tell which
   commit is actually live from `wrangler pages deployment list` alone.
8. **Build with `VITE_VWIKI_RACE_API_URL` UNSET.** This is the default and
   the correct state for every normal ship: the client resolves its API
   origin at runtime (own `*.pages.dev` origin first, `verify:bundle` checks
   both runtime branches are present in the shipped bundle). Setting this
   variable pins every client to the public `workers.dev` Worker origin,
   bypassing the same-origin `/api/*` routing entirely — **this is the
   rollback lever for the whole same-origin fix, not a build option to reach
   for casually.** Only set it deliberately, as a rollback, if same-origin
   routing itself is suspected broken.
9. **Assert the executed bundle in the live page before diagnosing anything
   as a production bug.** Cloudflare's edge can serve a stale colo's cached
   HTML/JS for several minutes after a deploy. Check the `index-*.js`
   filename actually being served (page source, Network tab, or
   `curl -s https://vwikirace.pages.dev/ | grep -o 'index-[A-Za-z0-9]*\.js'`)
   against what you just built. A "bug" that disappears a few minutes later
   with no further changes is almost always this, not a real regression —
   this has cost real debugging time at least twice.
10. Smoke-test canonical production and confirm D1 counts/invariants look
    sane.

Do not run manual cron fan-out as a test against production. Do not
print/commit D1 exports, credentials, tokens, Wrangler logs, or Time Travel
bookmarks.

As of this handoff: `main` is at `736eab5` (pushed), the live Worker version
is `4e4a3cac` (deployed 2026-07-26T16:26 UTC per `wrangler deployments list
--config wrangler.api.toml`), and the live Pages bundle is
`index-DTsZ8f1q.js` (verified live via direct curl of
`vwikirace.pages.dev/`) — this predates `736eab5` because that commit was a
server-only diff (the pageviews-floor fix has no client-visible surface), so
no Pages redeploy was required for it to be live.

## 3. Hard-won invariants (each has tests; do not regress these)

1. **Initial-route latch.** `App.tsx`'s `initialUrlRouteApplied` ref (set
   around the catalog-effect's URL-routing block, ~line 933) latches true on
   the very first successful catalog pass, whether or not that pass honored
   a requested `?challenge=` id. Without this, a later
   `visibilitychange`-triggered catalog refetch could re-read the URL and
   force-navigate the player into Challenges → Detail out from under
   whatever they were actually doing — including mid-race, under the
   full-screen race takeover.
2. **Locked-race pin.** While a race is active or recovering,
   `nav.pinLockedChallenge(id)` (see `App.tsx` ~1018-1064, `challengeIsLocked`)
   pins the selected challenge and the URL to that challenge regardless of
   what the catalog or URL routing would otherwise compute — a race in
   progress must never be silently swapped out from under the player by an
   unrelated state update.
3. **Recovery gate.** `useRaceController.recoverActiveRun` runs to completion
   *before any mode shell becomes interactive* on app load. `"recovered"`
   force-navigates straight into the mid-run HUD with no Home/nav flash;
   `"recovery-required"` (a legacy protocol-1 run, or a run whose challenge no
   longer exists) blocks behind an interstitial until resolved. This is an
   explicit, documented exception to "no run exists until Start" and
   "identity only at Start/Create" — a recovering account already has both.
   This gate was silently broken 2026-07-17 to 2026-07-24 by the bug
   described in Trap Class 4 — re-read that section before touching
   `findActiveRun` or anything near `MIN_RESUMABLE_CLICKS`.
4. **URL iff-invariant.** `?challenge=` in the address bar if and only if the
   player is on that challenge's Detail (or a locked/recovering race).
   Entry-intent (a share link) is honored forever; the app never
   self-syncs the URL to match whatever's merely selected; nav taps clear the
   param; expired/invalid ids degrade gracefully to Home. Lives in
   `src/services/urlRouting.ts` (`syncChallengeUrl`, `clearChallengeUrl`).
5. **Back-ladder DEPTH counter.** `urlRouting.ts`'s `vwrDepth` history-state
   value (0 = Home floor, 1 = one rung from Home, 2 = Detail depth) — **not**
   a boolean. An earlier boolean version (`vwrInApp`) was adversarially
   found to conflate "already away from Home" states that needed different
   push/replace handling, silently poisoning the Back stack (repro: Home →
   Challenges → open Detail → "← Challenges" → tap Stats → Back wrongly
   reopened the already-closed Detail). If you ever feel tempted to simplify
   this back to a boolean, read `urlRouting.ts`'s own comment block first —
   it documents the exact failure.
6. **FB-7 counted-attempt rule.** `MIN_COUNTED_DNF_CLICKS = 2`
   (`src/server/runProtocol.ts`) gates whether a DNF counts as a real
   attempt for board visibility, played/streak/participation-guard purposes,
   and roster census. **`MIN_RESUMABLE_CLICKS` is a separate constant** (also
   currently 2, but conceptually distinct and allowed to diverge) that gates
   whether `startRunV2` auto-abandons a stale "ghost" run on a fresh Start.
   These two constants happening to share a value is coincidence, not
   identity — conflating them by using one where the other belongs is
   exactly what killed run recovery for a week (Trap Class 4). Completed runs
   always count regardless of click count; only DNFs are gated by
   `MIN_COUNTED_DNF_CLICKS`, and only on the read/aggregation side.
7. **DNF finality** (ratified 2026-07-21, spec addendum in
   `docs/superpowers/specs/2026-07-18-ux-redesign-modes-design.md`). An
   abandoned run — End Run or expiry — is terminal. It can never be resumed
   or continued; "Try again" always starts a fresh run with a fresh clock.
   The only continuation that exists at all is resuming a still-*active* run
   after leaving the page (same attempt, same clock, still counting) — that's
   Invariant 3's recovery gate, a different mechanism entirely. Owner's own
   words, re-confirmed the same day: *"i like that rule."*
8. **Scroll-margin floors.** `src/race/raceHudScrollMargin.test.ts` is a
   regression guard, not a real-layout test (jsdom cannot see visibility or
   stacking) — it asserts the `.article-heading h2` `scroll-margin-top`
   values used to clear the sticky race HUD + path-strip on article-scroll
   don't silently shrink back toward an undersized value. These numbers have
   been re-measured live-DOM (Playwright, real viewport, `.race-takeover` as
   the actual scroll container — not `window`/`body`) **twice** as the HUD's
   own height changed (PKG-02 added an always-visible metrics row; HD-1 later
   shrank the HUD to one row) — they must move *with* the HUD any time its
   height changes again, or the sticky HUD visually swallows the live
   timer/click row (this exact bug shipped once and was only caught by a
   live prod screenshot, not any test suite).
9. **Coral is reserved.** `--coral: #ff765f` in `src/styles.css` means
   clock-commit/destructive race actions (Start, End Run) and the brand
   kicker only — never a generic accent, never a card wash, never a
   secondary CTA. This was a real, repeated bug class in Round 1 (coral-washed
   Browse cards, an unstyled default-teal race CTA on one screen) — the
   `--coral` token's own comment in `styles.css` states this rule explicitly;
   read it before adding any new coral usage.
10. **Fredoka capped at 600.** Only weights 300-600 are imported
    (`main.tsx`); the 700 weight file was dropped entirely (`289e86d`) after
    confirming every apparent 700+ usage in the stylesheet was actually being
    faked by the browser's font-weight fallback search landing on 700 anyway
    (`font-synthesis: none` is set at `:root`). Do not reintroduce a 700
    weight without re-auditing every literal that currently reads "700" —
    some of those are load-bearing on the fallback behavior, not a real
    asset.
11. **Paths hidden until the viewer has finished.** A challenge's path stays
    sanitized/link-free in every context — preview, retry-after-abandon —
    until the viewing account has *finished* that specific challenge (not
    merely started or DNF'd). This is spec invariant 5 in the redesign doc
    and holds across Detail, the graph modal (finisher-gated server endpoint),
    and Boards (which never discloses a path at all, by design — Detail-only).

## 4. Recurring trap classes (read before you hit one for the third time)

**1. `workerd` "Illegal invocation" on bare global `fetch`.** Passing the
bare global `fetch` function into an options object and later calling it as
`options.fetchImpl(...)` throws `TypeError` in `workerd` (Cloudflare's
runtime), even though the exact same code works fine in Node/browser
contexts. This killed **every** Worker→Wikipedia fetch — both scheduled daily
drops and on-demand `POST /challenges/random` — for the entire window a
Codex "harden evaluation" commit was live, and was only found by building a
scratch worker that empirically proved direct/detached calls return 200 while
the method-style call throws. Fixed by detaching and wrapping `fetch` at
every boundary; `src/server/fetchBinding.test.ts` is a source-shape guard
against reintroducing it. **Rule: never pass the bare global `fetch` into an
options object and call it as a method later** — always detach
(`const fetchFn = fetch; fetchFn(...)` or an explicit wrapper) at the call
site.

**2. D1 100-bind-param `IN`-list bombs.** SQLite/D1 has a bind-parameter
ceiling; building a query with one bound parameter per row of a
potentially-unbounded `IN (...)` list (e.g., a list of account or challenge
ids) will silently break once that list crosses the limit. This has bitten
the codebase **twice** on different queries — once in the original streak
derivation (fixed with a join-based rewrite, `efbe85d`), once again in the
FB-8/9/10 review pass on a different query (`82287f2`). Any new aggregate
query built by mapping a result set into an `IN (?, ?, ?, ...)` list is a
candidate for this — prefer a join or a subquery over building a
per-row-bound `IN` list.

**3. `clip-path`/`transform` on an ancestor breaks `position: fixed`/`sticky`
descendants.** A `clip-path` (or `transform`) on any ancestor element creates
a new CSS stacking/containing context, which silently breaks
`position: fixed` children (they become fixed *to that ancestor*, not the
viewport) and can break `position: sticky` outright. This has bitten twice:
the graph modal was invisible in production because `.leaderboard-panel`'s
`clip-path` trapped the fixed backdrop's z-index (fixed by portaling the
modal to `document.body` — `ModalDialog`'s opt-in `portal` prop); and the
sticky race HUD's own `clip-path`-driven visual chrome had to be moved off
the HUD's own wrapper and onto a `.race-hud::before` pseudo-element, because
putting it directly on the sticky element killed the sticking behavior
entirely. **Rule: portal modals to `document.body` rather than relying on
z-index inside a styled ancestor; move decorative `clip-path` chrome onto a
pseudo-element rather than the sticky/fixed element itself.**

**4. The 2026-07-17 "harden" commit family caused two separate incidents.**
Commit `8a4835f0` and its siblings from the same Codex hardening pass added
defensive-looking guards that were each individually plausible but broke
real behavior: one added a parser regression that broke the entire daily
pipeline (Trap Class origin of PKG-13, fixed same window); another added
`click_count >= 2` into `findActiveRun`'s read path, which silently killed
run recovery for every sub-2-click active run from 2026-07-17 until it was
found and fixed 2026-07-24 (RC-02, Invariant 3/6). **If you hit an unexplained
regression whose timing traces anywhere near mid-July, audit the sibling
commits in that same hardening pass before assuming the bug is new** — this
family has a track record of looking safe and not being safe.

**5. jsdom cannot see visibility, stacking, or real layout.** Multiple real
bugs (the sticky-HUD-swallows-the-timer-row bug behind Invariant 8, the
graph-modal-invisible-in-prod bug behind Trap Class 3) passed the entire unit
test suite and were only caught by live production screenshots or a real
browser rig (Playwright against a real viewport). **When a bug is plausibly
about what's actually visible/stacked/overlapping on screen, do not trust
jsdom test-suite green as evidence it's fixed** — screenshot the real app (see
the `run` skill) and eyeball it, the way Vijay does personally before calling
anything shipped.

**6. Session scratchpads get purged; the repo does not.** Working notes,
scratch measurements, and intermediate evidence tables have been lost between
sessions before. Anything that matters for the next agent — a measured
constant, a root-cause finding, a decision rationale — belongs in a commit
message, a code comment, or a dated doc under `docs/`, not left in a
scratchpad or session-only note.

## 5. Operations

### Manual daily-drop procedure

Only needed if the automatic scheduler (see §7 of `START_HERE.md`) has
failed to produce a Daily and needs a manual push. As one atomic
`--command`: `INSERT` a `challenges` row (copy the shape of the most recent
real challenge), `INSERT` a `daily_features` row with
`selection_source='automatic'`, `queue_entry_id=NULL`,
`classifier_version='manual-drop-<date>'`, and `UPDATE` the corresponding job
to `accepted`.

**You MUST also bump `challenge_number_sequence` in the same transaction.**
Forgetting this once made `createChallengeV2` silently return the just-created
manual daily to the next two players who tried to create their own new
challenge — their creates were swallowed until the sequence caught back up.
This is a one-line easy-to-forget step with a genuinely bad failure mode;
treat it as non-optional.

Flavor-by-weekday: `dailyFlavorForCentralDate` — Monday-Wednesday
`recognizable`, Thursday-Friday `weird`, Saturday-Sunday `hard`.

**Swapping out an already-featured daily** (not "the scheduler never
produced one" above, but "it produced one and it's bad" — e.g. the
2026-07-29 incident: the auto-daily picked "Technology", already the
07-20 daily's target) is a different operation, and it bit us today:
`challenges.daily_date` carries a UNIQUE index
(`challenges_daily_date_unique_idx`, migration 0004 — partial, enforced
only where `daily_date IS NOT NULL`), so you cannot point a replacement
challenge at today's date while the bad one still holds it. **`UPDATE`
the old challenge's `daily_date` to `NULL` FIRST — a separate statement
before (never in the same statement as, and ideally earlier in the same
transaction than) the `INSERT`/`UPDATE` that gives the replacement that
`daily_date`.** Doing it the other way around throws a UNIQUE constraint
violation. The old challenge can stay in the catalog (set `is_active = 0`
if it shouldn't remain playable, e.g. it was never actually the intended
daily) — only its `daily_date` needs to go.

The `daily_features` row for that date needs the same care:
`daily_date` is its primary key (one row per date) and `challenge_id` is
separately `UNIQUE`, so a swap `UPDATE`s the existing row's `challenge_id`
(and `selected_score`/`classifier_version` as appropriate) to point at the
replacement rather than trying to `INSERT` a second row for the same
date. **Re-confirm the sequence-bump step above still applies**: if the
replacement is a brand-new challenge row (not a challenge already sitting
in the catalog), bump `challenge_number_sequence` in the same transaction
— this is the same easy-to-forget, genuinely-bad-failure-mode step as the
from-scratch procedure, not a new one.

### `zz*` test-account convention

Any account whose current `account_profiles.public_name` starts with `zz` is
treated as a test/throwaway account: its runs get `board_excluded=1` via an
idempotent sweep (`sweepZzExcludedTestAccountRuns`,
`src/server/d1TrackingRepository.ts` ~2745-2755), now run automatically on
every hourly `17 * * * *` cron tick inside a `try`/`finally` so a sweep
failure can never mask a real daily-job outcome (`src/server/worker.ts`
~247-260). **Any guest account created by a test or e2e rig must use a `zz`
prefix**, or it will show up as a real player on public boards until the next
sweep. `vitest.config.ts` also excludes `**/.worktrees/**` from the test scan
(a real triple-scanning bug from when the redesign worktree was still
present).

### Daily difficulty floors

`src/server/dailyCandidateEvaluator.ts`: `INBOUND_LINK_FLOOR` = `{
recognizable: 150, weird: 30, hard: 150 }` (calibrated against all 12 dailies
run to date — `hard` needs the *highest* floor because "hard" means
connected-but-obscure, not a needle hunt); `RECOGNIZABLE_PAGEVIEWS_FLOOR =
1000` (monthly pageviews, recognizable-only, kills "technically Vital but
nobody's heard of them" misclassifications). Both floors are explicitly
**needle-hunt tail removal, not a solvability prediction** — this reframing
happened deliberately (2026-07-26) after an opus-run 8-metric validation
against real finish-rate data found raw inbound-link count the best available
proxy (Spearman 0.55) and falsified an earlier "hub distance" hypothesis on
its own counter-example. **Do not retune these floors without materially more
per-daily data than exists today, and exclude known outage days from any
retuning analysis** — the current calibration is thin (12 data points) and
was already shown to disagree with instinct once.

### The login/stall saga, summarized

What looked like one bug was several: (1) a real transient network stall,
mitigated by the `[4s, 8s, 15s]` retry ladder (`IDENTITY_ATTEMPT_TIMEOUTS_MS`
in `src/services/vgamesIdentity.ts`) plus a proxy-side single retry scoped to
connectivity-class failures; (2) the actual root cause of the *bursty* worst
cases, which was `workers.dev` DNS/routing flakiness from some client
networks — fixed by shipping same-origin `/api/*` routing (§1, §2); (3) a
felt-loss illusion from session wipes also clearing display-name drafts,
fixed in the session-persistence pass. Telemetry now self-names any future
occurrence: exhaustion beacons via `POST /api/client-error` and structured
`vgames_identity_call` proxy-side logs mean a new stall doesn't need a fresh
manual evidence table — query the existing logs first.

## 6. Community snapshot

Roughly a dozen real players as of this handoff: `theonenonlyvj` (owner),
`lollerskates`, `rnaik24`, `Reks`, `FranTheGreat`, `chase3`, `mattman`,
`Sylvia`, `RG`, `vinay`, `enthree`, `Goat`, `L`, `Mesh`, `Nisha`, `Rhubarb2`,
`RK`, `SunnyD`, `jvtyson` — growing weekly. Vijay texts friends directly for
feedback; their reports (lollerskates' old-iPhone bugs, a friend's "wrong
link" redirect report, Vijay's own catalog screenshot that cracked the
stall mystery) have driven multiple real fix cycles. Treat a friend bug
report as high-signal, not anecdotal — it has been the proximate cause of
several of the fixes in §1.

## 7. Open owner decisions (ask, don't guess)

### Trends ranking sort metric

The current 7d/30d/Lifetime ranking (average placement) is provisional. A
council simulated 6 candidate metrics against real production data; Vijay's
own raw-time/click-average instinct was disproven by the data (it would rank
`chase3`, zero wins, #1 — no difficulty normalization across challenges).
Three real options remain, ladder-style:

- **Option 1 — keep average placement** (current behavior; simplest, already
  shipped).
- **Option 2 — beat-rate: percentile-of-field with a worst-drop penalty**
  (RECOMMENDED by the council; the actual ranking math has been computed
  against real data, not just proposed).
- **Option 3 — golf-style field-handicap.** Rejected direction: it misranks
  players at the game's *current* field sizes (too few players per daily for
  a handicap-style normalization to be stable).

**Ask Vijay to pick 1 or 2** before touching the ranking query further; 3 is
presented for completeness, not as a live option.

### Scoring adjustment (Y)

Proposal: display an adjusted time, `Score = t + Y·clicks`, instead of raw
time, so a fast-but-many-clicks run and a slow-but-efficient run compare more
fairly. Currently `Y = 0` (raw time, unadjusted) in production — this is not
yet built into any live ranking. Vijay's instinct was `Y = 20`; a simulation
against real board data found this changes **0 of 10 existing boards' actual
ordering** — the first ordering flip doesn't happen until `Y = 28.2` (one
board) or `Y = 47.4` (a second board, also involving the same two
cricket-topic players). **Ask Vijay whether to ship `Y = 20` anyway (matches
instinct, currently inert), pick a higher value that actually changes
something, or leave scoring alone** — this decision is unusually low-stakes
to get "wrong" since the data shows it barely matters at the values discussed.

### DNF path-unlock ("Wordle model")

Proposed, not yet answered: unlock path disclosure for a challenge instantly
for anyone who has *finished* it (current behavior — unchanged), **plus** for
everyone once that challenge's calendar day has ended, finished or not — the
way Wordle reveals the answer at midnight regardless of whether you solved
it. This would be a real, deliberate loosening of Invariant 11 (paths hidden
until the viewer finishes) for daily challenges specifically. **Ask Vijay**
before building this — it changes a ratified spec invariant, not just an
implementation detail.

### Login-feel verdict, post-same-origin

The same-origin API routing (§1, §2) shipped 2026-07-23 specifically to kill
the bursty `workers.dev` stalls Vijay had been hitting. Nobody has explicitly
asked him whether it actually feels fixed from his own daily use since then.
**Ask him directly** — if the answer is "still occasionally stalls," the
`vgames_identity_call` proxy logs and `/api/client-error` beacons (§5) are
now in place specifically so the next investigation doesn't need a fresh
manual evidence table.

## 8. Queue (owner-approved order)

In order, per Vijay's explicit approval:

1. **Lean Wikipedia edge-proxy.** He is on record as wary of infra sprawl:
   scope this as **one** Worker route plus an edge cache keyed on
   `(title, revisionId)`, with `sanitizeWikipediaArticleHtml` moved
   server-side so every player after the first hit benefits from both the
   cache and the avoided client-side parse cost. Do not let this grow into a
   general-purpose proxy service.
2. **Leaderboard-integrity project.** Explicitly named the #1 competitive
   blocker (owner decision #7 in the round-2 ledger). The scoring-Y decision
   above should ride along with this project rather than shipping
   standalone, since both touch ranking trust. The `board_excluded`
   containment flag (migration `0006`, already shipped) exists specifically
   to bound the blast radius of a forged run while this project is pending —
   it is not itself the integrity fix.
3. **Desktop two-column Home.** Owner-approved *in principle*
   ("yes, but quality bar high") — but he was explicit that a **mockup and
   his sign-off must land before any building starts**, not after. Do not
   build this speculatively.

**Deferred by owner** (do not build without a fresh ask): rivalry features
(blocked on "who gets highlighted" — no clean answer yet in a small,
uneven-skill friend group); keyboard-only racing assistance (the
Ctrl/Cmd+F-is-blocked accessibility gap — fairness implications need a
decision on how much assistance is fair before scoping); roster
privacy/visibility controls; the Reks/`sgattu` account-merge request
("later").

**Queued small**: GV-2 — graph-modal label lanes for long disjoint paths.
The current merged-braid SVG layout is genuinely good when paths converge,
but degrades on long fully-disjoint paths where a label can currently land
between lanes instead of next to its own lane. Small, isolated fix; not
urgent.

## 9. Loose ends

- **`git stash@{0}`**: "RC-02 prior uncommitted client-side attempt
  (superseded by owner-proxy ruling: root-cause-first server fix)." This
  predates the shipped server-side recovery fix (Invariant 3, Trap Class 4)
  and was never verified against the fix that actually landed. **Decide
  explicitly whether to build on it or drop it — do not `git stash pop` it
  blindly**, since it may conflict with or duplicate behavior the shipped fix
  already covers.
- **`AdminDailies.tsx`'s third `errorMessage()` call site** has copy that was
  flagged as inconsistent with its siblings and never fixed (see the 6
  `errorMessage(caught, "...")` call sites around lines 49-145 of
  `src/components/AdminDailies.tsx`). Low priority — it's the protected admin
  moderation surface, not player-facing — but worth a quick pass next time
  that file is open.
- **Trends are deliberately uncached** (RC-03's read-cache group explicitly
  excludes them). This is intentional, not a gap: a player who just finished
  a race must see their own run reflected immediately, and caching trends
  would risk showing a stale board right after the moment a player most wants
  to see themselves on it. Do not "fix" this by adding a cache without
  re-deciding the tradeoff first.

## 10. The working pattern that delivered this

Vijay has explicitly endorsed this workflow — reuse it for the next cycle
rather than improvising a new one:

1. **Council workflow**: multiple sonnet-run expert lenses review real
   evidence (prod screenshots, code, ratified mockups) in parallel, judged by
   2+ independent judges, synthesized by a strong model into a small number
   of fix packages.
2. **Briefs with binding rulings**: each package gets a brief incorporating
   judge amendments, with owner-proxy (or, when available, real owner)
   rulings that are treated as binding — not re-litigated by the implementer.
3. **Sequential sonnet implementers**, one package at a time, in waves.
4. **Adversarial wave reviews** by a strong model after each wave — this has
   caught a genuine regression or data-loss bug in every single wave it's
   been run, not occasionally.
5. **Exit-code-checked gates** — never piped/truncated (see §2's explicit
   warning; this has burned real time twice from the opposite habit).
6. **The orchestrating agent ships and personally eyeballs key screenshots**
   before calling anything done — several real bugs (the sticky-HUD ghost,
   the invisible graph modal) were invisible to every automated test and only
   caught this way.
7. **Re-trace to prove**, not just to believe — after RC-02's recovery fix,
   the fix was proven by walking the exact failing journey again and
   confirming the new behavior, not just by the unit tests going green.

Vijay's own working style, for calibration: terse and direct; wants
structured choices with a recommendation, not open-ended questions; prefers
data over theory (simulate against real production data before proposing a
change, as the ranking and scoring-Y work did); dislikes both clunky
under-building and speculative over-building equally; decides fast once given
ladders/options — the open decisions in §7 are phrased as ladders
specifically because that's what gets a fast answer.
