# Editorial Dailies And Community Nominations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace first-valid random Dailies with a weekday editorial rhythm, deduplicate challenge pairs, support creation-time community nominations, and provide a VGames-account-authorized Daily queue inside VWiki Race.

**Architecture:** Keep immutable challenge identity separate from dated `daily_features`. D1 owns pair uniqueness, nominations, approved FIFO queue entries, feature uniqueness, and scheduler leases. Focused server modules load Wikipedia editorial pools and calculate bounded deterministic scores; the existing Worker remains the only API and D1 owner. The React app adds one creation-time checkbox and a protected `/admin/dailies` surface without redesigning the main product screens in this release.

**Tech Stack:** TypeScript, React 19, Vite 6, Cloudflare Workers, Cloudflare D1, Vitest, `@cloudflare/vitest-pool-workers`, `linkedom`, MediaWiki Action API, Wikimedia Analytics API.

## Global Constraints

- Monday-Wednesday are `recognizable`, Thursday-Friday are `weird`, and Saturday-Sunday are `hard` in `America/Chicago`.
- A challenge is unique by ordered `(start_page_id, target_page_id, ruleset)`; reverse direction is distinct.
- A challenge can be featured as a Daily only once, and each Central date has one Daily.
- Existing Daily challenges, runs, creators, and leaderboards must be preserved.
- Claimed VGames users may nominate only while submitting a challenge; guests may still create without nominating.
- Community nominations require admin approval; admin identity is configured with immutable VGames account IDs.
- Automatic selection is bounded to 25 seconds and 40 Wikimedia subrequests.
- No Wikipedia dump processing, open-ended BFS, exact shortest-path claim, AI classifier, community voting, or persisted automatic runner-up queue.
- Existing migrations `0001` through `0004` are immutable. Add only new migrations.
- Every mutation remains replay-safe with an `Idempotency-Key`.
- `ship it` requires Worker-first deployment, production D1 migration audit, Git push/Pages deploy, and production smoke checks.

---

## File Structure

### New files

- `d1/migrations/0005_editorial_dailies.sql`: additive pair uniqueness, feature, nomination, queue, and legacy-Daily backfill.
- `src/domain/dailyEditorial.ts`: Daily flavors, feature metadata, classifications, nomination and queue DTOs, weekday mapping, and pure validation helpers.
- `src/server/editorialTargetPools.ts`: cached Vital/Unusual pool loading and entry parsing.
- `src/server/dailyCandidateScoring.ts`: pure quality-floor rules, deterministic score components, stable sampling, and tie breaking.
- `src/server/dailyCandidateEvaluator.ts`: bounded Wikipedia/pageview orchestration, start validation, and hard two-click proxy.
- `src/components/AdminDailies.tsx`: protected Daily moderation and queue UI.
- `src/components/AdminDailies.test.tsx`: focused admin-surface behavior tests.
- `public/_redirects`: Cloudflare Pages SPA fallback for `/admin/dailies`.

### Modified files

- `src/domain/types.ts`: `Challenge.dailyFeature` and challenge-creation outcome types.
- `src/domain/challengeSelection.ts`: use authoritative feature metadata for Daily selection and labels.
- `src/server/contracts.ts`: v2 creation, capability, nomination, queue, and admin contracts.
- `src/server/trackingRepository.ts`: repository interfaces for deduplication, nomination, queues, and feature assignment.
- `src/server/d1TrackingRepository.ts`: atomic D1 implementations and row mapping.
- `src/server/runProtocol.ts`: creation fingerprints include nomination intent without breaking old receipts.
- `src/server/apiHandlers.ts`: expanded challenge creation outcome.
- `src/server/dailyChallengeCandidates.ts`: compatibility facade around the new evaluator.
- `src/server/worker.ts`: admin routes, capability route, queue-first scheduler, and configured admin authorization.
- `src/services/vwikiRaceApiClient.ts`: new validators and client methods.
- `src/App.tsx`: nomination intent through auth gating, duplicate feedback, capabilities, and admin route composition.
- `src/styles.css`: creation checkbox, notices, and admin surface responsive styles.
- `wrangler.toml`: non-secret `DAILY_ADMIN_ACCOUNT_IDS` production configuration.
- `README.md`, `docs/backlog.md`, and handoff docs: authoritative behavior and deployment notes.

---

### Task 1: Domain Contracts And Additive D1 Schema

**Files:**
- Create: `d1/migrations/0005_editorial_dailies.sql`
- Create: `src/domain/dailyEditorial.ts`
- Modify: `src/domain/types.ts`
- Modify: `src/server/contracts.ts`
- Modify: `src/server/trackingRepository.ts`
- Test: `src/server/d1TrackingRepository.worker.test.ts`
- Test: `src/domain/challengeSelection.test.ts`

**Interfaces:**
- Produces: `DailyFlavor`, `DailyFeature`, `DailyClassification`, `DailyNomination`, `DailyQueueEntry`, `CreateChallengeOutcome`, `dailyFlavorForCentralDate(date)`.
- Produces D1 tables: `daily_features`, `daily_nominations`, `daily_queue_entries`.

- [ ] **Step 1: Write failing migration and domain tests**

Before applying migration 0005 in the test fixture, insert three distinct legacy
Daily challenge rows with unique dates and ordered pairs. Then add tests asserting
the schema, exact preservation of those seeded rows, weekday mapping, and pair
uniqueness:

```ts
expect(await columns("daily_features")).toEqual(expect.arrayContaining([
  "daily_date", "challenge_id", "flavor", "selection_source",
]));
expect(await countWhere("daily_features", "daily_date is not null")).toBe(3);
expect(await legacyDailyFeatureMappings()).toEqual(seededLegacyDailies);
expect(dailyFlavorForCentralDate("2026-07-20")).toBe("recognizable");
expect(dailyFlavorForCentralDate("2026-07-23")).toBe("weird");
expect(dailyFlavorForCentralDate("2026-07-25")).toBe("hard");
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npm test -- src/domain/challengeSelection.test.ts
npm run test:worker -- src/server/d1TrackingRepository.worker.test.ts
```

Expected: failure because the new domain module and migration tables do not exist.

- [ ] **Step 3: Add the domain contracts**

Create the exact shared shapes:

```ts
export type DailyFlavor = "recognizable" | "weird" | "hard";
export type DailySelectionSource = "automatic" | "community" | "admin";
export interface DailyFeature {
  dailyDate: string;
  flavor: DailyFlavor;
  selectionSource: DailySelectionSource;
}
export interface DailyClassification {
  recognizableScore: number | null;
  weirdScore: number | null;
  hardScore: number | null;
  suggestedFlavor: DailyFlavor | null;
  confidence: "high" | "medium" | "low" | "unclassified";
  classifierVersion: string;
}
export type ChallengeCreationDisposition = "created" | "existing";
export type NominationDisposition =
  | "not_requested" | "pending" | "already_exists"
  | "previously_featured" | "account_required";
```

Add `dailyFeature?: DailyFeature | null` to `Challenge`; retain legacy provenance fields.

- [ ] **Step 4: Add migration 0005**

The migration must:

```sql
create unique index challenges_ordered_pair_unique_idx
  on challenges (start_page_id, target_page_id, ruleset)
  where start_page_id is not null and target_page_id is not null;

create table daily_nominations (...);
create table daily_queue_entries (...);
create table daily_features (...);

insert into daily_features (...)
select daily_date, id,
  case cast(strftime('%w', daily_date) as integer)
    when 0 then 'hard' when 6 then 'hard'
    when 4 then 'weird' when 5 then 'weird'
    else 'recognizable' end,
  'automatic', 'legacy-v1', created_at
from challenges where daily_date is not null;
```

Create partial indexes for pending nominations and queued FIFO entries. Use foreign keys, checks, and permanent `unique(challenge_id)` on `daily_features`.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the Task 1 commands. Expected: all selected tests pass.

- [ ] **Step 6: Commit Task 1**

```bash
git add d1/migrations/0005_editorial_dailies.sql src/domain/dailyEditorial.ts src/domain/types.ts src/server/contracts.ts src/server/trackingRepository.ts src/server/d1TrackingRepository.worker.test.ts src/domain/challengeSelection.test.ts
git commit -m "feat: add editorial daily data model"
```

---

### Task 2: Atomic Challenge Deduplication And Creation-Time Nominations

**Files:**
- Modify: `src/server/runProtocol.ts`
- Modify: `src/server/apiHandlers.ts`
- Modify: `src/server/d1TrackingRepository.ts`
- Modify: `src/server/contracts.ts`
- Modify: `src/server/trackingRepository.ts`
- Test: `src/server/apiHandlers.test.ts`
- Test: `src/server/d1TrackingRepository.worker.test.ts`

**Interfaces:**
- Consumes: Task 1 `CreateChallengeOutcome`, `DailyClassification`.
- Produces: `createChallengeV2(...): Promise<CreateChallengeOutcome>` and replay of both old and new receipts.

- [ ] **Step 1: Write failing deduplication and nomination tests**

Cover sequential and concurrent duplicates, reverse direction, sequence preservation, claimed/guest behavior, duplicate nomination, and replay:

```ts
const first = await repository.createChallengeV2(account, request("key-1", true));
const duplicate = await repository.createChallengeV2(other, request("key-2", true));
expect(first.disposition).toBe("created");
expect(duplicate).toMatchObject({
  disposition: "existing",
  challenge: { id: first.challenge.id },
  nomination: "already_exists",
});
expect(await nextChallengeNumber()).toBe(first.challenge.sortOrder! + 1);
```

- [ ] **Step 2: Run focused tests and verify RED**

```bash
npm test -- src/server/apiHandlers.test.ts
npm run test:worker -- src/server/d1TrackingRepository.worker.test.ts
```

Expected: old creation contract returns only `Challenge` and duplicate pairs conflict or consume numbers.

- [ ] **Step 3: Version the creation request fingerprint**

Include `nominateForDaily` in new fingerprints while accepting replay of legacy receipts that contain only a serialized challenge. Normalize legacy replay to:

```ts
{
  challenge: legacyChallenge,
  disposition: "created",
  nomination: "not_requested",
}
```

- [ ] **Step 4: Implement atomic pair reuse and nomination insertion**

Use guarded D1 batch statements in this order:

1. Insert/replay the idempotency operation.
2. Bind `resource_id` to an existing ordered pair before sequence allocation.
3. Allocate a number only when no pair exists.
4. Insert the challenge with `INSERT OR IGNORE` under the unique index.
5. Resolve a concurrent winner back into `resource_id`.
6. Insert one pending nomination when requested, claimed, and never featured.
7. Finalize one expanded response receipt.

Do not authorize nominations using display names. Preserve the original challenge creator when another user nominates an existing pair.

- [ ] **Step 5: Update API handler validation**

Accept:

```ts
interface CreateChallengeV2Request {
  startTitle: string;
  targetTitle: string;
  nominateForDaily?: boolean;
}
```

The API must create a guest challenge while returning `account_required` for a requested guest nomination. A classification failure stores `unclassified` and never rolls back the valid challenge.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run the Task 2 commands. Expected: selected suites pass with no sequence gaps.

- [ ] **Step 7: Commit Task 2**

```bash
git add src/server/runProtocol.ts src/server/apiHandlers.ts src/server/d1TrackingRepository.ts src/server/contracts.ts src/server/trackingRepository.ts src/server/apiHandlers.test.ts src/server/d1TrackingRepository.worker.test.ts
git commit -m "feat: deduplicate challenge creation"
```

---

### Task 3: Editorial Pools, Deterministic Scoring, And Hard Proxy

**Files:**
- Create: `src/server/editorialTargetPools.ts`
- Create: `src/server/editorialTargetPools.test.ts`
- Create: `src/server/dailyCandidateScoring.ts`
- Create: `src/server/dailyCandidateScoring.test.ts`
- Create: `src/server/dailyCandidateEvaluator.ts`
- Create: `src/server/dailyCandidateEvaluator.test.ts`
- Modify: `src/server/dailyChallengeCandidates.ts`
- Modify: `src/server/dailyChallengeCandidates.test.ts`

**Interfaces:**
- Produces: `createEditorialTargetPools(options).list(flavor, signal)`.
- Produces: `scoreDailyCandidate(input): ScoredDailyCandidate`.
- Produces: `createDailyCandidateEvaluator(options).findCandidate({ dailyDate, flavor })`.
- Preserves: `DailyChallengeCandidate` title/page-ID output required by persistence.

- [ ] **Step 1: Write failing parser, scorer, and budget tests**

Use checked-in inline HTML/JSON fixtures, not live Wikipedia:

```ts
expect(parseUnusualEntries(unusualHtml)).toEqual([
  { title: "Null Island", pageId: 123 },
  { title: "Gravity hill", pageId: 456 },
]);
expect(stableSample(pool, 10, "2026-07-23:v1")).toEqual(
  stableSample(pool, 10, "2026-07-23:v1"),
);
expect(scoreDailyCandidate(listLikeTarget).eligible).toBe(false);
expect(await evaluator.findCandidate(hardDay)).rejects.toMatchObject({
  code: "daily_candidate_unavailable",
});
expect(wikimediaRequestCount).toBeLessThanOrEqual(40);
```

- [ ] **Step 2: Run focused tests and verify RED**

```bash
npm test -- src/server/editorialTargetPools.test.ts src/server/dailyCandidateScoring.test.ts src/server/dailyCandidateEvaluator.test.ts src/server/dailyChallengeCandidates.test.ts
```

Expected: new modules do not exist.

- [ ] **Step 3: Implement editorial source adapters**

Use `linkedom/worker` to parse rendered Wikipedia project pages. Extract Vital Levels 1-3 entries and the first mainspace link in each Unusual entry term. Cache a validated pool for 24 hours, accept stale cache up to seven days, and reject empty/malformed upstream content.

- [ ] **Step 4: Implement pure scoring**

Enforce the hard quality floor:

```ts
const LIST_PREFIX = /^(List|Lists|Outline|Index|Glossary|Timeline|Bibliography|Discography) of\b/i;
const eligible = !LIST_PREFIX.test(target.title)
  && target.articleBytes >= 1500
  && target.leadText.trim().length >= 80
  && start.allowedLinks.length >= 8
  && start.allowedLinks.length <= 200;
```

Use integer components, classifier version `editorial-v1`, stable seeded hashes, and aggregate rejection reasons. Pageviews are the latest 30 complete UTC days; their failure lowers confidence but does not invalidate editorial membership.

- [ ] **Step 5: Implement bounded evaluator orchestration**

Sample at most 10 targets and three independent random starts. Count every Wikimedia request centrally, abort at 40 or 25 seconds, batch metadata by title, and stop evaluating after the budget. For hard pairs, reject direct edges and query all sanitized first-hop titles in batches of at most 50 with `prop=links&pltitles=<target>` to detect two-click shortcuts.

- [ ] **Step 6: Preserve the candidate facade**

Make `dailyChallengeCandidates.ts` delegate to the evaluator while retaining diagnostic event names needed by Worker logs and tests. The facade must now receive `dailyDate` and `flavor`.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run the Task 3 command. Expected: all selected tests pass without network access.

- [ ] **Step 8: Commit Task 3**

```bash
git add src/server/editorialTargetPools.ts src/server/editorialTargetPools.test.ts src/server/dailyCandidateScoring.ts src/server/dailyCandidateScoring.test.ts src/server/dailyCandidateEvaluator.ts src/server/dailyCandidateEvaluator.test.ts src/server/dailyChallengeCandidates.ts src/server/dailyChallengeCandidates.test.ts
git commit -m "feat: score editorial daily candidates"
```

---

### Task 4: Daily Features, Moderation Queue, And Atomic Scheduler Persistence

**Files:**
- Modify: `src/server/trackingRepository.ts`
- Modify: `src/server/d1TrackingRepository.ts`
- Modify: `src/server/dailyChallengeJobs.worker.test.ts`
- Modify: `src/server/d1TrackingRepository.worker.test.ts`

**Interfaces:**
- Produces: `listDailyAdminState()`, `approveDailyNomination()`, `declineDailyNomination()`, `queueDailyChallenge()`, `removeDailyQueueEntry()`.
- Produces: `findQueuedDailyCandidate(flavor)` and atomic `acceptDailyFeature(job, selection)`.

- [ ] **Step 1: Write failing repository and scheduler-state tests**

Cover FIFO by flavor, invalid queue entries, one feature per date/challenge, old challenge promotion, auto pair reuse, queue removal, and concurrent acceptance:

```ts
const queued = await repository.findQueuedDailyCandidate("weird");
expect(queued?.challenge.id).toBe(oldestWeirdChallenge.id);
const featured = await repository.acceptDailyFeature(job, {
  kind: "queued",
  queueEntryId: queued!.id,
  classifierVersion: "editorial-v1",
});
expect(featured.id).toBe(oldestWeirdChallenge.id);
expect(await featureCountFor(featured.id)).toBe(1);
```

- [ ] **Step 2: Run Worker tests and verify RED**

```bash
npm run test:worker -- src/server/dailyChallengeJobs.worker.test.ts src/server/d1TrackingRepository.worker.test.ts
```

Expected: repository methods do not exist.

- [ ] **Step 3: Implement moderation state transitions**

Use idempotent guarded D1 batches. Approval changes a pending nomination to approved and creates one queued entry. Decline never queues. Direct admin promotion creates an admin queue entry. Removal changes only a currently queued entry. Previously featured challenges are rejected before and by database constraints.

- [ ] **Step 4: Implement queue-first Daily acceptance**

For queued selections, atomically insert `daily_features`, mark the queue entry consumed, and accept the leased job without allocating a challenge number. For automatic selections, reuse an existing never-featured ordered pair or allocate/create the next challenge, then insert the feature and accept the job in one guarded batch.

- [ ] **Step 5: Update catalog mapping**

Join `daily_features` in `listChallenges()` and serialize:

```ts
dailyFeature: featureDate ? {
  dailyDate: featureDate,
  flavor: featureFlavor,
  selectionSource: featureSource,
} : null
```

Keep compatibility `origin`, `dailyDate`, and `source` fields for old clients.

- [ ] **Step 6: Run Worker tests and verify GREEN**

Run Task 4 command. Expected: selected suites pass.

- [ ] **Step 7: Commit Task 4**

```bash
git add src/server/trackingRepository.ts src/server/d1TrackingRepository.ts src/server/dailyChallengeJobs.worker.test.ts src/server/d1TrackingRepository.worker.test.ts
git commit -m "feat: add moderated daily queue"
```

---

### Task 5: Worker Capabilities, Admin Routes, And Queue-First Cron

**Files:**
- Modify: `src/server/worker.ts`
- Modify: `src/server/contracts.ts`
- Modify: `src/server/apiHandlers.ts`
- Modify: `src/server/apiHandlers.test.ts`
- Modify: `src/server/dailyChallengeJobs.worker.test.ts`
- Modify: `wrangler.toml`

**Interfaces:**
- Consumes: Task 3 evaluator and Task 4 repository operations.
- Produces the exact v2 routes from the design spec.

- [ ] **Step 1: Write failing authorization and route tests**

Test immutable account-ID authorization, name impersonation rejection, generic 403 responses, idempotency requirements, capability responses, route parsing, and queue-first cron behavior. A queued candidate must result in zero editorial-source calls.

- [ ] **Step 2: Run focused server tests and verify RED**

```bash
npm test -- src/server/apiHandlers.test.ts
npm run test:worker -- src/server/dailyChallengeJobs.worker.test.ts
```

Expected: admin and capability routes are absent.

- [ ] **Step 3: Add configured admin authorization**

Parse `DAILY_ADMIN_ACCOUNT_IDS` as a comma-separated set of trimmed, non-empty IDs. Authorize only claimed accounts whose canonical account ID is present. Never compare display names or aliases. Add the production administrator ID through Wrangler configuration without treating it as a secret.

- [ ] **Step 4: Implement capability and admin routes**

Add:

```text
GET    /api/v2/accounts/me/capabilities
GET    /api/v2/admin/dailies
POST   /api/v2/admin/daily-nominations/:id/approve
POST   /api/v2/admin/daily-nominations/:id/decline
POST   /api/v2/admin/daily-queue
DELETE /api/v2/admin/daily-queue/:id
```

Require authorization and `Idempotency-Key` for every mutation. Reuse the existing JSON/error/CORS patterns.

- [ ] **Step 5: Update scheduled execution**

Derive flavor from the claimed Central date, attempt queue consumption first, and instantiate the editorial evaluator only when no queued candidate succeeds. Keep the current future-trigger guard, lease/retry behavior, and structured logs. Add flavor, queue hit/miss, candidate count, request count, score, and elapsed time fields.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run Task 5 commands. Expected: selected suites pass.

- [ ] **Step 7: Commit Task 5**

```bash
git add src/server/worker.ts src/server/contracts.ts src/server/apiHandlers.ts src/server/apiHandlers.test.ts src/server/dailyChallengeJobs.worker.test.ts wrangler.toml
git commit -m "feat: expose daily moderation API"
```

---

### Task 6: Client Contracts And Creation-Time Nomination UX

**Files:**
- Modify: `src/services/vwikiRaceApiClient.ts`
- Modify: `src/services/vwikiRaceApiClient.test.ts`
- Modify: `src/App.tsx`
- Modify: `src/App.test.tsx`
- Modify: `src/domain/challengeSelection.ts`
- Modify: `src/domain/challengeSelection.test.ts`
- Modify: `src/styles.css`

**Interfaces:**
- Produces: expanded `createChallenge()` result and `getCapabilities()`/admin client methods.
- Consumes: `Challenge.dailyFeature` and creation dispositions.

- [ ] **Step 1: Write failing client and App tests**

Cover validators, feature metadata, checkbox visibility, auth-intent preservation, guest behavior, duplicate selection, and all nomination notices:

```tsx
expect(screen.getByRole("checkbox", { name: /nominate for a future daily/i })).toBeVisible();
await user.click(screen.getByRole("button", { name: /create challenge/i }));
expect(await screen.findByText(/already exists as challenge #12/i)).toBeVisible();
expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
  nominateForDaily: true,
}), token);
```

- [ ] **Step 2: Run focused client tests and verify RED**

```bash
npm test -- src/services/vwikiRaceApiClient.test.ts src/domain/challengeSelection.test.ts src/App.test.tsx
```

Expected: old client contract and UI lack nomination/feature support.

- [ ] **Step 3: Extend strict response validators and API methods**

Validate the expanded creation outcome, `dailyFeature`, capabilities, nominations, and queue responses. Keep unknown/invalid server payloads rejected. Invalidate the challenge catalog after create or admin mutations.

- [ ] **Step 4: Preserve nomination intent through auth gating**

Extend the create intent and form input with `nominateForDaily`. Show the checkbox only for a claimed session. A ghost who attempts to nominate must be guided to claim/login; ordinary ghost challenge creation remains available when nomination is false.

- [ ] **Step 5: Handle duplicate and nomination outcomes**

Always merge/select the returned challenge. Show concise notices for `existing`, `pending`, `already_exists`, `previously_featured`, and `account_required`. Do not report duplicate creation as an error.

- [ ] **Step 6: Switch Daily labels to authoritative features**

Update `dailyBadgeLabel` and default Daily selection to use `challenge.dailyFeature`, with legacy fields only as a compatibility fallback.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run Task 6 command. Expected: selected suites pass.

- [ ] **Step 8: Commit Task 6**

```bash
git add src/services/vwikiRaceApiClient.ts src/services/vwikiRaceApiClient.test.ts src/App.tsx src/App.test.tsx src/domain/challengeSelection.ts src/domain/challengeSelection.test.ts src/styles.css
git commit -m "feat: add creation-time daily nominations"
```

---

### Task 7: Protected In-App Daily Admin Surface

**Files:**
- Create: `src/components/AdminDailies.tsx`
- Create: `src/components/AdminDailies.test.tsx`
- Create: `public/_redirects`
- Modify: `src/App.tsx`
- Modify: `src/App.test.tsx`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: Task 6 API client admin methods and capabilities.
- Produces: `/admin/dailies` client route inside the existing Pages deployment.

- [ ] **Step 1: Write failing admin component and routing tests**

Test non-admin absence, admin navigation, loading/error/empty states, score display, suggested flavor, segmented override, approve, decline, removal, direct promotion, and narrow mobile layout.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
npm test -- src/components/AdminDailies.test.tsx src/App.test.tsx
```

Expected: component and route do not exist.

- [ ] **Step 3: Build the focused admin component**

Use an unframed operational layout with three compact views: pending nominations, approved queues grouped by flavor, and direct promotion. Reuse existing typography/colors, keep card radius at or below 8px, use segmented flavor controls, and avoid nesting cards.

- [ ] **Step 4: Add protected route composition**

Load capabilities only for an authenticated session. Show an Admin navigation command only when `canManageDailies` is true. Direct visits by non-admin users render the ordinary game with a generic authorization notice rather than exposing moderation data.

- [ ] **Step 5: Add Pages SPA fallback**

Create:

```text
/* /index.html 200
```

Verify it does not intercept `/api/*` Pages compatibility functions.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run Task 7 command. Expected: selected suites pass.

- [ ] **Step 7: Commit Task 7**

```bash
git add src/components/AdminDailies.tsx src/components/AdminDailies.test.tsx public/_redirects src/App.tsx src/App.test.tsx src/styles.css
git commit -m "feat: add daily moderation screen"
```

---

### Task 8: Documentation, Review, Full Verification, And Release

**Files:**
- Modify: `README.md`
- Modify: `docs/backlog.md`
- Modify: `docs/handoff/2026-07-16-friend-release-handoff.md`
- Modify: `docs/handoff/cloudflare-deployment-handoff.md`

**Interfaces:**
- Produces: current operational truth and a released Worker/Pages pair.

- [ ] **Step 1: Update authoritative documentation**

Document the editorial schedule, queue precedence, deduplication, nominations, admin config/routes, migration 0005, request limits, failure behavior, and deferred exact graph. Add the screen reimagining as the next explicit product-design task.

- [ ] **Step 2: Run static review checks**

```bash
git diff --check
rg -n "TBD|TODO|FIXME" src d1 docs README.md
npm audit --omit=dev
```

Expected: no whitespace errors, no new placeholders, zero production dependency vulnerabilities.

- [ ] **Step 3: Run full local gates**

```bash
npm test
npm run test:worker
npm run build
```

Expected: all tests and the production build pass.

- [ ] **Step 4: Request independent code and product review**

Review for D1 concurrency/sequence gaps, authorization, request-budget escape paths, migration data loss, duplicate Dailies, nomination abuse, mobile overflow, and confusing duplicate-create feedback. Fix every P0/P1 and material P2, then rerun affected suites and full gates.

- [ ] **Step 5: Commit final integration fixes and docs**

```bash
git add README.md docs src d1 public wrangler.toml
git commit -m "docs: hand off editorial daily operations"
```

- [ ] **Step 6: Audit production D1 before mutation**

Use Wrangler read-only queries to verify applied migrations, duplicate ordered pairs,
duplicate legacy Daily dates, legacy challenges featured on multiple dates, null page
IDs among legacy Dailies, current run counts, and nomination/feature table absence.
Do not apply migration 0005 unless every uniqueness query returns zero rows. Never
print tokens or secrets.

- [ ] **Step 7: Apply migration 0005 and deploy Worker first**

Apply only the new migration, deploy the Worker, confirm bindings/triggers, and smoke-test catalog, capabilities, generic admin rejection, preserved leaderboards, CORS, and cache headers. Do not create synthetic production challenges or runs.

- [ ] **Step 8: Push main and deploy Pages**

Push the reviewed commits, deploy Pages if Git does not auto-deploy, and confirm canonical assets correspond to the pushed HEAD.

- [ ] **Step 9: Run production browser smoke**

Verify desktop and mobile challenge creation, claimed nomination checkbox, duplicate-selection feedback using non-mutating mocks where production mutation would pollute data, Daily badges/flavor, protected admin navigation, and unchanged gameplay/leaderboard behavior.

- [ ] **Step 10: Record release evidence**

Report commit SHA, Worker version, Pages deployment ID, migration ledger, test counts, production smoke results, D1 row-count audit, and any explicitly deferred items.
