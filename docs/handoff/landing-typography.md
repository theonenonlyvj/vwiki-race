# Editorial landing refinement

This implementation replaces the blue shell with black and neutral surfaces,
using locally hosted Newsreader for the Home headline and route titles and
Source Sans for controls and body text. The selected sample's wordmark, atlas
artwork and turquoise accent remain. “Somewhere” uses the real italic font.
Font licenses are retained in `public/licenses/`.

Home explains the game once. The redundant teaching strip remains available on
Challenge Detail; full rules remain accessible from the permanent footer. The
footer labels are How to play, Feedback and More games, with larger text and
comfortable touch targets. External destinations are unchanged.

The race card precedes account prompts. Log in and Create account remain
available directly, and starting a race preserves the existing login-first
flow. Compact height-dependent layouts keep the race action clear of the fixed
navigation bar on short phones, tablets and landscape screens. Compact stacked
cards put the preview action before variable-height route titles; side-by-side
layouts align it to the top. Long article titles still wrap without truncating
the actual destination.

The graph retains Manrope locally so its measured labels and PNG export remain
consistent. Article typography, scoring, timing, session recovery, disclosure
rules, challenge generation and backend contracts are unchanged.

## Verification and limits

Client and Worker suites, TypeScript/build/bundle checks, copy checks and local
Chromium viewport/interaction checks cover the change. Browser checks assert
full CTA clearance above fixed navigation, no initial scroll or horizontal
overflow, readable footer targets, rule-dialog keyboard/focus behavior and
login-first preview entry. Checks include unusually long article names and blocked-font fallback. Gameplay smoke
covers recovery, completion and graph disclosure.

Local browser checks use synthetic API data; they do not establish physical
Safari behavior, every browser text-size setting, or real-device login
persistence. No Worker deployment or migration is needed. Confirm publication
separately: local implementation is not evidence of a production release.
