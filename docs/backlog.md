# VWiki Race Backlog

Date: 2026-07-17

Production covers the friend-ready v0 game loop plus the editorial Daily and
creation-time nomination release. Items below are deliberately outside that
release unless marked as an operational gate. Resume from
[`handoff/START_HERE.md`](handoff/START_HERE.md).

## Operational Gates

- Repeat responsive production browser QA and resolve any P0/P1 council finding
  before each friend release.
- Run the complete release gate in the Cloudflare handoff on every shipment.
- Deploy Worker before Pages when both changed, then run the documented
  production smoke test.
- Migration `0005` is applied and verified. Before any future schema release,
  inspect the remote D1 ledger, take a private backup, and apply only the next
  reviewed additive migration. Never replay `0005`.
- Confirm Cloudflare request counts after the first scheduled day; do not
  generate repeated manual cron events.

## Current Daily System

- Central weekday flavoring is implemented: `recognizable` Monday-Wednesday,
  `weird` Thursday-Friday, and `hard` Saturday-Sunday.
- Editorial target pools are cached for 24 hours, with stale data allowed for
  up to seven days. Automatic evaluation is deterministic and bounded to at
  most 10 targets, 3 random starts, 40 Wikimedia subrequests, and 25 seconds.
- Challenge pairs are unique by ordered start/target/ruleset, duplicate pairs
  reuse the existing challenge, and each challenge can be featured as a Daily
  only once.
- Claimed users can nominate only during challenge creation. Admin approval
  feeds a per-flavor FIFO queue, and direct admin promotion is supported. The
  scheduler consumes the queue before automatic selection.
- `hard` remains a bounded scoring proxy. There is no full Wikipedia graph or
  exact shortest-path claim yet.

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
- Replace the current bounded `hard` proxy with graph-backed difficulty only
  after a cached/offline graph exists; do not claim exact shortest paths before
  then.
- Add streaks, reminders, and notifications only after the core return loop is
  measured.

## Next Product Priority

Reimagine the main product as four distinct screen experiences: Play,
Leaderboard, Challenges, and Stats. Start this UI/product project after the
editorial Daily release; keep it separate from the current Daily scheduler,
queue, and nomination contracts.

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
