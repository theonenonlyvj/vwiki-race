---
written: 2026-09-19
by: Codex; session 01a0b9c8-6b20-7fc1-8e84-cb9474b10f3c
supersedes: none
---

# Daily performance audit: August 20–September 18, 2026

Recommendation: replace automatic Thursday/Friday weird selection with the recognizable selection used Monday–Wednesday. Preserve weekend hard selection. Keep unusual subjects available for deliberately vetted editorial picks. This is an audit recommendation; no scheduling, code, queue, or production changes were made.

Owner input, September 19: “DNF days are bad, i think we need to ditch the thurs/fri algo”. The hypothesis was tested against the complete visible daily boards rather than assumed.

## Evidence and measurement

Production GET /api/v2/challenges and GET /api/v2/challenges/{id}/board, fetched September 19 around 13:10–13:13 UTC. Main window: 30 completed Central daily dates, excluding today's incomplete September 19 challenge. Every date has a published daily, all selected automatically. Context window starts August 1.

Raw responses and reproducible calculations are gitignored at `.private/audit-2026-09-19/`; run `python3 .private/audit-2026-09-19/analyze.py`. Account identifiers and individual records are deliberately absent from this report. Local source reviewed at a7ac477; deployed Worker revision could not be verified because the configured Wrangler authentication was unavailable.

Unit: one account per challenge, as represented by the public board. A finish overrides that account's earlier DNFs. DNF means a board-visible abandonment with at least two clicks and no ranked eligible finish. Excludes active runs, sub-threshold abandons, excluded runs and unranked completions. These are current board outcomes, including later replays, NOT first-attempt failure rates or necessarily activity on the original daily date. The API has a 100-row cap per outcome group; no board approached it. Assertions checked account uniqueness and disjoint finish/DNF groups.

## Results

| Scheduled group | Days | Finishes | DNF-only | DNF share | Median successful decision time |
|---|---:|---:|---:|---:|---:|
| Mon–Wed recognizable | 12 | 91 | 8 | 8.1% | 1.17 min |
| Thu–Fri weird | 10 | 36 | 17 | 32.1% | 5.26 min |
| Sat–Sun hard | 8 | 58 | 5 | 7.9% | 2.14 min |

Receipt: weird = 17 / (36 + 17); other groups = 13 / (149 + 13); rate ratio = 4.00. Overall: 185 finishes and 30 DNF-only outcomes across 215 account-challenges. Successful times exclude fetch/synchronization latency by game design and describe survivors, not all attempts.

The Thursday/Friday hypothesis is supported descriptively (10 challenge dates, 53 account-challenges): approximately four times the DNF share of the other groups combined. It is not a randomized algorithm comparison: players, weekdays, targets and starts differ, and repeated players are not independent observations.

Friday is the worse half: 13/27 DNF-only outcomes (48.1%), versus Thursday 4/26 (15.4%). September 4 (Schmidt sting pain index) and September 11 (Buffalo buffalo…) each had one finisher and four DNF-only players. September 10 (Gabriel's horn) was one finish/one DNF. September 17 (Bild Lilli doll) was four finishes/two DNFs. Weird selection also produced healthy days, including August 20 and September 3 (six finishes, zero DNFs each); the problem is reliability, not universal impossibility.

No played day in the main window has zero finishers. September 18 has zero visible outcomes and must not be called an all-DNF day or a generation outage. Its challenge exists. Hidden active/sub-threshold runs cannot be checked through this endpoint.

## Participation

Equal weekday-balanced periods:

- August 20–September 2: 119 account-challenges, 8.50 per daily, 36 distinct visible accounts.
- September 3–16: 90 account-challenges, 6.43 per daily, 17 distinct visible accounts.
- Difference: (119 - 90) / 119 = 24.4% fewer account-challenges. Overall DNF share rose from 11/119 (9.2%) to 17/90 (18.9%). Weird share rose from 6/29 (20.7%) to 9/18 (50.0%).

This is lower participation on newer daily boards, not proof of churn caused by weird days. Older boards have had more time for late replays; account counts also cannot establish unique human counts. A run-timestamp/first-attempt cohort audit needs D1 access. All flavors show some participation decline.

## Mechanism inspected

`src/domain/dailyEditorial.ts` maps Thursday/Friday to weird. `src/server/dailyCandidateEvaluator.ts` requires only 30 inbound links for weird targets versus 150 for recognizable/hard, and recognizable alone has a pageviews floor. `dailyCandidateScoring.ts` rewards unusual editorial membership and common article-quality features; it does not validate a playable route as a condition of selection.

The selected pair survives a missing reference path: `maybeFindReferencePath` returns null on a miss or error. Its bounded search uses Wikipedia link metadata for intermediate edges, which does not establish that every edge survives the game's sanitizer. These are verified local code properties and plausible mechanisms for frustrating challenges; they do not establish the cause of any specific player's DNF or prove a selected target unreachable. Historical manual editorial successes are context, not a controlled comparison.

## Ranked actions

1. Retire automatic weird selection on Thursday/Friday; use recognizable then. This directly removes the group with the observed reliability problem while preserving daily generation. Before release, check the remaining recognizable pool against all-time target exclusions: increasing its frequency consumes the finite pool faster.
2. Add a verified playable-route acceptance gate with a vetted fallback. Every hop must survive the actual game sanitizer; keep the existing direct-edge rejection. Do not merely require the current best-effort metadata path to be non-null. Scope fallback and request-budget behavior before building so the fix does not create missing-daily outages.
3. Recheck the same outcome metrics after the change, and obtain run-level data for first-attempt outcomes, duration and actual return visits. No retention-causation claim is supported yet.

Things to retain, ranked: recognizable selection's completion reliability (12 dates); weekend selection's current performance (8 dates); reproducible board-based measurements with explicit non-attempt filtering. All dates published a daily, so there is no visible scheduler continuity failure to repair in this window.

Capacity context: a small recurring player population, with only 53 weird account-challenges and repeated participants. No implementation, commits, or deploys were performed.

## Daily receipt

| Date | Flavor | Target | Finished | DNF-only |
|---|---|---|---:|---:|
| 2026-08-20 | weird | Taikyoku shogi | 6 | 0 |
| 2026-08-21 | weird | Colonia Dignidad | 5 | 3 |
| 2026-08-22 | hard | Chemistry | 8 | 0 |
| 2026-08-23 | hard | Bacteria | 13 | 0 |
| 2026-08-24 | recognizable | Europe | 14 | 0 |
| 2026-08-25 | recognizable | Death | 11 | 0 |
| 2026-08-26 | recognizable | Society | 7 | 3 |
| 2026-08-27 | weird | Cadaver Synod | 5 | 1 |
| 2026-08-28 | weird | Advice to a Friend on Choosing a Mistress | 7 | 2 |
| 2026-08-29 | hard | Communication | 5 | 1 |
| 2026-08-30 | hard | Jersey Devil | 8 | 0 |
| 2026-08-31 | recognizable | The arts | 7 | 0 |
| 2026-09-01 | recognizable | Universe | 6 | 1 |
| 2026-09-02 | recognizable | Evolution | 6 | 0 |
| 2026-09-03 | weird | Sajjad Ganjzadeh | 6 | 0 |
| 2026-09-04 | weird | Schmidt sting pain index | 1 | 4 |
| 2026-09-05 | hard | Uday Hussein | 5 | 1 |
| 2026-09-06 | hard | Video game | 10 | 0 |
| 2026-09-07 | recognizable | Time | 6 | 1 |
| 2026-09-08 | recognizable | Music | 10 | 1 |
| 2026-09-09 | recognizable | History | 6 | 2 |
| 2026-09-10 | weird | Gabriel's horn | 1 | 1 |
| 2026-09-11 | weird | Buffalo buffalo Buffalo buffalo buffalo buffalo Buffalo buffalo | 1 | 4 |
| 2026-09-12 | hard | Fish | 6 | 0 |
| 2026-09-13 | hard | COVID-19 pandemic in Antarctica | 3 | 3 |
| 2026-09-14 | recognizable | Cell (biology) | 6 | 0 |
| 2026-09-15 | recognizable | North America | 6 | 0 |
| 2026-09-16 | recognizable | Asia | 6 | 0 |
| 2026-09-17 | weird | Bild Lilli doll | 4 | 2 |
| 2026-09-18 | weird | George Psalmanazar | 0 | 0 |
