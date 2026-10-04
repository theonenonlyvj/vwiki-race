# Challenge arrival and calendar-correct Stats

Local implementation; publication must be verified separately.

## Behavior

Stats Today represents the current Central calendar date. Before its Daily
arrives, show a waiting state with a route to Yesterday instead of displaying
the same challenge under both labels. This supersedes the earlier deliberate
pre-drop reuse policy. Refresh the catalog at both Central midnight and the
Daily drop. The still-open preceding Daily must not enter the permanent board
cache, including when trend history reads it first.

Challenges uses one catalog with an optional Daily-date lookup. Daily cards
and detail headings use the featured date. Hide system creator attribution
using the immutable system account ID; retain human attribution even when a
human chooses the same display name as the system.

The detail landing distinguishes unplayed, DNF, completed and revealed-route
states. Preview and retry open the existing preview; they never start a run.
Finished players can open the graph or race again. Eligible DNF players can
confirm a reveal; ineligible DNF copy offers retry without promising reveal.
Revealed-route players can view graphs and practise unranked.

## Preserved rules

DNF remains terminal. A retry is a new run. DNF alone never unlocks paths.
Revealing still requires confirmation, permanently forfeits ranked eligibility
for that challenge, and allows unranked practice. Outcome state is keyed to
both identity and challenge to prevent stale disclosure across navigation or
account changes. No server contract, ranking rule, migration or scheduler
changed.

## Verification and limits

Client and Worker suites passed, as did the production build and bundle
verification. Regression tests cover mounted calendar rollover, pre-drop
cache hints, system-versus-human provenance, account isolation, and landing
actions. Local browser checks cover mobile and desktop for each progress
state, archive lookup, graph dismissal, and cancelled reveal without mutation.
Physical Safari and arbitrary text enlargement remain unverified.
