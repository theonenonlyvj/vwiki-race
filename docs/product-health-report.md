---
written: 2026-09-19
by: Codex; session 01a0b9c8-6b20-7fc1-8e84-cb9474b10f3c
supersedes: none
---
# Read-only product health report

Run from this repository with the configured Cloudflare/Wrangler authorization:

```sh
npm run report:health
```

This issues four SELECT queries against the existing game database. It never starts a race, changes a player, writes D1, or sends new browser telemetry. The dated report directory is ignored under `.private/product-health/`. The CLI prints only the output path and completion status. It saves aggregate `report.json`, readable `report.md`, and a private pseudonymous `snapshot.json`; it does not save raw query results. Treat hashes as private data, not anonymous public identifiers. Never commit these artifacts.

For a repeat comparison, retain the first snapshot and pass its path:

```sh
npm run report:health -- --previous .private/product-health/BASELINE/snapshot.json
```

For deterministic offline verification against a separately held private source snapshot:

```sh
npm run report:health -- --input .private/source.json --as-of 2026-09-19T20:00:00.000Z --days 28 --output .private/health-check
```

Output directories must be beneath `.private/`; existing report files are never overwritten. Input shape is `{ capturedAt, profiles, aliases, runs, dailyFeatures }`; the CLI query selects only the columns used by the report module. Do not substitute credential exports or path/click payloads.

## Interpretation

The report includes full definitions and limitations. Daily completion is one canonical player per challenge, by the challenge's assigned Central daily date. Archive replays can update an old daily's result. It reports both mature-start completion (including quick exits) and engaged finish rate (eligible finishes plus failures with at least two clicks). An unexpired run is pending, not a DNF; lazy-expired active runs are shown separately in both Markdown and JSON. A completion always wins over other attempts by that player. Current account aliases prevent confirmed merged accounts from inflating denominators.

Returning players are current-window counted players with earlier observed counted play. Seven-day repeat is a different measure: first-observed players with a complete seven-day follow-up, returning on days +1 through +7. Neither means website visitor retention. First observed play is not registration time; profile updated_at is not used as a creation date.

Duplicate-name groups compare trimmed, case-folded current canonical profile names. These are candidates for review, never automatic merges. The initial snapshot is only a baseline; compare future snapshots to detect new, grown, and resolved name groups, plus newly observed account IDs now in candidate groups. Hashes support private comparison without rendering names in reports.

The default window is 28 complete Central days, excluding today. As-of bounds known starts and terminal timestamps but does not reconstruct mutable historical identities, click counts or moderation decisions. Use captured snapshots for reproducibility; do not present a backdated calculation from current data as a historical snapshot.

No automatic schedule is installed. An agent runs the report when requested. The first baseline predates any measurable effect of the visual release; it cannot prove that today's changes improved completion or return play.
