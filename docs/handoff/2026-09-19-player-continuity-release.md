---
written: 2026-09-19
by: Codex; session 01a0b9c8-6b20-7fc1-8e84-cb9474b10f3c
supersedes: current release state in 2026-09-19-login-and-ux-release.md
---
# Player continuity and recovery release

Owner approved the discovery/result priorities, confirmed duplicate-player ownership, and selected owner-issued recovery. The requested longer email-friendly reset window is seven days from issuance (604800 seconds), single use; reissue invalidates the preceding link.

Live runtime: VWiki `438901b` (main feature `832153f`), identity `58de31c`, both pushed to main. VWiki Worker `7262fcf4-3424-4631-a4f8-5ce719e6d22d`; Pages `4d37610f`, executed bundle `index-CuLFgSQb.js`. Identity final Worker version after temporary secret cleanup: `89113933-2cdc-42ad-9035-8d3cc3aa3d20` (same runtime code).

## Shipped behavior

- Owner panel at `/admin/dailies` includes Password reset links. Enter the player's VGames username, create and copy the link, then send it personally. No automated messages or email provider. Login has Forgot password contact instructions.
- Reset opens a dedicated page without mounting gameplay. Fragment token is removed from the address bar; password and confirmation are validated. Tokens persist only as hashes; reset/password/device changes are atomic. Authenticated owner issuance uses the private identity binding.
- Challenges has Past dailies/date filtering, account-specific outcomes, and a visible collapsible Create action. Hidden best metrics stay hidden until permitted by existing spoiler rules.
- Results distinguish persisted results from guest-device continuity, offer account creation and existing-account login, and emphasize sharing. Board snippets explain locked metrics once and say Did not finish.
- 44 confirmed accounts consolidated into seven canonical players through 37 reviewed identity merges and game aliases. All 131 affected runs preserved. Thirteen already-expired active rows finalized without deleting history. Cross-game reads found no affected Iota/Jaipur history. Raw run ownership remains intact; aliases resolve it.

## Verification and operations

Parent final runs: 1455 client tests, 290 Worker tests, 142 identity tests; TypeScript/build/bundle verification and both dry runs passed. Independent reviewers approved UI, identity and operator workflow. Browser checks covered live landing/archive and 320px reset layout. Three affected public `/board` responses have unique canonical participants; `/leaderboard` is a separate repeat-run history view and intentionally can repeat a person.

Identity migration `0002_password_reset_tokens.sql` was confirmed absent, applied before code deployment, and its table verified. No VWiki migration. Existing private backups were preserved; pre-merge game backup SHA-256 `66a4cc9ff90f534edb25618529988c98008acd00e2c64ba714c2e7d3f1ff85b7`, identity backup `9391869cb9fd1d07a801aead8489f8d84c7d9c91210536f1c7ef65b35501c32a`.

Live synthetic recovery verified issue, seven-day lifetime, consume, and new-password login, with no game runs created. Owner UI issuance is covered by tests; no principal sign-in was performed. Initial immediate operator call returned 401; after provisioning inventory verification and propagation delay, the same authenticated flow passed. Both attempts removed the temporary ADMIN_JWT_SECRET and verified absence. Merge audit actor is the verified agent subject, never a hardcoded principal.

Existing Viota access JWTs verified locally can remain usable until their existing 24-hour expiry; identity-checked VWiki access and remembered/device credentials are revoked by reset. UI does not claim immediate global logout. Four existing dependency advisories remain (browserslist/nanoid high; baseline-browser-mapping/postcss moderate).

Rollback code independently through prior deployment versions; retain additive reset table. Account consolidation rollback must be a narrow reviewed inverse using the ignored manifest/backups, not a whole-database restore that loses later play. Do not publish raw identity exports, account maps, passwords, tokens, or operator logs.

Final browser follow-up: same-document reset links initially left the current screen mounted. Fix438901b observes incoming reset fragments and remounts recovery for replacements; targeted regression failed before the fix, then full client1455/build and independent review passed. Final Pages4d37610f executed index-CuLFgSQb.js in the browser; navigation from an existing game tab to an invalid reset link entered recovery and scrubbed the fragment. Local task registry remained unavailable (connection refused); shared worklog and handoffs are current.
