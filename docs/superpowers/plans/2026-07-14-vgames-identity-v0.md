# VGames Identity V0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace VWiki Race's local player identity with VGames ghost/claimed identity while keeping VWiki Race as an asynchronous challenge leaderboard game.

**Architecture:** VWiki Race remains a Cloudflare Pages app with `/api/*` functions. VGames owns accounts and login through the live viota identity worker; VWiki Race owns challenge/run/click/path data keyed by VGames `account_id`. The browser stores only the device credential, token, account id, and local display metadata needed for silent guest re-auth.

**Tech Stack:** React 19, Vite, TypeScript, Vitest, Cloudflare Pages Functions, Cloudflare D1 for VWiki Race-owned run data, VGames identity worker at `https://viota-worker.theonenonlyvj.workers.dev`.

## Global Constraints

- VWiki Race does not use realtime rooms.
- VWiki Race does not use the VGames card-game layer.
- The unique VGames name/handle is the canonical public identity.
- Guests are real VGames ghost accounts, not local-only throwaway players.
- Guest stats must remain claimable when the user later secures or logs into an account.
- Do not commit secrets, Supabase keys, Cloudflare tokens, or VGames secrets.
- Keep Wikipedia article rendering true to Wikipedia.
- Keep VGames engines/rules untouched.

---

## File Structure

- `src/services/vgamesIdentity.ts`: browser-side device credential, token, and identity-session storage helpers.
- `src/services/vgamesIdentity.test.ts`: storage and request tests for guest, secure, and login flows.
- `src/server/vgamesIdentityClient.ts`: server-side fetch wrapper for VGames `/auth/quick`, `/auth/set-credentials`, `/auth/login`, and `/auth/introspect`.
- `src/server/vgamesIdentityClient.test.ts`: proxy/introspection tests with fake fetch.
- `src/server/d1TrackingRepository.ts`: D1-backed VWiki Race challenge/run/click repository keyed by `account_id`.
- `src/server/d1TrackingRepository.test.ts`: repository behavior tests with a fake D1 adapter.
- `src/server/trackingRepository.ts`: replace `playerId` inputs with `accountId` and account profile metadata.
- `src/server/apiHandlers.ts`: require `accountId` for run writes; remove local player creation.
- `functions/_shared/createTrackingContext.ts`: switch env from Supabase to D1 + VGames URL.
- `functions/api/identity/guest.ts`, `secure.ts`, `login.ts`: same-origin identity proxy endpoints.
- `functions/api/players.ts`: removed after client no longer calls it.
- `functions/api/runs/start.ts`: derive run identity from Authorization token instead of client `playerId`.
- `src/App.tsx`: landing gate with Secure display name / Log in primary flow and Play as guest secondary flow.
- `src/styles.css`: landing identity styles only; no article typography changes.
- `d1/migrations/0001_vwiki_race_tracking.sql`: D1 schema for challenges, account profile cache, runs, events, and path steps.
- `README.md` and `docs/handoff/cloudflare-deployment-handoff.md`: deployment docs for VGames identity + D1.
- `viota/packages/worker/src/d1/accounts.ts`: add `vwiki-race` to valid `origin_game` values.

## Task 1: Browser VGames Identity Session

**Files:**
- Create: `src/services/vgamesIdentity.ts`
- Create: `src/services/vgamesIdentity.test.ts`

**Interfaces:**
- Produces:
  - `VGamesIdentitySession`
  - `createVGamesIdentityRepository(storage, cryptoLike)`
  - `createVGamesIdentityClient(fetchImpl)`
  - methods `playAsGuest(displayName)`, `secureGuest(input)`, `login(input)`, `getSession()`, `clearSession()`

- [x] **Step 1: Write tests** for generated device credentials, stored sessions, guest auth request body including `game: "vwiki-race"`, secure flow, and login flow.
- [x] **Step 2: Run** `npm test -- src/services/vgamesIdentity.test.ts` and verify tests fail because the module is missing.
- [x] **Step 3: Implement** storage helpers and fetch client with same-origin `/api/identity/*` endpoints.
- [x] **Step 4: Run** `npm test -- src/services/vgamesIdentity.test.ts` and verify pass.

## Task 2: VGames Identity Proxy

**Files:**
- Create: `src/server/vgamesIdentityClient.ts`
- Create: `src/server/vgamesIdentityClient.test.ts`
- Create: `functions/api/identity/guest.ts`
- Create: `functions/api/identity/secure.ts`
- Create: `functions/api/identity/login.ts`
- Modify: `functions/api/routes.test.ts`
- Modify: `functions/_shared/createTrackingContext.ts`

**Interfaces:**
- Produces:
  - `createVGamesIdentityClient({ baseUrl, fetchImpl })`
  - `quick(displayName, deviceCredential)`
  - `secure(token, username, password, deviceCredential)`
  - `login(username, password, deviceCredential)`
  - `introspect(token)`

- [x] **Step 1: Write tests** proving the proxy calls VGames with `game: "vwiki-race"`, refreshes token after `/auth/set-credentials` by logging in, and returns structured API errors.
- [x] **Step 2: Run** `npm test -- src/server/vgamesIdentityClient.test.ts functions/api/routes.test.ts` and verify expected failures.
- [x] **Step 3: Implement** the client and Pages Function endpoints.
- [x] **Step 4: Run** targeted tests and verify pass.

## Task 3: D1 Account-Keyed Tracking Repository

**Files:**
- Create: `d1/migrations/0001_vwiki_race_tracking.sql`
- Create: `src/server/d1TrackingRepository.ts`
- Create: `src/server/d1TrackingRepository.test.ts`
- Modify: `src/server/trackingRepository.ts`
- Modify: `src/server/contracts.ts`
- Modify: `src/server/apiHandlers.ts`
- Modify: `functions/_shared/createTrackingContext.ts`

**Interfaces:**
- Consumes: VGames `accountId`, `publicName`, `identityStatus`.
- Produces: tracking methods keyed by `accountId` and `account_profiles`.

- [x] **Step 1: Write repository tests** for challenge seed, account profile upsert, starting a run by `accountId`, recording clicks, completing runs, and leaderboard display updating when an account profile changes from guest to handle.
- [x] **Step 2: Run** `npm test -- src/server/d1TrackingRepository.test.ts src/server/apiHandlers.test.ts` and verify failures.
- [x] **Step 3: Implement** the D1 repository and update handler contracts.
- [x] **Step 4: Run** targeted tests and verify pass.

## Task 4: Run API Authorization

**Files:**
- Modify: `functions/api/runs/start.ts`
- Modify: `functions/api/runs/[runId]/click.ts`
- Modify: `functions/api/runs/[runId]/complete.ts`
- Modify: `functions/api/runs/[runId]/abandon.ts`
- Modify: `functions/api/challenges.ts`
- Modify: `functions/api/routes.test.ts`
- Modify: `src/services/vwikiRaceApiClient.ts`
- Modify: `src/services/vwikiRaceApiClient.test.ts`

**Interfaces:**
- Consumes: `Authorization: Bearer <VGames token>`.
- Produces: run mutations that derive `accountId` from VGames introspection, not browser-provided `playerId`.

- [x] **Step 1: Write tests** that unauthenticated run start fails, authenticated run start omits `playerId`, and create challenge requires a VGames session.
- [x] **Step 2: Run** targeted tests and verify failures.
- [x] **Step 3: Implement** auth extraction/introspection and API client token headers.
- [x] **Step 4: Run** targeted tests and verify pass.

## Task 5: Landing And Session UI

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/App.test.tsx`
- Modify: `src/styles.css`
- Delete: `src/services/playerRepository.ts` after replacing usages.

**Interfaces:**
- Consumes: `VGamesIdentitySession`.
- Produces: landing state with primary "Secure display name / Log in" and secondary "Play as guest".

- [x] **Step 1: Write UI tests** for guest play, secure guest, login, persisted session, and run start with the identity token.
- [x] **Step 2: Run** `npm test -- src/App.test.tsx` and verify failures.
- [x] **Step 3: Implement** landing/session UI and replace `playerRepository` usages.
- [x] **Step 4: Run** targeted tests and verify pass.

## Task 6: VGames Origin Game Support

**Files:**
- Modify: `../viota/packages/worker/src/d1/accounts.ts`
- Modify: `../viota/packages/worker/test/accounts.test.ts`

**Interfaces:**
- Produces: `/auth/quick` accepts `game: "vwiki-race"` and stores `origin_game='vwiki-race'`.

- [x] **Step 1: Write or update viota worker test** proving `game: "vwiki-race"` is preserved.
- [x] **Step 2: Run** the viota worker test and verify failure.
- [x] **Step 3: Add `vwiki-race` to `ORIGIN_GAMES`.**
- [x] **Step 4: Run** the viota worker test and verify pass.

## Task 7: Documentation And Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/handoff/cloudflare-deployment-handoff.md`
- Modify: `docs/superpowers/specs/2026-07-14-vgames-identity-v0-design.md`

**Interfaces:**
- Produces: deployment docs with Cloudflare Pages, D1 binding, and VGames identity proxy setup.

- [x] **Step 1: Update docs** with D1 binding names, `VGAMES_URL`, and no standalone `players`.
- [x] **Step 2: Run** `npm test`.
- [x] **Step 3: Run** `npm run build`.
- [x] **Step 4: From viota, run** the targeted worker identity test changed in Task 6.
- [ ] **Step 5: Commit VWiki Race and viota changes separately unless Vijay asks for one combined checkpoint.**

## Self-Review

- Spec coverage: covers shared VGames identity, guest claimability, no realtime rooms, no card-game layer, account-keyed runs, and deployment doc changes.
- Known gap: exact production D1 binding creation happens in Cloudflare dashboard or `wrangler`; implementation docs must define the binding name before deploy.
- Placeholder scan: no TBD/TODO placeholders.
- Type consistency: plan uses `accountId`, `publicName`, and `identityStatus` consistently.
