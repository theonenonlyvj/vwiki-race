# Reveal confirmation and personal stats

Personal times and click counts remain visible in challenge history, Stats boards,
and compact board snippets even before finishing. Other players' measurements
remain subject to the existing spoiler mask. Path and graph disclosure and
server-side reveal eligibility are unchanged.

Show me the answers opens an explicit ranking-forfeiture confirmation when
eligible. Ineligible unfinished attempts get the specific missed requirement
where known, the existing eligibility rules, and a Race action that opens
briefing without starting a run or revealing answers. Pending or failed outcome
reads are not classified as ineligibility.

End Run is in the sticky HUD's right-hand controls beside Target. It remains
reachable while scrolling, uses the existing confirmation and disabled states,
and preserves terminal DNF behavior. The breadcrumb scrolls normally.

Regression coverage lives in RaceMode, ChallengeDetail, LeaderboardList,
BoardSnippet, Boards, RaceResults, GiveUpAffordance and App tests. Browser checks
must use the actual race-takeover scroll container and check narrow-screen
control overlap, confirmation, target disclosure and heading clearance.

Error reporting already installs browser error and unhandled-rejection handlers,
a React error boundary, and selected handled-error beacons. The API accepts
client-error reports into structured Worker logs and logs unhandled server
exceptions. Worker observability is enabled in configuration. Reporting is
best-effort and deduplicated; it does not guarantee capture of every caught or
offline failure. No alerting service is defined in this repository.
