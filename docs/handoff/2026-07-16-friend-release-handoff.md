# VWiki Race Friend Release Handoff

Date: 2026-07-16

Status: deployed friend release. The API Worker and Pages production deployment
listed in the Release Record passed direct and responsive smoke checks.

## Product In One Paragraph

VWiki Race is an asynchronous Wikipedia navigation game. A numbered challenge
defines one canonical start article and one canonical target article. A player
starts whenever they want, then reaches the target only through links displayed
inside the controlled Wikipedia renderer. VGames owns unique account names,
guest ghosts, login, and later guest-to-account claims. VWiki Race owns the
challenge catalog, creator attribution, every run from accepted start, accepted
click/path history, account stats, and per-challenge leaderboards in Cloudflare
D1. There is no realtime room layer.

## Current Friend-Ready Flow

1. Anyone can browse the challenge catalog and open a permanent URL such as
   `/?challenge=challenge-0003` without first signing in.
2. The target preview and completed result both expose Copy challenge link,
   which copies the permanent URL for the selected challenge and confirms the
   action inline. If browser permissions block automatic copying, the exact URL
   appears in a selectable field instead.
3. Start opens the identity gate only when needed. `Create New` is the default,
   `Log In / Existing` uses a VGames account, and `Guest` preserves a VGames
   ghost. Claimed users start without another prompt; returning ghosts are
   encouraged to claim before every challenge but may continue as the same
   guest.
4. The start page is loaded and sanitized before the server accepts the run.
   The interactive page and zero timer appear together only after acceptance.
5. Pointer-down or keyboard focus prewarms only the one indicated article link.
   Activating it freezes decision time. Once Wikipedia has returned and the
   article is sanitized, the destination appears while D1 synchronization is
   still pending. Click count, official path, and accepted current page do not
   change until the Worker accepts the transition.
6. A failed or rejected transition restores the accepted article. Recoverable
   failures preserve the exact idempotent click body for Retry.
7. Acceptance scrolls the new article heading below the sticky game chrome and
   focuses it. Ctrl/Cmd+F is blocked during active/syncing play only.
8. The compact path shows an ellipsis plus the most recent three visited pages
   when needed. A fixed target disclosure shows the full target title and the
   already-loaded, link-free target blurb.
9. Reaching the canonical target completes the run automatically. The result,
   leaderboard, stats, and disclosed path come from server data.

The Back button, direct URL entry, browser Find, Wikipedia search, external
links, category/navbox shortcuts, See Also, and citation-only link surfaces are
not valid Ranked Classic moves.

## Wikipedia Rendering

- The app uses English Wikipedia's MediaWiki API, canonical page IDs, and
  revision IDs.
- The sanitizer preserves prose, headings, lists, infoboxes, substantive
  tables, figures, captions, and safe Wikimedia images.
- It removes scripts/styles/embeds, external navigation, red links, non-article
  namespaces, categories, navboxes, portals, references, bibliography-only
  material, and See Also.
- Tables scroll horizontally on narrow screens. Images, figures, and infoboxes
  collapse to the available width on mobile.
- Every rendered article and pre-start target preview carries source-revision
  and CC BY-SA attribution.
- The per-run cache deduplicates in-flight/canonical aliases and is cleared
  between runs. It is not a cross-round knowledge cache.

## Runs, Scoring, And History

- A run is durable as soon as Start is accepted, including zero-click attempts.
- Decision time excludes Wikipedia loading and Worker synchronization. Speed is
  primary; click count, accepted completion time, then run ID break ties.
- Eligible finishes are not deduplicated to one personal best per account.
- An explicit End Run after at least one accepted click appears below finishes
  as `DNF`. DNF rows do not display a competitive numeric rank. They sort by
  time spent descending, clicks descending, abandonment time, then run ID.
- Zero-click abandons remain in account statistics but do not clutter the public
  challenge leaderboard.
- Any attempt after the canonical account's first stored start on that challenge
  is marked `Repeat run`, even when the earlier attempt ended at zero clicks.
  This is derived from history so VGames alias merges remain correct.
- Completed and meaningful DNF paths are available through the bounded public
  path-disclosure endpoint.
- The current leaderboard response is capped at the first 100 ordered terminal
  rows. D1 and account statistics retain later attempts; cursor pagination is a
  required follow-up before any challenge approaches that volume.
- Older DNF rows without stored elapsed values derive duration from server
  start/abandon timestamps, preserving history without a destructive migration.
- Closing a tab does not immediately create a DNF. The accepted active run is
  designed to resume on the next authenticated visit; End Run is the explicit
  abandonment action.

## Daily Challenge Contract

The Worker has DST-covering `0 10 * * *` and `0 11 * * *` UTC triggers plus a
cheap retry trigger at `17 * * * *`. A DST-aware `America/Chicago` gate allows
only the event whose local time is exactly 5:00 AM to create a new date. The
alternate DST trigger exits before D1. The minute-17 trigger may only claim an
existing due job; with no due job it performs one bounded D1 check and never
contacts Wikipedia. Events dated more than five minutes in the future relative
to Worker wall time exit before D1 or Wikipedia.

The accepted Central date is a durable job/idempotency key, never a challenge
number. Manual and daily creation share one transactional sequence. If
Challenge #15 is the latest accepted row, the next accepted manual or daily
challenge is Challenge #16.

### Random selection logic

For each candidate pair:

1. Ask MediaWiki independently for one random start and one random target from
   English Wikipedia's main article namespace with redirects excluded.
2. Reject missing, redirect, non-mainspace, malformed, disambiguation, or
   identical page IDs.
3. Render and sanitize the start, require exact canonical page identity, and
   require at least one playable Ranked Classic link.
4. Accept the pair atomically in D1 only after validation.

The generator tries at most three pairs inside a 25-second phase. It never uses
`Math.random`, a local curated list, or a hard-coded fallback. Failure leaves the
durable job pending with bounded backoff. The generator does not yet prove graph
reachability or calibrate difficulty; that requires an offline/cached graph.

### July 15-16 scheduler incident

Production D1 showed Challenge #4 with daily date `2026-07-15` and Challenge #5
with daily date `2026-07-16`. The old hourly UTC scheduler accepted #5 at
`2026-07-16T00:07:55Z`, which was 7:07 PM Central on July 15. At the real 5:00
AM Central run, July 16 already had its valid immutable row, so no additional
challenge was created. Nothing was wiped and #5 must not be deleted or
renumbered. Current badges show `Today` for the current Central daily and
`Daily M/D` for historical dailies, so two retained daily rows are no longer
visually ambiguous.

## Identity And Data Ownership

- VGames names are unique and take priority over guest display names.
- VWiki Race never creates a second username namespace.
- Guest creation and account creation rely on VGames uniqueness enforcement.
- VGames account aliases are server-only opaque IDs. Never serialize them to a
  browser or public leaderboard.
- Canonical account resolution makes guest history survive claim/merge and
  keeps challenge creators, stats, repeats, and attempts attached correctly.
- Browser localStorage holds only the current VGames session convenience copy.
  It is not the run system of record.

## Cloudflare Topology

- Pages: `https://vwikirace.pages.dev`
- API Worker: `vwikirace-api`
- D1: `vwiki-race`, binding `VWIKI_RACE_DB`
- VGames service binding: `VGAMES_IDENTITY`
- Compatibility Pages Functions proxy legacy `/api/*`; they do not bind D1.
- Cloudflare reported `Git Provider: No` for `vwikirace` on 2026-07-16, so
  pushing `main` does not deploy Pages. The frontend deployment is the explicit
  `npx wrangler pages deploy dist --project-name=vwikirace --branch=main` step.

This release adds no migration. Expected production ledger is `0001` through
`0004`. Migration `0003` is an immutable historical artifact whose superseded
cutover DML is unsafe to replay against imported/populated history. Never edit
or replay an applied migration; use a new reviewed additive migration for any
correction. Inspect the remote ledger before deployment. Deploy and smoke-test
the Worker before pushing/allowing Pages to deploy when both changed.

`ship it` is a repo-level instruction to verify and commit locally, inspect the
D1 ledger, deploy and smoke-test the Worker, then push `main` / allow Pages to
deploy, and run production smoke checks. The detailed commands and failure
triage remain in `cloudflare-deployment-handoff.md`.

## Highest-Priority Known Limitation

The Worker validates authorization, canonical account, step sequence, source
continuity, page identity, idempotency, and monotonic decision time. It does not
yet prove that a submitted destination was an allowed edge in the recorded
source revision. The browser only submits rendered links, but a malicious custom
client can bypass browser UX. Do not offer prizes or claim adversarial/tournament
integrity until a revision-keyed allowed-edge manifest or offline verifier exists.
Do not solve this by fetching Wikipedia once per player click; that would make
latency and request cost materially worse.

## Product Backlog That Still Matters

1. Revision-keyed edge verification before prizes or public tournaments.
2. Offline/cached reachability, shortest-path, and difficulty analysis for
   challenge quality and post-run comparison.
3. A dedicated player history/progression view; raw attempts already exist.
4. Catalog search/filter/archive and an explicit Copy Link action as volume
   grows.
5. Privacy-thresholded aggregate thinking maps for starts, targets, bridge
   pages, and transitions.
6. Decide whether a future Daily board ranks unlimited marked repeats, first
   attempt only, or best-of-day. Current behavior shows all attempts.
7. Race-the-ghost/replay comparison only after edge integrity is addressed.
8. Measure production fetch/sanitize/API spans before adding a bounded LRU or a
   lead-only preview endpoint. Never prefetch every visible link.
9. Add cursor pagination before a challenge approaches the current 100-row
   public leaderboard response cap.

## Next-Agent Orientation

1. Read repo `AGENTS.md`, this file, `README.md`, `docs/backlog.md`, and
   `docs/game-principles-and-rules.md`.
2. Run `git status`, inspect recent commits, and verify which commit Cloudflare
   currently serves before editing.
3. Treat production D1 as append-only history. Never delete, renumber, reset, or
   reseed challenges/runs to fix a presentation bug.
4. Use the existing test seams and Superpowers workflow. Required gates are
   `npm test`, `npm run test:worker`, `npm run build`, `npm audit --omit=dev`,
   `git diff --check`, and a Wrangler dry run.
5. Preserve the one-indicated-link prewarm budget, Wikimedia attribution, and
   Worker-before-Pages deployment order.

## Release Record

- Client tests: `322/322` passed before deployment.
- Worker tests: `77/77` passed before deployment.
- Build/bundle: TypeScript, Vite production build, and bundle verification passed.
- Dependency audit: `npm audit --omit=dev` reported zero vulnerabilities.
- Worker dry run: passed; upload 534.17 KiB / gzip 116.40 KiB and all bindings present.
- Runtime source commit SHA: `cff86fa7e66849c50ba33f4b3370e8b665a02ad7`.
- D1 migration ledger: remote reported no pending migrations; production audit
  found Challenges #1-#5 active, 5 abandoned + 2 active + 8 completed runs, and
  two accepted daily jobs with zero writes performed by the audit.
- Private backup (required only for data changes/new migrations): not required;
  this release has no migration or direct data mutation.
- Git push: release/runtime commits through `bb45a4f` pushed to GitHub `main`.
- Worker deployment/version and UTC time: `vwikirace-api` version
  `d699460b-a34a-4b6d-a3c7-5139311b1f0d`, verified by direct smoke at
  `2026-07-16T17:42:07Z`. Catalog returned all five active challenges with
  manual=`solo`, daily=`daily`, correct dates/CORS/cache; Challenge #3 retained
  both existing leaderboard rows and returned `Cache-Control: no-store`.
- Pages mechanism, commit/deployment ID, URL, and UTC time: manual Wrangler
  deploy (Git provider `No`), source `bb45a4f`, deployment
  `31a577e2-b537-4ee0-b218-8ed85536e214`,
  `https://31a577e2.vwikirace.pages.dev`, verified at
  `2026-07-16T17:47:13Z`; canonical URL is `https://vwikirace.pages.dev`.
- Desktop/mobile production smoke: canonical Challenge #3 deep link, target
  preview, five-row catalog, `Today`/historical daily badges, identity gate,
  and two-row preserved leaderboard passed. Desktop 1440x900 and mobile
  360x800, 390x844, and 430x932 showed no horizontal overflow. At 360px the
  dialog remained inside the dynamic viewport, locked body scroll, and exposed
  five 44px controls. Active/sync/result behavior remains covered by the 322
  automated client tests; no synthetic production run was created just for QA.
