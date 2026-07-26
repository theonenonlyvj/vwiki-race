# VWiki Race: Start Here

Last updated: 2026-07-26

This is the canonical cold-start orientation for VWiki Race. Read this file
before changing the product. It describes the current whole system as of
`736eab5` and points to authoritative detail rather than re-narrating it.

**Read `docs/handoff/2026-07-26-agent-handoff.md` next, in full, before
shipping anything.** That document is the narrative arc of everything that
happened after this file's previous version went stale (the UX redesign
shipping 2026-07-18 through the daily-difficulty-floor work on 2026-07-26),
plus the load-bearing reference material this file only summarizes: the
exact ship procedure with its two easy-to-repeat mistakes, eleven hard-won
invariants each backed by a test, six recurring trap classes that have each
already cost real debugging time (some twice), the open owner decisions
awaiting an answer, and the owner-approved work queue. This file is
orientation; that one is operating knowledge.

Vijay's own framing: **"Claude is in charge of this game."** He reviews
screenshots personally, texts real friends for feedback, and expects the
council → implement → adversarial-review → ship loop to run without
hand-holding.

## Current Status

- Production: <https://vwikirace.pages.dev>
- GitHub: <https://github.com/theonenonlyvj/vwiki-race>
- Canonical API (fallback/rollback path): <https://vwikirace-api.theonenonlyvj.workers.dev>
- VGames identity (separate repo, read-only from here): <https://vgames-identity.theonenonlyvj.workers.dev>, source at `/Users/vijayram/Cursor/vgames-platform/services/identity`
- Protected Daily moderation route: <https://vwikirace.pages.dev/admin/dailies>
- `main` is clean and matches `origin/main` at `736eab5`.
- Live Worker version: `4e4a3cac` (`wrangler deployments list --config
  wrangler.api.toml`, deployed 2026-07-26T16:26 UTC).
- Live Pages bundle: `index-DTsZ8f1q.js` (confirmed live via direct fetch of
  `vwikirace.pages.dev/` at doc time; predates `736eab5` because that commit
  was a server-only diff with no client-visible surface, so no Pages
  redeploy was required for it to be live). **Always reconfirm both of these
  yourself** (`wrangler deployments list`, and curl/view-source the live
  page for its `index-*.js` filename) rather than trusting this document's
  numbers as still current — they drift with every ship.
- Tests, verified at doc time: **1163 client tests / 236 Worker tests, all
  passing** (`npm test`, `npm run test:worker`), `tsc --noEmit` clean, `npm
  audit --omit=dev` reports 0 vulnerabilities.
- D1 migrations `0001` through `0006` are applied; there have been no new
  migrations since `0006_board_exclusions.sql` (Increment 0 of the redesign).
  Everything since — streaks, rolling trends, windowed boards, the zz-sweep,
  daily-difficulty floors — is read-side/derived logic or cron behavior with
  no schema change. Never replay an applied migration.
- `MAINTENANCE_MODE=false` (normal production mode).
- **The UX redesign (modes, not tabs) shipped 2026-07-18 and has since been
  through two full UX council review cycles (2026-07-19), a routing/Back-ladder
  redesign, a full runtime-reliability cycle, a same-origin API migration that
  fixed a real production stall bug, and a daily-difficulty-floor
  recalibration.** None of that is "next up" — it's already live. The actual
  next-up work is the Queue in `2026-07-26-agent-handoff.md` §8.

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
realtime room layer. Roughly a dozen real people play regularly (see the
community snapshot in the companion doc, §6); Vijay treats their direct
feedback as high-signal and has shipped multiple fix cycles from a single
friend's bug report.

## Decisions That Are Settled

- The product name is **VWiki Race**; repository/deployment key is
  `vwiki-race` / `vwikirace`.
- VGames is the only account namespace. Do not add local usernames or a local
  player table.
- A VGames username is the canonical public display name and is unique.
- A guest is a VGames ghost. Its device credential persists locally and its
  server-side stats can follow a later claim or account merge. **Guest-first
  identity is the default for everyone** (owner ruling, 2026-07-19, "b is
  fine, easy") — not just returning ghosts.
- Identity is requested before Start or Create, not merely to browse the
  site. Signed-in players are not prompted again. The one exception is
  active-run recovery on app load, which resolves before any identity prompt
  or mode shell renders — see "Recovery gate" in the companion doc's
  invariants (§3.3).
- `Create New` is the default identity tab, with one username/display-name
  field and password confirmation. `Guest` is first; `Log In / Existing` is
  the other VGames account path.
- Every accepted run is server-tracked from game 0. localStorage is not the
  source of truth for scores, paths, challenges, or stats.
- Challenge links are stable: `/?challenge=challenge-000N`. The URL policy is
  now a ratified, tested invariant, not just a landing behavior — see
  "URL iff-invariant" in the companion doc (§3.4): `?challenge=` sits in the
  address bar **if and only if** the player is on that challenge's own
  Detail screen (or a locked/recovering race), forever, with no self-sync.
- Challenge identity is ordered
  `(start_page_id, target_page_id, ruleset)`. Recreating an existing pair
  returns that challenge and consumes no number. The reverse direction is a
  different challenge.
- Manual and automatic challenges use one transactional sequence. A Daily gets
  whatever the next global challenge number is; the date never determines the
  number. **Manually creating a Daily row must also bump
  `challenge_number_sequence` in the same transaction** — forgetting this has
  actually happened and silently ate two players' own challenge creates. See
  the companion doc §5's manual daily-drop procedure.
- A challenge can be featured as a Daily only once ever. Daily dates and Daily
  challenge IDs are unique.
- Users may nominate a challenge only as part of challenge creation. If the
  entered pair already exists and is eligible, nomination may still attach to
  that existing challenge. Repeated nominations are idempotent.
- A claimed VGames account is required to nominate. Guests may still create
  normal challenges.
- The admin can approve, decline, remove, override flavor, or directly queue a
  never-featured human challenge, at the protected `/admin/dailies` surface
  (now lazy-loaded, code-split behind its own route gate — QF-02). It bypasses
  the bottom-nav shell entirely rather than becoming a nav item.
- Daily generation is asynchronous and leaderboard-based. It does not matter
  when different people press Start.
- **A DNF is terminal (DNF finality, ratified 2026-07-21).** An abandoned run
  — End Run or expiry — can never be resumed or continued. "Try again" always
  starts a fresh run with a fresh clock. The only continuation that exists at
  all is resuming a still-*active* run after leaving the page, which is the
  recovery gate above, not a DNF continuation. Owner, verbatim: *"i like that
  rule."*
- **A DNF under `MIN_COUNTED_DNF_CLICKS` (= 2) clicks is a non-attempt**
  everywhere except a player's own Results page, their own "Your history"
  list, and roster attempt-census (FB-7, owner ruling: *"those dont really
  even count, no?"*). This is a **different constant** from
  `MIN_RESUMABLE_CLICKS`, which gates something else entirely (auto-abandoning
  a stale run on a fresh Start) — see the companion doc's Invariant 6 and Trap
  Class 4 before touching either constant; conflating them is what killed run
  recovery for a week.
- **Coral (`--coral: #ff765f`) is reserved** for clock-commit/destructive race
  actions (Start, End Run) and the brand kicker only — never a generic accent
  or card wash.
- **Fredoka is capped at weight 600** app-wide; the 700 weight file was
  dropped.
- The recognizable daily pool is restricted to Wikipedia Vital Levels 1-2,
  with an additional pageviews floor (≥1000/mo) to filter out
  technically-Vital-but-actually-obscure targets; `hard` keeps full pool
  breadth. See the companion doc §5 for the full floor calibration
  (`INBOUND_LINK_FLOOR`, `RECOGNIZABLE_PAGEVIEWS_FLOOR` in
  `src/server/dailyCandidateEvaluator.ts`) and its explicit framing as
  needle-hunt removal, not a solvability prediction.

### Redesign global invariants (binding, apply to every screen present and future)

Council-ratified in `docs/superpowers/specs/2026-07-18-ux-redesign-modes-design.md`,
plus the 2026-07-21 DNF-finality addendum in that same file:

- **Time and clicks, always.** Any row or summary showing a run shows both
  (`0:38 · 5 clk`, `formatTimeAndClicks` is the one source of this string),
  matching the ranking order (time → clicks → completion).
- **A completion is permanent.** Player-facing state chips show best-ever
  outcome with precedence `✓ best (time·clicks)` > `DNF` > `NEW`. A later
  DNF never demotes a prior finish.
- **Placement is best-rank-per-account.** A player's placement for a given
  daily/board is their best (lowest) rank among that day's eligible runs —
  `GROUP BY account_id, MIN(rank)` — not a raw leaderboard row per attempt.
  This governs Boards/Stats (Today/Yesterday/trends) and the participation
  guard's "played" denominator (now a flat 2-completion inclusion floor for
  ranking — see Current User Experience below). It does **not** retroactively
  change Challenge Detail's own per-challenge leaderboard, which still lists
  every eligible attempt (each after the first labeled `Repeat run`).
- **No run exists until Start.** Browsing, previews, and backing out are
  consequence-free. Exception: active-run recovery on app load.
- **Identity is asked only at Start or Create**, never for browsing or
  previewing (same exception as above).
- **Paths stay hidden until you've played** a challenge, meaning finished —
  not merely started or DNF'd. A retry after an abandon still shows the
  sanitized, link-free preview. (An owner-proposed loosening of this rule for
  dailies specifically — the "Wordle model" — is an open decision; see the
  companion doc §7. Do not build it without asking first.)
- **Casual framing until integrity lands.** No prizes/"official" language
  while leaderboards remain forgeable — the leaderboard-integrity project is
  next in the owner-approved queue (companion doc §8) precisely to unblock
  this.
- **DNF finality** (added 2026-07-21): a DNF is terminal; see Decisions
  Settled above.

The companion doc's §3 ("Hard-won invariants") documents eleven invariants at
the engineering level — initial-route latch, locked-race pin, the recovery
gate's exact state machine, the Back-ladder depth counter, scroll-margin
floors, and more — each with its test file and the incident that made it
load-bearing. Read that section before touching routing, recovery, or race
HUD layout code.

## Current User Experience

Bottom-nav modes, current user-visible labels: **Home, Stats, Challenges,
You** (You reads "Log In" when signed out — NV-1). The internal mode key for
the Stats tab is still `"boards"` in code (`src/modes/AppShell.tsx`,
`ModeKey`) — Vijay asked to rename only the user-visible label ("Boards -
rename to stats"), so file/route/component names are unchanged. Do not be
confused by the mismatch between the code's `boards` and the UI's "Stats" —
it's deliberate, documented in `AppShell.tsx`'s own comment.

- **Home** — the stateful daily hub. Reads today's daily as **not attempted**
  (hero card, Race CTA, streak/avg-placement row, yesterday's board as a
  recap), **attempted, not finished** (hero acknowledges "Last try: DNF · Try
  again" rather than pretending nothing happened), or **finished** (hero
  flips to done state, today's live board with the player highlighted, Share
  result, a Play-another suggestion, guarded streak/trend row). Board
  snippets here (and on Results) are now **windowed**, not full lists: top 2
  rows plus the viewer's own ±2 neighborhood, with inline "… N more"
  expanders; boards with ≤7 total rows just show everything (BD-1,
  2026-07-25, `windowBoardRows`).
- **Race flow** — a full-screen, zero-chrome takeover, not a nav item.
  **Recovery takes priority over everything else** on app load: a
  `"recovered"` outcome force-navigates straight into the mid-run HUD;
  `"recovery-required"` forces a blocking interstitial. Beats: **1. Pre-race
  preview** ("YOUR TARGET," sanitized link-free lead, escape hatches) → **2.
  Race mode** — now a **one-row sticky HUD** (RUN metrics left, a TARGET chip
  with a preview popover right; End Run lives in the path-strip row below,
  not the HUD itself — HD-1, 2026-07-22), muted path breadcrumb, and a
  **"(redirected from X)"** disclosure line under the article heading
  whenever Wikipedia's own redirect resolved the clicked title to something
  different (2026-07-21; roughly 54% of organic clicks resolve through a
  redirect) → **3. Results** (placement, time·clicks, collapsed path recap,
  windowed board snippet, Share result, a claim CTA for unclaimed guests, the
  Play-another card, a first-finish ritual hook). Ending a run is always
  terminal (DNF finality, above); the End-Run confirmation copy honestly
  states whether ending now will count as a real attempt, per the FB-7
  2-click threshold.
- **Stats** (labeled "Stats," internally the `boards` mode) — segmented
  `[Today] [Yesterday] [7d] [30d] [Lifetime]`. Today/Yesterday show the full
  windowed board per invariant 2 plus a muted DNF section; a zero-finisher
  board reads **"No one has cracked this one yet."** with a same-day **"Try
  an easier one ›"** escape hatch into the suggestion engine (2026-07-26).
  7d/30d/Lifetime currently rank by average placement across that window's
  dailies (the ranking **metric itself is an open owner decision** — see
  below); the ranked-inclusion floor is now a flat **2 completions**, with a
  "Finish 1 more race to rank" runway row for players just under it, plus
  average time/click display columns on ranked rows (2026-07-25). Stats
  windows aggregate **all** challenges, not just dailies (windowed by
  challenge creation date; the daily streak itself stays daily-only).
- **Challenges** (library) — **Browse**: search field (accepts pasted share
  links), today's daily pinned at top pointing to Home, reverse-chronological
  catalog, played-state chips (`NEW` / `✓ best` / `DNF`, gated correctly so a
  premature "NEW" never flashes while outcomes are still loading), "+ Create
  a challenge" card. **Detail**: back link, pair title, creator attribution,
  "Race this," the challenge's own non-deduped leaderboard (promoted heading
  contrast — DT-1), a **"View graph"** modal showing the merged-braid path
  graph across finishers (server-side, finisher-gated, best-run-per-account;
  portaled to `document.body` to escape a `clip-path` stacking-context bug —
  see companion doc Trap Class 3), path comparison against other finished
  placements, "Your history," "Copy link."
- **You** — 3 explicit session states ("Honest You," 2026-07-20): guest,
  claimed-this-device, and signed-out. Includes Log Out, ghost-orphan guards
  on every path that could silently lose a local guest identity (logout,
  logging in over an active ghost, "play as someone else"), an amber
  at-risk indicator, and the persistent claim/log-in affordance for guests.
  Stats content (totals, top articles, bridge pages, streak/trend chip)
  otherwise unchanged.
- `/admin/dailies` bypasses the bottom-nav shell entirely, unchanged, and is
  now lazy-loaded (dead weight removed from the bundle for the ~99% of
  visits that never touch it).

### Play-another and on-demand random challenges

Unchanged in mechanics from the redesign: Home's post-play card and Results'
Play-another slot suggest the most-popular never-started challenge
(`account_aliases`-resolved, account-day-floored `playerCount`), excluding
today's daily; when none remain, "Create a random new one" calls `POST
/api/v2/challenges/random` (rate-limited per-account and per-IP, ~25s real
Wikipedia crawl). The same suggestion engine now also powers Stats' zero-finisher
"Try an easier one ›" escape hatch (2026-07-26).

### Gameplay (unchanged since the redesign)

- The article surface stays close to Wikipedia, stripping
  navigation/search/unsafe controls while keeping tables/images (wide tables
  now get their own per-table scroll wrapper, not a shared pane scroll —
  MB-1).
- Only allowed internal English mainspace links become moves.
- Clicking a valid link freezes decision time immediately; Wikipedia fetch
  and server sync time are excluded.
- Browser find is blocked in the official client; fair play relies on
  server-verifiable transitions, not invasive browser policing.
- A player must click the target and load it; merely seeing its link is not
  a win.

### Results, leaderboards, boards, and stats

- Completed runs rank by accepted active decision time, then clicks, then
  accepted completion time.
- Abandons at or above the FB-7 threshold (`MIN_COUNTED_DNF_CLICKS = 2`)
  appear below finishers as `DNF`. Sub-threshold abandons are non-attempts
  everywhere except a player's own Results/history/roster-census views.
- Paths are stored for every run and disclosed on demand — Boards/Stats never
  discloses a path at all (Detail and the graph modal only, both
  finisher-gated).
- Challenge Detail's own leaderboard is still capped at 100 terminal rows
  pending cursor pagination (unfixed, non-issue at current scale).
- Stats aggregate the canonical VGames account across all challenges (not
  just dailies), including merged guest history, plus the daily streak
  (consecutive days played, silent reset on a missed day) and rolling
  avg-placement trends (guarded by the 2-completion inclusion floor).

## Challenge Creation

Unchanged from the prior release: a player enters a title/URL for start and
target (or triggers the on-demand random path); the Worker resolves
redirects and validates canonical page IDs; the D1 repository atomically
reuses an existing ordered pair or assigns the next global number; a claimed
creator can nominate for a future Daily only during this flow; a nominated
challenge is classified into a suggested flavor when the bounded evaluator
has enough evidence.

There is no deletion flow for ordinary users. Moderation/reporting and
deactivation policy remain backlog decisions.

## Daily System

### Schedule

- Intended creation time: 5:00 AM `America/Chicago` every day.
- Cloudflare crons `0 10 * * *` and `0 11 * * *` cover both sides of the DST
  boundary; the wrong-side trigger exits before touching D1.
- `17 * * * *` (hourly) checks once for existing due work, and — since
  2026-07-25 — also runs the **auto zz-sweep** (`try`/`finally`-isolated so a
  sweep failure never masks a daily-job outcome). See the companion doc §5
  for the `zz*` test-account convention this maintains.
- The scheduler is durable and idempotent: at most one Daily per Central
  date, every accepted Daily consumes the next global challenge number.

### Editorial Flavors

- Monday-Wednesday: `recognizable` (Vital Levels 1-2 only, plus a ≥1000/mo
  pageviews floor).
- Thursday-Friday: `weird` (cached Unusual Articles).
- Saturday-Sunday: `hard` (union of both pools, with shortcut rejection).
- **Per-flavor inbound-link floors**, calibrated 2026-07-26 against all 12
  dailies run to date: `recognizable` 150, `weird` 30, `hard` 150 — `hard`
  needs the *highest* floor (it means connected-but-obscure, not a needle
  hunt). See the companion doc §5 for the full rationale and the explicit
  warning against retuning these without materially more data.
- Automatic evaluation stays deterministic and versioned (`editorial-v1`):
  at most 10 targets, 3 independent random starts, 40 Wikimedia subrequests,
  25 seconds. A canonical English mainspace target, no redirect/
  disambiguation/list-like target, ≥1,500 target bytes, an 80-character lead,
  and a start with 8-200 playable links are all still required.
- `hard` remains a bounded difficulty proxy, not a full Wikipedia graph or
  exact shortest-path claim.
- A zero-finisher board now reads honestly ("No one has cracked this one
  yet.") with a same-day escape hatch to an easier challenge, instead of
  silently presenting an empty table.

### Queue And Moderation

Unchanged: approved nominations enter a FIFO queue per flavor; the scheduler
consumes the oldest valid queued challenge before automatic selection; a
queued/featured challenge cannot be silently repurposed across sources
(migration `0005`'s constraints/triggers). **Capability gap, still open:**
there is no operation to swap or retract an already-featured daily once the
scheduler has run for that Central date.

## Architecture And Ownership

```text
Browser
  -> Cloudflare Pages (Vite/React UI)
       -> functions/api/[[path]].ts (same-origin /api/* forwarder)
       -> VWIKI_API service binding (Cloudflare-internal)
  -> canonical vwikirace-api Worker
       -> VGAMES_IDENTITY service binding for identity
       -> D1 vwiki-race for game state
       -> Wikipedia/Wikimedia for validated article content and bounded Daily work
```

- Pages project: `vwikirace`; production is **manually deployed** from
  `dist` — there is no Git provider connection, so pushing `main` does not
  by itself deploy Pages. See the companion doc §2 for the exact deploy
  command with a real `--commit-hash`.
- Worker: `vwikirace-api`; configuration is `wrangler.api.toml`.
- D1: `vwiki-race`, binding `VWIKI_RACE_DB`, database ID
  `bbd89b81-078a-47e0-9db4-5d170a3f78b4`.
- Retained `functions/api/*` per-route handlers are compatibility proxies for
  old `/api/*` clients; they do not bind D1 or own authorization/game logic.
- **Same-origin API routing (2026-07-23):** production clients call `/api/*`
  on their OWN origin. `functions/api/[[path]].ts` catches everything the
  retained legacy routes don't claim and forwards it to the Worker over the
  `VWIKI_API` service binding declared in the root `wrangler.toml`
  (Cloudflare-internal, no public `workers.dev` hop on the client path — that
  hostname intermittently stalled from some client ISPs, which is the actual
  bug this shipped to fix; see companion doc §1). The client resolves its API
  origin at RUNTIME: explicit `VITE_VWIKI_RACE_API_URL` override > own origin
  on any `*.pages.dev` host > legacy `workers.dev` fallback
  (`src/services/apiOrigin.ts`). **Build production with the variable
  UNSET** — setting it pins every client to the public Worker origin and is
  the deliberate rollback lever for this whole fix, not a default build
  option.
- VGames owns credentials, uniqueness, ghost accounts, sessions, and account
  merging, from a **separate repository**
  (`/Users/vijayram/Cursor/vgames-platform/services/identity`) — read-only
  from this repo. VWiki Race stores only canonical IDs/aliases needed to own
  game history.

### Source Map

Unchanged top-level split from the redesign (`src/App.tsx` bootstrap,
`src/modes/` mode components, `src/race/` full-screen takeover,
`src/server/` Worker), with these additions since:

- `src/services/urlRouting.ts`: the URL iff-invariant and Back-ladder depth
  counter (`vwrDepth`) — see companion doc Invariants 4-5 before editing.
- `src/server/runProtocol.ts`: `MIN_RESUMABLE_CLICKS` and
  `MIN_COUNTED_DNF_CLICKS` — two distinct constants, currently the same
  value, allowed to diverge. See companion doc Invariant 6 and Trap Class 4.
- `src/server/dailyCandidateEvaluator.ts`: `INBOUND_LINK_FLOOR` and
  `RECOGNIZABLE_PAGEVIEWS_FLOOR`, the daily-difficulty floors.
- `src/components/ChallengePathGraph.tsx` / `ChallengePathGraphButton.tsx`:
  the "View graph" modal (server endpoint: `GET /challenges/{id}/paths`,
  finisher-gated, best-run-per-account).
- `src/components/ModalDialog.tsx`: shared dialog chrome with an opt-in
  `portal` prop (portals to `document.body` — see Trap Class 3).
- `src/components/AdminDailies.tsx`: now lazy-loaded (`React.lazy`) behind
  the existing `isAdminDailiesRoute()` gate.
- `src/race/raceHudScrollMargin.test.ts`: a regression guard (not a real
  layout assertion — jsdom can't see visibility) on the sticky-HUD
  scroll-margin floors; see companion doc Invariant 8.
- `src/server/fetchBinding.test.ts`: a source-shape guard against
  reintroducing the `workerd` "Illegal invocation" bug — see companion doc
  Trap Class 1.
- `src/services/vgamesIdentity.ts`: `IDENTITY_ATTEMPT_TIMEOUTS_MS = [4000,
  8000, 15000]`, the login retry ladder.
- D1: `d1/migrations/`, still `0001` through `0006`, unchanged since
  Increment 0. Streaks and rolling trends remain derived on the fly, no new
  table (per the redesign spec's Open Question 2, still resolved that way).

## Deployment And Safety

In this repository, Vijay saying **ship it** means the sequence in the
companion doc's §2, verbatim commands included. The summary, with the two
mistakes that have actually happened called out:

1. Finish, review, and verify the change locally.
2. Run `npm test`, `npm run test:worker`, `npm run build`, `npm audit
   --omit=dev`, and `npx wrangler deploy --dry-run --config
   wrangler.api.toml` — **checking real exit codes, never piping to
   `grep`/`tail`/`head`** (this has silently eaten a real failure twice).
3. Commit locally.
4. Inspect the remote D1 migration ledger and back up before any new
   migration (there have been none since `0006`). Never replay an applied
   migration.
5. **Deploy the Worker before Pages whenever both changed** — reversing this
   briefly points Pages at a Worker that doesn't yet match the new client's
   contract.
6. Push `main`.
7. Build with `VITE_VWIKI_RACE_API_URL` **unset** and manually deploy Pages
   with the real `--commit-hash "$(git rev-parse HEAD)"` — Pages is not
   Git-connected, so pushing `main` alone deploys nothing.
8. Smoke-test canonical production. **Assert the actually-executed bundle
   (the live `index-*.js` filename) before diagnosing any apparent bug** —
   Cloudflare's edge can serve a stale colo's cached HTML for several
   minutes after a real deploy, and this has already cost debugging time
   more than once.

Do not run manual cron fan-out as a test against production. Do not
print/commit D1 exports, credentials, tokens, Wrangler logs, or Time Travel
bookmarks.

Migration `0005_editorial_dailies.sql` and `0006_board_exclusions.sql` are
already applied; `0005`'s D1 atomic-file-import recovery procedure (Wrangler
4.110 couldn't parse its compound triggers through the normal remote
migration path) is historical evidence, not an instruction to reapply it —
full procedure preserved in `docs/handoff/cloudflare-deployment-handoff.md`.

Verified at doc time: 1163/1163 client tests, 236/236 Worker/D1 tests,
`tsc --noEmit` clean, 0 production dependency vulnerabilities, runtime
`736eab5`, Worker `4e4a3cac`, Pages bundle `index-DTsZ8f1q.js`.

Production commands, migration preflights, smoke checks, failure triage, and
the maintenance-mode procedure remain authoritative in
`docs/handoff/cloudflare-deployment-handoff.md`. The exact ship-procedure
commands and their gotchas are also fully spelled out in the companion doc's
§2 — treat that copy as the executable reference, this one as the summary.

## Known Limitations

1. **Graph/difficulty:** still no full Wikipedia graph, exact reachability,
   challenge par, or shortest-path comparison. The 2026-07-26 metric
   validation (companion doc §1) found raw inbound-link count the best
   available finish-rate proxy among 8 tested, but this is still a proxy,
   not a graph.
2. **Competitive transition proof / leaderboard integrity:** the server does
   not yet prove every click against the exact stored source revision;
   leaderboards remain forgeable. This is the **#1 item in the owner-approved
   queue** (companion doc §8) — casual framing (redesign invariant 7) stays
   in force until it lands. The `board_excluded` containment flag (migration
   `0006`) bounds a forged run's blast radius in the meantime; it is not
   itself the fix.
3. **Historical reproducibility:** live Wikipedia changes; immutable
   snapshots or cached revision sets are required for tournament claims.
4. **Pagination:** the public/Detail leaderboard response stops at 100
   terminal rows, applied pre-dedup; still a non-issue at current scale,
   still not fixed.
5. **Community operations:** reporting, moderation, deactivation, and
   creator deletion for ordinary challenges remain undecided.
6. **Retention loops:** streaks and rolling avg-placement shipped; a Daily
   archive/calendar, reminders, and notifications remain unbuilt.
7. **Social layer / rivalry:** deferred by owner decision — no clean answer
   yet to "who gets highlighted" in a small, uneven-skill friend group. See
   companion doc §8.
8. **Localization:** English Wikipedia only.
9. **Daily swap:** the admin surface still cannot retract or swap an
   already-featured daily.
10. **Browse/Play-another scaling:** the popularity `ORDER BY` and
    Play-another suggestion query still have no covering index; fine at
    current scale (a few hundred challenges), revisit at low thousands.
11. **Catalog staleness:** the client's `visibilitychange`-triggered catalog
    refetch is still not tied to a bundle-version check, so a tab left open
    across a Pages deploy can serve a stale catalog snapshot until its next
    focus event. Unfixed.
12. **Ranking metric is provisional.** Stats' 7d/30d/Lifetime trends
    currently rank by average placement; a council-run simulation against
    real data disproved the owner's own raw-time-average instinct and
    produced two live ranking-metric options plus a recommendation — this is
    an **open owner decision**, not a settled design. See companion doc §7.
13. **Scoring adjustment (Y) is unshipped.** A proposed `Score = t + Y·clicks`
    adjusted-time display is not live (`Y = 0` today, i.e. raw time). Open
    owner decision, companion doc §7.
14. **DNF path-unlock ("Wordle model") is proposed, unanswered.** Do not
    build a day-end path-reveal for unfinished dailies without asking first
    — it changes a ratified spec invariant.
15. **`git stash@{0}`** holds an unverified, pre-fix client-side attempt at
    the recovery bug that was ultimately fixed server-side (RC-02). Decide
    explicitly whether to build on it or drop it; do not pop it blindly.

## Next Session

1. Read `/Users/vijayram/Cursor/AGENTS.md`, this file, and
   `docs/handoff/2026-07-26-agent-handoff.md` in full — the second document
   carries the operating detail this one only summarizes.
2. From `/Users/vijayram/Cursor/vwiki-race`, run `git status` and `git log`.
   Do not work from the umbrella folder.
3. Reconfirm the live Worker version (`wrangler deployments list --config
   wrangler.api.toml`) and the live Pages bundle hash (curl/view-source
   `vwikirace.pages.dev`) — do not trust this document's numbers without
   reconfirming, they drift with every ship.
4. List the remote D1 ledger before any future migration. `0006` should not
   be pending; stop and investigate rather than replaying it if the ledger
   says otherwise.
5. `docs/backlog.md` is dated 2026-07-17 and is now **stale** — it predates
   the entire redesign and everything in the companion doc. Do not treat it
   as current; the owner-approved Queue in the companion doc's §8 supersedes
   it for prioritization. It has not been rewritten as part of this handoff;
   consider doing so in a future session if it keeps causing confusion.
6. Start the next work cycle from the companion doc's §7 (Open Owner
   Decisions — ask before assuming) and §8 (Queue — lean Wikipedia
   edge-proxy → leaderboard integrity → desktop two-column Home, the last one
   gated on a mockup and sign-off before building).
7. Preserve all user data and existing leaderboard history. Never reset D1 to
   make a new interface easier.

## Documentation Map

- **`docs/handoff/2026-07-26-agent-handoff.md`: the primary companion to this
  file** — full narrative since 2026-07-18, exact ship procedure, hard-won
  invariants, recurring trap classes, operations detail, open owner
  decisions, the work queue, loose ends, and the working pattern that
  delivered all of it.
- `README.md`: short public project overview and local commands.
- `docs/game-principles-and-rules.md`: normative game rules and timing.
- `docs/backlog.md`: **stale** (dated 2026-07-17, predates the redesign) —
  see Next Session §5.
- `docs/handoff/cloudflare-deployment-handoff.md`: operational source of
  truth for deploy commands, migration preflights, and incident triage.
- `docs/superpowers/specs/2026-07-18-ux-redesign-modes-design.md`:
  council-ratified modes-not-tabs design — product lens, global invariants
  (including the 2026-07-21 DNF-finality addendum), per-screen specs, data
  requirements, build increments.
- `docs/superpowers/council/2026-07-19-ux-council/README.md` (+ briefs): the
  first UX council cycle — 13 judged fix packages, systemic-drift diagnosis.
- `docs/superpowers/council/2026-07-19-ux-council-round2/README.md` and
  `DECISIONS.md` (+ briefs): the second UX council cycle — 10 shipped
  quickfixes, the 12-item owner-decision backlog, and the verbatim decision
  ledger (several items in that ledger are still open — cross-check against
  the companion doc's §7 before assuming any of them were resolved later).
- `docs/handoff/2026-07-18-increment-0-release.md` and
  `2026-07-18-ux-redesign-release.md`: release evidence for the redesign
  itself (Increment 0, then 1-5).
- `docs/handoff/2026-07-17-editorial-dailies-release.md`,
  `2026-07-16-friend-release-handoff.md`,
  `2026-07-15-overnight-council-and-fixes.md`: earlier release history.
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
