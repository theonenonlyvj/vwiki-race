# Daily Challenge Design

## Goal

Create one immutable numbered VWiki Race challenge for each `America/Chicago`
calendar date when Wikipedia and D1 are available. D1 guarantees at most one accepted row per
date; a durable backlog retries missing dates until one is accepted. No system
can guarantee existence during an indefinite external outage, so the operational
promise is eventual coverage after dependencies recover. Each endpoint is
selected by Wikipedia's random-page service, not an application-maintained list
or a pseudorandom index over cached articles. Daily challenges are additive and
remain playable at permanent challenge URLs.

## Selection

The Worker calls the English Wikipedia Action API with `generator=random`,
`grnnamespace=0`, `grnfilterredir=nonredirects`, `grnlimit=1`, and `prop=info`.
MediaWiki documents that only the sequence starting point is random, so start
and target come from two separate random-generator requests and are never two
items from one response. The product does not claim statistical independence.

The random responses provide canonical title, namespace, and page ID directly.
The target needs no second title-resolution request. The start is rendered once
through the canonical `WikipediaGateway.getArticle` contract defined by Task 5
of `2026-07-14-council-hardening.md`; its result confirms the same page ID and
returns moves filtered by the shared `isAllowedArticleHref` gameplay predicate.
Missing, malformed,
redirect, non-main-namespace, duplicate-page, and dead-start candidates are
rejected.

One job tries at most three candidate pairs. A successful pair therefore uses
two random requests plus one start-render validation; an invocation makes at
most nine Wikipedia requests. Every request has a five-second timeout and the
generation phase has a 25-second total deadline. Failure never falls back to a
hard-coded challenge.

Reference: [MediaWiki API:Random](https://www.mediawiki.org/wiki/API:Random/en).

## Scheduling And Idempotency

The API Worker exposes a module `scheduled()` handler and two Wrangler cron
triggers: `0 10 * * *` and `0 11 * * *`. Cloudflare schedules cron in UTC, so
these cover 5:00 AM Central in daylight and standard time. The handler formats
the event in `America/Chicago`; the trigger that is not exactly 5:00 AM exits
before D1 or Wikipedia access. Only the invocation holding a generation lease
may contact Wikipedia.

The eligible invocation inserts the current Central `YYYY-MM-DD` job if absent, then attempts to
claim the oldest due pending or expired job. `daily_challenge_jobs` stores date,
status (`pending`, `claimed`, `accepted`), attempt count, next-attempt time,
lease token/expiry, accepted challenge ID, and a redacted failure code. Claiming
is one conditional D1 mutation. A loser exits without a Wikipedia request. A
crashed claim becomes eligible after a ten-minute lease.

On candidate failure, the lease holder returns the job to pending with bounded
backoff of one, two, four, then six hours. Past-date jobs remain in the backlog
and the next eligible daily invocation claims the oldest due job, so a late
failure is not permanently skipped. One invocation processes at most one job.

Acceptance is one D1 atomic operation that verifies the lease token, inserts
the immutable challenge, and marks the job accepted. A unique nullable
`daily_date` enforces at most one challenge per date. Manual legacy, manual v2,
and daily creation must use one transactional challenge-number sequence; no
other code may allocate with `MAX(sort_order) + 1`. The sequence increments
only in the same successful transaction, so failed/rejected operations do not
consume a number.

The daily date never determines or resets the challenge number. A daily row
receives the next number in the same global sequence when it is accepted: if
Challenges #1 through #15 already exist, that day's row is Challenge #16.

Challenge provenance is explicit:

- `origin: "manual" | "daily"`;
- `dailyDate: string | null`;
- `source: "curated" | "wikipedia_random"`.

Daily rows use the reserved non-user creator account `vwiki-race:daily`, display
name `VWiki Race`, and the existing claimed status solely for schema
compatibility. UI attribution uses `origin`, not an implication that this is a
VGames user.

Reference: [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/).

## Catalog And UX

The challenge catalog marks daily rows with `origin` and `dailyDate`. Selection
precedence is: resumable active run, valid direct `?challenge=` URL, today's
accepted daily row, then the first active catalog row. Historical daily
challenges remain ordinary numbered catalog entries.

The Play header uses a compact `Daily` marker and the date without displacing
the challenge number or start/target titles. The feature adds no separate daily
page, streak economy, notification system, or calendar UI in this release.

## Failure Behavior

- If today's row is accepted and no older due job exists, the scheduled
  invocation performs no Wikipedia call.
- If Wikipedia times out, rate-limits, or yields no valid pair within the
  fixed budget, the invocation records a redacted retry state and throws so the
  Cloudflare event is visibly unsuccessful. A later due invocation reclaims it.
- A failure never inserts a partial or unvalidated challenge.
- If D1 reports a date conflict after candidate selection, acceptance reads the
  existing challenge, marks the job accepted, and does not allocate a number.

## Tests

- Two separate `generator=random` requests supply the endpoints; one response
  never supplies both.
- Namespace, redirect, and candidate validation parameters are exact.
- Same-page, missing, redirect, and dead-start candidates are retried within a
  three-pair/nine-request budget with five-second request and 25-second phase
  deadlines.
- Concurrent invocations produce one lease winner and only one set of
  Wikipedia requests; an expired lease is reclaimable.
- Same UTC date sequential and concurrent invocations return one challenge and
  one challenge number.
- Manual legacy, manual v2, and later daily creation share one gap-free
  transactional number sequence.
- A failed late-date job remains in the durable backlog and is retried after the
  UTC date changes.
- Existing daily rows prevent all Wikipedia requests.
- Partial Wikipedia/D1 failure leaves no challenge or consumed number.
- Catalog metadata and default selection honor active runs, direct URLs, then
  today's daily row.
- Scheduled-handler local tests use Cloudflare's supported scheduled endpoint.

## Scope Boundary

This release does not try to prove that a random pair is connected, estimate a
shortest path, tune pair difficulty, or regenerate unpopular challenges. Those
are graph-analysis features for a later version.
