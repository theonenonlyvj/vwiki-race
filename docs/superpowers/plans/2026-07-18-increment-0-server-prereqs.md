# UX Redesign Increment 0: Server Prerequisites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the council-ratified server-side correctness and safety work (no UI change): board-exclusion containment flag, placement dedup query, and rate-limit hardening — the prerequisites every later redesign increment builds on.

**Architecture:** All work lands in the canonical Worker (`src/server/worker.ts`) and D1 repository (`src/server/d1TrackingRepository.ts`), plus one additive migration (`0006`). The existing `listLeaderboard` CTE chain (resolved → attempted → eligible → ranked) is the single source of eligibility truth; the exclusion flag filters inside it, and the new placements query builds on the same chain so the two can never disagree.

**Tech Stack:** Cloudflare Workers + D1, vitest (`npm test` jsdom; `npm run test:worker` = `*.worker.test.ts` via vitest-pool-workers with `applyD1Migrations`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-18-ux-redesign-modes-design.md` (council-amended). This plan implements its "Increment 0" only.
- Migrations are immutable history: new file `0006_board_exclusions.sql`, additive only (`ALTER TABLE ... ADD COLUMN`), no trigger syntax (0005's compound triggers broke wrangler's migration parser — do not repeat).
- Placement definition (spec invariant 2): a player's placement for a challenge = best (lowest) rank among their eligible completed runs — one row per canonical account.
- Exclusion scope: `board_excluded = 1` removes a run from leaderboards and placements. Account stats are NOT affected.
- Admin surface follows the existing dailies pattern exactly: VGames auth → `canManageDailies` allowlist (`DAILY_ADMIN_ACCOUNT_IDS`) → `DAILY_ADMIN_RATE_LIMITER`.
- Cloudflare rate-limit bindings support only 10s/60s periods. Hourly quotas are D1-side and land with their endpoint (Increment 5); this increment ships binding config + burst helpers only where the consumer exists.
- Never touch `/Users/vijayram/Cursor/vwiki-race` main checkout conventions: work in the assigned worktree, TDD, frequent commits, both suites green before every commit.
- Commit messages end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Migration 0006 + exclusion filter in `listLeaderboard`

**Files:**
- Create: `d1/migrations/0006_board_exclusions.sql`
- Modify: `src/server/d1TrackingRepository.ts` (the `listLeaderboard` CTE, ~line 2232)
- Test: `src/server/d1TrackingRepository.worker.test.ts` (new describe block)

**Interfaces:**
- Consumes: existing `listLeaderboard(challengeId)` repository method.
- Produces: `runs.board_excluded` column (0/1, default 0); `listLeaderboard` silently omits excluded runs. Task 2 consumes the column; Task 3's placements query must apply the same filter.

- [ ] **Step 1: Write the migration**

```sql
-- d1/migrations/0006_board_exclusions.sql
-- Additive only. Manual moderation flag: a run with board_excluded = 1 is
-- omitted from leaderboards and placement math (containment for forged or
-- broken runs). Account stats intentionally still include it.
alter table runs add column board_excluded integer not null default 0
  check (board_excluded in (0, 1));

create index if not exists runs_board_excluded_idx
  on runs (challenge_id, board_excluded);
```

- [ ] **Step 2: Write the failing worker test**

Add to `src/server/d1TrackingRepository.worker.test.ts` (follow the file's existing helpers for creating a challenge + completed runs; reuse its `recordTwoNonTerminalClicks`-style fixtures):

```ts
describe("board exclusion (migration 0006)", () => {
  it("omits excluded runs from listLeaderboard", async () => {
    // fixture: two accounts complete the same challenge
    // (use the file's existing start/click/complete helpers)
    // then: UPDATE runs SET board_excluded = 1 WHERE id = <fasterRunId>
    const before = await repository.listLeaderboard(challengeId);
    expect(before.map((r) => r.id)).toContain(fasterRunId);

    await env.VWIKI_RACE_DB.prepare(
      "UPDATE runs SET board_excluded = 1 WHERE id = ?",
    ).bind(fasterRunId).run();

    const after = await repository.listLeaderboard(challengeId);
    expect(after.map((r) => r.id)).not.toContain(fasterRunId);
    // remaining rows re-rank from 1 with no gap
    expect(after[0]?.rank).toBe(1);
  });

  it("defaults to included (board_excluded = 0) for new runs", async () => {
    const row = await env.VWIKI_RACE_DB.prepare(
      "SELECT board_excluded FROM runs WHERE id = ?",
    ).bind(anyRunId).first();
    expect(row?.board_excluded).toBe(0);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npm run test:worker -- -t "board exclusion"`
Expected: FAIL — `no such column: board_excluded` (migration list in the worker test setup picks up 0006 automatically via `applyD1Migrations`; if the setup enumerates files explicitly, add 0006 there first so the failure is the missing filter, not the missing column).

- [ ] **Step 4: Implement the filter**

In `listLeaderboard`'s `resolved` CTE WHERE clause (currently `WHERE r.challenge_id = ?`), change to:

```sql
WHERE r.challenge_id = ? AND r.board_excluded = 0
```

- [ ] **Step 5: Run tests to verify pass, then full suites**

Run: `npm run test:worker -- -t "board exclusion"` → PASS
Run: `npm run test:worker` and `npm test` → all green (existing leaderboard tests unaffected: default is 0).

- [ ] **Step 6: Commit**

```bash
git add d1/migrations/0006_board_exclusions.sql src/server/d1TrackingRepository.ts src/server/d1TrackingRepository.worker.test.ts
git commit -m "feat(server): board_excluded flag filters leaderboards (migration 0006)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Admin run-exclusion endpoint

**Files:**
- Modify: `src/server/worker.ts` (admin route block, near the `/api/v2/admin/daily-queue` routes ~line 364-390)
- Modify: `src/server/d1TrackingRepository.ts` (new repository method)
- Modify: `src/server/apiHandlers.ts` (handler wiring, following the dailies admin handlers' shape)
- Test: `src/server/clientErrorRoute.test.ts`-style plain server test OR extend the existing admin dailies test file — follow wherever `authorizeDailyAdministrator` is currently tested.

**Interfaces:**
- Consumes: `runs.board_excluded` (Task 1); `canManageDailies(account, env)`, `authorizeDailyAdministrator(...)`, `enforceDailyAdminRateLimit(env, accountId, route)` — all existing in worker.ts.
- Produces: `POST /api/v2/admin/runs/{runId}/exclusion` with JSON body `{ "excluded": true|false }` → 200 `{ runId, boardExcluded }`; 404 `run_not_found`; 401/403 per existing admin pattern. Repository: `setRunBoardExclusion(runId: string, excluded: boolean): Promise<{ runId: string; boardExcluded: boolean } | null>` (null = not found).

- [ ] **Step 1: Write the failing repository test** (worker test file)

```ts
describe("setRunBoardExclusion", () => {
  it("sets and clears the flag, returning the new state", async () => {
    const set = await repository.setRunBoardExclusion(runId, true);
    expect(set).toEqual({ runId, boardExcluded: true });
    const cleared = await repository.setRunBoardExclusion(runId, false);
    expect(cleared).toEqual({ runId, boardExcluded: false });
  });
  it("returns null for an unknown run", async () => {
    expect(await repository.setRunBoardExclusion("run-nope", true)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npm run test:worker -- -t "setRunBoardExclusion"` → FAIL (method missing).

- [ ] **Step 3: Implement repository method** (in `d1TrackingRepository.ts`, beside the other admin/daily methods):

```ts
async setRunBoardExclusion(runId, excluded) {
  const result = await db
    .prepare(
      `UPDATE runs SET board_excluded = ?
       WHERE id = ?
       RETURNING id`,
    )
    .bind(excluded ? 1 : 0, runId)
    .first();
  if (!result) return null;
  return { runId, boardExcluded: excluded };
},
```

(If the repository's house style routes writes through handler objects/batches, match it — but this is a single-row idempotent UPDATE; a direct prepared statement matches how similar single-row admin mutations are written.)

- [ ] **Step 4: Wire the route in worker.ts** beside the other admin routes:

```ts
const runExclusionMatch = url.pathname.match(
  /^\/api\/v2\/admin\/runs\/([^/]+)\/exclusion$/,
);
if (request.method === "POST" && runExclusionMatch) {
  const admin = await authorizeDailyAdministrator(request, tracking, env);
  await enforceDailyAdminRateLimit(env, admin.accountId, "run-exclusion");
  const body = await readJson(request);
  if (typeof body?.excluded !== "boolean") {
    throw new ApiError("invalid_excluded", "Request field is invalid.", 400);
  }
  const outcome = await tracking.handlers.setRunBoardExclusion(
    decodeURIComponent(runExclusionMatch[1]),
    body.excluded,
  );
  if (!outcome) {
    throw new ApiError("run_not_found", "Run not found.", 404);
  }
  console.info("run_board_exclusion", JSON.stringify({
    runId: outcome.runId, boardExcluded: outcome.boardExcluded,
    actor: admin.accountId,
  }));
  return json(outcome, 200, corsHeaders);
}
```

(Adapt helper names — `readJson`/`json`/`ApiError` signatures — to the file's actuals; the admin dailies routes a few lines above are the template. Add `setRunBoardExclusion` passthrough to the handlers object in `apiHandlers.ts` exactly like the dailies admin handlers.)

- [ ] **Step 5: Route test** — add a test following the existing admin-route tests (non-admin account → 403; admin + unknown run → 404; admin + valid run → 200 and the flag actually flips; audit log line emitted). Run the relevant suite → PASS. Then both full suites → green.

- [ ] **Step 6: Commit**

```bash
git add src/server/worker.ts src/server/apiHandlers.ts src/server/d1TrackingRepository.ts <test files>
git commit -m "feat(admin): run board-exclusion endpoint (containment for forged runs)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Placement dedup query (`listChallengePlacements`)

**Files:**
- Modify: `src/server/d1TrackingRepository.ts` (new method beside `listLeaderboard`)
- Modify: `src/server/trackingRepository.ts` (interface, if it declares repository methods)
- Test: `src/server/d1TrackingRepository.worker.test.ts`

**Interfaces:**
- Consumes: same eligibility rules as `listLeaderboard` (Task 1's exclusion filter included).
- Produces: `listChallengePlacements(challengeId: string): Promise<Array<{ accountId: string; displayName: string | null; placement: number; elapsedMs: number; clickCount: number; completedAt: string }>>` — **one row per canonical account** (their best completed run: elapsed_ms → click_count → completed_at), re-ranked 1..N with no gaps. Completed runs only (no DNFs). This is the foundation Increments 3/4 consume for Boards and rolling averages.

- [ ] **Step 1: Write the failing worker test**

```ts
describe("listChallengePlacements", () => {
  it("collapses repeat attempts to one best row per account", async () => {
    // fixture: account A completes twice (worse then better),
    // account B completes once, account C abandons (DNF)
    const placements = await repository.listChallengePlacements(challengeId);
    expect(placements).toHaveLength(2);                    // C's DNF absent
    expect(placements[0].accountId).toBe(accountWithBestTime);
    expect(placements[0].placement).toBe(1);
    expect(placements[1].placement).toBe(2);               // no gaps
    const a = placements.find((p) => p.accountId === accountA);
    expect(a?.elapsedMs).toBe(accountABestElapsedMs);      // best, not latest
  });

  it("respects board exclusion", async () => {
    await env.VWIKI_RACE_DB.prepare(
      "UPDATE runs SET board_excluded = 1 WHERE id = ?",
    ).bind(accountABestRunId).run();
    const placements = await repository.listChallengePlacements(challengeId);
    const a = placements.find((p) => p.accountId === accountA);
    // A's best is excluded → A's placement falls back to their other run
    expect(a?.elapsedMs).toBe(accountASecondBestElapsedMs);
  });

  it("resolves canonical accounts through account_aliases", async () => {
    // fixture: alias row mapping ghost → canonical; runs under both ids
    const placements = await repository.listChallengePlacements(challengeId);
    const ids = placements.map((p) => p.accountId);
    expect(new Set(ids).size).toBe(ids.length);            // one row per canonical id
  });
});
```

- [ ] **Step 2: Run to verify failure** — method missing.

- [ ] **Step 3: Implement** (same CTE skeleton as `listLeaderboard`, completions only, best-per-account then re-rank):

```ts
async listChallengePlacements(challengeId) {
  const { results } = await db
    .prepare(
      `WITH resolved AS (
         SELECT r.id,
                coalesce(a.canonical_account_id, r.canonical_account_id, r.account_id) account_id,
                r.elapsed_ms, r.click_count, r.completed_at
         FROM runs r
         LEFT JOIN account_aliases a
           ON a.alias_account_id = coalesce(r.canonical_account_id, r.account_id)
         WHERE r.challenge_id = ?
           AND r.board_excluded = 0
           AND r.status = 'completed'
           AND r.elapsed_ms IS NOT NULL
           AND r.completed_at IS NOT NULL
           AND ((r.protocol_version = 2 AND r.ranked_eligible = 1)
                OR r.protocol_version = 1)
       ), best AS (
         SELECT *, row_number() OVER (
           PARTITION BY account_id
           ORDER BY elapsed_ms ASC, click_count ASC, completed_at ASC, id
         ) attempt_rank
         FROM resolved
       )
       SELECT best.account_id, best.elapsed_ms, best.click_count,
              best.completed_at,
              row_number() OVER (
                ORDER BY best.elapsed_ms ASC, best.click_count ASC,
                         best.completed_at ASC, best.id
              ) placement,
              p.public_name AS display_name
       FROM best
       LEFT JOIN account_profiles p ON p.account_id = best.account_id
       WHERE best.attempt_rank = 1
       ORDER BY placement
       LIMIT 100`,
    )
    .bind(challengeId)
    .all();
  return (results ?? []).map((row) => ({
    accountId: String(row.account_id),
    displayName: row.display_name == null ? null : String(row.display_name),
    placement: Number(row.placement),
    elapsedMs: Number(row.elapsed_ms),
    clickCount: Number(row.click_count),
    completedAt: String(row.completed_at),
  }));
},
```

- [ ] **Step 4: Run tests → PASS; both full suites → green.**

- [ ] **Step 5: Commit**

```bash
git add src/server/d1TrackingRepository.ts src/server/trackingRepository.ts src/server/d1TrackingRepository.worker.test.ts
git commit -m "feat(server): listChallengePlacements — best-rank-per-account dedup (spec invariant 2)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Rate-limit hardening (identity + run-start) and reserved tiers

**Files:**
- Modify: `wrangler.api.toml` (two new `[[ratelimits]]`)
- Modify: `src/server/worker.ts` (Env fields + two enforce helpers + call sites)
- Test: extend the worker/server tests that already cover rate-limit behavior (search for the existing `enforceClickRateLimit` tests as the template).

**Interfaces:**
- Consumes: existing `RateLimiter` interface, `ApiError`.
- Produces: `IDENTITY_RATE_LIMITER` (ns `51006`, `limit 10, period 60`, keyed per client IP) enforced on `POST /api/v2/identity/guest|secure|login`; `RUN_START_RATE_LIMITER` (ns `51007`, `limit 6, period 60`, keyed per account) enforced on `POST /api/v2/runs/start`. Both OPTIONAL in Env (absent binding → skip, like `CLIENT_ERROR_RATE_LIMITER`) so tests/local dev don't break. NOTE for future increments: the on-demand random-challenge endpoint (Increment 5) gets its own tier + D1 hourly quota at build time — deliberately NOT configured here (council note; YAGNI until the endpoint exists).

- [ ] **Step 1: wrangler.api.toml additions**

```toml
[[ratelimits]]
name = "IDENTITY_RATE_LIMITER"
namespace_id = "51006"
simple = { limit = 10, period = 60 }

[[ratelimits]]
name = "RUN_START_RATE_LIMITER"
namespace_id = "51007"
simple = { limit = 6, period = 60 }
```

(Verify 51006/51007 are unused: current file tops out at 51005.)

- [ ] **Step 2: Failing tests** — identity route returns 429 with `Retry-After` when the fake limiter reports `success:false`; guest/secure/login all enforce; runs/start enforces per account; ABSENT binding skips enforcement (no 503 — mirror `CLIENT_ERROR_RATE_LIMITER`'s fail-open-when-missing behavior, NOT the dailies fail-closed one, because these are new belts on existing critical paths and a missing binding must not lock out logins).

- [ ] **Step 3: Implement helpers in worker.ts** (mirror `enforceClientErrorRateLimit`'s shape):

```ts
async function enforceIdentityRateLimit(env: Env, request: Request): Promise<void> {
  if (!env.IDENTITY_RATE_LIMITER) return;
  const key = request.headers.get("CF-Connecting-IP") ?? "unknown-client";
  const result = await env.IDENTITY_RATE_LIMITER.limit({ key });
  if (!result.success) {
    throw new ApiError(
      "identity_rate_limited",
      "Too many identity requests. Try again shortly.",
      429,
      60,
    );
  }
}

async function enforceRunStartRateLimit(env: Env, accountId: string): Promise<void> {
  if (!env.RUN_START_RATE_LIMITER) return;
  const result = await env.RUN_START_RATE_LIMITER.limit({ key: accountId });
  if (!result.success) {
    throw new ApiError(
      "run_start_rate_limited",
      "Too many new runs. Try again shortly.",
      429,
      60,
    );
  }
}
```

Env additions: `IDENTITY_RATE_LIMITER?: RateLimiter; RUN_START_RATE_LIMITER?: RateLimiter;`
Call sites: top of the three `/api/v2/identity/*` handlers (before proxying to VGames) and in the `/api/v2/runs/start` handler after authorization (so the key is the canonical account id).

- [ ] **Step 4: Tests pass; both suites green; `npx wrangler deploy --dry-run --config wrangler.api.toml` shows both new bindings.**

- [ ] **Step 5: Commit**

```bash
git add wrangler.api.toml src/server/worker.ts <test files>
git commit -m "feat(server): rate-limit identity and run-start endpoints

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Release (after all tasks reviewed)

Per `docs/handoff/START_HERE.md` ship-it definition — this increment has a migration, so the full sequence applies:

1. Both suites + `npm run build` + `npm audit --omit=dev` + dry-run deploy: green.
2. Inspect remote migration ledger (`0006` must be pending, nothing else): `npx wrangler d1 migrations list vwiki-race --remote --config wrangler.api.toml`.
3. Private D1 backup (ignored path, checksum recorded — follow `docs/handoff/cloudflare-deployment-handoff.md` §backup exactly; never print/commit the export).
4. Apply migration 0006 remote; verify `PRAGMA table_info(runs)` shows `board_excluded` and spot-check `SELECT count(*) FROM runs WHERE board_excluded != 0` → 0.
5. Deploy Worker; smoke: `GET /api/v2/challenges` 200; leaderboard for challenge-0003 unchanged rows; admin exclusion route 403 for non-admin.
6. Push `main`. (No Pages deploy — zero client change.)
7. Record release evidence in the dated handoff doc per house convention.
