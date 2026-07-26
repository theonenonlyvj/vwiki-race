# NOTICE for the vwiki-race agent — shared identity token TTL changed (2026-07-26)

**No action required from you. This is an FYI so a longer-lived token isn't a
surprise.** Left here by the vjaipur session (Vijay asked that you be notified).

## What changed
In the SHARED identity service (`vgames-platform/services/identity`, deployed as
`vgames-identity`), the **`vgames`/`vgames-web` token TTL was raised from 1 hour
to 24 hours** (`src/jwt.ts`, `VG_TTL_SECONDS`). Committed as
`vgames-platform@4e92f29`, deployed and verified live (login token measured
1.0h → 24.0h).

These are the tokens minted by **`POST /auth/login`** (username+password). The
legacy `viota`/`viota-web` tokens from `POST /auth/quick` were ALREADY 24h and
are unchanged.

## Why
Vijay: *"all the logging out is annoying on all of em."* A password login was
handed a 1h token while every anonymous/device session got 24h — so logging in
was strictly worse than staying a guest, and users were signed out hourly. No
new exposure class is introduced: 24h tokens have always circulated.

## Impact on vwiki-race — believed nil, but worth a glance
vwiki-race validates via **`POST /auth/introspect` per write**, which re-checks
the account live (`token_epoch`, `status`). So:
- **Revocation is unaffected for you** — a bumped `token_epoch` still invalidates
  within your introspect path regardless of the JWT's TTL.
- The only change you'd observe is that a given bearer token stays *signature-
  valid* for up to 24h instead of 1h. If anything in vwiki assumes a ~1h token
  lifetime (e.g. a cache TTL keyed to it, or a "re-auth hourly" assumption),
  that assumption is now stale — that's the one thing worth grepping for.

Post-change verification run from the vjaipur session: `/auth/quick` +
`/auth/introspect` OK; vjaipur and viota consumers both still return 200 with a
freshly minted token.

## Related (same day, vjaipur-side only — no vwiki impact)
The vjaipur client also gained **proactive token refresh** (refreshes before
expiry on boot/foreground/interval rather than reactively on a 401). If vwiki
ever sees the same "signed out constantly" complaint, that pattern is at
`vjaipur/src/net/tokenRefresh.ts` + `src/auth/tokenExpiry.ts` and is
straightforward to port.
