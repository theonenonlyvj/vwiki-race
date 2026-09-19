---
written: 2026-09-19
by: Codex; session 01a0b9c8-6b20-7fc1-8e84-cb9474b10f3c
supersedes: candidate UX/login audit
---
# Remembered login and daily UX

Owner approved ship of audit recommendations and requested an intuitive, exciting, inviting game plus a personal feedback invitation. This is the execution record.

- [x] Add shared identity remembered sessions with hashed random credentials, 30-day idle and 90-day absolute expiry, epoch checks, and explicit revocation. Existing JWT contract unchanged. Credential rotates on authenticated establishment/account change; renewals mint fresh bounded access tokens while retaining opaque device session for safe concurrent-tab/lost-response behavior.
- [x] Add same-origin VWiki session proxy with HttpOnly/Secure/SameSite cookie, origin validation, no-store, timeouts and rate limiting. Never expose renewal secret to browser JS.
- [x] Add single-flight client renewal, valid-session enrollment, cookie restore, logout revocation, stale-account response guards and regression tests. Preserve pending actions and current race.
- [x] Polish daily hierarchy, visible account state, recap, stats clarity and owner's feedback invitation without redesign or changing game rules.
- [x] Independently review, run client/Worker/identity gates, inspect responsive UI.
- [x] Back up identity D1, verify/apply additive session table, deploy identity then VWiki Worker then Pages, smoke and record rollback/version receipts. Push only relevant changes.

Rollback: restore previous frontend and Workers; leave additive identity session table intact. Do not modify other games, secrets or token claims. Other game clients do not enroll in remembered sessions in this release. Prior 24-hour-token users with already expired credentials may need one fresh login; valid current sessions can enroll automatically.

Completed and live: `docs/handoff/2026-09-19-login-and-ux-release.md`.
