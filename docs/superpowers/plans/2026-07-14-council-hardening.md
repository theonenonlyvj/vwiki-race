# VWiki Race Council Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing challenge race reliable, fast-feeling, server-tracked from the first run, and safe to deploy without breaking the currently served client.

**Architecture:** VGames remains the identity authority and adds canonical display-name and alias receipts to introspection. VWiki Race exposes a strict `/api/v2` Worker protocol backed by atomic D1 transitions while retaining protocol-1 adapters for the old asset. The React client preloads articles, records active decision time, commits navigation only after an idempotent click is accepted, and reads bounded challenge, leaderboard, path, and account-stat projections.

**Tech Stack:** React 19, TypeScript 5.7, Vite 6, Vitest, Cloudflare Workers, Cloudflare D1, Cloudflare Pages compatibility Functions, English Wikipedia REST/Action APIs.

## Global Constraints

- Treat both repositories as public; do not copy secrets or private project data into them.
- Do not commit, push, deploy, migrate remote D1, or publish during implementation; those remain later explicit actions.
- New VWiki Race clients call only `/api/v2` through one required `VITE_VWIKI_RACE_API_URL`; production must fail closed when the URL is absent or not HTTPS.
- Protocol-1 routes accept only protocol-1 runs and remain unranked; protocol-2 routes accept only protocol-2 runs.
- The published score is active decision time, then clicks, completion time, and run ID; server wall elapsed remains audit data.
- A run completes only from an accepted target-page click with at least one click; no v2 complete endpoint may mutate a run.
- One nonexpired active run is allowed per canonical account; a different start returns `409 active_run_exists` until explicit End Run or expiry.
- V0 is friends-first: the server enforces ownership, sequence, continuity, canonical target IDs, idempotency, and bounded client timing but does not re-fetch every clicked edge.
- All D1 writes distinguish SQL failure from a successful zero-row conditional statement; no design may claim zero rows cause rollback.
- Preserve Wikipedia attribution and recognizable article content; exclude See also, references, categories, site chrome, and non-main namespaces from moves.
- Browser QA must cover 1440x900, 1024x768, 390x844, 320x568, and 844x390 with no horizontal page overflow.

---

### Task 1: Extend VGames Introspection With Canonical Identity Receipts

**Repository:** `/Users/vijayram/Cursor/viota`

**Files:**
- Modify: `packages/worker/src/identity/canonical.ts`
- Modify: `packages/worker/src/identity/routes.ts`
- Modify: `packages/worker/test/identity-introspect.test.ts`

**Interfaces:**
- Consumes: existing `canonical(db, accountId)` merge resolution and the `accounts(id, display_name, status, merged_into)` table.
- Produces: successful `POST /auth/introspect` response `{ valid: true, accountId, status, displayName, aliases }` where aliases are sorted, unique, and exclude the canonical ID.

- [ ] **Step 1: Create a local implementation branch and write failing identity tests**

From `/Users/vijayram/Cursor/viota`, create `codex/vwiki-race-identity` without changing `main`. Extend the existing introspection suite with a ghost case and a merged-chain case:

```ts
it('returns the canonical display name and durable sorted aliases', async () => {
  await insertAccount('head', 'theonenonlyvj', 'claimed', null, 4)
  await insertAccount('old-b', 'Old B', 'merged', 'head', 2)
  await insertAccount('old-a', 'Old A', 'merged', 'old-b', 1)
  const token = await signVGamesToken(
    { accountId: 'head', status: 'claimed', epoch: 4 },
    SECRET,
  )

  const body = await (await intro(token)).json()
  expect(body).toEqual({
    valid: true,
    accountId: 'head',
    status: 'claimed',
    displayName: 'theonenonlyvj',
    aliases: ['old-a', 'old-b'],
  })
})
```

Also update the existing good-token expectation to require `displayName: 'I'` and `aliases: []`.

- [ ] **Step 2: Run the focused test and verify red**

Run: `pnpm --filter @viota/worker test -- identity-introspect.test.ts`

Expected: FAIL because `displayName` and `aliases` are absent.

- [ ] **Step 3: Add one canonical identity-summary helper**

Add this exported contract in `canonical.ts` and implement it with bounded account reads plus a recursive alias query or an equivalent cycle-safe walk:

```ts
export interface CanonicalIdentitySummary {
  id: string
  status: 'ghost' | 'claimed'
  displayName: string
  aliases: string[]
}

export async function canonicalIdentitySummary(
  db: D1Database,
  accountId: string,
): Promise<CanonicalIdentitySummary | null>
```

The helper must resolve the canonical head, load its stored `display_name`, find every merged account whose chain reaches that head, deduplicate, exclude the head, and sort aliases lexicographically. A malformed cycle returns `null`, not a partial identity receipt.

- [ ] **Step 4: Return the additive fields from introspection**

Replace the final canonical-only response in `handleIntrospect` with the summary:

```ts
const identity = await canonicalIdentitySummary(env.DB, claims.accountId)
if (!identity) return json({ valid: false })
return json({
  valid: true,
  accountId: identity.id,
  status: identity.status,
  displayName: identity.displayName,
  aliases: identity.aliases,
})
```

Do not change invalid-response status or shape.

- [ ] **Step 5: Run identity and Worker tests**

Run:

```bash
pnpm --filter @viota/worker test -- identity-introspect.test.ts identity-canonical.test.ts identity-merge.test.ts
pnpm --filter @viota/worker test
```

Expected: both commands PASS. Leave the branch uncommitted.

---

### Task 2: Establish the Versioned API Boundary and Typed Clients

**Repository:** `/Users/vijayram/Cursor/vwiki-race`

**Files:**
- Create: `src/services/apiOrigin.ts`
- Create: `src/services/apiRequest.ts`
- Create: `src/services/apiRequest.test.ts`
- Modify: `src/services/vwikiRaceApiClient.ts`
- Modify: `src/services/vwikiRaceApiClient.test.ts`
- Modify: `src/services/vgamesIdentity.ts`
- Modify: `src/services/vgamesIdentity.test.ts`
- Modify: `src/server/vgamesIdentityClient.ts`
- Modify: `src/server/vgamesIdentityClient.test.ts`
- Modify: `src/server/worker.ts`
- Modify: `src/server/apiHandlers.test.ts`
- Modify: `vite.config.ts`
- Modify: `.env.example`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 1 introspection response.
- Produces: `ApiRequestError`, `requestJson`, `resolveApiOrigin`, a v2-only browser tracking/identity client, and route-matrix tests that distinguish `/api` from `/api/v2`.

- [ ] **Step 1: Write failing origin, response-shape, timeout, and retry tests**

Cover these exact cases in `apiRequest.test.ts` and the two client suites:

```ts
await expect(requestJson(fetchHtml, '/api/v2/challenges', { validate: isChallenges }))
  .rejects.toMatchObject({ code: 'invalid_response', status: 502 })

await expect(requestJson(fetch429, '/api/v2/challenges', { validate: isChallenges }))
  .rejects.toMatchObject({ code: 'rate_limited', status: 429, retryAfterMs: 2000 })

expect(resolveApiOrigin('https://vwikirace-api.example.workers.dev/'))
  .toBe('https://vwikirace-api.example.workers.dev')
expect(() => resolveApiOrigin('', { production: true })).toThrow('VITE_VWIKI_RACE_API_URL')
```

Add a regression proving two renders with the default client issue one catalog request rather than a fetch-identity loop.

- [ ] **Step 2: Run focused client tests and verify red**

Run: `npm test -- src/services/apiRequest.test.ts src/services/vwikiRaceApiClient.test.ts src/services/vgamesIdentity.test.ts`

Expected: FAIL because the shared request/origin modules and typed validation do not exist.

- [ ] **Step 3: Implement one bounded JSON request primitive**

Export:

```ts
export class ApiRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly retryAfterMs: number | null = null,
  ) { super(message) }
}

export async function requestJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  options: {
    method?: 'GET' | 'POST'
    body?: unknown
    token?: string
    timeoutMs: number
    retry: 'read-once' | 'idempotent-once' | 'never'
    idempotencyKey?: string
    validate(value: unknown): value is T
  },
): Promise<T>
```

Use `AbortController`, require JSON content type for successful responses, preserve API error code/message/status and bounded `Retry-After`, retry only the matrix in the design, and never swallow malformed success bodies as `{}`.

- [ ] **Step 4: Move both browser clients to the canonical v2 origin**

`resolveApiOrigin` removes trailing slashes and rejects a missing/non-HTTPS production URL. Build both clients from a module-stable default fetch and the same origin. Tracking routes become `/api/v2/...`; identity routes become `/api/v2/identity/...`. Each response has a structural validator. Catalog and leaderboard reads deduplicate identical in-flight requests by fully resolved URL.

- [ ] **Step 5: Parse the expanded VGames receipt server-side**

Change introspection to:

```ts
export type VGamesIntrospection =
  | {
      valid: true
      accountId: string
      status: 'ghost' | 'claimed'
      displayName: string
      aliases: string[]
    }
  | { valid: false }
```

Reject merged status or malformed aliases/display name as an invalid upstream response. Do not accept a browser-supplied creator or player name in v2 handlers.

- [ ] **Step 6: Add the route-version matrix before repository changes**

In the exported Worker tests, require 404 for unknown routes, CORS preflight for an allowed exact origin, and distinct dispatch for:

```text
GET  /api/v2/challenges
POST /api/v2/challenges
POST /api/v2/runs/start
GET  /api/v2/runs/active
POST /api/v2/runs/:id/click
POST /api/v2/runs/:id/abandon
GET  /api/v2/runs/:id/path
GET  /api/v2/challenges/:id/leaderboard
GET  /api/v2/accounts/me/stats
POST /api/v2/identity/guest|secure|login
```

Legacy `/api` route expectations stay present as compatibility tests.

- [ ] **Step 7: Add build-time origin verification**

Add `verify:bundle` to inspect `dist` for the configured Worker host, reject relative production `/api` tracking/identity calls, and reject `globalThis.fetch.bind(globalThis)` inside React render paths. Production `vite.config.ts` throws before build if the origin is absent or invalid; tests inject an explicit relative origin.

- [ ] **Step 8: Run focused tests and build**

Run:

```bash
npm test -- src/services/apiRequest.test.ts src/services/vwikiRaceApiClient.test.ts src/services/vgamesIdentity.test.ts src/server/vgamesIdentityClient.test.ts src/server/apiHandlers.test.ts
npm run build
```

Expected: PASS with a test-origin value; a production build without the variable fails with the documented message. Leave changes uncommitted.

---

### Task 3: Add the Compatibility Migration and Atomic D1 Run Protocol

**Repository:** `/Users/vijayram/Cursor/vwiki-race`

**Files:**
- Create: `d1/migrations/0003_hardening_protocol.sql`
- Create: `src/server/runProtocol.ts`
- Create: `src/server/runProtocol.test.ts`
- Modify: `src/server/contracts.ts`
- Modify: `src/server/trackingRepository.ts`
- Modify: `src/server/d1TrackingRepository.ts`
- Modify: `src/server/d1TrackingRepository.test.ts`
- Modify: `src/domain/types.ts`
- Modify: `package.json`
- Modify: `wrangler.api.toml`

**Interfaces:**
- Consumes: canonical account receipt `{ accountId, displayName, status, aliases }` and validated challenge page IDs.
- Produces: `startRunV2`, `recordClickV2`, `abandonRunV2`, legacy protocol methods, and immutable `RunTransition` plus recomputed `LeaderboardContext`.

- [ ] **Step 1: Write migration assertions and failing repository protocol tests**

Add tests for the exact migration result and these transitions:

```ts
expect(await repo.startRunV2(account, start)).toMatchObject({
  protocolVersion: 2,
  clickCount: 0,
  status: 'active',
})

await expect(repo.startRunV2(account, otherKey)).rejects.toMatchObject({
  code: 'active_run_exists',
})

const completed = await repo.recordClickV2(account, targetClick)
expect(completed.transition).toMatchObject({
  runStatus: 'completed', clickCount: 1, elapsedMs: 4200,
})
```

Cover same-key replay, different-fingerprint conflict, terminal-click replay, stale step, wrong source page ID, invalid decision time, expiry, 250-click limit, concurrent clicks, click/abandon race, SQL failure rollback, and successful zero-row CAS with no event/path/run mutation.

- [ ] **Step 2: Run repository tests and verify red**

Run: `npm test -- src/server/runProtocol.test.ts src/server/d1TrackingRepository.test.ts`

Expected: FAIL because migration-3 columns and v2 methods do not exist.

- [ ] **Step 3: Write the forward-only migration**

Add the columns, constraints, indexes, alias table, and operation-idempotency table exactly from the design. Use `protocol_version INTEGER NOT NULL DEFAULT 1`, set every migrated completion `ranked_eligible = 0`, abandon every migrated active run, and embed:

```sql
UPDATE challenges SET start_page_id=19331, target_page_id=38579,
  start_title='Moon', target_title='Gravity', validation_status='ready'
WHERE id='challenge-0001';
UPDATE challenges SET start_page_id=5478840, target_page_id=80740,
  start_title='Maraba coffee', target_title='Moon landing conspiracy theories', validation_status='ready'
WHERE id='challenge-0002';
UPDATE challenges SET start_page_id=77543, target_page_id=11015252,
  start_title='FedEx', target_title='Vladimir Lenin', validation_status='ready'
WHERE id='challenge-0003';
```

Disable every other challenge ID regardless of prior fields. Add verification SQL/comments expecting exactly three ready active challenges, no other active challenge, no legacy active run, and no ranked-eligible legacy completion.

- [ ] **Step 4: Define protocol types and deterministic fingerprints**

Create:

```ts
export interface AuthorizedAccount {
  accountId: string
  displayName: string
  status: 'ghost' | 'claimed'
  aliases: string[]
}

export interface RunTransition {
  runId: string
  clickCount: number
  runStatus: 'active' | 'completed'
  completedAt?: string
  elapsedMs?: number
}

export interface LeaderboardContext {
  isPersonalBest: boolean
  rank: number | null
}
```

Canonicalize fingerprints with fixed field order and SHA-256; never hash tokens or display names into request logs.

- [ ] **Step 5: Implement alias ingestion and active-run ownership**

Every authenticated mutation upserts the canonical profile, path-compresses aliases, and abandons alias-owned active runs before operating. Materialize `canonical_account_id` on new runs. The unique active index applies to canonical ID and active status. Stats and reads resolve historical owners through `account_aliases`.

- [ ] **Step 6: Implement idempotent create/start outcome rows**

For a new operation key, use one D1 `batch()` to insert `pending`, conditionally create the resource, and finalize `accepted` or deterministic `rejected`. Inspect `D1Result.meta.changes` and then read the operation row. A matching completed operation replays; a mismatched fingerprint returns 409. An actual statement failure leaves no operation/resource because D1 rolls the batch back.

- [ ] **Step 7: Implement click compare-and-swap**

Compute the canonical fingerprint and use `click:${runId}:${clientEventId}` as the operation key before active validation. For an unseen event, insert-or-ignore a pending `click` operation, insert the event only from a matching protocol-2 active run row and that still-pending matching operation, then insert path and update run through that event in one batch. Every downstream statement is conditional on that operation still being pending. Finalize it as accepted through the event or as a stable rejected conflict when the event insert changes zero rows. A concurrent duplicate whose operation insert changes zero rows performs no writes and reads the winning outcome. The update stores page continuity, accepted decision elapsed, wall elapsed, and auto-completes on target page ID.

- [ ] **Step 8: Implement idempotent explicit abandonment and protocol-1 compatibility**

V2 abandon performs replay-before-state-check and uses one batch to insert a pending operation, conditionally transition the run, record its event, and finalize the resulting terminal state or stable rejection. Its sole protocol-1 exception requires `recoveryProtocolVersion: 1` from the confirmed End Old Run flow and stores `legacy_recovery_abandoned`; no other v2 operation mutates protocol 1. Legacy repeated start for the same owned active protocol-1 challenge returns that run because retry and deliberate repeat are indistinguishable; any other cross-version active run returns `active_run_exists`. Legacy click is sequential title-based and unranked, legacy complete requires at least one click plus observed target title, and legacy abandon is keyless but conditional. Every legacy run predicate requires version 1; every v2 gameplay predicate requires version 2, while active-run uniqueness spans both.

- [ ] **Step 9: Run real local-D1 and unit tests**

Add the Cloudflare Vitest pool for real D1 behavior, expose `npm run test:worker`, and run:

```bash
npm test -- src/server/runProtocol.test.ts src/server/d1TrackingRepository.test.ts
npm run test:worker
```

Expected: PASS, including concurrency and `batch()` metadata assertions against local D1. Leave changes uncommitted.

---

### Task 4: Add Canonical Challenge, Leaderboard, Path, and Stats Projections

**Repository:** `/Users/vijayram/Cursor/vwiki-race`

**Files:**
- Modify: `src/server/apiHandlers.ts`
- Modify: `src/server/apiHandlers.test.ts`
- Modify: `src/server/worker.ts`
- Modify: `src/server/d1TrackingRepository.ts`
- Modify: `src/server/d1TrackingRepository.test.ts`
- Modify: `src/server/contracts.ts`
- Modify: `src/domain/serverLeaderboard.ts`
- Modify: `src/domain/serverLeaderboard.test.ts`
- Modify: `src/services/vwikiRaceApiClient.ts`
- Modify: `src/services/vwikiRaceApiClient.test.ts`

**Interfaces:**
- Consumes: Task 3 protocol repository and Task 2 typed request client.
- Produces: canonical challenge creation, top-100 best-per-account leaderboard, lazy public paths, completion context, and alias-aware account stats.

- [ ] **Step 1: Write failing query and route tests**

Require speed-first deterministic ordering, one visible best per canonical account, max 100 rows, no embedded path, lazy completed-run path access, and account stats:

```ts
expect(rows.map((row) => row.runId)).toEqual(['fastest', 'same-time-fewer-clicks'])
expect(rows).toHaveLength(100)
expect(rows[0]).not.toHaveProperty('pathPreview')

expect(stats).toMatchObject({
  totals: { attempts: 3, completed: 2, abandoned: 1, timedCompleted: 1 },
  topStarts: [{ title: 'Moon', count: 2 }],
})
```

Prove opening one path makes one path query and a leaderboard load makes none.

- [ ] **Step 2: Run focused tests and verify red**

Run: `npm test -- src/domain/serverLeaderboard.test.ts src/server/d1TrackingRepository.test.ts src/server/apiHandlers.test.ts src/services/vwikiRaceApiClient.test.ts`

Expected: FAIL on best-per-account, path N+1, stats, and v2 contracts.

- [ ] **Step 3: Make challenge creation canonical and atomic**

The handler accepts only start/target input plus an idempotency key. The Wikipedia validator returns canonical title/page ID/link count. Reject same-page pairs and starts with no allowed links. The repository stores both IDs, allocates the next `sort_order` inside the serialized D1 batch, and derives creator name/status only from `AuthorizedAccount`.

- [ ] **Step 4: Replace leaderboard reads with one bounded SQL query**

Use:

```sql
ROW_NUMBER() OVER (
  PARTITION BY canonical_account_id
  ORDER BY elapsed_ms, click_count, completed_at, id
)
```

Filter to completed ranked-eligible rows, keep row number 1, order by the same keys, and limit 100. Do not call `getRunPath` while mapping rows.

- [ ] **Step 5: Return immutable transition plus current completion context**

Completion response is:

```ts
{
  transition: RunTransition
  leaderboardContext?: { isPersonalBest: boolean; rank: number | null }
}
```

Replay stored transition fields exactly and recompute only leaderboard context. A non-personal-best attempt completes with `rank: null`.

- [ ] **Step 6: Implement bounded account stats SQL**

Aggregate all alias-resolved attempts. Return totals plus top five starts, targets, and visited pages ordered by count descending/title ascending. Count start pages and accepted destination path rows. Include clicks from all completed attempts, but calculate `timedCompleted`, best elapsed, and average elapsed from protocol-2 decision-time runs only because legacy wall time is incomparable. Do not materialize an unbounded run history in application memory.

- [ ] **Step 7: Wire v2 handlers, CORS, body limits, and cache policy**

V2 handlers authorize to the complete account receipt. Reject bodies above 16 KiB and enforce title/anchor/name limits. Catalog/leaderboard reads get short public cache headers; identity, stats, path, and mutations use `no-store`. CORS reflects only the exact production origin or configured allowed local/preview origins.

Use exact D1 finalized-operation counts for 20 challenge-create attempts/account/rolling hour and 120 starts/account/rolling hour. Configure the Worker `CLICK_RATE_LIMITER` binding with namespace `51001`, limit 180, period 60 seconds, keyed by canonical account ID. Return typed 429 responses with `Retry-After`. Add structured redacted request logs containing route, status, request ID, latency, and failure boundary but never bearer tokens, passwords, or article bodies.

- [ ] **Step 8: Run focused and Worker route tests**

Run:

```bash
npm test -- src/domain/serverLeaderboard.test.ts src/server/d1TrackingRepository.test.ts src/server/apiHandlers.test.ts src/services/vwikiRaceApiClient.test.ts
npm run test:worker
```

Expected: PASS with no leaderboard path query. Leave changes uncommitted.

---

### Task 5: Correct Wikipedia Parsing, Rendering, and Cache Scope

**Repository:** `/Users/vijayram/Cursor/vwiki-race`

**Files:**
- Modify: `src/services/wikipediaGateway.ts`
- Modify: `src/services/wikipediaGateway.test.ts`
- Modify: `src/server/wikipediaChallengeValidator.ts`
- Modify: `src/server/wikipediaChallengeValidator.test.ts`
- Modify: `src/domain/rules.ts`
- Modify: `src/domain/rules.test.ts`
- Modify: `src/domain/types.ts`

**Interfaces:**
- Consumes: strict Wikipedia link policy and canonical page-ID challenge contract.
- Produces: a run-scoped gateway with `getArticle`, `clear`, canonical revision metadata, nested-image preservation, and strict main-namespace move parsing.

- [ ] **Step 1: Write the parser and renderer regression tests**

Add a table covering `AC/DC`, encoded slash titles, fragments, queries, protocol-relative URLs, lookalike hosts, malformed escapes, every namespace family, red links, and unsupported language hosts. Add DOM fixtures proving a disallowed File anchor retains its nested `<img>`, substantive tables keep allowed links, See also/references/navboxes are removed, and attribution includes the source revision.

- [ ] **Step 2: Run focused tests and verify red**

Run: `npm test -- src/domain/rules.test.ts src/services/wikipediaGateway.test.ts src/server/wikipediaChallengeValidator.test.ts`

Expected: FAIL on slash titles, nested images, table links, and page-ID/link-count validation.

- [ ] **Step 3: Implement one strict URL/title parser**

Resolve with `new URL(candidate, 'https://en.wikipedia.org/wiki/')`; require HTTPS, exact `en.wikipedia.org`, `/wiki/`, and no query. Strip fragments, decode each segment once, join slash segments, replace underscores, and reject recognized non-main namespace prefixes case-insensitively. Both client sanitizer and server validator use this shared policy.

- [ ] **Step 4: Preserve article structure while removing forbidden moves**

When an anchor is disallowed, replace it with its child nodes rather than `textContent`. Retain article images, infoboxes, and substantive tables/lists. Remove See also, notes/references/bibliography, category/navbox/site chrome, edit controls, and external move behavior. Put wide article elements inside article-level overflow, not page-level overflow.

- [ ] **Step 5: Return canonical metadata and scope caching to one run**

Article results include `canonicalTitle`, `pageId`, `revisionId`, source URL, attribution URL, and sanitized HTML. Evict rejected promises. Expose `clear()` and call it when a run completes/abandons; do not preserve cross-run visited caches.

- [ ] **Step 6: Validate challenge nodes without graph crawling**

Action API validation resolves redirects, requires main namespace/page ID for both nodes, rejects identical IDs, and confirms the start render exposes at least one allowed outgoing move. Do not attempt arbitrary reachability proof.

- [ ] **Step 7: Run Wikipedia tests**

Run: `npm test -- src/domain/rules.test.ts src/services/wikipediaGateway.test.ts src/server/wikipediaChallengeValidator.test.ts`

Expected: PASS. Leave changes uncommitted.

---

### Task 6: Replace the Client Race Flow With an Authoritative State Machine

**Repository:** `/Users/vijayram/Cursor/vwiki-race`

**Files:**
- Create: `src/hooks/useRaceController.ts`
- Create: `src/hooks/useRaceController.test.tsx`
- Create: `src/hooks/useElapsedDecisionTime.ts`
- Create: `src/hooks/useElapsedDecisionTime.test.ts`
- Modify: `src/App.tsx`
- Modify: `src/App.test.tsx`
- Modify: `src/services/vwikiRaceApiClient.ts`

**Interfaces:**
- Consumes: v2 clients from Tasks 2/4 and run-scoped Wikipedia gateway from Task 5.
- Produces: a locked active-run controller with idle/preparing/active/syncing/completed/abandoning states and accessible identity/end-run dialogs.

- [ ] **Step 1: Write failing controller tests**

Cover preload-before-start, timer zero at reveal, immediate syncing feedback, one click in flight, no local article/path commit before acceptance, same-event retry, failure rollback/resume, target auto-completion, challenge lock, explicit End Run confirmation, active-run discovery/resume after reload, active-run 409 recovery, and no redundant leaderboard refresh after completion.

```ts
expect(controller.state.phase).toBe('syncing')
expect(controller.state.article.canonicalTitle).toBe('Moon')
resolveClick({ transition: { runStatus: 'active', clickCount: 1 } })
expect(controller.state.article.canonicalTitle).toBe('Orbit')
```

- [ ] **Step 2: Run focused controller tests and verify red**

Run: `npm test -- src/hooks/useRaceController.test.tsx src/hooks/useElapsedDecisionTime.test.ts src/App.test.tsx`

Expected: FAIL because the controller and elapsed-time hook do not exist.

- [ ] **Step 3: Implement active-decision timing**

The hook starts a monotonic segment only when an article is interactive, freezes cumulative time immediately on link activation, resumes after accepted non-target reveal or recoverable failure, and remains frozen on completion/abandonment. UI ticks may use `requestAnimationFrame` or a 100 ms interval but cleanup must stop every timer.

- [ ] **Step 4: Implement the race controller**

On authenticated startup, query `/runs/active`; offer Resume Run or End Run before exposing Start. Resume a protocol-2 run by loading the accepted last article and path, using accepted decision elapsed as the timer base, and starting a new segment only when interactive. A discovered protocol-1 run offers only confirmed End Old Run through the v2 abandonment recovery exception. For a new run, preload the start article, create the run, reveal at response, and lock the challenge. On click, generate one `clientEventId`, capture cumulative decision time, fetch the destination, send v2 click, and commit article/session/path only after acceptance. Retrying reuses the exact body/event ID. A terminal conflict restores the previous article and gives a boundary-specific message.

- [ ] **Step 5: Make completion and abandonment single transitions**

Remove new-client calls to `completeRun`. A completed click sets result metrics and leaderboard context directly. End Run opens a confirmation dialog; confirm sends idempotent abandon, clears run cache/state, and returns to the selected challenge. Browser close relies on 24-hour expiry and does not pretend a beacon succeeded.

- [ ] **Step 6: Stabilize catalog, URL, leaderboard, path, and stats state**

Implement loading/loaded/empty/error states. Selection writes `?challenge=` and responds to `popstate` only while no run is active. Key leaderboard responses by requested challenge to prevent stale overwrite. Load a row path only on disclosure and memoize it. Load account stats from `/accounts/me/stats`, not the selected leaderboard.

- [ ] **Step 7: Make identity prompting seamless and accessible**

Prompt only on Start/Create without a valid session. A claimed session proceeds immediately; a returning ghost defaults to Claim but can Continue as guest again. Use labeled `aria-pressed` mode buttons, focus the first relevant field, trap focus, support Escape when idle, show errors inside the dialog, and restore focus to the exact triggering control. A 401 clears stale session and retains the pending intent.

- [ ] **Step 8: Run controller and App tests**

Run:

```bash
npm test -- src/hooks/useRaceController.test.tsx src/hooks/useElapsedDecisionTime.test.ts src/App.test.tsx
npm test
```

Expected: PASS with no duplicate catalog request, no separate completion call, and no stale challenge overwrite. Leave changes uncommitted.

---

### Task 7: Finish Responsive UX, Documentation, and Deployment Verification

**Repository:** `/Users/vijayram/Cursor/vwiki-race`

**Files:**
- Modify: `src/styles.css`
- Modify: `src/App.tsx`
- Modify: `src/App.test.tsx`
- Modify: `docs/game-principles-and-rules.md`
- Modify: `docs/backlog.md`
- Modify: `docs/handoff/cloudflare-deployment-handoff.md`
- Modify: `README.md`
- Modify: `.env.production`
- Modify: `package.json`

**Interfaces:**
- Consumes: completed v2 flow from Task 6.
- Produces: unclipped desktop/mobile UI, corrected authoritative docs, bundle verification evidence, and a local full-stack QA target.

- [ ] **Step 1: Add semantic UI assertions before CSS changes**

Require active navigation to be unavailable, End Run to be named, completion summary to precede the article, rank to render only for a personal best, non-best copy to say `Not a personal best`, and all path/leaderboard disclosures to be keyboard-operable.

- [ ] **Step 2: Run App tests and verify red**

Run: `npm test -- src/App.test.tsx`

Expected: FAIL on the new active/completion semantics.

- [ ] **Step 3: Correct header, navigation, and article layout**

Expanded idle/result header keeps the VWiki Race brand and selected route. Active desktop header is sticky and compact. At `max-width: 640px`, use two fixed rows: brand/ellipsized target/End Run, then timer/clicks. Omit player/challenge number there. Let challenge titles wrap, keep tabs reachable without clipping, and constrain tables/pre/math to article-level horizontal scrolling.

- [ ] **Step 4: Add visible feedback and result placement**

Link activation must immediately show a syncing state without shifting layout. Announce article changes and completion through a live region. Put elapsed time, clicks, path, and rank-or-non-best result before the target article at every width.

- [ ] **Step 5: Reconcile rules and handoff documentation**

Update scoring to active decision time first, clicks second; correct allowed sections; document v1 compatibility, v2 routes, stats, alias ownership, migration verification, environment variables, and fixed rollout order. Keep speculative graph proof and public adversarial competition in backlog. Do not claim deployment occurred.

- [ ] **Step 6: Run all automated verification**

Run:

```bash
npm test
npm run test:worker
npm run build
npm run verify:bundle
```

Expected: every command PASS. Record exact test counts and bundle asset names for the final report.

- [ ] **Step 7: Start the local full-stack target and perform browser QA**

Run `npm run dev:worker` on an unused localhost port. In the in-app browser, capture idle, identity, active, syncing, completion, leaderboard-path, challenge-creation, and stats states at 1440x900, 1024x768, 390x844, 320x568, and 844x390. At each viewport verify:

```js
document.documentElement.scrollWidth <= document.documentElement.clientWidth
```

Also verify article pixels are nonblank, images load, table links work, See also is absent, the sticky mobile header remains visible, and no action overlaps text.

- [ ] **Step 8: Run a final whole-branch review**

Provide the complete uncommitted diff, design spec, test evidence, and browser screenshots to a fresh high-capability reviewer. Fix every Critical/Important finding with focused tests, re-run the complete verification commands, and leave both repositories uncommitted and undeployed for explicit user approval.
