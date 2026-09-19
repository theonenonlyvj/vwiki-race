---
written: 2026-09-19
by: Codex; session 01a0b9c8-6b20-7fc1-8e84-cb9474b10f3c
supersedes: none
---
# UX and login persistence review

Owner asked for UX/UI polish and better login persistence after the daily schedule release. Investigation only; no authentication or UI changes shipped in this review.

## Login finding

Local source confirms browser localStorage persists the session (`src/services/vgamesIdentity.ts`, repository save/get); App restores it on startup. In shared identity source `../vgames-platform/services/identity/src/jwt.ts`, `VG_TTL_SECONDS = 24 * 60 * 60` is the login lifetime. Python calculated that expression as 86400 seconds. Shared router has no renewal endpoint, and VWiki's identity client supports guest, secure and login only. `src/App.tsx` clears identity after an unauthorized stats response via clearStaleIdentity/resetIdentityState. This explains a possible next-day logout without storage loss; it does not prove the owner's specific incident. Browser/device and triggering event were requested asynchronously and remain unconfirmed.

A newly opened browser tab retained the earlier test guest and loaded its account stats (n=1 observation). Claimed-account expiry was not reproduced in production. No principal credentials or browser session secrets were inspected.

## Recommended implementation direction (not yet approved)

Implement remembered-device sessions with silent renewal, a proposed 30-day idle window, and an explicit absolute lifetime defined in the identity design. Keep access tokens bounded. Store the renewal credential in a same-origin Secure/HttpOnly cookie; keep server-side hashed session state, rotation, revocation and logout behavior. Restore the same account/status; distinguish expired access, revoked session, temporary network failure and blocked storage. Preserve the race/pending action through renewal, with one shared renewal operation for concurrent requests. Do not treat a remembered display name or an expired token alone as authentication. Make logout prevent automatic restoration on the next visit.

This belongs in shared VGames identity plus the VWiki proxy/client integration, with migration and consumer compatibility review before deployment. Confirm current identity handoff and live deployment before implementation. Validation must cover next-day return, browser restart, concurrent requests/tabs, expiry/revocation, logout, network outage, guest-to-claimed continuity, and in-progress races. User's actual browser scenario remains a useful reproduction input.

Alternatives: extending only the access-token lifetime postpones the same interruption; clearer login prompts improve recovery but do not create persistence. Prefer renewable remembered sessions.

Reference for session lifecycle, cookie protections and revocation: https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html . The proposed product retention window is a design choice, not an OWASP mandate.

## Ranked UX polish opportunities

1. Make current identity visible near the landing Race action: playing as a named account vs guest; show recovery/reconnection without making the user infer logout from disappearing stats. Live Home currently puts account detail behind You (n=1).
2. Strengthen the daily card: explicit Start and Target labels, clearer title hierarchy, quieter countdown. Retain Race as the primary action. Current live card puts two names on one line and shows a seconds countdown (n=1).
3. Clarify community vs personal stats with headings/subcopy. Current Stats contains boards while You contains Your stats (both inspected, n=1 each). Preserve the deliberately chosen Stats navigation label unless owner approves changing it.
4. Give yesterday's recap more useful context when there are DNFs and no finishers: explicit completion/attempt summary and a clear board link, preserving DNF honesty. Current live recap had a DNF row and a dash (n=1).

These are candidate refinements based on direct inspection, not measured usability outcomes. Retain the existing visual style and daily-first layout. Prioritize persistence and visible account state over a broad redesign.
