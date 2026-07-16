# VWiki Race Backlog

Date: 2026-07-16

The current hardening worktree covers the friend-ready v0 game loop. Items below
are deliberately outside that launch scope unless marked as an operational
gate.

## Operational Gates

- Repeat responsive production browser QA and resolve any P0/P1 council finding
  before each friend release.
- Run the complete release gate in the Cloudflare handoff on every shipment.
- Deploy Worker before Pages when both changed, then run the documented
  production smoke test.
- Confirm Cloudflare request counts after the first scheduled day; do not
  generate repeated manual cron events.

## Challenge Quality

- Build an offline or cached graph-analysis pipeline for reachability, shortest
  path, and estimated difficulty. Never crawl Wikipedia during a player run.
- Flag or exclude overpowered hubs, dates, years, lists, and disambiguation
  pages in future ranked modes.
- Decide whether community challenges need moderation, reporting, deactivation,
  or creator-only deletion.
- Add challenge search/filtering once the numbered catalog becomes large.
- Add cursor pagination before any challenge approaches the current 100-row
  public leaderboard response cap; D1 already retains the underlying attempts.

## Daily Product Choices

- Decide whether daily leaderboards allow unlimited attempts, one ranked
  attempt, or best-of-day scoring.
- Add a daily archive/calendar only when enough history exists to justify it.
- Consider difficulty balancing after graph analysis exists; do not replace the
  current proper random selection with a hand-maintained pseudo-random list.
- Add streaks, reminders, and notifications only after the core return loop is
  measured.

## Thinking Maps And Stats

- Visualize aggregate navigation as a privacy-preserving graph: common starts,
  targets, bridge pages, transitions, and semantic clusters.
- Add a dedicated per-player history view and personal-best progression. The
  public challenge leaderboard already shows every completed/DNF attempt and
  marks repeats.
- Compare a completed path with known shortest paths only from an offline graph
  snapshot.
- Add friend filters after VGames exposes the required social graph.
- Set minimum cohort thresholds before displaying aggregate transitions so an
  individual path is not exposed unintentionally.

## Identity And Platform

- Keep VGames as the only account namespace; do not add local usernames.
- Add account-management links once the shared VGames account portal is ready.
- Verify alias/merge behavior across every VGames game before presenting
  cross-game profiles.
- Consider showing the broader VGames shell in a later version; VWiki Race does
  not need realtime rooms.

## Competition And Modes

- Preserve separate leaderboards for WikiGolf/fewest-click, hub-banned,
  first-link, hints, backtracking, and other rule variants.
- Add immutable Wikipedia snapshots or cached revision sets before claiming
  tournament-grade reproducibility.
- Add replay comparison, challenge par, and tournaments only after the current
  authoritative run protocol has production history.
- Friend v0 validates run ownership, canonical page identity, source continuity,
  sequence, idempotency, and decision time, but does not prove each clicked edge
  against the stored source revision. Add that proof from a cached/offline
  revision graph before public prizes or adversarial ranked play; do not add a
  live Wikipedia fetch to every player click.
- Treat anti-cheat as server-verifiable transition integrity first. Do not rely
  on invasive tab/devtools detection that cannot be made reliable on the web.

## Accessibility And Localization

- Test additional assistive technologies after the keyboard/screen-reader v0
  pass.
- Add language-edition support only with language-specific namespace metadata,
  canonicalization, attribution, and separate challenge graphs.
- Preserve reduced-motion, high-contrast, zoom, and narrow-screen behavior as
  the visual system evolves.
