# Atlas interface and login-first entry

## Status

Implemented on `feat/atlas-ui-login`, with publication authorized. The full
journey audit and state map are in `player-journey.md`. Confirm the release
commit and served Pages artifact before treating a deployment as complete.

## User-facing changes

- Original decorative connection-map artwork, ink-blue surfaces, turquoise
  accents, locally hosted Manrope, rounded panels and clearer navigation.
  The existing wordmark remains. Font licenses ship under `public/licenses/`.
- Home exposes Log in and Create account without requiring a race to start.
  Ordinary identity prompts default to Log in. Explicit Guest remains, and
  fresh-name switching still opens Guest. Existing guests can secure their
  own account without discarding their history.
- Same-origin cookie bootstrap resolves before the shell exposes identity
  or race controls. This prevents a late account restoration from arriving
  behind a competing login form. Existing renewal, outage handling, logout
  and account-isolation behavior stays in the session manager.
- Completed and abandoned results focus the outcome summary. A completed
  result's frozen article no longer scrolls that summary out of view. Active
  article navigation still focuses its new heading.

## Guardrails and review corrections

Race timing, accepted-click tracking, ranking, active-run recovery, path
disclosure, Daily generation, identity contracts and backend code are unchanged.
Artwork has no route data and is hidden from assistive technology.

Independent identity, design and adversarial gameplay reviews found a
session-restoration overlap, insufficient active-tab emphasis, reduced mobile
hit targets and a graph contrast regression. Corrections gate bootstrap, add
an active underline, restore comfortable account hit targets, and scope the
graph to its calibrated dark surface. PNG graph export uses the same Manrope
font as the graph. A follow-up review found no blocking issues.

The graph keeps its calibrated surface intentionally: globally replacing that
surface made a strand label fall below its contrast floor. Do not let shell
theme changes silently invalidate graph palette tests.

## Verification

The complete client and Worker suites pass, as do TypeScript, production
build, bundle checks and dependency audit. Focused tests were rerun after the
last result-scroll correction. Regression tests cover login default without
guest creation, Home account entry, delayed cookie-only restoration, result
focus and the graph's scoped contrast surface.

Chromium exercised desktop and narrow phone layouts using the built app.
Home, login, creation, Challenges and Stats had no horizontal overflow or
page errors. Creation submit remained reachable at the narrowest width.
Isolated synthetic gameplay restored an account, started and reloaded an
active run, completed the route under the same account, and kept both the
race HUD and final summary visible. No production player data was written.

These are local browser and mocked integration checks, not a new live
authenticated session test. Safari, real password-manager autofill, virtual
keyboards and visual fidelity of exported graph images remain unverified.
Quiet secondary-card borders remain an aesthetic tradeoff from design review.

## Release and follow-through

### Mobile gameplay and graph follow-through

Keep gameplay chrome compact: the path and End Run strip scroll out of view;
only the existing timer/clicks/target row remains sticky. A built-browser
long-article check verifies this behavior; no additional sticky controls were
introduced. The graph modal uses the modern heading face and occupies the
full phone viewport with safe-area padding. Its former backdrop gutter made
the full-height sheet extend beyond the viewport. Route layout, player focus,
calibrated contrast and spoiler gates remain unchanged.

The owner also reports real login persistence failure. Existing synthetic
restoration checks do not resolve that report. Browser/device and failure
trigger are still needed to reproduce it; the journey audit separately fixes a reproduced cookie-only restoration
outage that previously exposed competing signed-out controls. This does not
establish the cause of the reported real-device persistence failure.

Publication is authorized. Review the diff and screenshots, then commit only
the scoped interface and journey changes. No migration or Worker deployment is required by this
frontend change. Explicitly deploy Pages and verify its served bundle after
publication; a Git push alone is insufficient.

### Mobile player disclosure refinement

The graph player list now expands below the same persistent Show/Hide players
bar, inside a shared panel. Mobile no longer adds separate Show all or Hide
names controls. Tapping the selected player again clears route focus; closing
the list preserves the selection. Desktop retains Show all. The list remains
mounted but hidden when collapsed so aria-controls always resolves, and the
bar keeps keyboard focus. Portrait, desktop, image-export and dialog tests
cover this refinement, with built-browser checks of expansion and selection.

Review raised a discoverability tradeoff: collapsed selection requires
reopening the list and tapping the pressed player to return to all routes.
The simpler owner-requested disclosure takes priority; no redundant reset
button was reintroduced. See `player-journey.md` for the subsequent release audit.
