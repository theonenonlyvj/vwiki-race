# Player journey and release audit

The interface keeps the daily race as the primary activity. Account continuity
and deeper data support that activity without adding controls to the article.

| State | Main action | Destination and safeguards |
| --- | --- | --- |
| Arrival / restore | Restore remembered account | Resolve identity before exposing competing sign-in controls; temporary restoration failure offers a real retry. Recover an active run before the shell. |
| Landing | Race the selected daily | Open a target preview without creating a run. Log in and Create account are also available directly. |
| Target preview | Start race | Known claimed accounts start; unidentified or guest players enter the account sheet. Back and other challenges remain free exits. |
| Account sheet | Log in; optionally create or use Guest | Login is the default. Preserve the pending challenge, existing guest history and cancellation focus. Authentication itself does not start a race unless the player already selected Start. |
| Active race | Follow article links | Compact timer/clicks/target row stays visible. Path and End Run scroll away. No shell navigation or artwork over Wikipedia. Preserve server-accepted clicks, timer and recovery. |
| Finished | Play again / Your stats | Lead with the result and saved-state receipt, then adjacent replay and personal-stats actions. Sharing is optional; leaderboard and graph links sit with the board. Scoring is unchanged. |
| Ended early | Try again / Your stats | Accurate counted-versus-uncounted copy and destination. A DNF is terminal; retry creates a fresh run. |
| Personal stats / comparison | Explore more data | Existing personal stats, community windows and per-challenge boards retain their distinct meanings. No scoring or denominator changes. |
| Another challenge | Browse or select suggestion | Open challenge detail, then preview and explicit Start. No automatic new run. More VGames remains a footer link. |
| Graph | Expand players / select a route | One persistent mobile disclosure bar. Preserve route selection on collapse; tap a selected player again to clear. Text paths provide a nonvisual equivalent after the existing disclosure gate. |

## Audit priorities

Correct identity restoration, honest transitions, fresh post-run data, visible
current-player identification, keyboard focus, mobile viewport clearance and
existing path-disclosure rules take priority over decorative changes.

The visual direction remains the approved connection atlas, ink-blue shell,
local Manrope typography and restrained turquoise accents. Keep the graph's
calibrated dark surface and the article's reading layout.

## Release verification

Run client and Worker suites, TypeScript/build/bundle checks, dependency audit,
Worker dry run and migration-ledger inspection. Walk built-browser anonymous
and remembered-account flows, cancellation, completion, stats, another game,
and narrow-screen graph use. Record evidence outside the public repository.
Deploy Pages explicitly after pushing the reviewed commit; verify the exact
served bundle. UI success does not establish a diagnosis for every reported
real-device session-persistence failure.
