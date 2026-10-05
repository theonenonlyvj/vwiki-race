# Challenge arrival and game-day Stats

Local implementation; publication must be verified separately.

## Behavior

Stats Today represents the current game day, which turns over at the 5:00 AM
Central Daily drop, not at Central midnight (owner ruling 2026-10-05: "'today'
doesn't swap until 5am CST when the new challenge drops"). The shared
`centralGameDayKey` helper is the single source for this on both the client
(`todayUtc`) and the Worker (trends, streak, suggestion). If the drop passes
without a new Daily, show a waiting state with a route to Yesterday instead of
displaying the same challenge under both labels. Refresh the catalog at the
Daily drop only. The still-open preceding Daily must not enter the permanent
board cache, including when trend history reads it first.

Challenges uses one catalog with an optional Daily-date lookup. Daily cards
and detail headings use the featured date. Hide system creator attribution
using the immutable system account ID; retain human attribution even when a
human chooses the same display name as the system.

Home and challenge details share the same article-pair card component and bold
triangle-plus-Race entry button. The action is vertically centered beside the
article pair on desktop; compact Home layouts keep its existing visible-entry
ordering. Detail leaderboard, history, solution and share boxes are centered.

The card has no added invitation heading or explanatory paragraph. Compact
finished/best, DNF, loading/error and unranked-practice information remains.
Graph access sits in the leaderboard heading; eligible DNF players retain the
explicit give-up confirmation. Human authorship and Daily date metadata remain.

Race opens the target briefing. Only the briefing's separate Start race action
starts a run. The account reassurance line remains removed.

## Preserved rules

DNF remains terminal. A retry is a new run. DNF alone never unlocks paths.
Revealing still requires confirmation, permanently forfeits ranked eligibility
for that challenge, and allows unranked practice. Outcome state is keyed to
both identity and challenge to prevent stale disclosure across navigation or
account changes. No server contract, ranking rule, migration or scheduler
changed.

## Verification and limits

Client and Worker suites passed, as did the production build and bundle
verification. Regression tests cover the midnight non-rollover and 5:00 AM rollover, pre-drop
cache hints, system-versus-human provenance, account isolation, and landing
actions. Local browser checks cover mobile and desktop for each progress
state, archive lookup, graph dismissal, and cancelled reveal without mutation.
Physical Safari and arbitrary text enlargement remain unverified.
