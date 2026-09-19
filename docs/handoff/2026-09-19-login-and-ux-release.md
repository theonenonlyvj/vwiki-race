---
written: 2026-09-19
by: Codex; session 01a0b9c8-6b20-7fc1-8e84-cb9474b10f3c
supersedes: current runtime identifiers in the weekday and landing-notice releases
---
# Remembered login and inviting home release

Live and verified. Owner approved shipping a more intuitive, exciting, inviting game and a personal invitation for feedback.

## Live artifacts

- VWiki runtime: `2976b6d`, followed by narrow-screen CSS fix `e20f8c5`; both pushed to main.
- Identity runtime: `b529d9e`, pushed to vgames-platform main.
- Identity Worker: `87ecdea8-84eb-481d-9089-5b6d5da6f0ee`.
- VWiki Worker: `fe7f19b5-1ea8-4998-aeb1-14f4fc7b3657`; original cron schedules preserved.
- Final Pages: `https://55243024.vwikirace.pages.dev`; canonical production verified serving `index-85wJm5XH.js`, CSS `index-BmTlCDGk.css`.
- Initial Pages in this release was `f03a7367`; replaced by the narrow-screen correction.

## Behavior

Same-origin remembered sessions use a Secure, HttpOnly, SameSite=Lax host cookie. Identity stores only a credential hash; sessions expire after 30 idle days or 90 absolute days. Renewal preserves the existing 24-hour access-token contract. The identity session API is available only through the named Cloudflare `RememberedSessions` service entrypoint, not public HTTP. Other game clients and their deployment/secrets are unchanged.

Valid existing sessions enroll automatically. Already-expired sessions may need a fresh login. Refresh outages do not silently log players out. Explicit login is accepted only after remembered-session establishment succeeds; logout revokes the cookie session. Account changes and logout invalidate other tabs; same-account token renewal preserves play. Regression coverage includes late responses, retries, pending writes and account isolation. Clearing browser data still removes the device cookie. Expiry windows were tested with synthetic clocks, not elapsed production time.

Home now clearly labels Start and Target, provides a stronger daily CTA, shows actual account/guest state, and explains yesterday's completion counts. Stats headings distinguish community from personal statistics. The footer invites: “I’d love your feedback. Help me make this game better! (Vijay)” using the existing contact link. The previously shipped apology remains through September 25 Central, expiring via the app date lifecycle.

## Verification

- Full client suite: 1411 passing. Worker/D1: 290 passing. Identity: 130 passing. Typecheck, production build, bundle gate, both Worker dry runs and diff checks passed.
- Independent code review approved after session concurrency, binding confidentiality, and cross-tab fixes; focused reviewer suite 47/47 passed.
- Live identity health 200. Live catalog 200; unauthenticated admin 403. Canonical asset matches final build.
- Normal production smoke with a dedicated test ghost passed establishment, cookie attributes, secret-free JSON, cookie restoration and explicit logout. No gameplay/leaderboard rows created by that smoke. The test ghost remains in identity; its remembered session was revoked.
- Browser verified existing test guest `zzCodexSep19` enrollment and continued visible identity after reload, feedback link, actual Start/Target hierarchy, and desktop/390px/320px layouts. At 320px, discovered pre-existing body minimum-width overflow and corrected it; final DOM widths all 305px with the vertical scrollbar, no horizontal overflow. No new browser gameplay was started.
- Claimed-account renewal, expiry, cross-tab logout and outage behavior are automated regression evidence; the live browser smoke used the existing test guest.
- Existing four dependency advisories remain separate follow-up (see weekday release). No dependencies changed.

## Database and recovery

VWiki ledger verified 0001–0007, no migration needed. Identity schema inspected first (no session table), full export taken, then additive `services/identity/migrations/0001_remembered_sessions.sql` applied and table/index verified before identity deployment. Backup is ignored local-only `vgames-platform/backups/identity-before-remembered-sessions-20260919.sql`, SHA-256 `82498cbf792d935039e9d523956662aba796b94116b486dda3de8ccd6ea7650d`. Do not replay or drop data.

Rollback frontend to Pages `b48e0f6d`, VWiki Worker to `ff4c8704-7810-4181-b990-570a25ab6897`, identity Worker to `1bd22084-6466-467d-bf1f-15ee00b761f5` (consumer before provider). Leave additive session table intact. Previous frontend bundle `index-BbYoRW7-.js`. No JWT secret, issuer, lifetime or other game deployment changed.

Evidence logs are ignored local-only `.private/audit-2026-09-19/` and identity `backups/`. Pages is direct-upload: pushing alone does not deploy. Current identity source is `games/vgames-platform/services/identity`, not old umbrella paths in historical docs.
