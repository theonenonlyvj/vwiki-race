# VWiki Race Gameplay History, Speed, And Mobile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship durable DNF/repeat attempt history, correct daily presentation/scheduling, faster accepted navigation, and focused mobile gameplay fixes.

**Architecture:** Keep D1 and the existing protocol authoritative. Derive repeat status from immutable run history, include meaningful abandons in the same leaderboard response, prewarm only an indicated link, optimistically reveal only a fully loaded destination, and retain the link-free target preview in compact gameplay chrome.

**Tech Stack:** React 19, TypeScript 5.7, Vite 6, Vitest, Cloudflare Workers/Vitest pool, D1, MediaWiki Action API.

## Global Constraints

- Preserve all existing production rows; do not delete or renumber Challenges #4 or #5.
- Completed rows sort by elapsed decision time, clicks, completion time, and run id.
- DNF rows require at least one accepted click, appear after finishes, display no competitive rank, and sort by elapsed effort descending then clicks descending.
- Repeat status is server-derived from any earlier run by the canonical account on the challenge.
- Do not prefetch every article link or add a live server-side Wikimedia request per click.
- Ctrl/Cmd+F prevention is fair-play friction, not security.
- Keep Wikimedia attribution and the existing request-budget discipline.
- `ship it` means commit, push, deploy the API Worker, deploy Pages, and production-smoke the release.

---

### Task 1: Server Attempt History And Leaderboard Contract

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/server/d1TrackingRepository.ts`
- Modify: `src/server/trackingRepository.ts`
- Modify: `src/services/vwikiRaceApiClient.ts`
- Modify: `src/App.tsx`
- Test: `src/server/d1TrackingRepository.worker.test.ts`
- Test: `src/services/vwikiRaceApiClient.test.ts`
- Test: `src/App.test.tsx`

**Interfaces:**
- Produces `RankedLeaderboardRow.status`, `isRepeatRun`, `startedAt`, optional `completedAt`, and optional `abandonedAt`.
- Keeps `rank: number` on the wire; abandoned rows render `DNF` instead.

- [ ] **Step 1: Add failing D1 tests**

Create two completed runs and one one-click abandoned run for one canonical account plus a first run from another account. Assert all terminal attempts are returned, later attempts have `isRepeatRun: true`, finishes precede the DNF, and the DNF retains its path.

```ts
expect(rows.map(({ status, isRepeatRun }) => ({ status, isRepeatRun }))).toEqual([
  { status: "completed", isRepeatRun: false },
  { status: "completed", isRepeatRun: true },
  { status: "completed", isRepeatRun: false },
  { status: "abandoned", isRepeatRun: true },
]);
```

Also assert a zero-click abandon is stored in stats but excluded from `listLeaderboard`.

- [ ] **Step 2: Run the focused Worker test and verify RED**

Run: `npm run test:worker -- src/server/d1TrackingRepository.worker.test.ts`

Expected: existing query returns only one best completed row per account and no DNF fields.

- [ ] **Step 3: Implement terminal-attempt query and abandonment timing**

Update protocol-2 abandon to persist wall effort into existing `wall_elapsed_ms` and `elapsed_ms`. Replace the best-per-account query with CTEs that resolve aliases, assign `attempt_number` over every run, select eligible completes plus one-click DNFs, rank finishes first, and order DNFs by effort/clicks.

Allow `getPublicRunPath` for either a ranked completion or an abandoned run with `click_count > 0`.

- [ ] **Step 4: Update client validation and UI**

Validate the new fields. Render `#N` for completed rows, `DNF` for abandoned rows, a `Repeat run` badge when true, and `View path` for DNF rows.

After an accepted abandon, refresh the selected challenge leaderboard exactly once.

- [ ] **Step 5: Run focused tests and commit**

Run:

```bash
npm test -- src/services/vwikiRaceApiClient.test.ts src/App.test.tsx
npm run test:worker -- src/server/d1TrackingRepository.worker.test.ts
```

Commit: `feat(history): show DNF and repeat attempts`

---

### Task 2: Daily Challenge Correctness And Catalog Freshness

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/domain/challengeSelection.ts`
- Modify: `src/server/d1TrackingRepository.ts`
- Modify: `src/server/worker.ts`
- Test: `src/App.test.tsx`
- Test: `src/domain/challengeSelection.test.ts`
- Test: `src/server/dailyChallengeJobs.worker.test.ts`
- Test: `src/server/d1TrackingRepository.worker.test.ts`

**Interfaces:**
- Produces `centralDateKey(date): string` for browser selection/badges.
- Manual challenge rows map to `mode: "solo"`; true daily rows map to `mode: "daily"`.

- [ ] **Step 1: Add failing date, mode, badge, and refresh tests**

At `2026-07-16T00:30:00Z`, assert the Central key is `2026-07-15`. Assert manual D1 rows serialize as `solo`. Render July 15 and July 16 dailies and assert badges `Daily 7/15` and `Today`. Fire `visibilitychange` after replacing the catalog mock and assert one refresh.

Add a scheduled test whose controller timestamp is more than five minutes ahead of injected Worker wall time and assert tracking/Wikipedia are untouched.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npm test -- src/domain/challengeSelection.test.ts src/App.test.tsx
npm run test:worker -- src/server/dailyChallengeJobs.worker.test.ts src/server/d1TrackingRepository.worker.test.ts
```

- [ ] **Step 3: Implement Central date and catalog behavior**

Use an `Intl.DateTimeFormat` with `America/Chicago` for the browser date key. Add focus/visible refresh without polling. Derive badge text from `dailyDate` and the Central key.

Map challenge mode from `origin` in repository rows and idempotent response JSON.

Inject `now` into `createWorker`; reject only scheduled timestamps more than five minutes in the future, allowing delayed real cron events.

- [ ] **Step 4: Run tests and commit**

Commit: `fix(daily): clarify Central daily challenges`

---

### Task 3: Faster Accepted Navigation, Scroll, And Find Guard

**Files:**
- Modify: `src/hooks/useRaceController.ts`
- Modify: `src/App.tsx`
- Test: `src/hooks/useRaceController.test.tsx`
- Test: `src/App.test.tsx`

**Interfaces:**
- Produces `race.prewarmLink(title): void`.
- `WikipediaArticlePanel` consumes `acceptedPageId` and prewarm events.

- [ ] **Step 1: Add failing controller tests**

Assert `prewarmLink` and a subsequent click share one gateway request. With a deferred click API, assert the loaded destination becomes `article` while `session.currentPage` remains the source; on acceptance both become the destination; on rejection both roll back to source.

- [ ] **Step 2: Add failing App tests**

Stub `scrollIntoView`. Assert no scroll during destination load or pending API, then exactly one scroll after accepted page-id change. Dispatch Ctrl+F and Meta+F in idle/active/completed states; only active/syncing events are prevented.

- [ ] **Step 3: Implement prewarm and optimistic reveal**

On delegated `pointerdown` or focused playable link, call `prewarmLink`. After `getArticle` resolves, commit the destination article with pending sync state but retain the accepted source/session. Existing `PendingClick.sourceState` remains the rollback authority.

Scroll and focus from an effect keyed by accepted page id, with `scroll-margin-top` in CSS.

- [ ] **Step 4: Run tests and commit**

Run:

```bash
npm test -- src/hooks/useRaceController.test.tsx src/App.test.tsx
```

Commit: `perf(gameplay): accelerate article navigation`

---

### Task 4: Compact Target Reference And Mobile Interaction Fixes

**Files:**
- Modify: `src/hooks/useTargetPreview.ts`
- Modify: `src/App.tsx`
- Modify: `src/styles.css`
- Test: `src/hooks/useTargetPreview.test.tsx`
- Test: `src/App.test.tsx`

**Interfaces:**
- The preview hook retains the current challenge's ready snapshot while gameplay is active.
- `PathStrip` consumes the target preview and renders a fixed target disclosure beside scrollable history.

- [ ] **Step 1: Add failing preview/path/modal tests**

Assert starting a race retains the ready preview without another Wikipedia call. Assert the path strip exposes the full target title and blurb from a collapsed disclosure. Assert opening a modal sets body overflow to `hidden` and restores the previous value on close.

- [ ] **Step 2: Implement target strip and scroll lock**

Split path history from the final target. Render a `<details>` target control with a compact summary and an absolute, link-free blurb panel. Lock body scroll for the lifetime of `ModalDialog`.

- [ ] **Step 3: Apply bounded mobile CSS**

At `max-width: 640px`, enforce 44px controls/tabs, keep the target control visible, reduce the pre-start preview height/type, avoid header/path overlap, and keep modal scrolling contained.

- [ ] **Step 4: Run tests and commit**

Run:

```bash
npm test -- src/hooks/useTargetPreview.test.tsx src/App.test.tsx
```

Commit: `fix(mobile): keep gameplay controls and target usable`

---

### Task 5: Documentation, Review, And Release

**Files:**
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `docs/backlog.md`
- Modify: `docs/game-principles-and-rules.md`
- Modify: `docs/handoff/cloudflare-deployment-handoff.md`
- Create: `docs/handoff/agent-handoff-2026-07-16.md`

- [ ] **Step 1: Document current behavior and operating facts**

Record `ship it` semantics, attempt/DNF/repeat rules, daily randomness, the July 16 early-creation explanation, deployment order, current services, verification commands, known limits, and next-agent orientation.

- [ ] **Step 2: Run a whole-game council review**

Dispatch game-design, mobile UX, data-integrity, and performance reviewers against the complete diff. Fix Critical/Important findings; put genuine product choices in `docs/backlog.md`.

- [ ] **Step 3: Run release gates**

```bash
npm test
npm run test:worker
npm run build
npm audit --omit=dev
git diff --check
npx wrangler deploy --config wrangler.api.toml --dry-run
```

- [ ] **Step 4: Commit, push, and deploy**

Commit docs/review fixes, fetch and verify `origin/main`, push `main`, deploy `vwikirace-api`, deploy `dist` to Pages project `vwikirace`, and production-smoke challenge selection, one-click DNF, repeat labels, target disclosure, and mobile navigation.

