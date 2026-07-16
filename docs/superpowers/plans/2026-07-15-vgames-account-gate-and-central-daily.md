# VGames Account Gate And Central Daily Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a clear VGames account gate and generate one next-numbered daily challenge at 5:00 AM Central Time.

**Architecture:** VGames owns atomic username reservation and public account naming in the Viota Worker. VWiki Race owns presentation and proxies identity calls through its Cloudflare service binding. Two UTC cron triggers feed a DST-aware `America/Chicago` gate before the existing daily-job repository is called.

**Tech Stack:** React 19, TypeScript, Vitest, Cloudflare Workers, D1, Wrangler, PBKDF2-backed VGames identity.

## Global Constraints

- VGames is the only username namespace.
- Existing ghost account IDs and stats survive account creation and login fold.
- Guest names may duplicate other ghosts but may not match a claimed username.
- No database migration is required.
- Daily numbering continues through `challenge_number_sequence`; dates never assign numbers.
- Shared VGames identity deploys before the VWiki consumer.

---

### Task 1: Authoritative VGames Name Semantics

**Files:**
- Modify: `/Users/vijayram/Cursor/viota/.worktrees/vgames-identity-names/packages/worker/src/d1/accounts.ts`
- Modify: `/Users/vijayram/Cursor/viota/.worktrees/vgames-identity-names/packages/worker/src/identity/routes.ts`
- Test: `/Users/vijayram/Cursor/viota/.worktrees/vgames-identity-names/packages/worker/test/accounts.test.ts`
- Test: `/Users/vijayram/Cursor/viota/.worktrees/vgames-identity-names/packages/worker/test/identity-set-credentials.test.ts`

**Interfaces:**
- Consumes: `POST /auth/quick`, `POST /auth/set-credentials`.
- Produces: atomic `username` + `display_name` update; `409 { error: "name_reserved" }` for a new conflicting guest.

- [ ] Add a failing `/auth/quick` test that creates claimed username `runner`, then mints a different credential with display name `Runner` and expects `409 name_reserved`.
- [ ] Add a failing test proving an existing ghost credential still re-authenticates after its display name becomes reserved.
- [ ] Add a failing set-credentials test asserting both `username` and `display_name` become the normalized username.
- [ ] Run `pnpm --filter @viota/worker test -- accounts.test.ts identity-set-credentials.test.ts` and confirm the new assertions fail.
- [ ] In `handleAuthQuick`, check `lower(username) = lower(?)` only on the new-account path and return `name_reserved` before insertion.
- [ ] In `handleSetCredentials`, update `display_name` in the same D1 statement as `username`, password hash, status, timestamp, and token epoch.
- [ ] Run the focused tests, then `pnpm --filter @viota/worker test`.
- [ ] Commit the Viota branch as `feat(identity): reserve VGames public names`.

### Task 2: VWiki Account Gate

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/App.test.tsx`
- Modify: `src/services/vgamesIdentity.ts`
- Modify: `src/services/vgamesIdentity.test.ts`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: existing VWiki identity proxy routes and VGames error codes.
- Produces: `AuthMode = "guest" | "create" | "login"`; one username/display-name value; matching password confirmation.

- [ ] Replace claim-oriented App tests with failing tests for default `Create New`, left-only Guest action, `Log In / Existing`, VGames copy, and username-as-display-name.
- [ ] Add failing tests that mismatched passwords make no identity request and display a local error.
- [ ] Add failing tests mapping `username_taken` and `name_reserved` to actionable copy.
- [ ] Update `AuthMode`, draft state, prompt defaults, labels, autocomplete attributes, length constraints, and submit validation.
- [ ] Remove the separate display-name field from Create New; pass the username as the display name when a fresh ghost must be minted before set-credentials.
- [ ] Keep Guest's nickname field and existing public-leaderboard disclosure.
- [ ] Update identity-client error handling without adding username availability preflight requests.
- [ ] Run `npm test -- src/App.test.tsx src/services/vgamesIdentity.test.ts` and `npm run build`.
- [ ] Commit as `feat: simplify VGames account gate`.

### Task 3: 5:00 AM Central Daily Gate

**Files:**
- Modify: `src/server/worker.ts`
- Modify: `src/server/dailyChallengeJobs.worker.test.ts`
- Modify: `src/server/deploymentConfig.test.ts`
- Modify: `wrangler.api.toml`
- Modify: `docs/handoff/cloudflare-deployment-handoff.md`

**Interfaces:**
- Consumes: Cloudflare `scheduledTime` in epoch milliseconds.
- Produces: `{ dailyDate: string } | null` from a DST-aware Central-time eligibility function.

- [ ] Add failing summer and winter tests: `2026-07-15T10:00:00Z` and `2026-01-15T11:00:00Z` both yield their Central date.
- [ ] Add failing tests that the alternate summer/winter trigger exits before repository calls.
- [ ] Add a config test requiring exactly `0 10 * * *` and `0 11 * * *`.
- [ ] Implement the Central date/hour formatter with `Intl.DateTimeFormat` and gate before `buildTracking(env)`.
- [ ] Replace the hourly cron with the two UTC schedules and update the runbook.
- [ ] Run `npm run test:worker`, `npm test`, and `npm run build`.
- [ ] Commit as `feat: schedule daily challenge at five Central`.

### Task 4: Review And Release

**Files:**
- Review all files changed by Tasks 1-3.

**Interfaces:**
- Consumes: the tested VGames and VWiki commits.
- Produces: pushed `main` branches and verified live services.

- [ ] Review for account-enumeration regressions, ghost-stat loss, stale-session loops, DST/date errors, duplicate daily writes, and mobile modal overflow.
- [ ] Run Viota Worker tests and VWiki app/Worker/build/audit/dry-run gates.
- [ ] Fast-forward and push Viota `main`; deploy `vgames-identity` before VWiki.
- [ ] Push VWiki `main`; deploy Worker, then Pages.
- [ ] Verify live account creation, login, guest reservation, Challenge #3 history, and the configured cron triggers.

