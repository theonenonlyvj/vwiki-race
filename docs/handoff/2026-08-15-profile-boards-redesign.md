# 2026-08-15 — You profile + Boards redesign, per-window metrics, serif swap

Everything below is SHIPPED and live unless marked OPEN. `main` = `05bcae0`.

## What shipped (6 commits)

| commit | what |
|---|---|
| `7a9756a` | You: `[Most visited][Most time]` page toggle, per-page dwell |
| `32432e9` | You: layout B, Merriweather body face, `formatStatDuration` |
| `cbf5121` | `totalClicks` FB-7-gated (354 → 464 for the owner) |
| `7b32b89` | `totals.totalDwellMs` + a 66%-cheaper dwell query |
| `507a368` | Slim page-list bars, tracked featured figures |
| `4093a7f` + `05bcae0` | Boards: per-window metrics + row redesign |

## Decisions that cost real analysis — do not silently revisit

**Per-page dwell needs NO new column.** `run_path_steps.elapsed_since_start_ms`
is the run's CUMULATIVE decision time at each accepted click, so dwell is the
successive difference, and step 1's difference is time on the START page.

**`abandonRunV2` overwrites a DNF's `elapsed_ms` with WALL CLOCK.** So a DNF's
elapsed is a different clock from a completed run's decision time and the two
must never be summed. This is why `totalDwellMs` sums measured page dwells
instead. Evidence: the owner's 7 counted DNFs held 3h30m of elapsed_ms, 81
minutes of it inside ONE run's trailing wall-clock gap (82.8 min of "race",
1.8 min of actual clicking).

**`MAX_COUNTED_DWELL_MS` = 20 min, not 10.** 10 was shipped first and caught
understating a real row (Supreme Court: true 13:11 shown as 10:59). At 20 min
it clips exactly ONE step in the whole database.

**The dwell query's cost was join order, not arithmetic.** `coalesce(canonical_account_id, account_id)`
can't use an index, so `JOIN owner_runs` drives from steps into runs.
`WHERE run_id IN (SELECT id FROM owner_runs)` = 6152 → 2095 rows read.
Storing a precomputed dwell column was measured at 5755 — a 7% saving. **Do
not denormalise this.** Store facts, not aggregates: account merges, the zz
sweep and `board_excluded` flips all invalidate a stored per-account total.

**Boards: one primitive, three aggregations** (owner framing: "lifetime is
asking who's GOAT, 30 days: who's showing up, 7: who's hot?").
7d = mean % beaten (floor 2) · 30d = total racers beaten (floor 0, because the
metric IS participation) · lifetime = mean shrunk toward 0.5 by
`GOAT_PRIOR_RACES`=10, floor `GOAT_INCLUSION_FLOOR`=5.

**Lifetime needs BOTH its floor and its shrinkage.** One race at 100% shrinks
to 0.5455 and still beats a 33-race 54% record (0.5307); a prior strong enough
to fix that alone (K≈50) crushes everyone into 0.49–0.52. Floor = eligibility,
shrinkage = belief. Pinned by test.

**Drop-worst is gone everywhere.** Measured regressive: ~7 points to a 4-race
account vs 1.8 to a 30-race one (forgiving 1 of 4 discards 25% of a record,
1 of 30 discards 3%), while moving only 4 of 16 positions by one place each.

## Tooling notes that cost time

**Playwright browsers ARE installed** at `~/Library/Caches/ms-playwright`
(chromium-1234). The npm package is in no project — `npm install --no-save
playwright-core` in scratch, then `chromium.launch({ executablePath })` at the
cached binary. Checking only a project's `node_modules` and concluding "no
browser" wasted three rounds of unverified visual work.

**To render a real page against real data without writing to prod:** auth with
a throwaway `zz`-prefixed ghost (the hourly sweep excludes `zz*` from boards),
then `page.route()` to intercept ONLY the stats/trends response.

**Local dev needs `VITE_VWIKI_RACE_API_URL`** or every request dies with
`VWIKI_ABSOLUTE_API_URL_REQUIRED` (the same-origin branch only fires on
`*.pages.dev`). Intercepted cross-origin responses also need CORS headers.

**Identity merge gotchas:** `cat file | wrangler secret put` stores the
TRAILING NEWLINE, so every signed token 401s — use `printf '%s'`. And
`wrangler secret delete` has no `--force`; pipe `yes |` and ALWAYS re-check
`secret list`, because a failed delete prints a usage error that looks
unrelated and leaves the secret live.

## OPEN

1. **`kaymck` duplicate merge — BLOCKED on permission.** Two ghosts, same
   display name, created 11 min apart 2026-08-13, both origin vwiki-race,
   neither claimed (no password, so no login dies).
   Merge `aa98b1e6-9b2c-4026-a21e-dbacd25a5a83` (1 run, 0 completed, 19:00)
   INTO `2705ec8d-f405-4e6e-9edb-f52f16698d2e` (1 run, 1 completed, 19:10).
   Owner approved the intent; the Claude Code permission classifier blocks
   `wrangler secret put`, which the documented `/admin/merge` flow requires.
   Needs the owner to allow that action, then: set secret → dry-run → execute
   with `confirmNonce` → **delete secret and verify absent** → write the
   `account_aliases` row in vwiki-race so boards unify immediately.

2. **View graph — NEXT, not started.** Owner: "a super popular feature but it
   sucks on mobile. it's the coolest thing to look at the next day!" and
   navigating to old challenges to see one is "kind of a navigation
   nightmare". Reachable today only from `ChallengePathGraphButton` in
   `Boards.tsx:987`, `Home.tsx:492`, `RaceResults.tsx:424`. The two complaints
   are one problem: the graph wants to be a next-day ritual but is buried
   behind per-challenge drilldown. Component is `ChallengePathGraph.tsx`
   (A8 already has a <480px fit-to-width overview mode — check whether it
   actually works before redesigning).

3. **Landing page** — owner wants it "sleeker". Screenshot showed content
   occupying the top third with a large void beneath, down to the footer.

4. **Pre-existing `npm audit --omit=dev`**: nanoid (high), postcss (moderate).
   Untouched all session; no dependency changes were made beyond the font swap.

5. `CHAR_WIDTH_PX` in `ChallengePathGraph.tsx` is deliberately left at
   Fredoka's 6.6 though Merriweather measures 5.95 — it's a safety margin for
   label collision, and UNDER-estimating overlaps labels. Keep any future
   value at or above the body face's measured advance.
