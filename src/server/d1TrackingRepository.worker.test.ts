import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { centralDateDaysBefore } from "../domain/challengeSelection";
import type { AuthorizedAccount } from "../domain/types";
import { createApiHandlers } from "./apiHandlers";
import { DailyChallengeCandidateError } from "./dailyCandidateEvaluator";
import type { ValidateChallengeArticles } from "./wikipediaChallengeValidator";
import {
  createD1TrackingRepository,
  type D1DatabaseLike,
} from "./d1TrackingRepository";
import { ApiError } from "./http";
import { createWorker, type WorkerTracking } from "./worker";

const account: AuthorizedAccount = {
  accountId: "account-canonical",
  displayName: "Casey",
  status: "claimed",
  aliases: [],
};

const start = {
  challengeId: "challenge-0001",
  idempotencyKey: "start-00000000-0000-4000-8000-000000000001",
};

const targetClick = {
  runId: "run-1",
  clientEventId: "00000000-0000-4000-8000-000000000101",
  expectedStepNumber: 1,
  sourceTitle: "Moon",
  sourcePageId: 19331,
  sourceRevisionId: 123,
  clickedAnchorText: "gravity",
  requestedTitle: "Gravity",
  destinationTitle: "Gravity",
  destinationPageId: 38579,
  decisionElapsedMs: 4200,
  clientObservedAt: "2026-07-14T01:00:04.200Z",
};

beforeEach(async () => {
  await env.VWIKI_RACE_DB.exec(`
    DROP TRIGGER IF EXISTS force_click_failure;
    DROP TRIGGER IF EXISTS force_pair_winner;
    DELETE FROM daily_features WHERE challenge_id NOT IN ('challenge-0001', 'challenge-0002', 'challenge-0003');
    DELETE FROM daily_challenge_jobs;
    DELETE FROM daily_queue_entries;
    DELETE FROM daily_nominations;
    DELETE FROM operation_idempotency;
    DELETE FROM run_path_steps;
    DELETE FROM run_events;
    DELETE FROM runs;
    DELETE FROM account_aliases;
    DELETE FROM account_profiles;
  `);
  await env.VWIKI_RACE_DB.prepare(
    "DELETE FROM challenges WHERE id NOT IN ('challenge-0001', 'challenge-0002', 'challenge-0003')",
  ).run();
  await env.VWIKI_RACE_DB.prepare(
    "UPDATE challenge_number_sequence SET next_sort_order = 4 WHERE sequence_name = 'global'",
  ).run();
  // "I gave up" (owner spec, 2026-08-02): reset the fixture challenges' own
  // mutable `reference_path` column each test - a prior test setting it on
  // challenge-0001 would otherwise leak into every later test in the file
  // (this column isn't touched by the DELETE above, which only removes
  // non-fixture challenge ROWS, not fixture-row column mutations).
  await env.VWIKI_RACE_DB.prepare(
    "UPDATE challenges SET reference_path = NULL WHERE id IN ('challenge-0001', 'challenge-0002', 'challenge-0003')",
  ).run();
});

describe("hardening migration", () => {
  it("creates the exact compatibility schema and migration outcomes", async () => {
    const challengeColumns = await columns("challenges");
    expect(challengeColumns).toEqual(
      expect.arrayContaining([
        "start_page_id",
        "target_page_id",
        "validation_status",
      ]),
    );

    const runColumns = await columns("runs");
    expect(runColumns).toEqual(
      expect.arrayContaining([
        "start_page_id",
        "target_page_id",
        "last_page_id",
        "last_title",
        "expires_at",
        "wall_elapsed_ms",
        "canonical_account_id",
        "ranked_eligible",
        "protocol_version",
      ]),
    );
    const runInfo = await tableInfo("runs");
    expect(runInfo.find((column) => column.name === "protocol_version")).toMatchObject({
      notnull: 1,
      dflt_value: "1",
    });
    expect(runInfo.find((column) => column.name === "ranked_eligible")).toMatchObject({
      notnull: 1,
      dflt_value: "0",
    });

    const eventColumns = await columns("run_events");
    expect(eventColumns).toEqual(
      expect.arrayContaining([
        "client_event_id",
        "request_fingerprint",
        "source_page_id",
        "source_revision_id",
        "response_click_count",
        "response_run_status",
        "response_completed_at",
        "response_elapsed_ms",
      ]),
    );

    await expect(count("account_aliases")).resolves.toBe(0);
    await expect(count("operation_idempotency")).resolves.toBe(0);

    const runsSql = normalizeSql(await schemaSql("table", "runs"));
    expect(runsSql).toContain(
      "ranked_eligible integer not null default 0 check ( ranked_eligible in (0, 1) )",
    );
    expect(runsSql).toContain(
      "protocol_version integer not null default 1 check ( protocol_version in (1, 2) )",
    );
    const operationsSql = normalizeSql(await schemaSql("table", "operation_idempotency"));
    expect(operationsSql).toContain(
      "outcome_status text not null check ( outcome_status in ('pending', 'accepted', 'rejected') )",
    );

    expect(normalizeSql(await schemaSql(
      "index",
      "runs_one_active_canonical_account_idx",
    ))).toContain(
      "on runs (coalesce(canonical_account_id, account_id)) where status = 'active'",
    );
    expect(normalizeSql(await schemaSql(
      "index",
      "run_events_run_client_event_idx",
    ))).toContain(
      "on run_events (run_id, client_event_id) where client_event_id is not null",
    );
    expect(normalizeSql(await schemaSql(
      "index",
      "run_path_steps_run_step_unique_idx",
    ))).toContain("on run_path_steps (run_id, step_number)");

    await expect(env.VWIKI_RACE_DB.prepare(
      `INSERT INTO operation_idempotency
         (operation, idempotency_key, canonical_account_id,
          request_fingerprint, outcome_status, created_at)
       VALUES ('start', 'invalid-outcome', 'account', 'fingerprint',
               'unknown', '2026-07-14T00:00:00.000Z')`,
    ).run()).rejects.toThrow(/constraint/i);

    const { results } = await env.VWIKI_RACE_DB.prepare(
      `SELECT id, start_title, start_page_id, target_title, target_page_id
       FROM challenges
       WHERE is_active = 1 AND validation_status = 'ready'
       ORDER BY id`,
    ).all();
    expect(results).toEqual([
      {
        id: "challenge-0001",
        start_title: "Moon",
        start_page_id: 19331,
        target_title: "Gravity",
        target_page_id: 38579,
      },
      {
        id: "challenge-0002",
        start_title: "Maraba coffee",
        start_page_id: 5478840,
        target_title: "Moon landing conspiracy theories",
        target_page_id: 80740,
      },
      {
        id: "challenge-0003",
        start_title: "FedEx",
        start_page_id: 77543,
        target_title: "Vladimir Lenin",
        target_page_id: 11015252,
      },
    ]);

    await expect(
      scalar(
        `SELECT COUNT(*) FROM challenges
         WHERE is_active = 1 AND id NOT IN ('challenge-0001', 'challenge-0002', 'challenge-0003')`,
      ),
    ).resolves.toBe(0);
    await expect(
      scalar("SELECT COUNT(*) FROM runs WHERE status = 'active' AND protocol_version = 1"),
    ).resolves.toBe(0);
    await expect(
      scalar("SELECT COUNT(*) FROM runs WHERE status = 'completed' AND protocol_version = 1 AND ranked_eligible = 1"),
    ).resolves.toBe(0);
  });

  it("upgrades existing challenge and legacy-run rows without duplicate inserts", async () => {
    const db = env.MIGRATION_TEST_DB;
    await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, 2), "upgrade_migrations");
    await db.prepare(
      `INSERT INTO challenges
         (id, label, start_title, target_title, ruleset, sort_order, is_active,
          created_at, created_by_account_id, created_by_display_name,
          created_by_identity_status)
       VALUES ('challenge-0002', 'Existing #2', 'Old start', 'Old target',
               'ranked_classic', 2, 1, '2026-07-13T00:00:00.000Z',
               'creator', 'Creator', 'claimed')`,
    ).run();
    await db.prepare(
      `INSERT INTO challenges
         (id, label, start_title, target_title, ruleset, sort_order, is_active,
          created_at, created_by_account_id, created_by_display_name,
          created_by_identity_status)
       VALUES ('challenge-extra', 'Extra', 'A', 'B', 'ranked_classic', 9, 1,
               '2026-07-13T00:00:00.000Z', 'creator', 'Creator', 'claimed')`,
    ).run();
    for (const [id, status] of [
      ["legacy-active", "active"],
      ["legacy-active-duplicate", "active"],
      ["legacy-complete", "completed"],
    ] as const) {
      await db.prepare(
        `INSERT INTO runs
           (id, challenge_id, account_id, status, started_at, completed_at,
            elapsed_ms, click_count, start_title, target_title, final_title,
            created_at, updated_at)
         VALUES (?, 'challenge-0001', 'legacy-account', ?,
                 '2026-07-13T00:00:00.000Z', ?, ?, 1, 'Moon', 'Gravity', ?,
                 '2026-07-13T00:00:00.000Z', '2026-07-13T00:00:01.000Z')`,
      ).bind(
        id,
        status,
        status === "completed" ? "2026-07-13T00:00:01.000Z" : null,
        status === "completed" ? 1000 : null,
        status === "completed" ? "Gravity" : null,
      ).run();
    }

    await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(2, 4), "upgrade_migrations");

    const seededLegacyDailies = [
      {
        dailyDate: "2026-07-20",
        challengeId: "legacy-daily-recognizable",
        flavor: "recognizable",
        selectionSource: "automatic",
        classifierVersion: "legacy-v1",
        createdAt: "2026-07-17T00:00:00.000Z",
      },
      {
        dailyDate: "2026-07-23",
        challengeId: "legacy-daily-weird",
        flavor: "weird",
        selectionSource: "automatic",
        classifierVersion: "legacy-v1",
        createdAt: "2026-07-17T00:00:00.000Z",
      },
      {
        dailyDate: "2026-07-25",
        challengeId: "legacy-daily-hard",
        flavor: "hard",
        selectionSource: "automatic",
        classifierVersion: "legacy-v1",
        createdAt: "2026-07-17T00:00:00.000Z",
      },
    ];
    for (const [index, daily] of seededLegacyDailies.entries()) {
      await db.prepare(
        `INSERT INTO challenges
           (id, label, start_title, target_title, ruleset, sort_order, is_active,
            created_at, created_by_account_id, created_by_display_name,
            created_by_identity_status, start_page_id, target_page_id,
            validation_status, origin, daily_date, source)
         VALUES (?, ?, ?, ?, 'ranked_classic', ?, 1,
                 '2026-07-17T00:00:00.000Z', 'creator', 'Creator', 'claimed',
                 ?, ?, 'ready', 'daily', ?, 'wikipedia_random')`,
      ).bind(
        daily.challengeId,
        `Legacy Daily #${index + 1}`,
        `Legacy start ${index + 1}`,
        `Legacy target ${index + 1}`,
        100 + index,
        9001 + index,
        9101 + index,
        daily.dailyDate,
      ).run();
    }

    await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(4), "editorial_migrations");

    for (const [table, expectedColumns] of [
      [
        "daily_nominations",
        ["id", "challenge_id", "status", "confidence", "classifier_version", "created_at"],
      ],
      [
        "daily_queue_entries",
        ["id", "challenge_id", "nomination_id", "flavor", "source", "status", "queued_at"],
      ],
      [
        "daily_features",
        ["daily_date", "challenge_id", "flavor", "selection_source", "queue_entry_id", "created_at"],
      ],
    ] as const) {
      const { results } = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
      expect(results.map((column) => column.name)).toEqual(expect.arrayContaining([...expectedColumns]));
    }
    for (const [index, expectedSql] of [
      [
        "challenges_ordered_pair_unique_idx",
        "on challenges (start_page_id, target_page_id, ruleset) where start_page_id is not null and target_page_id is not null",
      ],
      ["daily_nominations_pending_idx", "on daily_nominations (created_at, id) where status = 'pending'"],
      ["daily_queue_entries_one_queued_challenge_idx", "on daily_queue_entries (challenge_id) where status = 'queued'"],
      ["daily_queue_entries_queued_fifo_idx", "on daily_queue_entries (flavor, queued_at, id) where status = 'queued'"],
    ] as const) {
      const row = await db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
      ).bind(index).first<{ sql: string }>();
      expect(row?.sql, `${index} should exist`).toBeTruthy();
      expect(normalizeSql(row?.sql ?? "")).toContain(expectedSql);
    }
    await expect(db.prepare(
      "SELECT COUNT(*) AS count FROM daily_features WHERE daily_date IS NOT NULL",
    ).first<{ count: number }>()).resolves.toEqual({ count: 3 });
    await expect(db.prepare(
      `SELECT daily_date AS dailyDate, challenge_id AS challengeId,
              flavor, selection_source AS selectionSource,
              classifier_version AS classifierVersion, created_at AS createdAt
       FROM daily_features
       ORDER BY daily_date`,
    ).all()).resolves.toMatchObject({ results: seededLegacyDailies });
    await expect(db.prepare(
      `INSERT INTO challenges
         (id, label, start_title, target_title, ruleset, sort_order, is_active,
          created_at, start_page_id, target_page_id, validation_status)
       VALUES ('duplicate-ordered-pair', 'Duplicate pair', 'Another start',
               'Another target', 'ranked_classic', 200, 1,
               '2026-07-17T00:00:00.000Z', 9001, 9101, 'ready')`,
    ).run()).rejects.toThrow(/constraint/i);
    await expect(db.prepare(
      `INSERT INTO challenges
         (id, label, start_title, target_title, ruleset, sort_order, is_active,
          created_at, start_page_id, target_page_id, validation_status)
       VALUES ('reverse-ordered-pair', 'Reverse pair', 'Another start',
               'Another target', 'ranked_classic', 201, 1,
               '2026-07-17T00:00:00.000Z', 9101, 9001, 'ready')`,
    ).run()).resolves.toBeDefined();

    await expect(insertEditorialQueue(db, {
      id: "queue-community-without-nomination",
      challengeId: "challenge-0001",
      source: "community",
    })).rejects.toThrow(/community queue entry requires an approved nomination/i);
    await insertEditorialNomination(db, {
      id: "nomination-pending",
      challengeId: "challenge-0001",
      status: "pending",
    });
    await expect(insertEditorialQueue(db, {
      id: "queue-community-pending-nomination",
      challengeId: "challenge-0001",
      nominationId: "nomination-pending",
      source: "community",
    })).rejects.toThrow(/community queue entry requires an approved nomination/i);
    await insertEditorialNomination(db, {
      id: "nomination-approved-other-challenge",
      challengeId: "challenge-0002",
      status: "approved",
    });
    await expect(insertEditorialQueue(db, {
      id: "queue-community-mismatched-nomination",
      challengeId: "challenge-0001",
      nominationId: "nomination-approved-other-challenge",
      source: "community",
    })).rejects.toThrow(/community queue entry requires an approved nomination/i);
    await insertEditorialNomination(db, {
      id: "nomination-approved",
      challengeId: "challenge-0003",
      status: "approved",
    });
    await insertEditorialQueue(db, {
      id: "queue-community",
      challengeId: "challenge-0003",
      nominationId: "nomination-approved",
      source: "community",
    });
    await insertEditorialQueue(db, {
      id: "queue-admin",
      challengeId: "reverse-ordered-pair",
      source: "admin",
    });
    await expect(insertEditorialQueue(db, {
      id: "queue-admin-duplicate",
      challengeId: "reverse-ordered-pair",
      source: "admin",
    })).rejects.toThrow(/constraint/i);
    await expect(db.prepare(
      `UPDATE daily_queue_entries
       SET status = 'consumed', consumed_daily_date = '2026-07-28',
           consumed_at = '2026-07-17T00:01:00.000Z'
       WHERE id = 'queue-admin'`,
    ).run()).resolves.toBeDefined();
    await insertEditorialQueue(db, {
      id: "queue-admin-replacement",
      challengeId: "reverse-ordered-pair",
      source: "admin",
    });
    await expect(db.prepare(
      "UPDATE daily_nominations SET status = 'declined' WHERE id = 'nomination-approved'",
    ).run()).rejects.toThrow(/community queue entry requires an approved nomination/i);

    await expect(insertEditorialFeature(db, {
      dailyDate: "2026-07-26",
      challengeId: "challenge-0001",
      selectionSource: "automatic",
      queueEntryId: "queue-community",
    })).rejects.toThrow(/automatic daily feature cannot reference a queue entry/i);
    await expect(insertEditorialFeature(db, {
      dailyDate: "2026-07-26",
      challengeId: "challenge-0002",
      selectionSource: "community",
      queueEntryId: "queue-community",
    })).rejects.toThrow(/daily feature queue entry must match challenge and selection source/i);
    await expect(insertEditorialFeature(db, {
      dailyDate: "2026-07-26",
      challengeId: "challenge-0003",
      selectionSource: "admin",
      queueEntryId: "queue-community",
    })).rejects.toThrow(/daily feature queue entry must match challenge and selection source/i);
    await insertEditorialFeature(db, {
      dailyDate: "2026-07-27",
      challengeId: "challenge-0003",
      selectionSource: "community",
      queueEntryId: "queue-community",
    });
    await insertEditorialFeature(db, {
      dailyDate: "2026-07-28",
      challengeId: "reverse-ordered-pair",
      selectionSource: "admin",
      queueEntryId: "queue-admin",
    });
    await expect(insertEditorialFeature(db, {
      dailyDate: "2026-07-28",
      challengeId: "challenge-0003",
      selectionSource: "automatic",
    })).rejects.toThrow(/constraint/i);
    await expect(insertEditorialFeature(db, {
      dailyDate: "2026-07-29",
      challengeId: "reverse-ordered-pair",
      selectionSource: "automatic",
    })).rejects.toThrow(/constraint/i);

    await expect(db.prepare(
      "SELECT start_title, start_page_id, validation_status FROM challenges WHERE id = 'challenge-0002'",
    ).first()).resolves.toEqual({
      start_title: "Maraba coffee",
      start_page_id: 5478840,
      validation_status: "ready",
    });
    await expect(db.prepare(
      "SELECT is_active, validation_status FROM challenges WHERE id = 'challenge-extra'",
    ).first()).resolves.toEqual({ is_active: 0, validation_status: "disabled" });
    await expect(db.prepare(
      "SELECT status, protocol_version, ranked_eligible FROM runs WHERE id = 'legacy-active'",
    ).first()).resolves.toEqual({
      status: "abandoned",
      protocol_version: 1,
      ranked_eligible: 0,
    });
    await expect(db.prepare(
      "SELECT status, protocol_version, ranked_eligible FROM runs WHERE id = 'legacy-active-duplicate'",
    ).first()).resolves.toEqual({
      status: "abandoned",
      protocol_version: 1,
      ranked_eligible: 0,
    });
    await expect(db.prepare(
      "SELECT status, protocol_version, ranked_eligible FROM runs WHERE id = 'legacy-complete'",
    ).first()).resolves.toEqual({
      status: "completed",
      protocol_version: 1,
      ranked_eligible: 0,
    });
  });
});

describe("atomic D1 protocol-2 runs", () => {
  it("treats an intervening old-writer row with null canonical id as the active run", async () => {
    const at = "2026-07-14T00:00:00.000Z";
    await env.VWIKI_RACE_DB.prepare(
      `INSERT INTO runs
         (id, challenge_id, account_id, status, started_at, click_count,
          start_title, target_title, created_at, updated_at)
       VALUES ('old-writer-run', 'challenge-0001', ?, 'active', ?, 0,
               'Moon', 'Gravity', ?, ?)`,
    ).bind(account.accountId, at, at, at).run();
    const { repository } = fixture();

    await expect(repository.findActiveRun(account)).resolves.toMatchObject({
      id: "old-writer-run",
      protocolVersion: 1,
      canonicalAccountId: account.accountId,
    });
    await expect(repository.startRunV2(account, start)).rejects.toMatchObject({
      code: "active_run_exists",
    });
    await expect(repository.recordClick("old-writer-run", account.accountId, {
      sourceTitle: "Moon",
      clickedAnchorText: "orbit",
      requestedTitle: "Orbit",
      destinationTitle: "Orbit",
      destinationPageId: 1234,
    })).resolves.toEqual({ clickCount: 1 });
    await expect(
      repository.abandonRun("old-writer-run", account.accountId),
    ).resolves.toEqual({ status: "abandoned" });
    await expect(runSnapshot("old-writer-run")).resolves.toMatchObject({
      status: "abandoned",
      click_count: 1,
      canonical_account_id: null,
      protocol_version: 1,
    });
    await expect(count("runs")).resolves.toBe(1);
  });

  it("starts once, replays the same key, and stores active-run rejection outcomes", async () => {
    const clock = { now: "2026-07-14T01:00:00.000Z" };
    const { repository } = fixture(clock);
    const created = await repository.startRunV2(account, start);
    expect(created).toMatchObject({
      id: "run-1",
      protocolVersion: 2,
      clickCount: 0,
      status: "active",
      startPageId: 19331,
      targetPageId: 38579,
    });
    await expect(repository.startRunV2(account, start)).resolves.toEqual(created);

    // Give the run enough clicks to be a real, resumable run: only a run at
    // or above the 2-click floor still blocks a competing start attempt.
    await recordTwoNonTerminalClicks(repository, clock);

    const otherKey = { ...start, idempotencyKey: "start-other-key" };
    await expect(repository.startRunV2(account, otherKey)).rejects.toMatchObject({
      code: "active_run_exists",
      status: 409,
    });
    await repository.abandonRunV2(account, {
      runId: created.id,
      idempotencyKey: "abandon-started-run",
    });
    await expect(repository.startRunV2(account, otherKey)).rejects.toMatchObject({
      code: "active_run_exists",
    });

    await expect(
      repository.startRunV2(account, {
        challengeId: "challenge-0002",
        idempotencyKey: start.idempotencyKey,
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    await expect(count("runs")).resolves.toBe(1);
    await expect(count("operation_idempotency")).resolves.toBe(5);
  });

  // PKG-03 (council 2026-07-19): the abandon response used to omit
  // elapsedMs for a genuine "abandoned" outcome (only "already_completed"
  // carried it) - App.tsx's DNF snapshot fell back to the client's own
  // pre-call timer reading instead, which structurally disagreed with the
  // server's own abandoned_at-based elapsed_ms (the header showed "0:04"
  // while the eventual board row, reading the same runs.elapsed_ms this
  // test asserts on, showed "0:05"). The response now echoes the same
  // value it just persisted.
  it("echoes the server-persisted elapsedMs on a genuine abandon, not just an already-completed one", async () => {
    const clock = { now: "2026-07-14T01:00:00.000Z" };
    const { repository } = fixture(clock);
    const created = await repository.startRunV2(account, start);
    await recordTwoNonTerminalClicks(repository, clock);

    clock.now = "2026-07-14T01:00:08.500Z";
    const outcome = await repository.abandonRunV2(account, {
      runId: created.id,
      idempotencyKey: "abandon-with-elapsed",
    });

    expect(outcome).toMatchObject({ runStatus: "abandoned", elapsedMs: 8_500 });
    await expect(runSnapshot(created.id)).resolves.toMatchObject({
      status: "abandoned",
      elapsed_ms: 8_500,
    });
  });

  it("serializes concurrent same-key start and click retries to one write set", async () => {
    const clock = { now: "2026-07-14T01:00:00.000Z" };
    const { repository } = fixture(clock);

    const [firstStart, secondStart] = await Promise.all([
      repository.startRunV2(account, start),
      repository.startRunV2(account, start),
    ]);
    expect(secondStart).toEqual(firstStart);
    await expect(count("runs")).resolves.toBe(1);
    await expect(scalar(
      "SELECT COUNT(*) FROM operation_idempotency WHERE operation = 'start'",
    )).resolves.toBe(1);

    clock.now = "2026-07-14T01:00:04.200Z";
    const [firstClick, secondClick] = await Promise.all([
      repository.recordClickV2(account, targetClick),
      repository.recordClickV2(account, targetClick),
    ]);
    expect(secondClick).toEqual(firstClick);
    await expect(count("run_events")).resolves.toBe(2);
    await expect(count("run_path_steps")).resolves.toBe(1);
    await expect(scalar(
      "SELECT COUNT(*) FROM operation_idempotency WHERE operation = 'click'",
    )).resolves.toBe(1);
    await expect(runSnapshot("run-1")).resolves.toMatchObject({
      status: "completed",
      click_count: 1,
    });
  });

  it("ingests aliases, abandons alias-owned active runs, and discovers active runs across versions", async () => {
    await insertLegacyRun({
      id: "legacy-alias-run",
      accountId: "account-old",
      challengeId: "challenge-0002",
    });
    const merged = { ...account, aliases: ["account-old", "account-older"] };
    const { repository } = fixture();

    const created = await repository.startRunV2(merged, start);
    expect(created.protocolVersion).toBe(2);
    await expect(runStatus("legacy-alias-run")).resolves.toBe("abandoned");
    // click_count is incidental here (RC-02 root-cause fix: findActiveRun no
    // longer gates on it - see the "findActiveRun surfaces active runs
    // regardless of click count" describe block) - bumped anyway just to
    // exercise a non-zero value alongside the alias/cross-protocol discovery
    // this test is actually about.
    await env.VWIKI_RACE_DB.prepare("UPDATE runs SET click_count = 2 WHERE id = ?")
      .bind(created.id).run();
    await expect(repository.findActiveRun(merged)).resolves.toMatchObject({
      id: created.id,
      protocolVersion: 2,
    });

    const alias = await env.VWIKI_RACE_DB.prepare(
      "SELECT canonical_account_id FROM account_aliases WHERE alias_account_id = ?",
    ).bind("account-old").first<{ canonical_account_id: string }>();
    expect(alias?.canonical_account_id).toBe(account.accountId);
  });

  it("accepts a target click atomically and replays its immutable terminal transition", async () => {
    const clock = { now: "2026-07-14T01:00:00.000Z" };
    const { repository } = fixture(clock);
    await repository.startRunV2(account, start);
    clock.now = "2026-07-14T01:00:04.200Z";

    const completed = await repository.recordClickV2(account, targetClick);
    expect(completed.transition).toEqual({
      runId: "run-1",
      runStatus: "completed",
      clickCount: 1,
      completedAt: clock.now,
      elapsedMs: 4200,
    });
    expect(completed.leaderboardContext).toEqual({
      isPersonalBest: true,
      rank: 1,
    });
    await expect(repository.recordClickV2(account, targetClick)).resolves.toEqual(completed);

    await expect(count("run_events")).resolves.toBe(2);
    await expect(count("run_path_steps")).resolves.toBe(1);
    await expect(runSnapshot("run-1")).resolves.toMatchObject({
      status: "completed",
      click_count: 1,
      elapsed_ms: 4200,
      wall_elapsed_ms: 4200,
      last_page_id: 38579,
    });

    const operation = await operationRow("click", `click:${targetClick.runId}:${targetClick.clientEventId}`);
    expect(operation).toMatchObject({ outcome_status: "accepted", error_code: null });
    expect(String(operation?.response_json)).not.toContain("leaderboardContext");
  });

  it("rejects a reused click event with a different fingerprint before terminal state checks", async () => {
    const clock = { now: "2026-07-14T01:00:00.000Z" };
    const { repository } = fixture(clock);
    await repository.startRunV2(account, start);
    clock.now = "2026-07-14T01:00:04.200Z";
    await repository.recordClickV2(account, targetClick);

    await expect(
      repository.recordClickV2(account, {
        ...targetClick,
        clickedAnchorText: "different",
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    await expect(count("run_events")).resolves.toBe(2);
  });

  it.each([
    ["stale_step", { expectedStepNumber: 2 }],
    ["source_page_mismatch", { sourcePageId: 999 }],
    ["invalid_decision_time", { decisionElapsedMs: -1 }],
    ["invalid_decision_time", { decisionElapsedMs: 4.2 }],
    ["invalid_decision_time", { decisionElapsedMs: 10001 }],
  ])("stores %s as a rejected zero-row CAS without gameplay mutation", async (code, change) => {
    const clock = { now: "2026-07-14T01:00:00.000Z" };
    const { repository } = fixture(clock);
    await repository.startRunV2(account, start);
    clock.now = "2026-07-14T01:00:04.200Z";
    const click = { ...targetClick, ...change };

    await expect(repository.recordClickV2(account, click)).rejects.toMatchObject({
      code,
      status: 409,
    });
    await expect(repository.recordClickV2(account, click)).rejects.toMatchObject({ code });
    await expect(count("run_events")).resolves.toBe(1);
    await expect(count("run_path_steps")).resolves.toBe(0);
    await expect(runSnapshot("run-1")).resolves.toMatchObject({
      status: "active",
      click_count: 0,
      last_page_id: 19331,
    });
    await expect(
      operationRow("click", `click:${click.runId}:${click.clientEventId}`),
    ).resolves.toMatchObject({ outcome_status: "rejected", error_code: code });
  });

  it.each([0, -1, Number.MAX_SAFE_INTEGER + 1, 1.5])(
    "stores invalid source revision %s as a replayable typed rejection",
    async (sourceRevisionId) => {
      const clock = { now: "2026-07-14T01:00:00.000Z" };
      const { repository } = fixture(clock);
      await repository.startRunV2(account, start);
      clock.now = "2026-07-14T01:00:04.200Z";
      const click = { ...targetClick, sourceRevisionId };

      await expect(repository.recordClickV2(account, click)).rejects.toMatchObject({
        code: "invalid_source_revision",
        status: 409,
      });
      await expect(repository.recordClickV2(account, click)).rejects.toMatchObject({
        code: "invalid_source_revision",
        status: 409,
      });
      await expect(count("run_events")).resolves.toBe(1);
      await expect(count("run_path_steps")).resolves.toBe(0);
      await expect(runSnapshot("run-1")).resolves.toMatchObject({
        status: "active",
        click_count: 0,
        last_page_id: 19331,
      });
      await expect(
        operationRow("click", `click:${click.runId}:${click.clientEventId}`),
      ).resolves.toMatchObject({
        outcome_status: "rejected",
        error_code: "invalid_source_revision",
      });
    },
  );

  it("rejects expired and click-limited runs without event, path, or run mutation", async () => {
    const expiredClock = { now: "2026-07-14T01:00:00.000Z" };
    const expired = fixture(expiredClock).repository;
    await expired.startRunV2(account, start);
    expiredClock.now = "2026-07-15T01:00:00.001Z";
    await expect(expired.recordClickV2(account, targetClick)).rejects.toMatchObject({
      code: "run_expired",
    });
    await expect(count("run_events")).resolves.toBe(1);
    await expect(count("run_path_steps")).resolves.toBe(0);

    const limitedAccount = { ...account, accountId: "account-limited" };
    const limited = fixture(
      { now: "2026-07-14T02:00:00.000Z" },
      "run-limited",
    ).repository;
    const limitedRun = await limited.startRunV2(limitedAccount, {
      ...start,
      idempotencyKey: "limited-start",
    });
    await env.VWIKI_RACE_DB.prepare(
      "UPDATE runs SET click_count = 250 WHERE id = ?",
    ).bind(limitedRun.id).run();
    await expect(
      limited.recordClickV2(limitedAccount, {
        ...targetClick,
        runId: limitedRun.id,
        expectedStepNumber: 251,
        clientEventId: "00000000-0000-4000-8000-000000000250",
      }),
    ).rejects.toMatchObject({ code: "click_limit_reached" });
    await expect(runSnapshot(limitedRun.id)).resolves.toMatchObject({ click_count: 250 });
  });

  it("serializes concurrent clicks so only one expected next step wins", async () => {
    const clock = { now: "2026-07-14T01:00:00.000Z" };
    const { repository } = fixture(clock);
    await repository.startRunV2(account, start);
    clock.now = "2026-07-14T01:00:01.000Z";
    const clickA = { ...targetClick, destinationPageId: 1234, destinationTitle: "A" };
    const clickB = {
      ...clickA,
      clientEventId: "00000000-0000-4000-8000-000000000102",
      destinationPageId: 5678,
      destinationTitle: "B",
    };

    const outcomes = await Promise.allSettled([
      repository.recordClickV2(account, clickA),
      repository.recordClickV2(account, clickB),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    await expect(count("run_events")).resolves.toBe(2);
    await expect(count("run_path_steps")).resolves.toBe(1);
    await expect(runSnapshot("run-1")).resolves.toMatchObject({ click_count: 1 });
  });

  it("rejects decision time that decreases after an accepted active click", async () => {
    const clock = { now: "2026-07-14T01:00:00.000Z" };
    const { repository } = fixture(clock);
    await repository.startRunV2(account, start);
    clock.now = "2026-07-14T01:00:04.000Z";
    await repository.recordClickV2(account, {
      ...targetClick,
      destinationTitle: "Orbit",
      destinationPageId: 1234,
      decisionElapsedMs: 4000,
    });
    clock.now = "2026-07-14T01:00:05.000Z";

    await expect(repository.recordClickV2(account, {
      ...targetClick,
      clientEventId: "00000000-0000-4000-8000-000000000103",
      expectedStepNumber: 2,
      sourceTitle: "Orbit",
      sourcePageId: 1234,
      decisionElapsedMs: 3999,
    })).rejects.toMatchObject({ code: "invalid_decision_time" });
    await expect(runSnapshot("run-1")).resolves.toMatchObject({
      status: "active",
      click_count: 1,
      elapsed_ms: 4000,
    });
  });

  it("recomputes leaderboard context while replaying the same immutable transition", async () => {
    const clock = { now: "2026-07-14T01:00:00.000Z" };
    const { repository } = fixture(clock);
    await repository.startRunV2(account, start);
    clock.now = "2026-07-14T01:00:04.200Z";
    const first = await repository.recordClickV2(account, targetClick);
    await insertCompletedV2({
      id: "faster-competitor",
      accountId: "account-faster",
      elapsedMs: 3000,
      completedAt: "2026-07-14T01:00:03.000Z",
    });
    await insertCompletedV2({
      id: "faster-repeat",
      accountId: "account-faster",
      elapsedMs: 3500,
      completedAt: "2026-07-14T01:00:03.500Z",
    });

    const replay = await repository.recordClickV2(account, targetClick);
    expect(replay.transition).toEqual(first.transition);
    expect(first.leaderboardContext).toEqual({ isPersonalBest: true, rank: 1 });
    expect(replay.leaderboardContext).toEqual({ isPersonalBest: true, rank: 3 });
  });

  it("spans active-run uniqueness across protocols and forbids v2 clicks on protocol 1", async () => {
    await insertLegacyRun({ id: "legacy-active", accountId: account.accountId });
    const { repository } = fixture();

    await expect(repository.findActiveRun(account)).resolves.toMatchObject({
      id: "legacy-active",
      protocolVersion: 1,
    });
    await expect(repository.startRunV2(account, start)).rejects.toMatchObject({
      code: "active_run_exists",
    });
    await expect(repository.recordClickV2(account, {
      ...targetClick,
      runId: "legacy-active",
    })).rejects.toMatchObject({ code: "protocol_mismatch" });
    await expect(runSnapshot("legacy-active")).resolves.toMatchObject({
      status: "active",
      click_count: 0,
    });
  });

  it("serializes a terminal click against abandonment without overwriting completion", async () => {
    const clock = { now: "2026-07-14T01:00:00.000Z" };
    const { repository } = fixture(clock);
    await repository.startRunV2(account, start);
    clock.now = "2026-07-14T01:00:04.200Z";

    await Promise.allSettled([
      repository.recordClickV2(account, targetClick),
      repository.abandonRunV2(account, {
        runId: "run-1",
        idempotencyKey: "abandon-race-key",
      }),
    ]);

    const snapshot = await runSnapshot("run-1");
    expect(["completed", "abandoned"]).toContain(snapshot?.status);
    if (snapshot?.status === "completed") {
      expect(snapshot.completed_at).toBe(clock.now);
      expect(snapshot.abandoned_at).toBeNull();
    }
    await expect(count("run_path_steps")).resolves.toBe(snapshot?.status === "completed" ? 1 : 0);
  });

  it("allows only the exact winning abandon operation at an identical timestamp", async () => {
    const clock = { now: "2026-07-14T01:00:00.000Z" };
    const { repository } = fixture(clock);
    await repository.startRunV2(account, start);
    clock.now = "2026-07-14T01:00:05.000Z";

    const outcomes = await Promise.allSettled([
      repository.abandonRunV2(account, {
        runId: "run-1",
        idempotencyKey: "abandon-same-time-a",
      }),
      repository.abandonRunV2(account, {
        runId: "run-1",
        idempotencyKey: "abandon-same-time-b",
      }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "run_not_active" },
    });
    await expect(scalar(
      "SELECT COUNT(*) FROM run_events WHERE run_id = 'run-1' AND event_type = 'run_abandoned'",
    )).resolves.toBe(1);
    await expect(scalar(
      "SELECT COUNT(*) FROM operation_idempotency WHERE operation = 'abandon' AND outcome_status = 'accepted'",
    )).resolves.toBe(1);
    await expect(scalar(
      "SELECT COUNT(*) FROM operation_idempotency WHERE operation = 'abandon' AND outcome_status = 'rejected'",
    )).resolves.toBe(1);
    await expect(runSnapshot("run-1")).resolves.toMatchObject({
      status: "abandoned",
      abandoned_at: clock.now,
    });
  });

  it("rolls the entire click batch back on a real SQL statement failure", async () => {
    const clock = { now: "2026-07-14T01:00:00.000Z" };
    const { repository } = fixture(clock);
    await repository.startRunV2(account, start);
    await env.VWIKI_RACE_DB.prepare(
      `CREATE TRIGGER force_click_failure
       BEFORE INSERT ON run_events
       WHEN NEW.client_event_id = '00000000-0000-4000-8000-000000000999'
       BEGIN SELECT RAISE(ABORT, 'forced click failure'); END`,
    ).run();
    clock.now = "2026-07-14T01:00:01.000Z";
    const failedClick = {
      ...targetClick,
      clientEventId: "00000000-0000-4000-8000-000000000999",
      decisionElapsedMs: 1000,
    };

    await expect(repository.recordClickV2(account, failedClick)).rejects.toThrow();
    await expect(
      operationRow("click", `click:${failedClick.runId}:${failedClick.clientEventId}`),
    ).resolves.toBeNull();
    await expect(count("run_events")).resolves.toBe(1);
    await expect(count("run_path_steps")).resolves.toBe(0);
    await expect(runSnapshot("run-1")).resolves.toMatchObject({
      status: "active",
      click_count: 0,
    });
  });

  it("requires explicit protocol-1 recovery abandonment and replays its outcome", async () => {
    await insertLegacyRun({ id: "legacy-run", accountId: account.accountId });
    const { repository } = fixture();
    const request = {
      runId: "legacy-run",
      idempotencyKey: "recover-legacy-key",
      recoveryProtocolVersion: 1 as const,
    };

    await expect(
      repository.abandonRunV2(account, {
        ...request,
        idempotencyKey: "recover-missing-key",
        recoveryProtocolVersion: undefined,
      }),
    ).rejects.toMatchObject({ code: "protocol_mismatch" });
    await expect(repository.abandonRunV2(account, request)).resolves.toMatchObject({
      runId: "legacy-run",
      runStatus: "abandoned",
      outcome: "legacy_recovery_abandoned",
    });
    await expect(repository.abandonRunV2(account, request)).resolves.toMatchObject({
      outcome: "legacy_recovery_abandoned",
    });
    await expect(runSnapshot("legacy-run")).resolves.toMatchObject({
      status: "abandoned",
      protocol_version: 1,
      ranked_eligible: 0,
    });
  });
});

describe("findActiveRun surfaces active runs regardless of click count (RC-02 root-cause fix)", () => {
  // RC-02 (owner-proxy ruling, "no silent run loss", 2026-07-24): findActiveRun
  // backs GET /api/v2/runs/active, the client's sole means of detecting "is
  // there a run to recover" on load/reload. Before this fix it additionally
  // required `click_count >= MIN_RESUMABLE_CLICKS` (added 2026-07-17),
  // conflating "is there an active run at all" with the unrelated "should a
  // trivial run get auto-abandoned to make way for a fresh start" concern
  // below. That meant a genuinely active 0- or 1-click run resolved as
  // `run: null` on reload - exactly journey8's traced defect (click 200,
  // then active->null). These three cases are the regression contract the
  // ruling calls for: 0 clicks, 1 click, and 2+ clicks must ALL be surfaced.
  it("surfaces a 0-click active run from findActiveRun", async () => {
    const { repository } = fixture();
    const created = await repository.startRunV2(account, start);
    expect(created).toMatchObject({ clickCount: 0, status: "active" });

    await expect(repository.findActiveRun(account)).resolves.toMatchObject({
      id: created.id,
      status: "active",
      clickCount: 0,
    });
  });

  it("surfaces a 1-click active run from findActiveRun", async () => {
    const clock = { now: "2026-07-14T01:00:00.000Z" };
    const { repository } = fixture(clock);
    await repository.startRunV2(account, start);
    clock.now = "2026-07-14T01:00:01.000Z";
    await repository.recordClickV2(account, {
      ...targetClick,
      destinationTitle: "Orbit",
      destinationPageId: 1234,
      decisionElapsedMs: 1000,
    });

    await expect(runSnapshot("run-1")).resolves.toMatchObject({
      status: "active",
      click_count: 1,
    });
    await expect(repository.findActiveRun(account)).resolves.toMatchObject({
      id: "run-1",
      status: "active",
      clickCount: 1,
    });
  });

  it("surfaces a 2-click active run from findActiveRun", async () => {
    const clock = { now: "2026-07-14T01:00:00.000Z" };
    const { repository } = fixture(clock);
    await repository.startRunV2(account, start);
    await recordTwoNonTerminalClicks(repository, clock);

    await expect(runSnapshot("run-1")).resolves.toMatchObject({
      status: "active",
      click_count: 2,
    });
    await expect(repository.findActiveRun(account)).resolves.toMatchObject({
      id: "run-1",
      status: "active",
      clickCount: 2,
    });
  });

  it.each([0, 1])(
    "auto-abandons a %i-click active run and lets a fresh start succeed",
    async (clickCount) => {
      const clock = { now: "2026-07-14T01:00:00.000Z" };
      const { repository } = fixture(clock);
      const first = await repository.startRunV2(account, start);
      if (clickCount === 1) {
        clock.now = "2026-07-14T01:00:01.000Z";
        await repository.recordClickV2(account, {
          ...targetClick,
          destinationTitle: "Orbit",
          destinationPageId: 1234,
          decisionElapsedMs: 1000,
        });
      }
      await expect(runSnapshot(first.id)).resolves.toMatchObject({
        status: "active",
        click_count: clickCount,
        start_title: "Moon",
        target_title: "Gravity",
      });

      clock.now = "2026-07-14T01:05:00.000Z";
      const second = await repository.startRunV2(account, {
        ...start,
        idempotencyKey: "start-second-attempt",
      });

      expect(second).toMatchObject({ status: "active", clickCount: 0 });
      expect(second.id).not.toBe(first.id);
      await expect(runSnapshot(first.id)).resolves.toMatchObject({
        status: "abandoned",
        click_count: clickCount,
        start_title: "Moon",
        target_title: "Gravity",
      });
      await expect(runSnapshot(second.id)).resolves.toMatchObject({
        status: "active",
        click_count: 0,
      });
      // RC-02 root-cause fix: findActiveRun surfaces every active run
      // regardless of click count, so the fresh (0-click) second run is
      // exactly what comes back here - not null, and not the abandoned first
      // run.
      await expect(repository.findActiveRun(account)).resolves.toMatchObject({
        id: second.id,
        status: "active",
        clickCount: 0,
      });
      await expect(count("runs")).resolves.toBe(2);
    },
  );

  it("still rejects a new start with active_run_exists once the active run has 2+ clicks", async () => {
    const clock = { now: "2026-07-14T01:00:00.000Z" };
    const { repository } = fixture(clock);
    const first = await repository.startRunV2(account, start);
    await recordTwoNonTerminalClicks(repository, clock);

    clock.now = "2026-07-14T01:05:00.000Z";
    await expect(repository.startRunV2(account, {
      ...start,
      idempotencyKey: "start-blocked-attempt",
    })).rejects.toMatchObject({ code: "active_run_exists", status: 409 });

    await expect(runSnapshot(first.id)).resolves.toMatchObject({
      status: "active",
      click_count: 2,
      start_title: "Moon",
      target_title: "Gravity",
    });
    await expect(count("runs")).resolves.toBe(1);
  });
});

describe("protocol-1 compatibility adapters", () => {
  it("uses the authorized canonical receipt on the legacy start route", async () => {
    await insertLegacyRun({
      id: "alias-owned-run",
      accountId: "account-old",
      challengeId: "challenge-0002",
    });
    const canonicalAccount = { ...account, aliases: ["account-old"] };
    const { repository } = fixture();
    const worker = createWorker({
      createTracking: () => ({
        handlers: {
          startRun: async () => {
            throw new Error("legacy handler must not receive canonical mutations");
          },
        },
        identity: {},
        runProtocol: repository,
        authorize: async () => canonicalAccount,
      } as unknown as WorkerTracking),
    });

    const response = await worker.fetch(
      new Request("https://worker.example/api/runs/start", {
        method: "POST",
        headers: {
          Authorization: "Bearer test",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          challengeId: "challenge-0001",
          publicName: "Impostor",
        }),
      }),
      {
        VWIKI_RACE_DB: env.VWIKI_RACE_DB,
        VGAMES_URL: "https://vgames.example",
        CLICK_RATE_LIMITER: { limit: async () => ({ success: true }) },
        ACCOUNT_READ_RATE_LIMITER: { limit: async () => ({ success: true }) },
        CHALLENGE_CREATE_RATE_LIMITER: { limit: async () => ({ success: true }) },
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      run: {
        id: "run-1",
        accountId: account.accountId,
        protocolVersion: 1,
      },
    });
    await expect(runStatus("alias-owned-run")).resolves.toBe("abandoned");
    await expect(env.VWIKI_RACE_DB.prepare(
      "SELECT public_name, identity_status FROM account_profiles WHERE account_id = ?",
    ).bind(account.accountId).first()).resolves.toEqual({
      public_name: "Casey",
      identity_status: "claimed",
    });
  });

  it("reuses only the same active legacy challenge and keeps legacy completion unranked", async () => {
    const { repository } = fixture();
    const legacyInput = {
      challengeId: "challenge-0001",
      accountId: account.accountId,
      publicName: account.displayName,
      identityStatus: account.status,
    };
    const run = await repository.startRun(legacyInput);
    await expect(repository.startRun(legacyInput)).resolves.toEqual(run);
    await expect(repository.startRun({ ...legacyInput, challengeId: "challenge-0002" })).rejects.toMatchObject({
      code: "active_run_exists",
    });
    await expect(scalar(
      "SELECT COUNT(*) FROM operation_idempotency WHERE operation = 'start' AND outcome_status <> 'pending'",
    )).resolves.toBe(3);

    await expect(
      repository.completeRun(run.id, account.accountId, { finalTitle: "Gravity" }),
    ).rejects.toMatchObject({ code: "completion_requires_click" });
    await repository.recordClick(run.id, account.accountId, {
      sourceTitle: "Moon",
      clickedAnchorText: "gravity",
      requestedTitle: "Gravity",
      destinationTitle: "Gravity",
      destinationPageId: 38579,
    });
    await repository.completeRun(run.id, account.accountId, { finalTitle: "Gravity" });
    await expect(runSnapshot(run.id)).resolves.toMatchObject({
      status: "completed",
      protocol_version: 1,
      ranked_eligible: 0,
    });
  });

  it("keeps the observed target in the legacy completion update predicate", async () => {
    const { repository } = fixture();
    const run = await repository.startRunLegacy(account, {
      challengeId: "challenge-0001",
    });
    await repository.recordClickLegacy(account, run.id, {
      sourceTitle: "Moon",
      clickedAnchorText: "gravity",
      requestedTitle: "Gravity",
      destinationTitle: "Gravity",
      destinationPageId: 38579,
    });

    let batchCalls = 0;
    const controlledDb: D1DatabaseLike = {
      prepare: (sql) => env.VWIKI_RACE_DB.prepare(sql),
      batch: async (statements) => {
        batchCalls += 1;
        if (batchCalls === 2) {
          await env.VWIKI_RACE_DB.prepare(
            `UPDATE runs
             SET last_title = 'Moved away', last_page_id = 999,
                 click_count = click_count + 1
             WHERE id = ?`,
          ).bind(run.id).run();
        }
        return env.VWIKI_RACE_DB.batch(statements as D1PreparedStatement[]);
      },
    };
    const controlled = createD1TrackingRepository({
      db: controlledDb,
      now: () => new Date("2026-07-14T01:00:05.000Z"),
    });

    await expect(controlled.completeRunLegacy(account, run.id, {
      finalTitle: "Gravity",
    })).rejects.toMatchObject({ code: "target_mismatch", status: 409 });
    await expect(runSnapshot(run.id)).resolves.toMatchObject({
      status: "active",
      click_count: 2,
      last_title: "Moved away",
      last_page_id: 999,
    });
    await expect(scalar(
      `SELECT COUNT(*) FROM run_events
       WHERE run_id = '${run.id}' AND event_type = 'run_completed'`,
    )).resolves.toBe(0);
  });

  it("records one keyless legacy abandon event for same-millisecond contenders", async () => {
    await insertLegacyRun({ id: "legacy-abandon-race", accountId: account.accountId });
    let batchCalls = 0;
    let abandonArrivals = 0;
    let releaseAbandons = () => {};
    const bothAbandonsReady = new Promise<void>((resolve) => {
      releaseAbandons = resolve;
    });
    const abandonChanges: number[] = [];
    const controlledDb: D1DatabaseLike = {
      prepare: (sql) => env.VWIKI_RACE_DB.prepare(sql),
      batch: async (statements) => {
        batchCalls += 1;
        if (batchCalls <= 2) {
          return env.VWIKI_RACE_DB.batch(statements as D1PreparedStatement[]);
        }
        abandonArrivals += 1;
        if (abandonArrivals === 2) {
          releaseAbandons();
        }
        await bothAbandonsReady;
        const results = await env.VWIKI_RACE_DB.batch(
          statements as D1PreparedStatement[],
        );
        abandonChanges.push(Number(results[0]?.meta.changes ?? 0));
        return results;
      },
    };
    let generatedId = 0;
    const repository = createD1TrackingRepository({
      db: controlledDb,
      now: () => new Date("2026-07-14T01:00:05.000Z"),
      randomId: () => `legacy-abandon-event-${++generatedId}`,
    });

    const outcomes = await Promise.all([
      repository.abandonRunLegacy(account, "legacy-abandon-race"),
      repository.abandonRunLegacy(account, "legacy-abandon-race"),
    ]);

    expect(outcomes).toEqual([
      { status: "abandoned" },
      { status: "abandoned" },
    ]);
    expect(abandonChanges).toHaveLength(2);
    expect(abandonChanges.reduce((sum, changes) => sum + changes, 0)).toBe(1);
    await expect(scalar(
      `SELECT COUNT(*) FROM run_events
       WHERE run_id = 'legacy-abandon-race' AND event_type = 'run_abandoned'`,
    )).resolves.toBe(1);
    await expect(runSnapshot("legacy-abandon-race")).resolves.toMatchObject({
      status: "abandoned",
      abandoned_at: "2026-07-14T01:00:05.000Z",
    });
  });

  it("returns the stored completion when keyless legacy abandon loses its CAS", async () => {
    await insertLegacyRun({
      id: "legacy-complete-abandon-race",
      accountId: account.accountId,
    });
    await fixture().repository.recordClickLegacy(
      account,
      "legacy-complete-abandon-race",
      {
        sourceTitle: "Moon",
        clickedAnchorText: "gravity",
        requestedTitle: "Gravity",
        destinationTitle: "Gravity",
        destinationPageId: 38579,
      },
    );

    let terminalArrivals = 0;
    let releaseTerminals = () => {};
    const bothTerminalsReady = new Promise<void>((resolve) => {
      releaseTerminals = resolve;
    });
    let releaseCompletion = () => {};
    const completionFinished = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    const controlledDb = (operation: "complete" | "abandon"): D1DatabaseLike => {
      let batchCalls = 0;
      return {
        prepare: (sql) => env.VWIKI_RACE_DB.prepare(sql),
        batch: async (statements) => {
          batchCalls += 1;
          if (batchCalls === 1) {
            return env.VWIKI_RACE_DB.batch(statements as D1PreparedStatement[]);
          }
          terminalArrivals += 1;
          if (terminalArrivals === 2) {
            releaseTerminals();
          }
          await bothTerminalsReady;
          if (operation === "abandon") {
            await completionFinished;
            return env.VWIKI_RACE_DB.batch(statements as D1PreparedStatement[]);
          }
          try {
            return await env.VWIKI_RACE_DB.batch(
              statements as D1PreparedStatement[],
            );
          } finally {
            releaseCompletion();
          }
        },
      };
    };
    const now = () => new Date("2026-07-14T01:00:05.000Z");
    const completionRepository = createD1TrackingRepository({
      db: controlledDb("complete"),
      now,
      randomId: () => "legacy-race-completion-event",
    });
    const abandonRepository = createD1TrackingRepository({
      db: controlledDb("abandon"),
      now,
      randomId: () => "legacy-race-abandon-event",
    });

    const [completion, abandonment] = await Promise.all([
      completionRepository.completeRunLegacy(
        account,
        "legacy-complete-abandon-race",
        { finalTitle: "Gravity" },
      ),
      abandonRepository.abandonRunLegacy(
        account,
        "legacy-complete-abandon-race",
      ),
    ]);

    expect(completion.runId).toBe("legacy-complete-abandon-race");
    expect(abandonment).toEqual({ status: "completed" });
    await expect(runSnapshot("legacy-complete-abandon-race")).resolves.toMatchObject({
      status: "completed",
      completed_at: "2026-07-14T01:00:05.000Z",
      abandoned_at: null,
    });
    await expect(scalar(
      `SELECT COUNT(*) FROM run_events
       WHERE run_id = 'legacy-complete-abandon-race'
         AND event_type = 'run_completed'`,
    )).resolves.toBe(1);
    await expect(scalar(
      `SELECT COUNT(*) FROM run_events
       WHERE run_id = 'legacy-complete-abandon-race'
         AND event_type = 'run_abandoned'`,
    )).resolves.toBe(0);
  });
});

describe("Task 4 D1 projections", () => {
  it("approves pending nominations into FIFO flavor queues and replays the same transition", async () => {
    const clock = { now: "2026-07-14T01:00:00.000Z" };
    const { repository } = fixture(clock);
    await insertReadyChallenge({ id: "queue-oldest", startPageId: 6101, targetPageId: 6102 });
    await insertReadyChallenge({ id: "queue-newest", startPageId: 6201, targetPageId: 6202 });
    await insertEditorialNomination(env.VWIKI_RACE_DB, {
      id: "nomination-oldest",
      challengeId: "queue-oldest",
      status: "pending",
    });
    await insertEditorialNomination(env.VWIKI_RACE_DB, {
      id: "nomination-newest",
      challengeId: "queue-newest",
      status: "pending",
    });

    const oldest = await repository.approveDailyNomination({
      nominationId: "nomination-oldest",
      flavor: "weird",
      actorAccountId: "admin-account",
      idempotencyKey: "approve-oldest",
    });
    clock.now = "2026-07-14T01:01:00.000Z";
    const newest = await repository.approveDailyNomination({
      nominationId: "nomination-newest",
      flavor: "weird",
      actorAccountId: "admin-account",
      idempotencyKey: "approve-newest",
    });
    await expect(repository.approveDailyNomination({
      nominationId: "nomination-oldest",
      flavor: "weird",
      actorAccountId: "admin-account",
      idempotencyKey: "approve-oldest",
    })).resolves.toEqual(oldest);

    const queued = await repository.findQueuedDailyCandidate("weird");
    expect(queued).toMatchObject({
      id: oldest.id,
      challenge: { id: "queue-oldest" },
    });
    expect(queued?.id).not.toBe(newest.id);
    const adminState = await repository.listDailyAdminState();
    expect(adminState.nominations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "nomination-oldest", status: "approved", reviewedByAccountId: "admin-account",
      }),
      expect.objectContaining({
        id: "nomination-newest", status: "approved", reviewedByAccountId: "admin-account",
      }),
    ]));
    expect(adminState.queueEntries).toEqual([
      expect.objectContaining(
        { id: oldest.id, flavor: "weird", source: "community", status: "queued" },
      ),
      expect.objectContaining(
        { id: newest.id, flavor: "weird", source: "community", status: "queued" },
      ),
    ]);
  });

  it("keeps approval pending when another queue entry owns the challenge and replays the rejection", async () => {
    const { repository } = fixture(
      { now: "2026-07-17T01:00:00.000Z" },
      "approval-conflict-generated",
    );
    await insertReadyChallenge({
      id: "approval-conflict-challenge",
      startPageId: 6251,
      targetPageId: 6252,
    });
    await insertEditorialNomination(env.VWIKI_RACE_DB, {
      id: "approval-conflict-nomination",
      challengeId: "approval-conflict-challenge",
      status: "pending",
    });
    await insertEditorialQueue(env.VWIKI_RACE_DB, {
      id: "approval-conflict-admin-entry",
      challengeId: "approval-conflict-challenge",
      source: "admin",
      flavor: "hard",
    });
    const approve = () => repository.approveDailyNomination({
      nominationId: "approval-conflict-nomination",
      flavor: "weird",
      actorAccountId: "admin-account",
      idempotencyKey: "approval-conflict",
    });

    await expect(approve()).rejects.toMatchObject({ code: "daily_queue_conflict", status: 409 });
    await expect(approve()).rejects.toMatchObject({ code: "daily_queue_conflict", status: 409 });
    await expect(env.VWIKI_RACE_DB.prepare(
      "SELECT status, reviewed_by_account_id, reviewed_at FROM daily_nominations WHERE id = ?",
    ).bind("approval-conflict-nomination").first()).resolves.toEqual({
      status: "pending",
      reviewed_by_account_id: null,
      reviewed_at: null,
    });
    await expect(operationRow("approve_daily_nomination", "approval-conflict")).resolves
      .toMatchObject({
        outcome_status: "rejected",
        error_code: "daily_queue_conflict",
        resource_id: null,
      });
    await expect(scalar(
      "SELECT COUNT(*) FROM daily_queue_entries WHERE challenge_id = 'approval-conflict-challenge'",
    )).resolves.toBe(1);
  });

  it.each(["admin", "community"] as const)(
    "rejects and replays direct queue conflicts with an existing %s entry",
    async (source) => {
      const generatedId = `direct-${source}-generated`;
      const challengeId = `direct-${source}-conflict`;
      const { repository } = fixture({ now: "2026-07-17T02:00:00.000Z" }, generatedId);
      await insertReadyChallenge({
        id: challengeId,
        startPageId: source === "admin" ? 6261 : 6271,
        targetPageId: source === "admin" ? 6262 : 6272,
      });
      let nominationId: string | undefined;
      if (source === "community") {
        nominationId = "direct-community-nomination";
        await insertEditorialNomination(env.VWIKI_RACE_DB, {
          id: nominationId,
          challengeId,
          status: "approved",
        });
      }
      await insertEditorialQueue(env.VWIKI_RACE_DB, {
        id: `existing-${source}-entry`,
        challengeId,
        nominationId,
        source,
        flavor: "hard",
      });
      const queue = () => repository.queueDailyChallenge({
        challengeId,
        flavor: "weird",
        actorAccountId: "admin-account",
        idempotencyKey: `direct-${source}-conflict`,
      });

      await expect(queue()).rejects.toMatchObject({ code: "daily_queue_conflict", status: 409 });
      await expect(queue()).rejects.toMatchObject({ code: "daily_queue_conflict", status: 409 });
      await expect(operationRow("queue_daily_challenge", `direct-${source}-conflict`)).resolves
        .toMatchObject({
          outcome_status: "rejected",
          error_code: "daily_queue_conflict",
          resource_id: null,
        });
      await expect(env.VWIKI_RACE_DB.prepare(
        "SELECT id, flavor, source, status FROM daily_queue_entries WHERE challenge_id = ?",
      ).bind(challengeId).first()).resolves.toEqual({
        id: `existing-${source}-entry`,
        flavor: "hard",
        source,
        status: "queued",
      });
      await expect(env.VWIKI_RACE_DB.prepare(
        "SELECT COUNT(*) AS count FROM daily_queue_entries WHERE id = ?",
      ).bind(generatedId).first()).resolves.toEqual({ count: 0 });
    },
  );

  it("returns and replays daily_nomination_not_found for a missing nomination", async () => {
    const { repository } = fixture();
    const decline = () => repository.declineDailyNomination({
      nominationId: "missing-editorial-nomination",
      actorAccountId: "admin-account",
      idempotencyKey: "decline-missing-nomination",
    });

    await expect(decline()).rejects.toMatchObject({
      code: "daily_nomination_not_found",
      status: 404,
    });
    await expect(decline()).rejects.toMatchObject({
      code: "daily_nomination_not_found",
      status: 404,
    });
    await expect(operationRow(
      "decline_daily_nomination",
      "decline-missing-nomination",
    )).resolves.toMatchObject({
      outcome_status: "rejected",
      error_code: "daily_nomination_not_found",
      resource_id: null,
    });
  });

  it("invalidates unusable queue entries and never consumes featured or removed entries", async () => {
    const { repository } = fixture();
    await insertReadyChallenge({ id: "queue-disabled", startPageId: 6301, targetPageId: 6302 });
    await insertReadyChallenge({ id: "queue-featured", startPageId: 6401, targetPageId: 6402 });
    await insertReadyChallenge({ id: "queue-removed", startPageId: 6501, targetPageId: 6502 });
    await insertEditorialNomination(env.VWIKI_RACE_DB, {
      id: "featured-nomination",
      challengeId: "queue-featured",
      status: "pending",
    });
    await insertEditorialQueue(env.VWIKI_RACE_DB, {
      id: "disabled-entry",
      challengeId: "queue-disabled",
      source: "admin",
      flavor: "hard",
    });
    await insertEditorialQueue(env.VWIKI_RACE_DB, {
      id: "featured-entry",
      challengeId: "queue-featured",
      source: "admin",
      flavor: "hard",
    });
    await insertEditorialQueue(env.VWIKI_RACE_DB, {
      id: "removed-entry",
      challengeId: "queue-removed",
      source: "admin",
      flavor: "hard",
      status: "removed",
    });
    await env.VWIKI_RACE_DB.prepare(
      "UPDATE challenges SET is_active = 0, validation_status = 'disabled' WHERE id = 'queue-disabled'",
    ).run();
    await insertEditorialFeature(env.VWIKI_RACE_DB, {
      dailyDate: "2026-07-19",
      challengeId: "queue-featured",
      selectionSource: "automatic",
    });

    await expect(repository.findQueuedDailyCandidate("hard")).resolves.toBeNull();
    await expect(env.VWIKI_RACE_DB.prepare(
      "SELECT id, status FROM daily_queue_entries ORDER BY id",
    ).all()).resolves.toMatchObject({
      results: [
        { id: "disabled-entry", status: "invalid" },
        { id: "featured-entry", status: "invalid" },
        { id: "removed-entry", status: "removed" },
      ],
    });
    await expect(repository.queueDailyChallenge({
      challengeId: "queue-featured",
      flavor: "hard",
      actorAccountId: "admin-account",
      idempotencyKey: "queue-featured-again",
    })).rejects.toMatchObject({ code: "daily_challenge_already_featured", status: 409 });
    await expect(repository.approveDailyNomination({
      nominationId: "featured-nomination",
      flavor: "hard",
      actorAccountId: "admin-account",
      idempotencyKey: "approve-featured-nomination",
    })).rejects.toMatchObject({ code: "daily_challenge_already_featured", status: 409 });
    await expect(env.VWIKI_RACE_DB.prepare(
      "SELECT status FROM daily_nominations WHERE id = 'featured-nomination'",
    ).first()).resolves.toEqual({ status: "pending" });
  });

  it("declines without queuing and removes only a currently queued direct promotion", async () => {
    const { repository } = fixture();
    await insertReadyChallenge({ id: "declined-challenge", startPageId: 6601, targetPageId: 6602 });
    await insertReadyChallenge({ id: "removable-challenge", startPageId: 6701, targetPageId: 6702 });
    await insertEditorialNomination(env.VWIKI_RACE_DB, {
      id: "declined-nomination",
      challengeId: "declined-challenge",
      status: "pending",
    });

    const declined = await repository.declineDailyNomination({
      nominationId: "declined-nomination",
      actorAccountId: "admin-account",
      idempotencyKey: "decline-nomination",
    });
    expect(declined).toMatchObject({ status: "declined", reviewedByAccountId: "admin-account" });
    await expect(scalar(
      "SELECT COUNT(*) FROM daily_queue_entries WHERE nomination_id = 'declined-nomination'",
    )).resolves.toBe(0);

    const queued = await repository.queueDailyChallenge({
      challengeId: "removable-challenge",
      flavor: "recognizable",
      actorAccountId: "admin-account",
      idempotencyKey: "queue-removable",
    });
    const removed = await repository.removeDailyQueueEntry({
      queueEntryId: queued.id,
      actorAccountId: "admin-account",
      idempotencyKey: "remove-queued-entry",
    });
    await expect(repository.removeDailyQueueEntry({
      queueEntryId: queued.id,
      actorAccountId: "admin-account",
      idempotencyKey: "remove-queued-entry",
    })).resolves.toEqual(removed);
    expect(removed).toMatchObject({ id: queued.id, status: "removed" });
    await expect(repository.findQueuedDailyCandidate("recognizable")).resolves.toBeNull();
  });

  it("reuses an old ordered pair, exposes the authoritative feature, and never features it twice", async () => {
    const { repository } = fixture();
    await insertReadyChallenge({ id: "old-automatic-pair", startPageId: 6801, targetPageId: 6802 });
    await repository.ensureDailyChallengeJob("2026-07-20");
    const firstJob = await repository.claimDueDailyChallengeJob();
    const first = await repository.acceptDailyFeature(firstJob!, {
      kind: "automatic",
      candidate: {
        startTitle: "Start 6801",
        startPageId: 6801,
        targetTitle: "Target 6802",
        targetPageId: 6802,
      },
      classifierVersion: "editorial-v1",
      selectedScore: 81,
    });

    expect(first).toMatchObject({
      id: "old-automatic-pair",
      origin: "daily",
      dailyDate: "2026-07-20",
      source: "wikipedia_random",
      dailyFeature: {
        dailyDate: "2026-07-20",
        flavor: "recognizable",
        selectionSource: "automatic",
      },
    });
    await expect(scalar(
      "SELECT next_sort_order FROM challenge_number_sequence WHERE sequence_name = 'global'",
    )).resolves.toBe(4);
    await expect(repository.listChallenges()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "old-automatic-pair",
        origin: "daily",
        dailyDate: "2026-07-20",
        // PKG-07: `dailyFeature` now also carries a server-computed
        // `dailyNumber` - wrapped in its own `objectContaining` (rather
        // than a bare literal) so this assertion keeps checking exactly
        // the fields it cares about without also having to hardcode the
        // ordinal (covered on its own by the "dailyNumber is server-
        // computed..." test below).
        dailyFeature: expect.objectContaining({
          dailyDate: "2026-07-20",
          flavor: "recognizable",
          selectionSource: "automatic",
        }),
      }),
    ]));

    await repository.ensureDailyChallengeJob("2026-07-21");
    const secondJob = await repository.claimDueDailyChallengeJob();
    await expect(repository.acceptDailyFeature(secondJob!, {
      kind: "automatic",
      candidate: {
        startTitle: "Start 6801",
        startPageId: 6801,
        targetTitle: "Target 6802",
        targetPageId: 6802,
      },
      classifierVersion: "editorial-v1",
    })).rejects.toMatchObject({ code: "daily_feature_selection_conflict", status: 500 });
    await expect(scalar(
      "SELECT COUNT(*) FROM daily_features WHERE challenge_id = 'old-automatic-pair'",
    )).resolves.toBe(1);
    await expect(scalar(
      "SELECT next_sort_order FROM challenge_number_sequence WHERE sequence_name = 'global'",
    )).resolves.toBe(4);
  });

  it("PKG-07 (council 2026-07-19, owner-proxy ruling (c)): dailyNumber is a permanent COUNT against daily_features, stable even once an older daily ages out of the active catalog", async () => {
    const { repository } = fixture();
    await insertReadyChallenge({ id: "daily-a", startPageId: 7101, targetPageId: 7102 });
    await insertReadyChallenge({ id: "daily-b", startPageId: 7201, targetPageId: 7202 });
    await insertReadyChallenge({ id: "daily-c", startPageId: 7301, targetPageId: 7302 });
    await insertEditorialFeature(env.VWIKI_RACE_DB, {
      dailyDate: "2026-07-17", challengeId: "daily-a", selectionSource: "automatic",
    });
    await insertEditorialFeature(env.VWIKI_RACE_DB, {
      dailyDate: "2026-07-18", challengeId: "daily-b", selectionSource: "automatic",
    });
    await insertEditorialFeature(env.VWIKI_RACE_DB, {
      dailyDate: "2026-07-19", challengeId: "daily-c", selectionSource: "automatic",
    });

    const challenges = await repository.listChallenges();
    expect(challenges.find((c) => c.id === "daily-a")?.dailyFeature).toMatchObject({ dailyNumber: 1 });
    expect(challenges.find((c) => c.id === "daily-b")?.dailyFeature).toMatchObject({ dailyNumber: 2 });
    expect(challenges.find((c) => c.id === "daily-c")?.dailyFeature).toMatchObject({ dailyNumber: 3 });

    // Home/Boards' own comments document that `listChallenges` only ever
    // carries active challenges - a real daily is expected to age out of it
    // once retired. `dailyNumber` must NOT be recomputed against whatever's
    // still active when that happens (the exact client-side derivation risk
    // Judges A/B both flagged) - "daily-b"/"daily-c" must keep their
    // original numbers, not collapse to 1/2 once "daily-a" is trimmed.
    await env.VWIKI_RACE_DB.prepare(
      "UPDATE challenges SET is_active = 0 WHERE id = 'daily-a'",
    ).run();
    const afterTrim = await repository.listChallenges();
    expect(afterTrim.find((c) => c.id === "daily-a")).toBeUndefined();
    expect(afterTrim.find((c) => c.id === "daily-b")?.dailyFeature).toMatchObject({ dailyNumber: 2 });
    expect(afterTrim.find((c) => c.id === "daily-c")?.dailyFeature).toMatchObject({ dailyNumber: 3 });
  });

  it("serializes concurrent automatic acceptance into one feature and one allocated number", async () => {
    const { repository } = fixture();
    await repository.ensureDailyChallengeJob("2026-07-22");
    const job = await repository.claimDueDailyChallengeJob();
    const selection = {
      kind: "automatic" as const,
      candidate: {
        startTitle: "Concurrent start",
        startPageId: 6901,
        targetTitle: "Concurrent target",
        targetPageId: 6902,
      },
      classifierVersion: "editorial-v1",
    };
    const [first, second] = await Promise.all([
      repository.acceptDailyFeature(job!, selection),
      repository.acceptDailyFeature(job!, selection),
    ]);

    expect(second).toEqual(first);
    expect(first).toMatchObject({ id: "challenge-0004", sortOrder: 4 });
    await expect(scalar(
      "SELECT COUNT(*) FROM daily_features WHERE daily_date = '2026-07-22'",
    )).resolves.toBe(1);
    await expect(scalar(
      "SELECT COUNT(*) FROM challenges WHERE start_page_id = 6901 AND target_page_id = 6902",
    )).resolves.toBe(1);
    await expect(scalar(
      "SELECT next_sort_order FROM challenge_number_sequence WHERE sequence_name = 'global'",
    )).resolves.toBe(5);
  });

  it("rejects a stale queued acceptance when another selection won the date", async () => {
    const clock = { now: "2026-07-17T03:00:00.000Z" };
    const staleRepository = fixture(clock, "stale-queued-lease").repository;
    await insertReadyChallenge({
      id: "stale-queued-challenge",
      startPageId: 6911,
      targetPageId: 6912,
    });
    await insertEditorialQueue(env.VWIKI_RACE_DB, {
      id: "stale-queued-entry",
      challengeId: "stale-queued-challenge",
      source: "admin",
      flavor: "recognizable",
    });
    await staleRepository.ensureDailyChallengeJob("2026-07-27");
    const staleJob = await staleRepository.claimDueDailyChallengeJob();

    clock.now = "2026-07-17T03:11:00.000Z";
    const winnerRepository = fixture(clock, "queued-winner-lease").repository;
    const winnerJob = await winnerRepository.claimDueDailyChallengeJob();
    const winner = await winnerRepository.acceptDailyFeature(winnerJob!, {
      kind: "automatic",
      candidate: {
        startTitle: "Queued race winner start",
        startPageId: 6921,
        targetTitle: "Queued race winner target",
        targetPageId: 6922,
      },
      classifierVersion: "editorial-v1",
    });

    await expect(staleRepository.acceptDailyFeature(staleJob!, {
      kind: "queued",
      queueEntryId: "stale-queued-entry",
      classifierVersion: "editorial-v1",
    })).rejects.toMatchObject({ code: "daily_feature_date_conflict", status: 500 });
    await expect(env.VWIKI_RACE_DB.prepare(
      "SELECT challenge_id, selection_source, queue_entry_id FROM daily_features WHERE daily_date = ?",
    ).bind("2026-07-27").first()).resolves.toEqual({
      challenge_id: winner.id,
      selection_source: "automatic",
      queue_entry_id: null,
    });
    await expect(env.VWIKI_RACE_DB.prepare(
      "SELECT status, consumed_daily_date FROM daily_queue_entries WHERE id = ?",
    ).bind("stale-queued-entry").first()).resolves.toEqual({
      status: "queued",
      consumed_daily_date: null,
    });
  });

  it("classifies a lost lease without consuming the selected queue entry", async () => {
    const clock = { now: "2026-07-17T03:30:00.000Z" };
    const staleRepository = fixture(clock, "lost-lease-stale").repository;
    await insertReadyChallenge({
      id: "lost-lease-challenge",
      startPageId: 6923,
      targetPageId: 6924,
    });
    await insertEditorialQueue(env.VWIKI_RACE_DB, {
      id: "lost-lease-queue",
      challengeId: "lost-lease-challenge",
      source: "admin",
      flavor: "recognizable",
    });
    await staleRepository.ensureDailyChallengeJob("2026-07-31");
    const staleJob = await staleRepository.claimDueDailyChallengeJob();

    clock.now = "2026-07-17T03:41:00.000Z";
    const currentRepository = fixture(clock, "lost-lease-current").repository;
    const currentJob = await currentRepository.claimDueDailyChallengeJob();
    expect(currentJob).toMatchObject({ leaseToken: "lost-lease-current" });

    await expect(staleRepository.acceptDailyFeature(staleJob!, {
      kind: "queued",
      queueEntryId: "lost-lease-queue",
      classifierVersion: "editorial-v1",
    })).rejects.toMatchObject({ code: "daily_feature_lease_lost", status: 500 });
    await expect(env.VWIKI_RACE_DB.prepare(
      "SELECT status, consumed_daily_date FROM daily_queue_entries WHERE id = ?",
    ).bind("lost-lease-queue").first()).resolves.toEqual({
      status: "queued",
      consumed_daily_date: null,
    });
    await expect(env.VWIKI_RACE_DB.prepare(
      "SELECT status, lease_token FROM daily_challenge_jobs WHERE daily_date = ?",
    ).bind("2026-07-31").first()).resolves.toEqual({
      status: "claimed",
      lease_token: "lost-lease-current",
    });
  });

  it("rejects a stale automatic acceptance when another ordered pair won the date", async () => {
    const clock = { now: "2026-07-17T04:00:00.000Z" };
    const staleRepository = fixture(clock, "stale-automatic-lease").repository;
    await staleRepository.ensureDailyChallengeJob("2026-07-28");
    const staleJob = await staleRepository.claimDueDailyChallengeJob();

    clock.now = "2026-07-17T04:11:00.000Z";
    const winnerRepository = fixture(clock, "automatic-winner-lease").repository;
    const winnerJob = await winnerRepository.claimDueDailyChallengeJob();
    const winner = await winnerRepository.acceptDailyFeature(winnerJob!, {
      kind: "automatic",
      candidate: {
        startTitle: "Automatic race winner start",
        startPageId: 6931,
        targetTitle: "Automatic race winner target",
        targetPageId: 6932,
      },
      classifierVersion: "editorial-v1",
    });

    await expect(staleRepository.acceptDailyFeature(staleJob!, {
      kind: "automatic",
      candidate: {
        startTitle: "Stale automatic start",
        startPageId: 6941,
        targetTitle: "Stale automatic target",
        targetPageId: 6942,
      },
      classifierVersion: "editorial-v1",
    })).rejects.toMatchObject({ code: "daily_feature_date_conflict", status: 500 });
    await expect(env.VWIKI_RACE_DB.prepare(
      `SELECT f.challenge_id, f.selection_source, c.start_page_id, c.target_page_id
       FROM daily_features f JOIN challenges c ON c.id = f.challenge_id
       WHERE f.daily_date = ?`,
    ).bind("2026-07-28").first()).resolves.toEqual({
      challenge_id: winner.id,
      selection_source: "automatic",
      start_page_id: 6931,
      target_page_id: 6932,
    });
    await expect(scalar(
      "SELECT COUNT(*) FROM challenges WHERE start_page_id = 6941 AND target_page_id = 6942",
    )).resolves.toBe(0);
  });

  it("rejects a selected queue entry when an older valid FIFO candidate wins before acceptance", async () => {
    const { repository } = fixture({ now: "2026-07-17T05:00:00.000Z" }, "fifo-lease");
    await insertReadyChallenge({ id: "fifo-selected", startPageId: 6951, targetPageId: 6952 });
    await insertReadyChallenge({ id: "fifo-older", startPageId: 6961, targetPageId: 6962 });
    await insertEditorialQueue(env.VWIKI_RACE_DB, {
      id: "z-fifo-selected-entry",
      challengeId: "fifo-selected",
      source: "admin",
      flavor: "recognizable",
    });
    await expect(repository.findQueuedDailyCandidate("recognizable")).resolves.toMatchObject({
      id: "z-fifo-selected-entry",
    });
    await insertEditorialQueue(env.VWIKI_RACE_DB, {
      id: "a-fifo-older-entry",
      challengeId: "fifo-older",
      source: "admin",
      flavor: "recognizable",
    });
    await repository.ensureDailyChallengeJob("2026-07-29");
    const job = await repository.claimDueDailyChallengeJob();

    await expect(repository.acceptDailyFeature(job!, {
      kind: "queued",
      queueEntryId: "z-fifo-selected-entry",
      classifierVersion: "editorial-v1",
    })).rejects.toMatchObject({ code: "daily_queue_selection_changed", status: 500 });
    await expect(env.VWIKI_RACE_DB.prepare(
      "SELECT id, status FROM daily_queue_entries ORDER BY id",
    ).all()).resolves.toMatchObject({
      results: [
        { id: "a-fifo-older-entry", status: "queued" },
        { id: "z-fifo-selected-entry", status: "queued" },
      ],
    });

    await expect(repository.acceptDailyFeature(job!, {
      kind: "queued",
      queueEntryId: "a-fifo-older-entry",
      classifierVersion: "editorial-v1",
    })).resolves.toMatchObject({ id: "fifo-older" });
    await expect(env.VWIKI_RACE_DB.prepare(
      "SELECT id, status FROM daily_queue_entries ORDER BY id",
    ).all()).resolves.toMatchObject({
      results: [
        { id: "a-fifo-older-entry", status: "consumed" },
        { id: "z-fifo-selected-entry", status: "queued" },
      ],
    });
  });

  it("rolls back automatic allocation when a forced ordered-pair winner appears", async () => {
    await env.VWIKI_RACE_DB.prepare(`
      CREATE TRIGGER force_pair_winner
      BEFORE INSERT ON challenges
      FOR EACH ROW
      WHEN NEW.id <> 'daily-pair-race-winner'
        AND NEW.start_page_id = 6971 AND NEW.target_page_id = 6972
      BEGIN
        INSERT INTO challenges
          (id, label, start_title, target_title, start_page_id, target_page_id,
           validation_status, ruleset, sort_order, is_active, created_at,
           created_by_account_id, created_by_display_name,
           created_by_identity_status, origin, source)
        VALUES
          ('daily-pair-race-winner', 'Forced Daily winner', NEW.start_title, NEW.target_title,
           NEW.start_page_id, NEW.target_page_id, 'ready', 'ranked_classic',
           NEW.sort_order + 1000, 1, NEW.created_at, 'account-race-winner',
           'Race winner', 'claimed', 'manual', 'curated');
      END;
    `).run();
    const { repository } = fixture({ now: "2026-07-17T06:00:00.000Z" }, "pair-race-lease");
    await repository.ensureDailyChallengeJob("2026-07-30");
    const job = await repository.claimDueDailyChallengeJob();

    const featured = await repository.acceptDailyFeature(job!, {
      kind: "automatic",
      candidate: {
        startTitle: "Forced Daily start",
        startPageId: 6971,
        targetTitle: "Forced Daily target",
        targetPageId: 6972,
      },
      classifierVersion: "editorial-v1",
    });

    expect(featured).toMatchObject({ id: "daily-pair-race-winner" });
    await expect(scalar(
      "SELECT COUNT(*) FROM challenges WHERE start_page_id = 6971 AND target_page_id = 6972",
    )).resolves.toBe(1);
    await expect(scalar(
      "SELECT COUNT(*) FROM daily_features WHERE daily_date = '2026-07-30' AND challenge_id = 'daily-pair-race-winner'",
    )).resolves.toBe(1);
    await expect(scalar(
      "SELECT next_sort_order FROM challenge_number_sequence WHERE sequence_name = 'global'",
    )).resolves.toBe(4);
  });

  it("\"I gave up\" reference path (owner spec, 2026-08-02): stores the evaluator's computed candidate.referencePath on a brand-new automatic daily challenge", async () => {
    const { repository } = fixture();
    await repository.ensureDailyChallengeJob("2026-07-20");
    const job = await repository.claimDueDailyChallengeJob();

    const featured = await repository.acceptDailyFeature(job!, {
      kind: "automatic",
      candidate: {
        startTitle: "Reference Path Start",
        startPageId: 9001,
        targetTitle: "Reference Path Target",
        targetPageId: 9002,
        referencePath: ["Reference Path Start", "Hop", "Reference Path Target"],
      },
      classifierVersion: "editorial-v1",
      selectedScore: 80,
    });

    const stored = await env.VWIKI_RACE_DB.prepare(
      "SELECT reference_path FROM challenges WHERE id = ?",
    ).bind(featured.id).first<{ reference_path: string | null }>();
    expect(JSON.parse(stored?.reference_path ?? "null")).toEqual([
      "Reference Path Start", "Hop", "Reference Path Target",
    ]);
  });

  it("\"I gave up\" reference path: degrades to a plain NULL column when the evaluator found nothing (never blocks the drop)", async () => {
    const { repository } = fixture();
    await repository.ensureDailyChallengeJob("2026-07-20");
    const job = await repository.claimDueDailyChallengeJob();

    const featured = await repository.acceptDailyFeature(job!, {
      kind: "automatic",
      candidate: {
        startTitle: "No Reference Start",
        startPageId: 9003,
        targetTitle: "No Reference Target",
        targetPageId: 9004,
        referencePath: null,
      },
      classifierVersion: "editorial-v1",
      selectedScore: 80,
    });

    const stored = await env.VWIKI_RACE_DB.prepare(
      "SELECT reference_path FROM challenges WHERE id = ?",
    ).bind(featured.id).first<{ reference_path: string | null }>();
    expect(stored?.reference_path).toBeNull();
  });

  it("\"I gave up\" reference path: a queued (nominated) daily never writes one - candidate selection never ran for it", async () => {
    const { repository } = fixture();
    await insertReadyChallenge({ id: "queued-no-reference", startPageId: 9101, targetPageId: 9102 });
    await insertEditorialQueue(env.VWIKI_RACE_DB, {
      id: "queued-no-reference-entry",
      challengeId: "queued-no-reference",
      source: "admin",
      flavor: "recognizable",
    });
    await repository.ensureDailyChallengeJob("2026-07-20");
    const job = await repository.claimDueDailyChallengeJob();

    await repository.acceptDailyFeature(job!, {
      kind: "queued",
      queueEntryId: "queued-no-reference-entry",
      classifierVersion: "editorial-v1",
    });

    const stored = await env.VWIKI_RACE_DB.prepare(
      "SELECT reference_path FROM challenges WHERE id = 'queued-no-reference'",
    ).first<{ reference_path: string | null }>();
    expect(stored?.reference_path).toBeNull();
  });

  it("routes legacy creation through canonical validation and deterministic replay", async () => {
    const { repository } = fixture();
    const validateChallengeArticles = vi.fn(async () => ({
      start: { title: "Mars", pageId: 123, allowedLinkCount: 4 },
      target: { title: "Water", pageId: 456, allowedLinkCount: 2 },
    }));
    const handlers = createApiHandlers(repository, { validateChallengeArticles });
    const worker = createWorker({
      createTracking: () => ({
        handlers,
        identity: {},
        runProtocol: repository,
        authorize: async () => account,
      } as unknown as WorkerTracking),
    });
    const request = (creatorDisplayName: string) => new Request("https://worker.example/api/challenges", {
      method: "POST",
      headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      body: JSON.stringify({
        startTitle: "Mars",
        targetTitle: "Water",
        creatorDisplayName,
      }),
    });
    const workerEnv = {
      VWIKI_RACE_DB: env.VWIKI_RACE_DB,
      VGAMES_URL: "https://vgames.example",
      CLICK_RATE_LIMITER: { limit: async () => ({ success: true }) },
      ACCOUNT_READ_RATE_LIMITER: { limit: async () => ({ success: true }) },
      CHALLENGE_CREATE_RATE_LIMITER: { limit: async () => ({ success: true }) },
    };

    const first = await worker.fetch(request("Browser Impostor"), workerEnv);
    const second = await worker.fetch(request("Different Browser Name"), workerEnv);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({
      challenge: { id: "challenge-0004", createdBy: { displayName: "Casey" } },
    });
    expect(validateChallengeArticles).toHaveBeenCalledTimes(1);
    await expect(scalar(
      "SELECT COUNT(*) FROM challenges WHERE created_by_display_name = 'Casey'",
    )).resolves.toBe(1);
  });

  it("replays a committed raw creation before Wikipedia is consulted again", async () => {
    const { repository } = fixture();
    const validating = createApiHandlers(repository, {
      validateChallengeArticles: async () => ({
        start: { title: "Mars", pageId: 123, allowedLinkCount: 4 },
        target: { title: "Water", pageId: 456, allowedLinkCount: 2 },
      }),
    });
    const request = { startTitle: " mars ", targetTitle: "water" };
    const created = await validating.createChallengeV2(account, request, "replay-before-wikipedia");

    const unavailable = createApiHandlers(repository, {
      validateChallengeArticles: async () => {
        throw new Error("Wikipedia unavailable");
      },
    });
    await expect(unavailable.createChallengeV2(
      account,
      request,
      "replay-before-wikipedia",
    )).resolves.toEqual(created);
    await expect(unavailable.createChallengeV2(
      account,
      { ...request, targetTitle: "Venus" },
      "replay-before-wikipedia",
    )).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
  });

  it("replays a rejected creation before Wikipedia is consulted again", async () => {
    for (let index = 0; index < 10; index += 1) {
      await insertFinalizedOperation({
        operation: "create_challenge",
        key: `daily-create-${index}`,
        accountId: account.accountId,
        outcome: "accepted",
        createdAt: `2026-07-14T00:${String(index).padStart(2, "0")}:00.000Z`,
      });
    }
    const { repository } = fixture();
    const validating = createApiHandlers(repository, {
      validateChallengeArticles: async () => ({
        start: { title: "Mars", pageId: 123, allowedLinkCount: 4 },
        target: { title: "Water", pageId: 456, allowedLinkCount: 2 },
      }),
    });
    const request = { startTitle: "Mars", targetTitle: "Water" };
    await expect(validating.createChallengeV2(
      account,
      request,
      "rejected-before-wikipedia",
    )).rejects.toMatchObject({ code: "challenge_create_daily_limit", status: 429 });

    const unavailable = vi.fn(async () => {
      throw new Error("Wikipedia unavailable");
    });
    const replaying = createApiHandlers(repository, {
      validateChallengeArticles: unavailable,
    });
    await expect(replaying.createChallengeV2(
      account,
      request,
      "rejected-before-wikipedia",
    )).rejects.toMatchObject({ code: "challenge_create_daily_limit", status: 429 });
    expect(unavailable).not.toHaveBeenCalled();
  });

  it("uses receipt aliases to replay and reopen a create quota rejection", async () => {
    const aliasAccount: AuthorizedAccount = {
      accountId: "account-alias",
      displayName: "Casey Ghost",
      status: "ghost",
      aliases: [],
    };
    const mergedAccount: AuthorizedAccount = {
      accountId: account.accountId,
      displayName: account.displayName,
      status: "claimed",
      aliases: [aliasAccount.accountId],
    };
    for (let index = 0; index < 20; index += 1) {
      await insertFinalizedOperation({
        operation: "create_challenge",
        key: `alias-hour-recovery-${index}`,
        accountId: aliasAccount.accountId,
        outcome: index < 5 ? "accepted" : "rejected",
        createdAt: index === 0
          ? "2026-07-14T00:00:30.000Z"
          : `2026-07-14T00:${String(index).padStart(2, "0")}:00.000Z`,
      });
    }
    const clock = { now: "2026-07-14T01:00:00.000Z" };
    const { repository } = fixture(clock);
    const request = { startTitle: "Mars", targetTitle: "Water" };
    const idempotencyKey = "alias-create-quota-recovery";
    const validArticles = async () => ({
      start: { title: "Mars", pageId: 123, allowedLinkCount: 4 },
      target: { title: "Water", pageId: 456, allowedLinkCount: 2 },
    });
    const aliasHandlers = createApiHandlers(repository, {
      validateChallengeArticles: validArticles,
    });

    await expect(aliasHandlers.createChallengeV2(
      aliasAccount,
      request,
      idempotencyKey,
    )).rejects.toMatchObject({
      code: "challenge_create_rate_limited",
      retryAfterSeconds: 60,
    });
    await expect(count("account_aliases")).resolves.toBe(0);

    const unavailable = vi.fn(async () => {
      throw new Error("Wikipedia unavailable");
    });
    const unavailableHandlers = createApiHandlers(repository, {
      validateChallengeArticles: unavailable,
    });
    await expect(unavailableHandlers.createChallengeV2(
      mergedAccount,
      request,
      idempotencyKey,
    )).rejects.toMatchObject({
      code: "challenge_create_rate_limited",
      retryAfterSeconds: 60,
    });
    expect(unavailable).not.toHaveBeenCalled();
    await expect(count("account_aliases")).resolves.toBe(0);

    clock.now = "2026-07-14T01:01:00.000Z";
    await expect(unavailableHandlers.createChallengeV2(
      mergedAccount,
      request,
      idempotencyKey,
    )).rejects.toThrow("Wikipedia unavailable");
    expect(unavailable).toHaveBeenCalledTimes(1);
    await expect(count("account_aliases")).resolves.toBe(0);

    const mergedHandlers = createApiHandlers(repository, {
      validateChallengeArticles: validArticles,
    });
    const accepted = await mergedHandlers.createChallengeV2(
      mergedAccount,
      request,
      idempotencyKey,
    );
    await expect(unavailableHandlers.createChallengeV2(
      mergedAccount,
      request,
      idempotencyKey,
    )).resolves.toEqual(accepted);
    expect(unavailable).toHaveBeenCalledTimes(1);
    expect(accepted.challenge).toMatchObject({
      id: "challenge-0004",
      createdBy: { accountId: account.accountId, identityStatus: "claimed" },
    });
    await expect(count("account_aliases")).resolves.toBe(1);
    await expect(scalar(
      "SELECT COUNT(*) FROM challenges WHERE created_by_account_id = 'account-canonical'",
    )).resolves.toBe(1);
    await expect(scalar(
      "SELECT COUNT(*) FROM operation_idempotency WHERE operation = 'create_challenge'",
    )).resolves.toBe(22);
  });

  it("reopens a legacy hourly rejection at its actionable retry boundary", async () => {
    for (let index = 0; index < 20; index += 1) {
      await insertFinalizedOperation({
        operation: "create_challenge",
        key: `hour-recovery-${index}`,
        accountId: account.accountId,
        outcome: index < 5 ? "accepted" : "rejected",
        createdAt: index === 0
          ? "2026-07-14T00:00:30.000Z"
          : `2026-07-14T00:${String(index).padStart(2, "0")}:00.000Z`,
      });
    }
    const clock = { now: "2026-07-14T01:00:00.000Z" };
    const { repository } = fixture(clock);
    const validateChallengeArticles = vi.fn(async () => ({
      start: { title: "Mars", pageId: 123, allowedLinkCount: 4 },
      target: { title: "Water", pageId: 456, allowedLinkCount: 2 },
    }));
    const worker = createLegacyCreationWorker(repository, validateChallengeArticles);
    const request = legacyCreationRequest();

    const rejected = await worker.fetch(request(), workerEnv());
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get("Retry-After")).toBe("60");
    clock.now = "2026-07-14T01:00:59.000Z";
    const replayedRejection = await worker.fetch(request(), workerEnv());
    expect(replayedRejection.status).toBe(429);
    expect(validateChallengeArticles).toHaveBeenCalledTimes(1);

    clock.now = "2026-07-14T01:01:00.000Z";
    const accepted = await worker.fetch(request(), workerEnv());
    const acceptedReplay = await worker.fetch(request(), workerEnv());
    expect(accepted.status).toBe(200);
    expect(acceptedReplay.status).toBe(200);
    await expect(acceptedReplay.json()).resolves.toMatchObject({
      challenge: { id: "challenge-0004" },
    });
    expect(validateChallengeArticles).toHaveBeenCalledTimes(2);
    await expect(scalar(
      "SELECT COUNT(*) FROM challenges WHERE created_by_account_id = 'account-canonical'",
    )).resolves.toBe(1);
    await expect(scalar(
      "SELECT COUNT(*) FROM operation_idempotency WHERE operation = 'create_challenge'",
    )).resolves.toBe(22);
  });

  it("reopens a legacy daily rejection at the advertised UTC boundary", async () => {
    for (let index = 0; index < 10; index += 1) {
      await insertFinalizedOperation({
        operation: "create_challenge",
        key: `day-recovery-${index}`,
        accountId: account.accountId,
        outcome: "accepted",
        createdAt: `2026-07-14T00:${String(index).padStart(2, "0")}:00.000Z`,
      });
    }
    const clock = { now: "2026-07-14T23:59:00.000Z" };
    const { repository } = fixture(clock);
    const validateChallengeArticles = vi.fn(async () => ({
      start: { title: "Mars", pageId: 123, allowedLinkCount: 4 },
      target: { title: "Water", pageId: 456, allowedLinkCount: 2 },
    }));
    const worker = createLegacyCreationWorker(repository, validateChallengeArticles);
    const request = legacyCreationRequest();

    const rejected = await worker.fetch(request(), workerEnv());
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get("Retry-After")).toBe("60");
    clock.now = "2026-07-14T23:59:59.000Z";
    expect((await worker.fetch(request(), workerEnv())).status).toBe(429);
    expect(validateChallengeArticles).toHaveBeenCalledTimes(1);

    clock.now = "2026-07-15T00:00:00.000Z";
    expect((await worker.fetch(request(), workerEnv())).status).toBe(200);
    expect((await worker.fetch(request(), workerEnv())).status).toBe(200);
    expect(validateChallengeArticles).toHaveBeenCalledTimes(2);
    await expect(scalar(
      "SELECT COUNT(*) FROM challenges WHERE created_by_account_id = 'account-canonical'",
    )).resolves.toBe(1);
    await expect(scalar(
      "SELECT COUNT(*) FROM operation_idempotency WHERE operation = 'create_challenge'",
    )).resolves.toBe(12);
  });

  it("creates one canonical challenge per idempotency key with page ids", async () => {
    const { repository } = fixture();
    const input = {
      startTitle: "Mars",
      startPageId: 123,
      startAllowedLinkCount: 4,
      targetTitle: "Water",
      targetPageId: 456,
      idempotencyKey: "create-challenge-key",
    };

    const created = await repository.createChallengeV2(account, input);
    await expect(repository.createChallengeV2(account, input)).resolves.toEqual(created);
    expect(created).toMatchObject({
      disposition: "created",
      nomination: "not_requested",
      challenge: {
        id: "challenge-0004",
        sortOrder: 4,
        isActive: true,
        start: { title: "Mars", pageId: 123 },
        target: { title: "Water", pageId: 456 },
        createdBy: { accountId: account.accountId, displayName: "Casey" },
      },
    });
    await expect(scalar("SELECT COUNT(*) FROM challenges WHERE id = 'challenge-0004'"))
      .resolves.toBe(1);
    await expect(scalar(
      "SELECT COUNT(*) FROM operation_idempotency WHERE operation = 'create_challenge'",
    )).resolves.toBe(1);
  });

  it("reuses an ordered pair without consuming a number and preserves its creator", async () => {
    const { repository } = fixture();
    const original = await repository.createChallengeV2(account, {
      startTitle: "Mars",
      startPageId: 123,
      startAllowedLinkCount: 4,
      targetTitle: "Water",
      targetPageId: 456,
      idempotencyKey: "dedupe-original",
      nominateForDaily: false,
    });
    const nominator: AuthorizedAccount = {
      accountId: "account-nominator",
      displayName: "Nora",
      status: "claimed",
      aliases: [],
    };

    const duplicate = await repository.createChallengeV2(nominator, {
      startTitle: "Mars",
      startPageId: 123,
      startAllowedLinkCount: 4,
      targetTitle: "Water",
      targetPageId: 456,
      idempotencyKey: "dedupe-nomination",
      nominateForDaily: true,
    });
    const repeatedNomination = await repository.createChallengeV2({
      ...nominator,
      accountId: "account-second-nominator",
    }, {
      startTitle: "Mars",
      startPageId: 123,
      startAllowedLinkCount: 4,
      targetTitle: "Water",
      targetPageId: 456,
      idempotencyKey: "dedupe-second-nomination",
      nominateForDaily: true,
    });

    expect(original).toMatchObject({
      disposition: "created",
      nomination: "not_requested",
      challenge: { id: "challenge-0004", sortOrder: 4 },
    });
    expect(duplicate).toMatchObject({
      disposition: "existing",
      nomination: "pending",
      challenge: {
        id: "challenge-0004",
        createdBy: { accountId: account.accountId, displayName: account.displayName },
      },
    });
    expect(repeatedNomination).toMatchObject({
      disposition: "existing",
      nomination: "already_exists",
      challenge: { id: "challenge-0004" },
    });
    await expect(scalar(
      "SELECT next_sort_order FROM challenge_number_sequence WHERE sequence_name = 'global'",
    )).resolves.toBe(5);
    await expect(scalar(
      "SELECT COUNT(*) FROM challenges WHERE start_page_id = 123 AND target_page_id = 456",
    )).resolves.toBe(1);
    await expect(scalar(
      "SELECT COUNT(*) FROM daily_nominations WHERE challenge_id = 'challenge-0004'",
    )).resolves.toBe(1);

    const reverse = await repository.createChallengeV2(nominator, {
      startTitle: "Water",
      startPageId: 456,
      startAllowedLinkCount: 4,
      targetTitle: "Mars",
      targetPageId: 123,
      idempotencyKey: "dedupe-reverse",
      nominateForDaily: false,
    });
    expect(reverse).toMatchObject({
      disposition: "created",
      challenge: { id: "challenge-0005", sortOrder: 5 },
    });
  });

  it("serializes concurrent duplicate pairs into one number and one nomination", async () => {
    const { repository } = fixture();
    const accounts: AuthorizedAccount[] = [
      account,
      { accountId: "account-racer", displayName: "Riley", status: "claimed", aliases: [] },
    ];
    const outcomes = await Promise.all(accounts.map((creator, index) =>
      repository.createChallengeV2(creator, {
        startTitle: "Saturn",
        startPageId: 777,
        startAllowedLinkCount: 12,
        targetTitle: "Ocean",
        targetPageId: 888,
        idempotencyKey: `concurrent-dedupe-${index}`,
        nominateForDaily: true,
      })));

    expect(outcomes.map((outcome) => outcome.disposition).sort()).toEqual(["created", "existing"]);
    expect(outcomes.map((outcome) => outcome.challenge.id)).toEqual([
      "challenge-0004",
      "challenge-0004",
    ]);
    expect(outcomes.map((outcome) => outcome.nomination).sort()).toEqual([
      "already_exists",
      "pending",
    ]);
    await expect(scalar(
      "SELECT next_sort_order FROM challenge_number_sequence WHERE sequence_name = 'global'",
    )).resolves.toBe(5);
    await expect(scalar(
      "SELECT COUNT(*) FROM daily_nominations WHERE challenge_id = 'challenge-0004'",
    )).resolves.toBe(1);
  });

  it("reconciles a unique-index winner that appears after the pair lookup", async () => {
    await env.VWIKI_RACE_DB.prepare(`
      CREATE TRIGGER force_pair_winner
      BEFORE INSERT ON challenges
      FOR EACH ROW
      WHEN NEW.id <> 'challenge-race-winner'
        AND NEW.start_page_id = 7001 AND NEW.target_page_id = 7002
      BEGIN
        INSERT INTO challenges
          (id, label, start_title, target_title, start_page_id, target_page_id,
           validation_status, ruleset, sort_order, is_active, created_at,
           created_by_account_id, created_by_display_name,
           created_by_identity_status)
        VALUES
          ('challenge-race-winner', NEW.label, NEW.start_title, NEW.target_title,
           NEW.start_page_id, NEW.target_page_id, 'ready', 'ranked_classic',
           NEW.sort_order, 1, NEW.created_at, 'account-race-winner',
           'Race winner', 'claimed');
      END;
    `).run();
    const { repository } = fixture();

    const outcome = await repository.createChallengeV2(account, {
      startTitle: "Race start",
      startPageId: 7001,
      startAllowedLinkCount: 20,
      targetTitle: "Race target",
      targetPageId: 7002,
      idempotencyKey: "forced-pair-race",
      nominateForDaily: true,
    });

    expect(outcome).toMatchObject({
      disposition: "existing",
      nomination: "pending",
      challenge: {
        id: "challenge-race-winner",
        sortOrder: 4,
        createdBy: {
          accountId: "account-race-winner",
          displayName: "Race winner",
        },
      },
    });
    await expect(scalar(
      "SELECT next_sort_order FROM challenge_number_sequence WHERE sequence_name = 'global'",
    )).resolves.toBe(5);
    await expect(scalar(
      "SELECT COUNT(*) FROM challenges WHERE start_page_id = 7001 AND target_page_id = 7002",
    )).resolves.toBe(1);
    await expect(scalar(
      "SELECT COUNT(*) FROM daily_nominations WHERE challenge_id = 'challenge-race-winner'",
    )).resolves.toBe(1);
  });

  it("does not renominate a challenge that was already featured", async () => {
    const { repository } = fixture();
    const created = await repository.createChallengeV2(account, {
      startTitle: "Mercury",
      startPageId: 901,
      startAllowedLinkCount: 20,
      targetTitle: "Tides",
      targetPageId: 902,
      idempotencyKey: "featured-original",
      nominateForDaily: false,
    });
    await insertEditorialQueue(env.VWIKI_RACE_DB, {
      id: "featured-admin-entry",
      challengeId: created.challenge.id,
      source: "admin",
    });
    await env.VWIKI_RACE_DB.prepare(
      `UPDATE daily_queue_entries
       SET status = 'consumed', consumed_daily_date = '2026-07-20',
           consumed_at = '2026-07-20T10:00:00.000Z'
       WHERE id = 'featured-admin-entry'`,
    ).run();
    await insertEditorialFeature(env.VWIKI_RACE_DB, {
      dailyDate: "2026-07-20",
      challengeId: created.challenge.id,
      selectionSource: "admin",
      queueEntryId: "featured-admin-entry",
    });

    const duplicateAccount = {
      ...account,
      accountId: "account-late-nominator",
    };
    const duplicateInput = {
      startTitle: "Mercury",
      startPageId: 901,
      startAllowedLinkCount: 20,
      targetTitle: "Tides",
      targetPageId: 902,
      idempotencyKey: "featured-duplicate",
      nominateForDaily: true,
    };
    const duplicate = await repository.createChallengeV2(
      duplicateAccount,
      duplicateInput,
    );

    expect(duplicate).toMatchObject({
      disposition: "existing",
      nomination: "previously_featured",
      challenge: {
        id: created.challenge.id,
        mode: "daily",
        origin: "daily",
        dailyDate: "2026-07-20",
        dailyFeature: {
          dailyDate: "2026-07-20",
          flavor: "recognizable",
          selectionSource: "admin",
        },
        source: "curated",
      },
    });
    await expect(repository.createChallengeV2(
      duplicateAccount,
      duplicateInput,
    )).resolves.toEqual(duplicate);
    await expect(scalar(
      `SELECT COUNT(*) FROM daily_nominations WHERE challenge_id = '${created.challenge.id}'`,
    )).resolves.toBe(0);
    await expect(scalar(
      "SELECT next_sort_order FROM challenge_number_sequence WHERE sequence_name = 'global'",
    )).resolves.toBe(5);
  });

  it("creates for a guest but rejects nomination intent and replays legacy receipts", async () => {
    const { repository } = fixture();
    const guest: AuthorizedAccount = {
      accountId: "account-guest",
      displayName: "Guest name",
      status: "ghost",
      aliases: [],
    };
    const guestOutcome = await repository.createChallengeV2(guest, {
      startTitle: "Mars",
      startPageId: 123,
      startAllowedLinkCount: 4,
      targetTitle: "Water",
      targetPageId: 456,
      idempotencyKey: "guest-nomination",
      nominateForDaily: true,
    });
    expect(guestOutcome).toMatchObject({
      disposition: "created",
      nomination: "account_required",
      challenge: { id: "challenge-0004" },
    });
    await expect(scalar("SELECT COUNT(*) FROM daily_nominations")).resolves.toBe(0);

    const legacyChallenge = (await repository.listChallenges())[0];
    await env.VWIKI_RACE_DB.prepare(
      `INSERT INTO operation_idempotency
         (operation, idempotency_key, canonical_account_id, request_fingerprint,
          resource_id, outcome_status, response_json, created_at)
       VALUES ('create_challenge', 'legacy-create-receipt', ?, 'legacy-fingerprint',
               ?, 'accepted', ?, '2026-07-14T12:00:00.000Z')`,
    ).bind(account.accountId, legacyChallenge.id, JSON.stringify(legacyChallenge)).run();

    await expect(repository.findChallengeCreationReplay(account, {
      idempotencyKey: "legacy-create-receipt",
      requestFingerprint: "legacy-fingerprint",
    })).resolves.toEqual({
      challenge: legacyChallenge,
      disposition: "created",
      nomination: "not_requested",
    });
  });

  it("serializes numeric challenge allocation and enforces the accepted daily quota", async () => {
    const { repository } = fixture();
    const requests = Array.from({ length: 11 }, (_, index) => ({
      startTitle: `Start ${index}`,
      startPageId: 1000 + index,
      startAllowedLinkCount: 1,
      targetTitle: `Target ${index}`,
      targetPageId: 2000 + index,
      idempotencyKey: `create-${index}`,
    }));
    const outcomes = await Promise.allSettled(
      requests.map((input) => repository.createChallengeV2(account, input)),
    );
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(10);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    await expect(scalar(
      "SELECT COUNT(*) FROM challenges WHERE created_by_account_id = 'account-canonical'",
    )).resolves.toBe(10);
    const { results } = await env.VWIKI_RACE_DB.prepare(
      "SELECT sort_order FROM challenges WHERE created_by_account_id = ? ORDER BY sort_order",
    ).bind(account.accountId).all<{ sort_order: number }>();
    expect(results.map((row) => row.sort_order)).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    await expect(repository.createChallengeV2(account, {
      ...requests[0], idempotencyKey: "create-after-daily-limit",
    })).rejects.toMatchObject({ code: "challenge_create_daily_limit", status: 429 });
  });

  it("counts accepted create operations through receipt aliases", async () => {
    for (let index = 0; index < 10; index += 1) {
      await insertFinalizedOperation({
        operation: "create_challenge",
        key: `old-create-${index}`,
        accountId: "account-old",
        outcome: "accepted",
        createdAt: `2026-07-14T00:${String(index).padStart(2, "0")}:00.000Z`,
      });
    }
    const { repository } = fixture();
    await expect(repository.createChallengeV2(
      { ...account, aliases: ["account-old"] },
      {
        startTitle: "Mars",
        startPageId: 123,
        startAllowedLinkCount: 4,
        targetTitle: "Water",
        targetPageId: 456,
        idempotencyKey: "alias-create-limit",
        requestFingerprint: "raw-create-fingerprint",
      },
    )).rejects.toMatchObject({
      code: "challenge_create_daily_limit",
      status: 429,
      retryAfterSeconds: 82_800,
    });
  });

  it("counts all finalized alias create attempts at the rolling-hour boundary", async () => {
    for (let index = 0; index < 20; index += 1) {
      await insertFinalizedOperation({
        operation: "create_challenge",
        key: `hourly-create-${index}`,
        accountId: "account-old",
        outcome: index < 5 ? "accepted" : "rejected",
        createdAt: `2026-07-14T00:${String(index).padStart(2, "0")}:30.000Z`,
      });
    }
    const { repository } = fixture();
    await expect(repository.createChallengeV2(
      { ...account, aliases: ["account-old"] },
      {
        startTitle: "Mars",
        startPageId: 123,
        startAllowedLinkCount: 4,
        targetTitle: "Water",
        targetPageId: 456,
        idempotencyKey: "alias-create-hour-limit",
        requestFingerprint: "raw-create-hour-fingerprint",
      },
    )).rejects.toMatchObject({
      code: "challenge_create_rate_limited",
      status: 429,
      retryAfterSeconds: 90,
    });
  });

  it("accepts the 120th alias-owned start and rejects the next legacy call", async () => {
    for (let index = 0; index < 119; index += 1) {
      await insertFinalizedOperation({
        operation: "start",
        key: `boundary-start-${index}`,
        accountId: "account-old",
        outcome: index % 2 === 0 ? "accepted" : "rejected",
        createdAt: `2026-07-14T00:${String(index % 60).padStart(2, "0")}:30.000Z`,
      });
    }
    const receipt = { ...account, aliases: ["account-old"] };
    const { repository } = fixture();
    await expect(repository.startRunV2(receipt, {
      challengeId: "challenge-0001",
      idempotencyKey: "boundary-v2-start",
    })).resolves.toMatchObject({ protocolVersion: 2, status: "active" });
    await expect(repository.startRunLegacy(receipt, {
      challengeId: "challenge-0001",
    })).rejects.toMatchObject({
      code: "start_rate_limited",
      status: 429,
      retryAfterSeconds: 30,
    });
    await expect(scalar(
      "SELECT COUNT(*) FROM operation_idempotency WHERE operation = 'start'",
    )).resolves.toBe(121);
  });

  it("shares the alias-aware hourly start budget across v2 and legacy starts", async () => {
    for (let index = 0; index < 120; index += 1) {
      await insertFinalizedOperation({
        operation: "start",
        key: `old-start-${index}`,
        accountId: "account-old",
        outcome: index % 2 === 0 ? "accepted" : "rejected",
        createdAt: `2026-07-14T00:${String(index % 60).padStart(2, "0")}:30.000Z`,
      });
    }
    const receipt = { ...account, aliases: ["account-old"] };
    const { repository } = fixture();
    await expect(repository.startRunV2(receipt, {
      challengeId: "challenge-0001",
      idempotencyKey: "alias-v2-start-limit",
    })).rejects.toMatchObject({
      code: "start_rate_limited",
      status: 429,
      retryAfterSeconds: 30,
    });
    const worker = createWorker({
      createTracking: () => ({
        handlers: createApiHandlers(repository),
        identity: {},
        runProtocol: repository,
        authorize: async () => receipt,
      } as unknown as WorkerTracking),
    });
    const legacyResponse = await worker.fetch(new Request(
      "https://worker.example/api/runs/start",
      {
        method: "POST",
        headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId: "challenge-0001" }),
      },
    ), {
      VWIKI_RACE_DB: env.VWIKI_RACE_DB,
      VGAMES_URL: "https://vgames.example",
      CLICK_RATE_LIMITER: { limit: async () => ({ success: true }) },
      ACCOUNT_READ_RATE_LIMITER: { limit: async () => ({ success: true }) },
      CHALLENGE_CREATE_RATE_LIMITER: { limit: async () => ({ success: true }) },
    });
    expect(legacyResponse.status).toBe(429);
    expect(legacyResponse.headers.get("Retry-After")).toBe("90");
    await expect(legacyResponse.json()).resolves.toMatchObject({
      error: { code: "start_rate_limited" },
    });
    await expect(scalar(
      "SELECT COUNT(*) FROM operation_idempotency WHERE operation = 'start'",
    )).resolves.toBe(122);
  });

  it("caps the ordered terminal-attempt leaderboard at 100", async () => {
    for (let index = 0; index < 101; index += 1) {
      await insertCompletedV2({
        id: `leaderboard-${String(index).padStart(3, "0")}`,
        accountId: `leaderboard-account-${index}`,
        elapsedMs: 10_000 + index,
        completedAt: `2026-07-14T01:00:${String(index % 60).padStart(2, "0")}.000Z`,
      });
    }
    await insertCompletedV2({
      id: "repeat-slower",
      accountId: "leaderboard-account-0",
      elapsedMs: 99_999,
      completedAt: "2026-07-14T02:00:00.000Z",
    });
    const { repository } = fixture();
    const rows = await repository.listLeaderboard("challenge-0001");
    expect(rows).toHaveLength(100);
    expect(rows[0]?.runId).toBe("leaderboard-000");
    expect(rows.some((row) => row.runId === "repeat-slower")).toBe(false);
    expect(rows[0]).not.toHaveProperty("pathPreview");
  });

  it("shows every completion plus meaningful DNFs and derives repeat attempts", async () => {
    await insertCompletedV2({
      id: "other-fast",
      accountId: "other-account",
      elapsedMs: 4_000,
      completedAt: "2026-07-14T01:00:04.000Z",
    });
    await insertCompletedV2({
      id: "same-first",
      accountId: account.accountId,
      elapsedMs: 5_000,
      completedAt: "2026-07-14T01:00:05.000Z",
    });
    await insertCompletedV2({
      id: "same-repeat",
      accountId: account.accountId,
      elapsedMs: 6_000,
      completedAt: "2026-07-14T01:01:06.000Z",
    });
    await env.VWIKI_RACE_DB.prepare(
      `UPDATE runs SET started_at='2026-07-14T01:01:00.000Z',
         created_at='2026-07-14T01:01:00.000Z' WHERE id='same-repeat'`,
    ).run();

    await insertLegacyRun({ id: "same-dnf", accountId: account.accountId });
    await env.VWIKI_RACE_DB.prepare(
      `UPDATE runs SET status='abandoned', protocol_version=2, click_count=2,
         started_at='2026-07-14T01:02:00.000Z',
         abandoned_at='2026-07-14T01:02:15.000Z', elapsed_ms=NULL,
         wall_elapsed_ms=NULL, updated_at='2026-07-14T01:02:15.000Z'
       WHERE id='same-dnf'`,
    ).run();
    await env.VWIKI_RACE_DB.prepare(
      `INSERT INTO run_path_steps
         (run_id, step_number, source_title, clicked_anchor_text,
          destination_title, destination_page_id, elapsed_since_start_ms, created_at)
       VALUES ('same-dnf', 1, 'Moon', 'space', 'Outer space', 1, 7000,
               '2026-07-14T01:02:07.000Z'),
              ('same-dnf', 2, 'Outer space', 'orbit', 'Orbit', 2, 12000,
               '2026-07-14T01:02:12.000Z')`,
    ).run();

    await insertLegacyRun({ id: "zero-click-dnf", accountId: "zero-account" });
    await env.VWIKI_RACE_DB.prepare(
      `UPDATE runs SET status='abandoned', protocol_version=2,
         abandoned_at='2026-07-14T01:03:01.000Z', elapsed_ms=1000,
         wall_elapsed_ms=1000 WHERE id='zero-click-dnf'`,
    ).run();

    const { repository } = fixture();
    const rows = await repository.listLeaderboard("challenge-0001");

    expect(rows.map((row) => ({
      id: row.runId,
      status: row.status,
      repeat: row.isRepeatRun,
    }))).toEqual([
      { id: "other-fast", status: "completed", repeat: false },
      { id: "same-first", status: "completed", repeat: false },
      { id: "same-repeat", status: "completed", repeat: true },
      { id: "same-dnf", status: "abandoned", repeat: true },
    ]);
    expect(rows.at(-1)).toMatchObject({
      abandonedAt: "2026-07-14T01:02:15.000Z",
      clickCount: 2,
      elapsedMs: 15_000,
      rank: 4,
      startedAt: "2026-07-14T01:02:00.000Z",
    });
    // `account` qualifies as viewer via its own eligible completed run on
    // this challenge ("same-first", above).
    await expect(repository.getPublicRunPath("same-dnf", account)).resolves.toHaveLength(2);
    expect(rows.some((row) => row.runId === "zero-click-dnf")).toBe(false);
  });

  it("DT-1 (\"Your history\" lists EVERY counted attempt): TWO separate DNFs on the same challenge, no completion at all, both appear - no cap/dedup hides the second one", async () => {
    await insertAbandonedV2({
      id: "two-dnf-first", accountId: account.accountId, clickCount: 3,
      elapsedMs: 8_000, abandonedAt: "2026-07-14T01:00:08.000Z",
    });
    await insertAbandonedV2({
      id: "two-dnf-second", accountId: account.accountId, clickCount: 6,
      elapsedMs: 15_000, abandonedAt: "2026-07-14T02:00:15.000Z",
    });

    const { repository } = fixture();
    const rows = await repository.listLeaderboard("challenge-0001");
    const mine = rows.filter((row) => row.accountId === account.accountId);

    expect(mine.map((row) => row.runId).sort()).toEqual(["two-dnf-first", "two-dnf-second"]);
    expect(mine.every((row) => row.status === "abandoned")).toBe(true);
    // Both are counted attempts (DT-1/FB-7): the second one is a repeat
    // attempt (`isRepeatRun`), not deduped away or capped to one DNF.
    expect(mine.find((row) => row.runId === "two-dnf-first")?.isRepeatRun).toBe(false);
    expect(mine.find((row) => row.runId === "two-dnf-second")?.isRepeatRun).toBe(true);
  });

  it("FB-7 (owner ruling, 2026-07-19): getPublicRunPath refuses a sub-threshold (1-click) DNF's path - it's no longer board-visible anywhere", async () => {
    await insertCompletedV2({
      id: "public-path-viewer-own-completed",
      accountId: account.accountId,
      elapsedMs: 4_000,
      completedAt: "2026-07-14T01:00:04.000Z",
    });
    await insertLegacyRun({ id: "one-click-dnf-path", accountId: "one-click-dnf-account" });
    await env.VWIKI_RACE_DB.prepare(
      `UPDATE runs SET status='abandoned', protocol_version=2, click_count=1,
         abandoned_at='2026-07-14T01:00:05.000Z', elapsed_ms=5000,
         wall_elapsed_ms=5000 WHERE id='one-click-dnf-path'`,
    ).run();
    await env.VWIKI_RACE_DB.prepare(
      `INSERT INTO run_path_steps
         (run_id, step_number, source_title, clicked_anchor_text, destination_title,
          destination_page_id, elapsed_since_start_ms, created_at)
       VALUES ('one-click-dnf-path', 1, 'Moon', 'gravity', 'Gravity', 38579, 5000,
               '2026-07-14T01:00:05.000Z')`,
    ).run();

    const { repository } = fixture();
    // `account` qualifies as viewer via its own eligible completed run above.
    await expect(repository.getPublicRunPath("one-click-dnf-path", account)).rejects.toMatchObject({
      code: "run_path_not_found", status: 404,
    });
  });

  it("derives repeat attempts across VGames account aliases", async () => {
    await insertCompletedV2({
      id: "alias-first",
      accountId: "account-before-claim",
      elapsedMs: 3_000,
      completedAt: "2026-07-14T00:59:03.000Z",
    });
    await env.VWIKI_RACE_DB.prepare(
      `UPDATE runs SET started_at='2026-07-14T00:59:00.000Z',
         created_at='2026-07-14T00:59:00.000Z' WHERE id='alias-first'`,
    ).run();
    const clock = { now: "2026-07-14T01:00:00.000Z" };
    const { repository } = fixture(clock);
    const claimed = { ...account, aliases: ["account-before-claim"] };
    await repository.startRunV2(claimed, start);
    clock.now = "2026-07-14T01:00:04.200Z";
    await repository.recordClickV2(claimed, targetClick);

    const rows = await repository.listLeaderboard("challenge-0001");
    expect(rows.map((row) => ({
      id: row.runId,
      accountId: row.accountId,
      repeat: row.isRepeatRun,
    }))).toEqual([
      { id: "alias-first", accountId: account.accountId, repeat: false },
      { id: "run-1", accountId: account.accountId, repeat: true },
    ]);
  });

  it("keeps completed protocol-1 runs ranked alongside verified protocol-2 runs", async () => {
    await insertCompletedLegacy({
      id: "historical-fastest",
      accountId: "historical-account",
      elapsedMs: 4_000,
      clickCount: 3,
      completedAt: "2026-07-14T01:00:04.000Z",
    });
    await insertCompletedV2({
      id: "verified-second",
      accountId: "verified-account",
      elapsedMs: 5_000,
      completedAt: "2026-07-14T01:00:05.000Z",
    });

    const { repository } = fixture();
    const rows = await repository.listLeaderboard("challenge-0001");

    expect(rows).toEqual([
      expect.objectContaining({
        rank: 1,
        runId: "historical-fastest",
        protocolVersion: 1,
      }),
      expect.objectContaining({
        rank: 2,
        runId: "verified-second",
        protocolVersion: 2,
      }),
    ]);
  });

  it("exposes one public path read only for a completed ranked run", async () => {
    await insertCompletedV2({
      id: "public-path-run",
      accountId: account.accountId,
      elapsedMs: 4200,
      completedAt: "2026-07-14T01:00:04.200Z",
    });
    await env.VWIKI_RACE_DB.prepare(
      `INSERT INTO run_path_steps
         (run_id, step_number, source_title, clicked_anchor_text, destination_title,
          destination_page_id, elapsed_since_start_ms, created_at)
       VALUES ('public-path-run', 1, 'Moon', 'gravity', 'Gravity', 38579, 4200,
               '2026-07-14T01:00:04.200Z')`,
    ).run();
    await insertLegacyRun({ id: "private-path-run", accountId: account.accountId });
    const { repository } = fixture();
    // `account` qualifies as viewer via its own eligible completed run
    // ("public-path-run" itself) - see the FB-4 tests below for the
    // NON-OWN-run disclosure cases.
    await expect(repository.getPublicRunPath("public-path-run", account)).resolves.toEqual([
      expect.objectContaining({ destinationTitle: "Gravity", stepNumber: 1 }),
    ]);
    await expect(repository.getPublicRunPath("private-path-run", account)).rejects.toMatchObject({
      code: "run_path_not_found", status: 404,
    });
  });

  it("hides the path of a board-excluded run behind the same not-found outcome", async () => {
    await insertCompletedV2({
      id: "excluded-path-run",
      accountId: account.accountId,
      elapsedMs: 4200,
      completedAt: "2026-07-14T01:00:04.200Z",
    });
    await env.VWIKI_RACE_DB.prepare(
      `INSERT INTO run_path_steps
         (run_id, step_number, source_title, clicked_anchor_text, destination_title,
          destination_page_id, elapsed_since_start_ms, created_at)
       VALUES ('excluded-path-run', 1, 'Moon', 'gravity', 'Gravity', 38579, 4200,
               '2026-07-14T01:00:04.200Z')`,
    ).run();
    const { repository } = fixture();
    await expect(repository.getPublicRunPath("excluded-path-run", account)).resolves.toEqual([
      expect.objectContaining({ destinationTitle: "Gravity", stepNumber: 1 }),
    ]);

    await repository.setRunBoardExclusion("excluded-path-run", true);

    await expect(repository.getPublicRunPath("excluded-path-run", account)).rejects.toMatchObject({
      code: "run_path_not_found", status: 404,
    });
  });

  it("keeps the recorded path of a completed protocol-1 run publicly viewable", async () => {
    await insertCompletedLegacy({
      id: "historical-path-run",
      accountId: account.accountId,
      elapsedMs: 4200,
      clickCount: 1,
      completedAt: "2026-07-14T01:00:04.200Z",
    });
    await env.VWIKI_RACE_DB.prepare(
      `INSERT INTO run_path_steps
         (run_id, step_number, source_title, clicked_anchor_text, destination_title,
          destination_page_id, elapsed_since_start_ms, created_at)
       VALUES ('historical-path-run', 1, 'Moon', 'gravity', 'Gravity', 38579, 4200,
               '2026-07-14T01:00:04.200Z')`,
    ).run();

    const { repository } = fixture();
    await expect(repository.getPublicRunPath("historical-path-run", account)).resolves.toEqual([
      expect.objectContaining({ destinationTitle: "Gravity", stepNumber: 1 }),
    ]);
  });

  it("does not expose a malformed protocol-1 completion as a public ranked path", async () => {
    await insertCompletedLegacy({
      id: "malformed-historical-path",
      accountId: account.accountId,
      elapsedMs: 4200,
      clickCount: 1,
      completedAt: "2026-07-14T01:00:04.200Z",
    });
    await env.VWIKI_RACE_DB.prepare(
      "UPDATE runs SET elapsed_ms = NULL WHERE id = 'malformed-historical-path'",
    ).run();
    await env.VWIKI_RACE_DB.prepare(
      `INSERT INTO run_path_steps
         (run_id, step_number, source_title, clicked_anchor_text, destination_title,
          destination_page_id, elapsed_since_start_ms, created_at)
       VALUES ('malformed-historical-path', 1, 'Moon', 'gravity', 'Gravity', 38579,
               4200, '2026-07-14T01:00:04.200Z')`,
    ).run();

    const { repository } = fixture();
    await expect(repository.getPublicRunPath("malformed-historical-path", account))
      .rejects.toMatchObject({ code: "run_path_not_found", status: 404 });
  });

  it("FB-4 (council 2026-07-19, owner decision 10): discloses a NON-OWN completed run's path once the viewer has their own eligible completed run on the SAME challenge", async () => {
    await insertCompletedV2({
      id: "winner-run",
      accountId: "other-account",
      elapsedMs: 4_000,
      completedAt: "2026-07-14T01:00:04.000Z",
    });
    await env.VWIKI_RACE_DB.prepare(
      `INSERT INTO run_path_steps
         (run_id, step_number, source_title, clicked_anchor_text, destination_title,
          destination_page_id, elapsed_since_start_ms, created_at)
       VALUES ('winner-run', 1, 'Moon', 'gravity', 'Gravity', 38579, 4000,
               '2026-07-14T01:00:04.000Z')`,
    ).run();
    // The viewer (account) has their own eligible completed run on the same
    // challenge-0001 - never "winner-run" itself.
    await insertCompletedV2({
      id: "viewer-own-run",
      accountId: account.accountId,
      elapsedMs: 6_000,
      completedAt: "2026-07-14T01:00:06.000Z",
    });

    const { repository } = fixture();
    await expect(repository.getPublicRunPath("winner-run", account)).resolves.toEqual([
      expect.objectContaining({ destinationTitle: "Gravity", stepNumber: 1 }),
    ]);
  });

  it("FB-4: blocks a NON-OWN completed run's path when the viewer has not finished that challenge - server-side, not client-trusted", async () => {
    await insertCompletedV2({
      id: "winner-run",
      accountId: "other-account",
      elapsedMs: 4_000,
      completedAt: "2026-07-14T01:00:04.000Z",
    });
    await env.VWIKI_RACE_DB.prepare(
      `INSERT INTO run_path_steps
         (run_id, step_number, source_title, clicked_anchor_text, destination_title,
          destination_page_id, elapsed_since_start_ms, created_at)
       VALUES ('winner-run', 1, 'Moon', 'gravity', 'Gravity', 38579, 4000,
               '2026-07-14T01:00:04.000Z')`,
    ).run();
    const { repository } = fixture();

    // No run at all for the viewer on this challenge.
    await expect(repository.getPublicRunPath("winner-run", account)).rejects.toMatchObject({
      code: "run_path_not_found", status: 404,
    });

    // A DNF alone doesn't unlock it either (invariant 2/5: only a
    // completion counts as "played").
    await insertLegacyRun({ id: "viewer-dnf", accountId: account.accountId });
    await env.VWIKI_RACE_DB.prepare(
      `UPDATE runs SET status='abandoned', protocol_version=2, click_count=2,
         abandoned_at='2026-07-14T01:02:15.000Z', elapsed_ms=3000
       WHERE id='viewer-dnf'`,
    ).run();
    await expect(repository.getPublicRunPath("winner-run", account)).rejects.toMatchObject({
      code: "run_path_not_found", status: 404,
    });
  });

  it("FB-4: resolves the viewer-finished guard through canonical account aliases, same as the rest of the board/stats queries", async () => {
    await insertCompletedV2({
      id: "winner-run",
      accountId: "other-account",
      elapsedMs: 4_000,
      completedAt: "2026-07-14T01:00:04.000Z",
    });
    await env.VWIKI_RACE_DB.prepare(
      `INSERT INTO run_path_steps
         (run_id, step_number, source_title, clicked_anchor_text, destination_title,
          destination_page_id, elapsed_since_start_ms, created_at)
       VALUES ('winner-run', 1, 'Moon', 'gravity', 'Gravity', 38579, 4000,
               '2026-07-14T01:00:04.000Z')`,
    ).run();
    // The viewer's completed run is recorded under a pre-claim alias id,
    // merged into the canonical account via `account_aliases`.
    await insertCompletedV2({
      id: "viewer-alias-run",
      accountId: "account-before-claim",
      elapsedMs: 6_000,
      completedAt: "2026-07-14T01:00:06.000Z",
    });
    await env.VWIKI_RACE_DB.prepare(
      `INSERT INTO account_aliases (alias_account_id, canonical_account_id, updated_at)
       VALUES ('account-before-claim', ?, '2026-07-14T01:00:00.000Z')`,
    ).bind(account.accountId).run();

    const { repository } = fixture();
    await expect(repository.getPublicRunPath("winner-run", account)).resolves.toEqual([
      expect.objectContaining({ destinationTitle: "Gravity", stepNumber: 1 }),
    ]);
  });

  it("FB-4: the authenticated v2 Worker route requires a viewer and enforces the same guard end to end", async () => {
    await insertCompletedV2({
      id: "winner-run",
      accountId: "other-account",
      elapsedMs: 4_000,
      completedAt: "2026-07-14T01:00:04.000Z",
    });
    await env.VWIKI_RACE_DB.prepare(
      `INSERT INTO run_path_steps
         (run_id, step_number, source_title, clicked_anchor_text, destination_title,
          destination_page_id, elapsed_since_start_ms, created_at)
       VALUES ('winner-run', 1, 'Moon', 'gravity', 'Gravity', 38579, 4000,
               '2026-07-14T01:00:04.000Z')`,
    ).run();
    const { repository } = fixture();
    const authorize = vi.fn(async (request: Request) => {
      if (request.headers.get("Authorization") !== "Bearer viewer-token") {
        throw new ApiError("unauthorized", "Sign in to view this path.", 401);
      }
      return account;
    });
    const accountReadLimit = vi.fn(async () => ({ success: true }));
    const worker = createWorker({
      createTracking: () => ({
        handlers: createApiHandlers(repository),
        identity: {},
        runProtocol: repository,
        authorize,
      } as unknown as WorkerTracking),
    });
    const route = "https://worker.example/api/v2/runs/winner-run/path";
    const workerEnv = {
      VWIKI_RACE_DB: env.VWIKI_RACE_DB,
      VGAMES_URL: "https://vgames.example",
      CLICK_RATE_LIMITER: { limit: async () => ({ success: true }) },
      ACCOUNT_READ_RATE_LIMITER: { limit: accountReadLimit },
      CHALLENGE_CREATE_RATE_LIMITER: { limit: async () => ({ success: true }) },
    };

    // No Authorization header at all - this route refuses to answer
    // anonymously (the pre-migration legacy `/api/runs/{id}/path` route,
    // which used to answer anonymously, has been retired entirely - see
    // the dedicated test below).
    const unauthorized = await worker.fetch(new Request(route), workerEnv);
    expect(unauthorized.status).toBe(401);
    expect(accountReadLimit).not.toHaveBeenCalled();

    // Authorized, but the viewer hasn't finished challenge-0001 yet.
    const blocked = await worker.fetch(new Request(route, {
      headers: { Authorization: "Bearer viewer-token" },
    }), workerEnv);
    expect(blocked.status).toBe(404);
    await expect(blocked.json()).resolves.toMatchObject({
      error: { code: "run_path_not_found" },
    });
    expect(accountReadLimit).toHaveBeenCalledWith({ key: "path:account-canonical" });

    // The viewer finishes challenge-0001 themselves, then the same route
    // discloses the OTHER player's path.
    await repository.startRunV2(account, start);
    await repository.recordClickV2(account, targetClick);
    const allowed = await worker.fetch(new Request(route, {
      headers: { Authorization: "Bearer viewer-token" },
    }), workerEnv);
    expect(allowed.status).toBe(200);
    await expect(allowed.json()).resolves.toEqual({
      path: [expect.objectContaining({ destinationTitle: "Gravity", stepNumber: 1 })],
    });
  });

  it("FB-4 review fix: the retired legacy GET /api/runs/{id}/path route no longer answers anonymously (or at all)", async () => {
    await insertCompletedV2({
      id: "winner-run",
      accountId: "other-account",
      elapsedMs: 4_000,
      completedAt: "2026-07-14T01:00:04.000Z",
    });
    await env.VWIKI_RACE_DB.prepare(
      `INSERT INTO run_path_steps
         (run_id, step_number, source_title, clicked_anchor_text, destination_title,
          destination_page_id, elapsed_since_start_ms, created_at)
       VALUES ('winner-run', 1, 'Moon', 'gravity', 'Gravity', 38579, 4000,
               '2026-07-14T01:00:04.000Z')`,
    ).run();
    const { repository } = fixture();
    const worker = createWorker({
      createTracking: () => ({
        handlers: createApiHandlers(repository),
        identity: {},
        runProtocol: repository,
        authorize: vi.fn(async () => {
          throw new ApiError("unauthorized", "Sign in.", 401);
        }),
      } as unknown as WorkerTracking),
    });
    const workerEnv = {
      VWIKI_RACE_DB: env.VWIKI_RACE_DB,
      VGAMES_URL: "https://vgames.example",
      CLICK_RATE_LIMITER: { limit: async () => ({ success: true }) },
      ACCOUNT_READ_RATE_LIMITER: { limit: async () => ({ success: true }) },
      CHALLENGE_CREATE_RATE_LIMITER: { limit: async () => ({ success: true }) },
    };

    // The old anonymous, unguarded route - no Authorization header, and
    // `authorize` above would reject one anyway - must not disclose the
    // path (PKG-03 board rows publicly carry `runId`, so this was a
    // straight bypass of the v2 route's viewer-finished guard).
    const legacy = await worker.fetch(
      new Request("https://worker.example/api/runs/winner-run/path"),
      workerEnv,
    );
    expect(legacy.status).toBe(404);
    await expect(legacy.json()).resolves.toMatchObject({ error: { code: "not_found" } });
  });

  it("returns an owned active protocol-2 zero-click recovery path through the authenticated rate-limited Worker route", async () => {
    const { repository } = fixture();
    const run = await repository.startRunV2(account, start);
    const authorize = vi.fn(async (request: Request) => {
      if (request.headers.get("Authorization") !== "Bearer recovery-token") {
        throw new ApiError("unauthorized", "Sign in before recovering a run.", 401);
      }
      return account;
    });
    const accountReadLimit = vi.fn(async () => ({ success: true }));
    const worker = createWorker({
      createTracking: () => ({
        handlers: createApiHandlers(repository),
        identity: {},
        runProtocol: repository,
        authorize,
      } as unknown as WorkerTracking),
    });
    const route = `https://worker.example/api/v2/runs/${run.id}/recovery-path`;
    const workerEnv = {
      VWIKI_RACE_DB: env.VWIKI_RACE_DB,
      VGAMES_URL: "https://vgames.example",
      CLICK_RATE_LIMITER: { limit: async () => ({ success: true }) },
      ACCOUNT_READ_RATE_LIMITER: { limit: accountReadLimit },
      CHALLENGE_CREATE_RATE_LIMITER: { limit: async () => ({ success: true }) },
    };

    const unauthorized = await worker.fetch(new Request(route), workerEnv);
    expect(unauthorized.status).toBe(401);
    expect(accountReadLimit).not.toHaveBeenCalled();

    const response = await worker.fetch(new Request(route, {
      headers: { Authorization: "Bearer recovery-token" },
    }), workerEnv);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ path: [] });
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(accountReadLimit).toHaveBeenCalledWith({
      key: "recovery-path:account-canonical",
    });

    const limitedWorker = createWorker({
      createTracking: () => ({
        handlers: createApiHandlers(repository),
        identity: {},
        runProtocol: repository,
        authorize,
      } as unknown as WorkerTracking),
    });
    const limited = await limitedWorker.fetch(new Request(route, {
      headers: { Authorization: "Bearer recovery-token" },
    }), {
      ...workerEnv,
      ACCOUNT_READ_RATE_LIMITER: { limit: async () => ({ success: false }) },
      CHALLENGE_CREATE_RATE_LIMITER: { limit: async () => ({ success: true }) },
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
    await expect(limited.json()).resolves.toMatchObject({
      error: { code: "account_read_rate_limited" },
    });
  });

  it("returns only accepted path rows for an owned active protocol-2 run", async () => {
    const { repository } = fixture();
    const run = await repository.startRunV2(account, start);
    await repository.recordClickV2(account, {
      ...targetClick,
      runId: run.id,
      clientEventId: "00000000-0000-4000-8000-000000000301",
      destinationTitle: "Orbit",
      destinationPageId: 1234,
    });

    await expect(repository.getRecoveryRunPath(account, run.id)).resolves.toEqual([
      expect.objectContaining({
        stepNumber: 1,
        sourceTitle: "Moon",
        destinationTitle: "Orbit",
        destinationPageId: 1234,
      }),
    ]);
  });

  it("resolves recovery-path ownership through the canonical account aliases", async () => {
    const aliasAccount = {
      ...account,
      accountId: "account-old",
      aliases: [],
    };
    const { repository } = fixture();
    const run = await repository.startRunV2(aliasAccount, start);
    await env.VWIKI_RACE_DB.prepare(
      `INSERT INTO account_aliases (alias_account_id, canonical_account_id, updated_at)
       VALUES ('account-old', ?, '2026-07-14T01:00:00.000Z')`,
    ).bind(account.accountId).run();

    await expect(repository.getRecoveryRunPath({
      ...account,
      aliases: ["account-old"],
    }, run.id)).resolves.toEqual([]);
  });

  it("does not disclose foreign, inactive, or legacy recovery paths", async () => {
    const { repository } = fixture();
    const active = await repository.startRunV2(account, start);
    const foreignAccount = {
      ...account,
      accountId: "account-foreign",
      aliases: [],
    };
    await expect(repository.getRecoveryRunPath(foreignAccount, active.id)).rejects.toMatchObject({
      code: "recovery_path_not_found",
      status: 404,
    });

    await repository.abandonRunV2(account, {
      runId: active.id,
      idempotencyKey: "abandon-recovery-run",
    });
    await expect(repository.getRecoveryRunPath(account, active.id)).rejects.toMatchObject({
      code: "recovery_path_not_found",
      status: 404,
    });

    await insertCompletedV2({
      id: "completed-recovery-run",
      accountId: account.accountId,
      elapsedMs: 4200,
      completedAt: "2026-07-14T01:00:04.200Z",
    });
    await expect(repository.getRecoveryRunPath(account, "completed-recovery-run")).rejects.toMatchObject({
      code: "recovery_path_not_found",
      status: 404,
    });

    await insertLegacyRun({ id: "legacy-recovery-run", accountId: account.accountId });
    await expect(repository.getRecoveryRunPath(account, "legacy-recovery-run")).rejects.toMatchObject({
      code: "recovery_path_not_found",
      status: 404,
    });
  });

  it.each([
    { protocolVersion: 2 as const, recoveryProtocolVersion: undefined },
    { protocolVersion: 1 as const, recoveryProtocolVersion: 1 as const },
  ])("abandons a discovered alias-owned protocol-$protocolVersion run exactly once", async ({
    protocolVersion,
    recoveryProtocolVersion,
  }) => {
    const oldAccount = { ...account, accountId: "account-old", aliases: [] };
    const { repository } = fixture(undefined, "alias-abandon-run");
    if (protocolVersion === 2) {
      await repository.startRunV2(oldAccount, {
        challengeId: "challenge-0001",
        idempotencyKey: "alias-old-start",
      });
      // click_count is incidental here (RC-02 root-cause fix: findActiveRun no
      // longer gates on it) - bumped anyway just to exercise a non-zero value
      // alongside the alias-owned discovery/abandon behavior under test.
      await env.VWIKI_RACE_DB.prepare("UPDATE runs SET click_count = 2 WHERE id = ?")
        .bind("alias-abandon-run").run();
    } else {
      await insertLegacyRun({ id: "alias-abandon-run", accountId: oldAccount.accountId });
    }
    const receipt = { ...account, aliases: [oldAccount.accountId] };
    await expect(repository.findActiveRun(receipt)).resolves.toMatchObject({
      id: "alias-abandon-run",
      status: "active",
    });
    const input = {
      runId: "alias-abandon-run",
      idempotencyKey: `alias-abandon-${protocolVersion}`,
      recoveryProtocolVersion,
    };

    const transition = await repository.abandonRunV2(receipt, input);
    await expect(repository.abandonRunV2(receipt, input)).resolves.toEqual(transition);
    expect(transition).toMatchObject({
      runId: "alias-abandon-run",
      runStatus: "abandoned",
      outcome: protocolVersion === 1 ? "legacy_recovery_abandoned" : "abandoned",
    });
    await expect(scalar(
      `SELECT COUNT(*) FROM run_events
       WHERE run_id = 'alias-abandon-run' AND event_type = 'run_abandoned'`,
    )).resolves.toBe(1);
    await expect(operationRow("abandon", input.idempotencyKey)).resolves.toMatchObject({
      outcome_status: "accepted",
    });
  });

  it("returns numeric zero averages for empty account stats", async () => {
    const { repository } = fixture();
    await expect(repository.getAccountStats(account)).resolves.toEqual({
      totals: {
        attempts: 0,
        completed: 0,
        abandoned: 0,
        timedCompleted: 0,
        totalClicks: 0,
        bestClicks: null,
        bestElapsedMs: null,
        averageClicks: 0,
        averageElapsedMs: 0,
      },
      topStarts: [],
      topTargets: [],
      mostVisited: [],
      dailyStreak: 0,
      // Owner ruling, 2026-07-25 ("metric-independent ranking changes"):
      // `guard` is now the flat `DAILY_TREND_INCLUSION_FLOOR` (2),
      // regardless of catalog size (was `ceil(0/3) = 1` under the old
      // reality-scaled formula, since this fixture is otherwise empty).
      // Ranking council (2026-08-02): `beatRate`/`gradedCount` mirror the
      // below-guard shape - null/0 with zero completions.
      trend30: { avgPlacement: null, beatRate: null, gradedCount: 0, playedCount: 0, ranked: false, guard: 2 },
    });
  });

  it("projects exact bounded stats without account-ingestion writes", async () => {
    await insertCompletedV2({
      id: "stats-v2", accountId: "old-account", elapsedMs: 4200,
      completedAt: "2026-07-14T01:00:04.200Z",
    });
    await env.VWIKI_RACE_DB.prepare(
      "UPDATE runs SET click_count = 3 WHERE id = 'stats-v2'",
    ).run();
    await insertLegacyRun({ id: "stats-completed-legacy", accountId: "old-account" });
    await env.VWIKI_RACE_DB.prepare(
      `UPDATE runs SET status = 'completed', click_count = 2,
         completed_at = '2026-07-14T01:00:08.000Z', elapsed_ms = 8000
       WHERE id = 'stats-completed-legacy'`,
    ).run();
    await insertLegacyRun({ id: "stats-abandoned", accountId: "old-account" });
    await env.VWIKI_RACE_DB.prepare(
      "UPDATE runs SET status = 'abandoned', click_count = 9 WHERE id = 'stats-abandoned'",
    ).run();
    await env.VWIKI_RACE_DB.prepare(
      `INSERT INTO run_path_steps
         (run_id, step_number, source_title, clicked_anchor_text, destination_title,
          destination_page_id, elapsed_since_start_ms, created_at)
       VALUES ('stats-v2', 1, 'Moon', 'gravity', 'Gravity', 38579, 4200,
               '2026-07-14T01:00:04.200Z')`,
    ).run();
    await env.VWIKI_RACE_DB.prepare(
      `INSERT INTO account_aliases (alias_account_id, canonical_account_id, updated_at)
       VALUES ('old-account', ?, '2026-07-14T00:00:00.000Z')`,
    ).bind(account.accountId).run();
    const { repository } = fixture();
    const stats = await repository.getAccountStats({ ...account, aliases: ["old-account"] });
    expect(stats).toEqual({
      totals: {
        attempts: 3,
        completed: 2,
        abandoned: 1,
        timedCompleted: 1,
        totalClicks: 5,
        bestClicks: 2,
        bestElapsedMs: 4200,
        averageClicks: 2.5,
        averageElapsedMs: 4200,
      },
      topStarts: [{ title: "Moon", count: 3 }],
      topTargets: [{ title: "Gravity", count: 3 }],
      mostVisited: [
        { title: "Moon", count: 3 },
        { title: "Gravity", count: 1 },
      ],
      dailyStreak: 0,
      // FB-10 (owner ruling, 2026-07-20): `trend30` now aggregates over
      // every challenge, not just dailies - this account's completed run
      // above lands on the seeded `challenge-0001` (the only active
      // challenge in this fixture's 30d window), so it's now the sole,
      // solo entrant. Owner ruling, 2026-07-25 ("metric-independent ranking
      // changes"): the guard is a flat 2 counted completions now (not
      // catalog-scaled) - this account's single completion stays below it,
      // so it's unranked with no avgPlacement, same shape the below-guard
      // branch above uses. It's also a SOLO completion (nobody else raced
      // `challenge-0001` in this fixture), so `gradedCount` is 0 regardless.
      trend30: { avgPlacement: null, beatRate: null, gradedCount: 0, playedCount: 1, ranked: false, guard: 2 },
    });
    await expect(count("account_profiles")).resolves.toBe(0);
    await expect(count("account_aliases")).resolves.toBe(1);
  });

  it("FB-7 (owner ruling, 2026-07-19): excludes a 1-click DNF from attempts/abandoned - the exact site the owner's own Daily #4 DNF prompted this ruling from", async () => {
    await insertAbandonedV2({
      id: "stats-one-click-dnf",
      accountId: account.accountId,
      clickCount: 1,
      elapsedMs: 1_000,
      abandonedAt: "2026-07-14T01:00:01.000Z",
    });

    const { repository } = fixture();
    const stats = await repository.getAccountStats(account);

    expect(stats.totals).toMatchObject({ attempts: 0, completed: 0, abandoned: 0 });
  });

  it("counts a 2-click DNF in attempts/abandoned (exactly at the FB-7 threshold)", async () => {
    await insertAbandonedV2({
      id: "stats-two-click-dnf",
      accountId: account.accountId,
      clickCount: 2,
      elapsedMs: 1_000,
      abandonedAt: "2026-07-14T01:00:01.000Z",
    });

    const { repository } = fixture();
    const stats = await repository.getAccountStats(account);

    expect(stats.totals).toMatchObject({ attempts: 1, completed: 0, abandoned: 1 });
  });
});

describe("getDailyExclusionSets (no-repeat exclusions, owner incident 2026-07-29 - a target is used once, ever)", () => {
  it("includes every title ever used as a daily target, all-time - no 30-day window on targets", async () => {
    await insertReadyChallenge({ id: "excl-old-daily", startPageId: 8001, targetPageId: 8002 });
    await insertEditorialFeature(env.VWIKI_RACE_DB, {
      dailyDate: "2025-01-01",
      challengeId: "excl-old-daily",
      selectionSource: "automatic",
    });
    // Deactivating it afterward (e.g. a since-retired daily) must not drop
    // it from the all-time target memory - that's the whole point of "used
    // once, ever" versus the separate "currently active" arm below.
    await env.VWIKI_RACE_DB.prepare(
      "UPDATE challenges SET is_active = 0 WHERE id = 'excl-old-daily'",
    ).run();
    const { repository } = fixture();

    const sets = await repository.getDailyExclusionSets("2026-07-29");

    expect(sets.excludedTargetTitles.has("target 8002")).toBe(true);
  });

  it("includes the target of any currently-active catalog challenge, regardless of origin, even if it was never a daily", async () => {
    await insertReadyChallenge({ id: "excl-live-manual", startPageId: 8101, targetPageId: 8102 });
    const { repository } = fixture();

    const sets = await repository.getDailyExclusionSets("2026-07-29");

    expect(sets.excludedTargetTitles.has("target 8102")).toBe(true);
  });

  it("excludes an inactive, never-featured challenge's target from the target set", async () => {
    await insertReadyChallenge({ id: "excl-inactive-never-daily", startPageId: 8201, targetPageId: 8202 });
    await env.VWIKI_RACE_DB.prepare(
      "UPDATE challenges SET is_active = 0 WHERE id = 'excl-inactive-never-daily'",
    ).run();
    const { repository } = fixture();

    const sets = await repository.getDailyExclusionSets("2026-07-29");

    expect(sets.excludedTargetTitles.has("target 8202")).toBe(false);
  });

  it("includes a daily's start only within the last 30 days, and excludes an older one", async () => {
    await insertReadyChallenge({ id: "excl-start-recent", startPageId: 8301, targetPageId: 8302 });
    await insertReadyChallenge({ id: "excl-start-stale", startPageId: 8401, targetPageId: 8402 });
    await insertEditorialFeature(env.VWIKI_RACE_DB, {
      dailyDate: "2026-07-10",
      challengeId: "excl-start-recent",
      selectionSource: "automatic",
    });
    await insertEditorialFeature(env.VWIKI_RACE_DB, {
      dailyDate: "2026-05-01",
      challengeId: "excl-start-stale",
      selectionSource: "automatic",
    });
    const { repository } = fixture();

    const sets = await repository.getDailyExclusionSets("2026-07-29");

    expect(sets.excludedStartTitles.has("start 8301")).toBe(true);
    expect(sets.excludedStartTitles.has("start 8401")).toBe(false);
  });

  it("includes a start exactly 30 days back (inclusive boundary)", async () => {
    await insertReadyChallenge({ id: "excl-start-boundary", startPageId: 8501, targetPageId: 8502 });
    await insertEditorialFeature(env.VWIKI_RACE_DB, {
      dailyDate: "2026-06-29",
      challengeId: "excl-start-boundary",
      selectionSource: "automatic",
    });
    const { repository } = fixture();

    const sets = await repository.getDailyExclusionSets("2026-07-29");

    expect(sets.excludedStartTitles.has("start 8501")).toBe(true);
  });

  it("normalizes titles (case/underscore/whitespace-insensitive) the same way the evaluator compares them", async () => {
    await env.VWIKI_RACE_DB.prepare(
      `INSERT INTO challenges
         (id, label, start_title, target_title, start_page_id, target_page_id,
          validation_status, ruleset, sort_order, is_active, created_at, origin, source)
       VALUES ('excl-normalize', 'Normalize', 'Odd   Start', 'Odd_Target', 8601, 8602,
               'ready', 'ranked_classic', 190, 1, '2026-07-14T01:00:00.000Z', 'manual', 'curated')`,
    ).run();
    await insertEditorialFeature(env.VWIKI_RACE_DB, {
      dailyDate: "2026-07-10",
      challengeId: "excl-normalize",
      selectionSource: "automatic",
    });
    const { repository } = fixture();

    const sets = await repository.getDailyExclusionSets("2026-07-29");

    expect(sets.excludedTargetTitles.has("odd target")).toBe(true);
    expect(sets.excludedStartTitles.has("odd start")).toBe(true);
  });

  it("rejects a malformed reference date the same way other daily-date entry points do", async () => {
    const { repository } = fixture();

    await expect(repository.getDailyExclusionSets("2026-13-40")).rejects.toMatchObject({
      code: "invalid_daily_date",
      status: 400,
    });
  });
});

describe("getChallengePaths (GR-1 \"View graph\")", () => {
  it("refuses when the viewer has no eligible completed run on this challenge (FB-4 guard, shared with getPublicRunPath)", async () => {
    await insertCompletedV2({
      id: "gr1-guard-other-run",
      accountId: "other-account",
      elapsedMs: 4_000,
      completedAt: "2026-07-14T01:00:04.000Z",
    });
    const { repository } = fixture();
    await expect(repository.getChallengePaths("challenge-0001", account)).rejects.toMatchObject({
      code: "challenge_paths_not_found", status: 404,
    });

    // A DNF alone doesn't unlock it either (invariant 2/5: only a
    // completion counts as "played") - same rule getPublicRunPath enforces.
    await insertLegacyRun({ id: "gr1-guard-viewer-dnf", accountId: account.accountId });
    await env.VWIKI_RACE_DB.prepare(
      `UPDATE runs SET status='abandoned', protocol_version=2, click_count=2,
         abandoned_at='2026-07-14T01:02:15.000Z', elapsed_ms=3000
       WHERE id='gr1-guard-viewer-dnf'`,
    ).run();
    await expect(repository.getChallengePaths("challenge-0001", account)).rejects.toMatchObject({
      code: "challenge_paths_not_found", status: 404,
    });
  });

  it("once the viewer has finished, returns every counted run's full path, finishers-fastest-first then DNFs", async () => {
    await insertCompletedV2({
      id: "gr1-fast-run",
      accountId: "fast-account",
      elapsedMs: 3_000,
      completedAt: "2026-07-14T01:00:03.000Z",
    });
    await insertPathSteps("gr1-fast-run", [
      { n: 1, from: "Moon", to: "Orbit" },
      { n: 2, from: "Orbit", to: "Gravity" },
    ]);
    await insertCompletedV2({
      id: "gr1-viewer-run",
      accountId: account.accountId,
      elapsedMs: 5_000,
      completedAt: "2026-07-14T01:00:05.000Z",
    });
    await insertPathSteps("gr1-viewer-run", [{ n: 1, from: "Moon", to: "Gravity" }]);
    await insertAbandonedV2({
      id: "gr1-dnf-run",
      accountId: "dnf-account",
      clickCount: 2,
      elapsedMs: 9_000,
      abandonedAt: "2026-07-14T01:00:09.000Z",
    });
    await insertPathSteps("gr1-dnf-run", [
      { n: 1, from: "Moon", to: "Space" },
      { n: 2, from: "Space", to: "Orbit" },
    ]);
    await insertAccountProfile("fast-account", "Fast Runner");
    await insertAccountProfile("dnf-account", "Almost");
    await insertAccountProfile(account.accountId, "Casey");

    const { repository } = fixture();
    const result = await repository.getChallengePaths("challenge-0001", account);

    expect(result.totalRuns).toBe(3);
    expect(result.runs).toEqual([
      {
        player: "Fast Runner",
        status: "completed",
        elapsedMs: 3_000,
        clicks: 1,
        steps: [
          { n: 1, from: "Moon", to: "Orbit" },
          { n: 2, from: "Orbit", to: "Gravity" },
        ],
      },
      {
        player: "Casey",
        status: "completed",
        elapsedMs: 5_000,
        clicks: 1,
        steps: [{ n: 1, from: "Moon", to: "Gravity" }],
      },
      {
        player: "Almost",
        status: "abandoned",
        elapsedMs: 9_000,
        clicks: 2,
        steps: [
          { n: 1, from: "Moon", to: "Space" },
          { n: 2, from: "Space", to: "Orbit" },
        ],
      },
    ]);
  });

  it("FB-7 (owner ruling, 2026-07-19): a sub-threshold (1-click) DNF gets no strand - not board-visible anywhere", async () => {
    await insertCompletedV2({
      id: "gr1-fb7-viewer-run",
      accountId: account.accountId,
      elapsedMs: 5_000,
      completedAt: "2026-07-14T01:00:05.000Z",
    });
    await insertAbandonedV2({
      id: "gr1-fb7-subthreshold-dnf",
      accountId: "subthreshold-account",
      clickCount: 1,
      elapsedMs: 1_000,
      abandonedAt: "2026-07-14T01:00:01.000Z",
    });

    const { repository } = fixture();
    const result = await repository.getChallengePaths("challenge-0001", account);

    expect(result.totalRuns).toBe(1);
    expect(result.runs.map((r) => r.status)).toEqual(["completed"]);
  });

  it("omits a board-excluded run from the merged graph, same as the public board", async () => {
    await insertCompletedV2({
      id: "gr1-excl-viewer-run",
      accountId: account.accountId,
      elapsedMs: 5_000,
      completedAt: "2026-07-14T01:00:05.000Z",
    });
    await insertCompletedV2({
      id: "gr1-excl-other-run",
      accountId: "excluded-account",
      elapsedMs: 2_000,
      completedAt: "2026-07-14T01:00:02.000Z",
    });
    const { repository } = fixture();
    await repository.setRunBoardExclusion("gr1-excl-other-run", true);

    const result = await repository.getChallengePaths("challenge-0001", account);

    expect(result.totalRuns).toBe(1);
    expect(result.runs.map((r) => r.elapsedMs)).toEqual([5_000]);
  });

  it("resolves both the viewer-finished guard AND each run's player through canonical account aliases", async () => {
    await insertCompletedV2({
      id: "gr1-alias-run",
      accountId: "account-before-claim",
      elapsedMs: 4_000,
      completedAt: "2026-07-14T01:00:04.000Z",
    });
    await env.VWIKI_RACE_DB.prepare(
      `INSERT INTO account_aliases (alias_account_id, canonical_account_id, updated_at)
       VALUES ('account-before-claim', ?, '2026-07-14T01:00:00.000Z')`,
    ).bind(account.accountId).run();
    await insertAccountProfile(account.accountId, "Casey Claimed");

    const { repository } = fixture();
    const result = await repository.getChallengePaths("challenge-0001", account);

    expect(result.runs).toEqual([
      expect.objectContaining({ player: "Casey Claimed", status: "completed", elapsedMs: 4_000 }),
    ]);
  });

  it("dedupes repeat runs to each account's single best (the fast completion, not an earlier slow one or a DNF)", async () => {
    await insertCompletedV2({
      id: "gr1-dedupe-viewer-run",
      accountId: account.accountId,
      elapsedMs: 5_000,
      completedAt: "2026-07-14T01:00:05.000Z",
    });
    await insertCompletedV2({
      id: "gr1-dedupe-slow",
      accountId: "repeat-account",
      elapsedMs: 9_000,
      completedAt: "2026-07-14T01:00:09.000Z",
    });
    await insertCompletedV2({
      id: "gr1-dedupe-fast",
      accountId: "repeat-account",
      elapsedMs: 3_000,
      completedAt: "2026-07-14T01:00:03.000Z",
    });
    // invariant 2: a completion supersedes the SAME account's own DNF too.
    await insertAbandonedV2({
      id: "gr1-dedupe-then-completed-dnf",
      accountId: "redemption-account",
      clickCount: 4,
      elapsedMs: 6_000,
      abandonedAt: "2026-07-14T01:00:06.000Z",
    });
    await insertCompletedV2({
      id: "gr1-dedupe-then-completed-win",
      accountId: "redemption-account",
      elapsedMs: 4_000,
      completedAt: "2026-07-14T01:00:04.000Z",
    });

    const { repository } = fixture();
    const result = await repository.getChallengePaths("challenge-0001", account);

    expect(result.totalRuns).toBe(3); // viewer + repeat-account (best only) + redemption-account (win only)
    expect(result.runs.every((r) => r.status === "completed")).toBe(true);
    expect(result.runs.map((r) => r.elapsedMs).sort((a, b) => a - b)).toEqual([3_000, 4_000, 5_000]);
  });

  it("caps returned runs at the documented limit (12) while totalRuns reports the real, uncapped count", async () => {
    await insertCompletedV2({
      id: "gr1-cap-viewer-run",
      accountId: account.accountId,
      elapsedMs: 1_000,
      completedAt: "2026-07-14T01:00:01.000Z",
    });
    for (let i = 0; i < 12; i += 1) {
      const second = String(2 + i).padStart(2, "0");
      await insertCompletedV2({
        id: `gr1-cap-run-${i}`,
        accountId: `gr1-cap-account-${i}`,
        elapsedMs: 2_000 + i * 100,
        completedAt: `2026-07-14T01:00:${second}.000Z`,
      });
    }

    const { repository } = fixture();
    const result = await repository.getChallengePaths("challenge-0001", account);

    // 13 counted runs total (the viewer + 12 others); only 12 fit the cap.
    expect(result.totalRuns).toBe(13);
    expect(result.runs).toHaveLength(12);
    // The 13th-fastest (i.e. slowest, elapsedMs 3_100) is the one dropped -
    // the cap keeps the BEST 12, not an arbitrary 12.
    expect(result.runs.some((r) => r.elapsedMs === 3_100)).toBe(false);
    expect(result.runs.some((r) => r.elapsedMs === 1_000)).toBe(true);
  });

  describe("\"I gave up\" disclosure extension (owner spec, 2026-08-02)", () => {
    it("a peeked (never-finished) viewer unlocks disclosure even with zero counted strands, falling back to the stored reference path", async () => {
      await env.VWIKI_RACE_DB.prepare(
        `UPDATE challenges SET reference_path = ? WHERE id = 'challenge-0001'`,
      ).bind(JSON.stringify(["Moon", "Orbit", "Gravity"])).run();
      await insertPeek(account.accountId, "challenge-0001");

      const { repository } = fixture();
      const result = await repository.getChallengePaths("challenge-0001", account);

      expect(result.totalRuns).toBe(0);
      expect(result.runs).toEqual([]);
      expect(result.referencePath).toEqual(["Moon", "Orbit", "Gravity"]);
    });

    it("a peeked viewer with zero strands AND no stored reference path gets an honest null (\"no one's cracked it\")", async () => {
      await insertPeek(account.accountId, "challenge-0001");

      const { repository } = fixture();
      const result = await repository.getChallengePaths("challenge-0001", account);

      expect(result.totalRuns).toBe(0);
      expect(result.runs).toEqual([]);
      expect(result.referencePath).toBeNull();
    });

    it("a peeked viewer sees the reference path even when OTHER accounts have DNF strands but nobody has actually finished it yet", async () => {
      await insertPeek(account.accountId, "challenge-0001");
      await env.VWIKI_RACE_DB.prepare(
        `UPDATE challenges SET reference_path = ? WHERE id = 'challenge-0001'`,
      ).bind(JSON.stringify(["Moon", "Orbit", "Gravity"])).run();
      await insertAbandonedV2({
        id: "gr1-peek-dnf-only", accountId: "someone-else-dnf", clickCount: 6,
        elapsedMs: 20_000, abandonedAt: "2026-07-14T01:00:05.000Z",
      });

      const { repository } = fixture();
      const result = await repository.getChallengePaths("challenge-0001", account);

      // Case (a) needs an actual completion, not just a counted attempt -
      // other players' DNF strands don't count as "a solution," so the
      // reference-path fallback applies exactly as if nobody had touched
      // the challenge at all.
      expect(result.totalRuns).toBe(0);
      expect(result.runs).toEqual([]);
      expect(result.referencePath).toEqual(["Moon", "Orbit", "Gravity"]);
    });

    it("a real finisher's path still wins over the reference path once one exists, even for a peeked viewer", async () => {
      await insertPeek(account.accountId, "challenge-0001");
      await env.VWIKI_RACE_DB.prepare(
        `UPDATE challenges SET reference_path = ? WHERE id = 'challenge-0001'`,
      ).bind(JSON.stringify(["Moon", "Reference", "Gravity"])).run();
      await insertCompletedV2({
        id: "gr1-peek-real-finisher", accountId: "someone-else", elapsedMs: 4_000,
        completedAt: "2026-07-14T01:00:04.000Z",
      });

      const { repository } = fixture();
      const result = await repository.getChallengePaths("challenge-0001", account);

      expect(result.totalRuns).toBe(1);
      expect(result.runs[0]).toMatchObject({ status: "completed", elapsedMs: 4_000 });
      expect(result.referencePath).toBeUndefined();
    });

    it("a viewer who has neither finished nor peeked still gets the 404 (guard unchanged for the common case)", async () => {
      const { repository } = fixture();
      await expect(repository.getChallengePaths("challenge-0001", account)).rejects.toMatchObject({
        code: "challenge_paths_not_found", status: 404,
      });
    });
  });
});

describe("giveUpChallenge (\"I gave up\", owner spec 2026-08-02)", () => {
  it("rejects an account that has never touched the challenge", async () => {
    const { repository } = fixture();
    await expect(repository.giveUpChallenge(account, {
      challengeId: "challenge-0001",
      idempotencyKey: "give-up-never-touched",
    })).rejects.toMatchObject({ code: "give_up_not_eligible", status: 409 });
  });

  it("rejects a counted DNF that clears FB-7 but falls short of BOTH give-up thresholds", async () => {
    // Counted (>= MIN_COUNTED_DNF_CLICKS = 2) but neither >= 5 clicks nor
    // >= 180s wall-elapsed - a real-but-modest attempt, not yet a qualifying
    // one for this specific affordance.
    await insertAbandonedV2({
      id: "give-up-short-dnf", accountId: account.accountId, clickCount: 3,
      elapsedMs: 5_000, abandonedAt: "2026-07-14T01:00:05.000Z",
    });
    const { repository } = fixture();
    await expect(repository.giveUpChallenge(account, {
      challengeId: "challenge-0001",
      idempotencyKey: "give-up-short-dnf-key",
    })).rejects.toMatchObject({ code: "give_up_not_eligible", status: 409 });
  });

  it("rejects an account that has already finished the challenge, even alongside a qualifying DNF", async () => {
    await insertAbandonedV2({
      id: "give-up-finished-dnf", accountId: account.accountId, clickCount: 12,
      elapsedMs: 30_000, abandonedAt: "2026-07-14T01:00:05.000Z",
    });
    await insertCompletedV2({
      id: "give-up-finished-win", accountId: account.accountId, elapsedMs: 4_000,
      completedAt: "2026-07-14T01:00:06.000Z",
    });
    const { repository } = fixture();
    await expect(repository.giveUpChallenge(account, {
      challengeId: "challenge-0001",
      idempotencyKey: "give-up-already-finished-key",
    })).rejects.toMatchObject({ code: "give_up_already_finished", status: 409 });
  });

  it("accepts via the click-count threshold (>= 5 clicks) and durably records the peek", async () => {
    await insertAbandonedV2({
      id: "give-up-clicks-dnf", accountId: account.accountId, clickCount: 6,
      elapsedMs: 10_000, abandonedAt: "2026-07-14T01:00:05.000Z",
    });
    const { repository } = fixture();

    await expect(repository.giveUpChallenge(account, {
      challengeId: "challenge-0001",
      idempotencyKey: "give-up-clicks-key",
    })).resolves.toEqual({ challengeId: "challenge-0001", peeked: true });

    const peek = await env.VWIKI_RACE_DB.prepare(
      `SELECT canonical_account_id, resource_id, outcome_status FROM operation_idempotency
       WHERE operation = 'solution_peek'`,
    ).first<{ canonical_account_id: string; resource_id: string; outcome_status: string }>();
    expect(peek).toEqual({
      canonical_account_id: account.accountId,
      resource_id: "challenge-0001",
      outcome_status: "accepted",
    });
  });

  it("accepts via the wall-elapsed threshold (>= 180s) even with very few clicks", async () => {
    await insertAbandonedV2({
      id: "give-up-wall-dnf", accountId: account.accountId, clickCount: 2,
      elapsedMs: 200_000, abandonedAt: "2026-07-14T01:03:20.000Z",
    });
    const { repository } = fixture();

    await expect(repository.giveUpChallenge(account, {
      challengeId: "challenge-0001",
      idempotencyKey: "give-up-wall-key",
    })).resolves.toEqual({ challengeId: "challenge-0001", peeked: true });
  });

  it("\"any attempt\" - an earlier qualifying DNF still unlocks give-up even if a LATER retry on the same challenge was trivial", async () => {
    await insertAbandonedV2({
      id: "give-up-earlier-qualifying", accountId: account.accountId, clickCount: 8,
      elapsedMs: 20_000, abandonedAt: "2026-07-14T01:00:05.000Z",
    });
    await insertAbandonedV2({
      id: "give-up-later-trivial", accountId: account.accountId, clickCount: 2,
      elapsedMs: 3_000, abandonedAt: "2026-07-14T02:00:05.000Z",
    });
    const { repository } = fixture();

    await expect(repository.giveUpChallenge(account, {
      challengeId: "challenge-0001",
      idempotencyKey: "give-up-any-attempt-key",
    })).resolves.toEqual({ challengeId: "challenge-0001", peeked: true });
  });

  it("is idempotent under the same idempotency key - a retry replays the original outcome without double-recording the peek", async () => {
    await insertAbandonedV2({
      id: "give-up-replay-dnf", accountId: account.accountId, clickCount: 6,
      elapsedMs: 10_000, abandonedAt: "2026-07-14T01:00:05.000Z",
    });
    const { repository } = fixture();
    const idempotencyKey = "give-up-replay-key";

    const first = await repository.giveUpChallenge(account, { challengeId: "challenge-0001", idempotencyKey });
    const second = await repository.giveUpChallenge(account, { challengeId: "challenge-0001", idempotencyKey });

    expect(second).toEqual(first);
    const peekCount = await env.VWIKI_RACE_DB.prepare(
      `SELECT count(*) AS n FROM operation_idempotency WHERE operation = 'solution_peek'`,
    ).first<{ n: number }>();
    expect(Number(peekCount?.n)).toBe(1);
  });

  it("re-confirms with a FRESH idempotency key once already peeked, rather than erroring or double-recording", async () => {
    await insertAbandonedV2({
      id: "give-up-reconfirm-dnf", accountId: account.accountId, clickCount: 6,
      elapsedMs: 10_000, abandonedAt: "2026-07-14T01:00:05.000Z",
    });
    const { repository } = fixture();
    await repository.giveUpChallenge(account, {
      challengeId: "challenge-0001", idempotencyKey: "give-up-reconfirm-first",
    });

    await expect(repository.giveUpChallenge(account, {
      challengeId: "challenge-0001", idempotencyKey: "give-up-reconfirm-second",
    })).resolves.toEqual({ challengeId: "challenge-0001", peeked: true });

    const peekCount = await env.VWIKI_RACE_DB.prepare(
      `SELECT count(*) AS n FROM operation_idempotency WHERE operation = 'solution_peek'`,
    ).first<{ n: number }>();
    expect(Number(peekCount?.n)).toBe(1);
  });

  it("closes ranked eligibility for the account's SUBSEQUENT completions on this challenge, from the very next run onward", async () => {
    await insertAbandonedV2({
      id: "give-up-ranked-closure-dnf", accountId: account.accountId, clickCount: 6,
      elapsedMs: 10_000, abandonedAt: "2026-07-14T01:00:05.000Z",
    });
    const { repository } = fixture({ now: "2026-07-14T02:00:00.000Z" }, "give-up-ranked-closure-run");
    await repository.giveUpChallenge(account, {
      challengeId: "challenge-0001", idempotencyKey: "give-up-ranked-closure-key",
    });

    await repository.startRunV2(account, {
      challengeId: "challenge-0001",
      idempotencyKey: "give-up-ranked-closure-start",
    });

    const newRun = await env.VWIKI_RACE_DB.prepare(
      `SELECT ranked_eligible FROM runs WHERE challenge_id = 'challenge-0001'
         AND account_id = ? AND status = 'active'`,
    ).bind(account.accountId).first<{ ranked_eligible: number }>();
    expect(Number(newRun?.ranked_eligible)).toBe(0);

    // The prior qualifying DNF itself is untouched by give-up - it was
    // already ranked_eligible = 0 from its own abandon, and give-up never
    // writes to `runs` at all.
    const priorDnf = await env.VWIKI_RACE_DB.prepare(
      `SELECT ranked_eligible, status FROM runs WHERE id = 'give-up-ranked-closure-dnf'`,
    ).first<{ ranked_eligible: number; status: string }>();
    expect(priorDnf).toEqual({ ranked_eligible: 0, status: "abandoned" });
  });

  it("resolves eligibility through account_aliases, same as every other viewer-identity guard in this file", async () => {
    const canonical = "give-up-alias-canonical";
    const ghost = "give-up-alias-ghost";
    await insertAbandonedV2({
      id: "give-up-alias-dnf", accountId: ghost, clickCount: 6,
      elapsedMs: 10_000, abandonedAt: "2026-07-14T01:00:05.000Z",
    });
    await env.VWIKI_RACE_DB.prepare(
      `INSERT INTO account_aliases (alias_account_id, canonical_account_id, updated_at)
       VALUES (?, ?, '2026-07-14T01:00:00.000Z')`,
    ).bind(ghost, canonical).run();
    const { repository } = fixture();

    await expect(repository.giveUpChallenge(
      { accountId: canonical, displayName: "Casey", status: "claimed", aliases: [] },
      { challengeId: "challenge-0001", idempotencyKey: "give-up-alias-key" },
    )).resolves.toEqual({ challengeId: "challenge-0001", peeked: true });
  });
});

describe("GET /api/v2/challenges/:id/paths", () => {
  it("GR-1: requires a viewer, enforces the FB-4 guard end to end, and returns the merged graph payload", async () => {
    await insertCompletedV2({
      id: "gr1-route-other-run",
      accountId: "other-account",
      elapsedMs: 4_000,
      completedAt: "2026-07-14T01:00:04.000Z",
    });
    await insertPathSteps("gr1-route-other-run", [{ n: 1, from: "Moon", to: "Gravity" }]);

    const { repository } = fixture();
    const authorize = vi.fn(async (request: Request) => {
      if (request.headers.get("Authorization") !== "Bearer viewer-token") {
        throw new ApiError("unauthorized", "Sign in to view this graph.", 401);
      }
      return account;
    });
    const accountReadLimit = vi.fn(async () => ({ success: true }));
    const worker = createWorker({
      createTracking: () => ({
        handlers: createApiHandlers(repository),
        identity: {},
        runProtocol: repository,
        authorize,
      } as unknown as WorkerTracking),
    });
    const route = "https://worker.example/api/v2/challenges/challenge-0001/paths";
    const routeWorkerEnv = {
      VWIKI_RACE_DB: env.VWIKI_RACE_DB,
      VGAMES_URL: "https://vgames.example",
      CLICK_RATE_LIMITER: { limit: async () => ({ success: true }) },
      ACCOUNT_READ_RATE_LIMITER: { limit: accountReadLimit },
      CHALLENGE_CREATE_RATE_LIMITER: { limit: async () => ({ success: true }) },
    };

    const unauthorized = await worker.fetch(new Request(route), routeWorkerEnv);
    expect(unauthorized.status).toBe(401);
    expect(accountReadLimit).not.toHaveBeenCalled();

    const blocked = await worker.fetch(new Request(route, {
      headers: { Authorization: "Bearer viewer-token" },
    }), routeWorkerEnv);
    expect(blocked.status).toBe(404);
    await expect(blocked.json()).resolves.toMatchObject({
      error: { code: "challenge_paths_not_found" },
    });
    expect(accountReadLimit).toHaveBeenCalledWith({ key: "paths:account-canonical" });

    await insertCompletedV2({
      id: "gr1-route-viewer-run",
      accountId: account.accountId,
      elapsedMs: 6_000,
      completedAt: "2026-07-14T01:00:06.000Z",
    });

    const allowed = await worker.fetch(new Request(route, {
      headers: { Authorization: "Bearer viewer-token" },
    }), routeWorkerEnv);
    expect(allowed.status).toBe(200);
    await expect(allowed.json()).resolves.toEqual({
      totalRuns: 2,
      runs: [
        expect.objectContaining({
          status: "completed",
          elapsedMs: 4_000,
          steps: [{ n: 1, from: "Moon", to: "Gravity" }],
        }),
        expect.objectContaining({ status: "completed", elapsedMs: 6_000, steps: [] }),
      ],
    });
  });

  it("GR-1: rate-limits like the other account-read routes", async () => {
    await insertCompletedV2({
      id: "gr1-limit-viewer-run",
      accountId: account.accountId,
      elapsedMs: 4_000,
      completedAt: "2026-07-14T01:00:04.000Z",
    });
    const { repository } = fixture();
    const worker = createWorker({
      createTracking: () => ({
        handlers: createApiHandlers(repository),
        identity: {},
        runProtocol: repository,
        authorize: async () => account,
      } as unknown as WorkerTracking),
    });
    const response = await worker.fetch(
      new Request("https://worker.example/api/v2/challenges/challenge-0001/paths", {
        headers: { Authorization: "Bearer test" },
      }),
      { ...workerEnv(), ACCOUNT_READ_RATE_LIMITER: { limit: async () => ({ success: false }) } },
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "account_read_rate_limited" },
    });
  });
});

describe("board exclusion (migration 0006)", () => {
  it("omits excluded runs from listLeaderboard", async () => {
    const fasterRunId = "faster-excluded";
    await insertCompletedV2({
      id: fasterRunId,
      accountId: "faster-account",
      elapsedMs: 3_000,
      completedAt: "2026-07-14T01:00:03.000Z",
    });
    await insertCompletedV2({
      id: "slower-kept",
      accountId: "slower-account",
      elapsedMs: 5_000,
      completedAt: "2026-07-14T01:00:05.000Z",
    });

    const { repository } = fixture();
    const before = await repository.listLeaderboard("challenge-0001");
    expect(before.map((r) => r.runId)).toContain(fasterRunId);

    await env.VWIKI_RACE_DB.prepare(
      "UPDATE runs SET board_excluded = 1 WHERE id = ?",
    ).bind(fasterRunId).run();

    const after = await repository.listLeaderboard("challenge-0001");
    expect(after.map((r) => r.runId)).not.toContain(fasterRunId);
    expect(after[0]?.runId).toBe("slower-kept");
    // remaining rows re-rank from 1 with no gap
    expect(after[0]?.rank).toBe(1);
  });

  it("defaults to included (board_excluded = 0) for new runs", async () => {
    const anyRunId = "default-included";
    await insertCompletedV2({
      id: anyRunId,
      accountId: "default-account",
      elapsedMs: 4_000,
      completedAt: "2026-07-14T01:00:04.000Z",
    });

    const row = await env.VWIKI_RACE_DB.prepare(
      "SELECT board_excluded FROM runs WHERE id = ?",
    ).bind(anyRunId).first<{ board_excluded: number }>();
    expect(row?.board_excluded).toBe(0);
  });

  it("excludes board-excluded competitors from the completion rank context (loadLeaderboardContext)", async () => {
    const clock = { now: "2026-07-14T01:00:00.000Z" };
    const { repository } = fixture(clock);

    // A: fast, but excluded from the boards.
    await insertCompletedV2({
      id: "rank-ctx-fast-excluded",
      accountId: "rank-ctx-fast-account",
      elapsedMs: 3_000,
      completedAt: "2026-07-14T01:00:03.000Z",
    });
    // B: slower than the new completion (C) below.
    await insertCompletedV2({
      id: "rank-ctx-slow",
      accountId: "rank-ctx-slow-account",
      elapsedMs: 8_000,
      completedAt: "2026-07-14T01:00:08.000Z",
    });
    await repository.setRunBoardExclusion("rank-ctx-fast-excluded", true);

    // C: a fresh completion, slower than excluded A but faster than B.
    await repository.startRunV2(account, start);
    clock.now = "2026-07-14T01:00:05.000Z";
    const completed = await repository.recordClickV2(account, {
      ...targetClick,
      decisionElapsedMs: 5_000,
      clientObservedAt: clock.now,
    });

    const board = await repository.listLeaderboard("challenge-0001");
    const ownRow = board.find((row) => row.runId === "run-1");
    // Only "rank-ctx-slow" (8s) is eligible competition; the excluded 3s run
    // must not push C to rank 2.
    expect(ownRow?.rank).toBe(1);
    expect(completed.leaderboardContext).toEqual({
      isPersonalBest: true,
      rank: ownRow?.rank,
    });
  });
});

describe("setRunBoardExclusion", () => {
  it("sets and clears the flag, returning the new state", async () => {
    const runId = "exclusion-target";
    await insertCompletedV2({
      id: runId,
      accountId: "exclusion-account",
      elapsedMs: 4_000,
      completedAt: "2026-07-14T01:00:04.000Z",
    });
    const { repository } = fixture();

    const set = await repository.setRunBoardExclusion(runId, true);
    expect(set).toEqual({ runId, boardExcluded: true });
    const excludedRow = await env.VWIKI_RACE_DB.prepare(
      "SELECT board_excluded FROM runs WHERE id = ?",
    ).bind(runId).first<{ board_excluded: number }>();
    expect(excludedRow?.board_excluded).toBe(1);

    const cleared = await repository.setRunBoardExclusion(runId, false);
    expect(cleared).toEqual({ runId, boardExcluded: false });
    const clearedRow = await env.VWIKI_RACE_DB.prepare(
      "SELECT board_excluded FROM runs WHERE id = ?",
    ).bind(runId).first<{ board_excluded: number }>();
    expect(clearedRow?.board_excluded).toBe(0);
  });

  it("is idempotent when re-applying the same state", async () => {
    const runId = "exclusion-idempotent";
    await insertCompletedV2({
      id: runId,
      accountId: "exclusion-account-2",
      elapsedMs: 4_000,
      completedAt: "2026-07-14T01:00:04.000Z",
    });
    const { repository } = fixture();

    const first = await repository.setRunBoardExclusion(runId, true);
    const second = await repository.setRunBoardExclusion(runId, true);
    expect(first).toEqual({ runId, boardExcluded: true });
    expect(second).toEqual({ runId, boardExcluded: true });
  });

  it("returns null for an unknown run", async () => {
    const { repository } = fixture();
    expect(await repository.setRunBoardExclusion("run-nope", true)).toBeNull();
  });

  it("excludes the run from listLeaderboard once set", async () => {
    const runId = "exclusion-leaderboard";
    await insertCompletedV2({
      id: runId,
      accountId: "exclusion-lb-account",
      elapsedMs: 4_000,
      completedAt: "2026-07-14T01:00:04.000Z",
    });
    const { repository } = fixture();

    await repository.setRunBoardExclusion(runId, true);

    const leaderboard = await repository.listLeaderboard("challenge-0001");
    expect(leaderboard.map((r) => r.runId)).not.toContain(runId);
  });
});

describe("listChallengePlacements", () => {
  it("collapses repeat attempts to one best row per account", async () => {
    const accountA = "placement-account-a";
    const accountB = "placement-account-b";
    const accountC = "placement-account-c";

    // Account A completes twice: a worse attempt, then a better one.
    await insertCompletedV2({
      id: "a-worse",
      accountId: accountA,
      elapsedMs: 9_000,
      completedAt: "2026-07-14T01:00:09.000Z",
    });
    await insertCompletedV2({
      id: "a-better",
      accountId: accountA,
      elapsedMs: 4_000,
      completedAt: "2026-07-14T01:00:04.000Z",
    });

    // Account B completes once, slower than A's best.
    await insertCompletedV2({
      id: "b-only",
      accountId: accountB,
      elapsedMs: 6_000,
      completedAt: "2026-07-14T01:00:06.000Z",
    });

    // Account C abandons (DNF) — must be absent from placements entirely.
    await insertLegacyRun({ id: "c-dnf", accountId: accountC });
    await env.VWIKI_RACE_DB.prepare(
      `UPDATE runs SET status='abandoned', protocol_version=2, click_count=2,
         abandoned_at='2026-07-14T01:00:10.000Z', elapsed_ms=NULL,
         wall_elapsed_ms=NULL WHERE id='c-dnf'`,
    ).run();

    const { repository } = fixture();
    const placements = await repository.listChallengePlacements("challenge-0001");

    expect(placements).toHaveLength(2); // C's DNF absent
    expect(placements[0].accountId).toBe(accountA);
    expect(placements[0].placement).toBe(1);
    expect(placements[0].elapsedMs).toBe(4_000); // best, not latest
    // PKG-03 remainder fix: `runId` must point at the SURVIVING best attempt
    // ("a-better") - not the worse one ("a-worse") the account also has on
    // this challenge - so a path disclosure keyed on it always resolves to
    // the run that actually earned this placement.
    expect(placements[0].runId).toBe("a-better");
    expect(placements[1].accountId).toBe(accountB);
    expect(placements[1].placement).toBe(2); // no gaps
    expect(placements[1].runId).toBe("b-only");
  });

  it("respects board exclusion", async () => {
    const accountA = "placement-exclusion-account";
    await insertCompletedV2({
      id: "a-best-excluded",
      accountId: accountA,
      elapsedMs: 3_000,
      completedAt: "2026-07-14T01:00:03.000Z",
    });
    await insertCompletedV2({
      id: "a-second-best",
      accountId: accountA,
      elapsedMs: 7_000,
      completedAt: "2026-07-14T01:00:07.000Z",
    });

    await env.VWIKI_RACE_DB.prepare(
      "UPDATE runs SET board_excluded = 1 WHERE id = ?",
    ).bind("a-best-excluded").run();

    const { repository } = fixture();
    const placements = await repository.listChallengePlacements("challenge-0001");
    const a = placements.find((p) => p.accountId === accountA);
    // A's best is excluded → A's placement falls back to their other run.
    expect(a?.elapsedMs).toBe(7_000);
    // ...and `runId` must follow the same fallback, never the excluded run.
    expect(a?.runId).toBe("a-second-best");
  });

  it("resolves canonical accounts through account_aliases", async () => {
    const canonical = "placement-canonical";
    const ghost = "placement-ghost";
    await insertCompletedV2({
      id: "ghost-run",
      accountId: ghost,
      elapsedMs: 5_000,
      completedAt: "2026-07-14T01:00:05.000Z",
    });
    await insertCompletedV2({
      id: "canonical-run",
      accountId: canonical,
      elapsedMs: 3_000,
      completedAt: "2026-07-14T01:00:03.000Z",
    });
    await env.VWIKI_RACE_DB.prepare(
      `INSERT INTO account_aliases (alias_account_id, canonical_account_id, updated_at)
       VALUES (?, ?, '2026-07-14T01:00:00.000Z')`,
    ).bind(ghost, canonical).run();

    const { repository } = fixture();
    const placements = await repository.listChallengePlacements("challenge-0001");
    const ids = placements.map((p) => p.accountId);
    expect(new Set(ids).size).toBe(ids.length); // one row per canonical id
    expect(ids).toContain(canonical);
    expect(ids).not.toContain(ghost);
    const merged = placements.find((p) => p.accountId === canonical);
    expect(merged?.elapsedMs).toBe(3_000); // canonical's own best beats the alias's run
  });
});

describe("listChallengeDnfs", () => {
  it("collapses repeat DNFs to the most-progressed attempt (max clicks, then longest elapsed)", async () => {
    const accountA = "dnf-account-a";
    await insertAbandonedV2({
      id: "a-shallow",
      accountId: accountA,
      clickCount: 2,
      elapsedMs: 9_000,
      abandonedAt: "2026-07-14T01:00:09.000Z",
    });
    await insertAbandonedV2({
      id: "a-deepest",
      accountId: accountA,
      clickCount: 5,
      elapsedMs: 4_000,
      abandonedAt: "2026-07-14T01:00:04.000Z",
    });
    // Same click count as the deepest attempt but a longer elapsed time -
    // the tie-break ("then longest elapsed") should prefer this one.
    await insertAbandonedV2({
      id: "a-deepest-slower",
      accountId: accountA,
      clickCount: 5,
      elapsedMs: 7_000,
      abandonedAt: "2026-07-14T01:00:07.000Z",
    });

    const { repository } = fixture();
    const dnfs = await repository.listChallengeDnfs("challenge-0001");

    expect(dnfs).toHaveLength(1);
    expect(dnfs[0]).toMatchObject({
      accountId: accountA,
      clickCount: 5,
      elapsedMs: 7_000,
    });
  });

  it("excludes an account with a completed eligible run - a completion supersedes DNF", async () => {
    const accountB = "dnf-account-b";
    await insertAbandonedV2({
      id: "b-dnf",
      accountId: accountB,
      clickCount: 3,
      elapsedMs: 5_000,
      abandonedAt: "2026-07-14T01:00:05.000Z",
    });
    await insertCompletedV2({
      id: "b-completed",
      accountId: accountB,
      elapsedMs: 8_000,
      completedAt: "2026-07-14T01:00:08.000Z",
    });

    const { repository } = fixture();
    const dnfs = await repository.listChallengeDnfs("challenge-0001");

    expect(dnfs.map((d) => d.accountId)).not.toContain(accountB);
  });

  it("never surfaces a 0-click abandon (FB-7: sub-threshold DNFs are non-attempts)", async () => {
    const accountC = "dnf-account-c";
    await insertLegacyRun({ id: "c-zero-click", accountId: accountC });
    await env.VWIKI_RACE_DB.prepare(
      `UPDATE runs SET status='abandoned', protocol_version=2, click_count=0,
         abandoned_at='2026-07-14T01:00:02.000Z', elapsed_ms=2000,
         wall_elapsed_ms=2000 WHERE id='c-zero-click'`,
    ).run();

    const { repository } = fixture();
    const dnfs = await repository.listChallengeDnfs("challenge-0001");

    expect(dnfs.map((d) => d.accountId)).not.toContain(accountC);
  });

  it("never surfaces a 1-click abandon either (FB-7 owner ruling, 2026-07-19: the DNF threshold is >= 2 clicks, not > 0)", async () => {
    const accountOneClick = "dnf-account-one-click";
    await insertAbandonedV2({
      id: "one-click-dnf",
      accountId: accountOneClick,
      clickCount: 1,
      elapsedMs: 3_000,
      abandonedAt: "2026-07-14T01:00:03.000Z",
    });

    const { repository } = fixture();
    const dnfs = await repository.listChallengeDnfs("challenge-0001");

    expect(dnfs.map((d) => d.accountId)).not.toContain(accountOneClick);
  });

  it("surfaces a 2-click abandon (exactly at the FB-7 threshold)", async () => {
    const accountTwoClick = "dnf-account-two-click";
    await insertAbandonedV2({
      id: "two-click-dnf",
      accountId: accountTwoClick,
      clickCount: 2,
      elapsedMs: 3_000,
      abandonedAt: "2026-07-14T01:00:03.000Z",
    });

    const { repository } = fixture();
    const dnfs = await repository.listChallengeDnfs("challenge-0001");

    expect(dnfs.map((d) => d.accountId)).toContain(accountTwoClick);
  });

  it("respects board exclusion", async () => {
    const accountD = "dnf-account-d";
    await insertAbandonedV2({
      id: "d-excluded-best",
      accountId: accountD,
      clickCount: 9,
      elapsedMs: 3_000,
      abandonedAt: "2026-07-14T01:00:03.000Z",
    });
    await insertAbandonedV2({
      id: "d-remaining",
      accountId: accountD,
      clickCount: 4,
      elapsedMs: 6_000,
      abandonedAt: "2026-07-14T01:00:06.000Z",
    });
    await env.VWIKI_RACE_DB.prepare(
      "UPDATE runs SET board_excluded = 1 WHERE id = ?",
    ).bind("d-excluded-best").run();

    const { repository } = fixture();
    const dnfs = await repository.listChallengeDnfs("challenge-0001");
    const d = dnfs.find((entry) => entry.accountId === accountD);

    // D's most-progressed (9 clicks) attempt is excluded -> falls back to
    // the remaining eligible attempt (4 clicks), not absent entirely.
    expect(d?.clickCount).toBe(4);
  });

  it("resolves canonical accounts through account_aliases", async () => {
    const canonical = "dnf-canonical";
    const ghost = "dnf-ghost";
    await insertAbandonedV2({
      id: "ghost-dnf",
      accountId: ghost,
      clickCount: 6,
      elapsedMs: 5_000,
      abandonedAt: "2026-07-14T01:00:05.000Z",
    });
    await insertAbandonedV2({
      id: "canonical-dnf",
      accountId: canonical,
      clickCount: 3,
      elapsedMs: 3_000,
      abandonedAt: "2026-07-14T01:00:03.000Z",
    });
    await env.VWIKI_RACE_DB.prepare(
      `INSERT INTO account_aliases (alias_account_id, canonical_account_id, updated_at)
       VALUES (?, ?, '2026-07-14T01:00:00.000Z')`,
    ).bind(ghost, canonical).run();

    const { repository } = fixture();
    const dnfs = await repository.listChallengeDnfs("challenge-0001");
    const ids = dnfs.map((d) => d.accountId);

    expect(new Set(ids).size).toBe(ids.length); // one row per canonical id
    expect(ids).toContain(canonical);
    expect(ids).not.toContain(ghost);
    // The alias's 6-click attempt beats the canonical's own 3-click attempt
    // once merged under the canonical id (most-progressed wins).
    const merged = dnfs.find((d) => d.accountId === canonical);
    expect(merged?.clickCount).toBe(6);
  });

  it("orders the list by clicks descending", async () => {
    const accountLow = "dnf-order-low";
    const accountHigh = "dnf-order-high";
    await insertAbandonedV2({
      id: "order-low",
      accountId: accountLow,
      clickCount: 2,
      elapsedMs: 4_000,
      abandonedAt: "2026-07-14T01:00:04.000Z",
    });
    await insertAbandonedV2({
      id: "order-high",
      accountId: accountHigh,
      clickCount: 7,
      elapsedMs: 6_000,
      abandonedAt: "2026-07-14T01:00:06.000Z",
    });

    const { repository } = fixture();
    const dnfs = await repository.listChallengeDnfs("challenge-0001");

    expect(dnfs.map((d) => d.accountId)).toEqual([accountHigh, accountLow]);
  });
});

describe("listChallengesSummary (Increment 5)", () => {
  it("aggregates distinct player count and the #1 completed placement per challenge, one query across all active challenges", async () => {
    const accountA = "summary-account-a";
    const accountB = "summary-account-b";
    await insertCompletedV2({
      id: "summary-a-worse", accountId: accountA, elapsedMs: 9_000,
      completedAt: "2026-07-14T01:00:09.000Z", challengeId: "challenge-0001",
    });
    await insertCompletedV2({
      id: "summary-a-better", accountId: accountA, elapsedMs: 4_000,
      completedAt: "2026-07-14T01:00:04.000Z", challengeId: "challenge-0001",
    });
    await insertCompletedV2({
      id: "summary-b", accountId: accountB, elapsedMs: 6_000,
      completedAt: "2026-07-14T01:00:06.000Z", challengeId: "challenge-0001",
    });
    await insertAbandonedV2({
      id: "summary-dnf-only", accountId: "summary-account-c", clickCount: 2,
      elapsedMs: 3_000, abandonedAt: "2026-07-14T01:00:03.000Z", challengeId: "challenge-0002",
    });

    const { repository } = fixture();
    const summary = await repository.listChallengesSummary();

    expect(summary.find((s) => s.challengeId === "challenge-0001")).toEqual({
      challengeId: "challenge-0001",
      playerCount: 2, // A (deduped across two attempts) + B - DISTINCT ACCOUNTS
      best: { elapsedMs: 4_000, clickCount: 1 }, // A's best, not latest
    });
    expect(summary.find((s) => s.challengeId === "challenge-0002")).toEqual({
      challengeId: "challenge-0002",
      playerCount: 1, // a board-visible DNF still counts as a player
      best: null, // nobody has finished it
    });
    expect(summary.find((s) => s.challengeId === "challenge-0003")).toEqual({
      challengeId: "challenge-0003",
      playerCount: 0,
      best: null,
    });
  });

  it("excludes a 0-click abandon from player count", async () => {
    await insertLegacyRun({
      id: "summary-zero-click", accountId: "summary-zero-account", challengeId: "challenge-0001",
    });
    await env.VWIKI_RACE_DB.prepare(
      `UPDATE runs SET status='abandoned', protocol_version=2, click_count=0,
         abandoned_at='2026-07-14T01:00:02.000Z', elapsed_ms=2000,
         wall_elapsed_ms=2000 WHERE id='summary-zero-click'`,
    ).run();

    const { repository } = fixture();
    const summary = await repository.listChallengesSummary();

    expect(summary.find((s) => s.challengeId === "challenge-0001")?.playerCount).toBe(0);
  });

  it("FB-7 (owner ruling, 2026-07-19): excludes a 1-click abandon from player count too", async () => {
    await insertAbandonedV2({
      id: "summary-one-click", accountId: "summary-one-click-account", clickCount: 1,
      elapsedMs: 1_000, abandonedAt: "2026-07-14T01:00:01.000Z", challengeId: "challenge-0001",
    });

    const { repository } = fixture();
    const summary = await repository.listChallengesSummary();

    expect(summary.find((s) => s.challengeId === "challenge-0001")?.playerCount).toBe(0);
  });

  it("respects board exclusion for both player count and best", async () => {
    await insertCompletedV2({
      id: "summary-excluded-best", accountId: "summary-excl-account", elapsedMs: 3_000,
      completedAt: "2026-07-14T01:00:03.000Z", challengeId: "challenge-0001",
    });
    await env.VWIKI_RACE_DB.prepare(
      "UPDATE runs SET board_excluded = 1 WHERE id = ?",
    ).bind("summary-excluded-best").run();

    const { repository } = fixture();
    const summary = await repository.listChallengesSummary();

    expect(summary.find((s) => s.challengeId === "challenge-0001")).toEqual({
      challengeId: "challenge-0001", playerCount: 0, best: null,
    });
  });

  it("omits an inactive challenge entirely", async () => {
    await insertReadyChallenge({ id: "summary-inactive", startPageId: 9101, targetPageId: 9102 });
    await env.VWIKI_RACE_DB.prepare(
      "UPDATE challenges SET is_active = 0 WHERE id = 'summary-inactive'",
    ).run();

    const { repository } = fixture();
    const summary = await repository.listChallengesSummary();

    expect(summary.map((s) => s.challengeId)).not.toContain("summary-inactive");
  });
});

describe("getAccountChallengeOutcomes (Increment 5)", () => {
  it("returns 'completed' with best time·clicks, and 'dnf' with no best for a different challenge", async () => {
    const me: AuthorizedAccount = {
      accountId: "outcomes-account", displayName: "Casey", status: "claimed", aliases: [],
    };
    await insertCompletedV2({
      id: "outcomes-completed", accountId: me.accountId, elapsedMs: 4_000,
      completedAt: "2026-07-14T01:00:04.000Z", challengeId: "challenge-0001",
    });
    await insertAbandonedV2({
      id: "outcomes-dnf", accountId: me.accountId, clickCount: 3, elapsedMs: 5_000,
      abandonedAt: "2026-07-14T01:00:05.000Z", challengeId: "challenge-0002",
    });

    const { repository } = fixture();
    const outcomes = await repository.getAccountChallengeOutcomes(me);

    expect(outcomes.find((o) => o.challengeId === "challenge-0001")).toEqual({
      challengeId: "challenge-0001", outcome: "completed", best: { elapsedMs: 4_000, clickCount: 1 },
    });
    expect(outcomes.find((o) => o.challengeId === "challenge-0002")).toEqual({
      challengeId: "challenge-0002", outcome: "dnf", best: null,
    });
  });

  it("invariant 2: a later DNF never demotes a prior completed outcome", async () => {
    const me: AuthorizedAccount = {
      accountId: "outcomes-precedence-account", displayName: "Casey", status: "claimed", aliases: [],
    };
    await insertCompletedV2({
      id: "outcomes-first-completed", accountId: me.accountId, elapsedMs: 4_000,
      completedAt: "2026-07-14T01:00:04.000Z", challengeId: "challenge-0001",
    });
    await insertAbandonedV2({
      id: "outcomes-later-dnf", accountId: me.accountId, clickCount: 3, elapsedMs: 5_000,
      abandonedAt: "2026-07-14T01:00:05.000Z", challengeId: "challenge-0001",
    });

    const { repository } = fixture();
    const outcomes = await repository.getAccountChallengeOutcomes(me);

    expect(outcomes.find((o) => o.challengeId === "challenge-0001")).toEqual({
      challengeId: "challenge-0001", outcome: "completed", best: { elapsedMs: 4_000, clickCount: 1 },
    });
  });

  it("omits a challenge where the account's only run was 0-click", async () => {
    const me: AuthorizedAccount = {
      accountId: "outcomes-zero-account", displayName: "Casey", status: "claimed", aliases: [],
    };
    await insertLegacyRun({ id: "outcomes-zero-click", accountId: me.accountId, challengeId: "challenge-0001" });
    await env.VWIKI_RACE_DB.prepare(
      `UPDATE runs SET status='abandoned', protocol_version=2, click_count=0,
         abandoned_at='2026-07-14T01:00:02.000Z', elapsed_ms=2000,
         wall_elapsed_ms=2000 WHERE id='outcomes-zero-click'`,
    ).run();

    const { repository } = fixture();
    const outcomes = await repository.getAccountChallengeOutcomes(me);

    expect(outcomes.map((o) => o.challengeId)).not.toContain("challenge-0001");
  });

  it("FB-7 (owner ruling, 2026-07-19): omits a challenge where the account's only run was a 1-click DNF - the client reads this as 'NEW', not 'DNF'", async () => {
    const me: AuthorizedAccount = {
      accountId: "outcomes-one-click-account", displayName: "Casey", status: "claimed", aliases: [],
    };
    await insertAbandonedV2({
      id: "outcomes-one-click", accountId: me.accountId, clickCount: 1, elapsedMs: 1_000,
      abandonedAt: "2026-07-14T01:00:01.000Z", challengeId: "challenge-0001",
    });

    const { repository } = fixture();
    const outcomes = await repository.getAccountChallengeOutcomes(me);

    expect(outcomes.map((o) => o.challengeId)).not.toContain("challenge-0001");
  });

  it("resolves the canonical account through account_aliases", async () => {
    const canonical = "outcomes-canonical";
    const ghost = "outcomes-ghost";
    await insertCompletedV2({
      id: "outcomes-ghost-run", accountId: ghost, elapsedMs: 4_000,
      completedAt: "2026-07-14T01:00:04.000Z", challengeId: "challenge-0001",
    });
    await env.VWIKI_RACE_DB.prepare(
      `INSERT INTO account_aliases (alias_account_id, canonical_account_id, updated_at)
       VALUES (?, ?, '2026-07-14T01:00:00.000Z')`,
    ).bind(ghost, canonical).run();

    const { repository } = fixture();
    const outcomes = await repository.getAccountChallengeOutcomes({
      accountId: canonical, displayName: "Casey", status: "claimed", aliases: [],
    });

    expect(outcomes.find((o) => o.challengeId === "challenge-0001")).toMatchObject({
      outcome: "completed",
    });
  });

  it("returns nothing for an account that has never touched any challenge", async () => {
    const me: AuthorizedAccount = {
      accountId: "outcomes-untouched-account", displayName: "Casey", status: "claimed", aliases: [],
    };
    const { repository } = fixture();

    await expect(repository.getAccountChallengeOutcomes(me)).resolves.toEqual([]);
  });

  describe("\"I gave up\" gating fields (owner spec, 2026-08-02)", () => {
    it("omits giveUpEligible/peeked entirely for a plain 'completed' outcome", async () => {
      const me: AuthorizedAccount = {
        accountId: "outcomes-giveup-completed", displayName: "Casey", status: "claimed", aliases: [],
      };
      await insertCompletedV2({
        id: "outcomes-giveup-completed-run", accountId: me.accountId, elapsedMs: 4_000,
        completedAt: "2026-07-14T01:00:04.000Z",
      });

      const { repository } = fixture();
      const outcomes = await repository.getAccountChallengeOutcomes(me);

      expect(outcomes.find((o) => o.challengeId === "challenge-0001")).toEqual({
        challengeId: "challenge-0001", outcome: "completed", best: { elapsedMs: 4_000, clickCount: 1 },
      });
    });

    it("omits giveUpEligible for a counted DNF that falls short of both give-up thresholds", async () => {
      const me: AuthorizedAccount = {
        accountId: "outcomes-giveup-short", displayName: "Casey", status: "claimed", aliases: [],
      };
      await insertAbandonedV2({
        id: "outcomes-giveup-short-run", accountId: me.accountId, clickCount: 3,
        elapsedMs: 5_000, abandonedAt: "2026-07-14T01:00:05.000Z",
      });

      const { repository } = fixture();
      const outcomes = await repository.getAccountChallengeOutcomes(me);

      expect(outcomes.find((o) => o.challengeId === "challenge-0001")).toEqual({
        challengeId: "challenge-0001", outcome: "dnf", best: null,
      });
    });

    it("sets giveUpEligible: true for a DNF clearing the click-count threshold, via EITHER attempt (\"any attempt\")", async () => {
      const me: AuthorizedAccount = {
        accountId: "outcomes-giveup-eligible", displayName: "Casey", status: "claimed", aliases: [],
      };
      await insertAbandonedV2({
        id: "outcomes-giveup-eligible-short", accountId: me.accountId, clickCount: 2,
        elapsedMs: 3_000, abandonedAt: "2026-07-14T01:00:05.000Z",
      });
      await insertAbandonedV2({
        id: "outcomes-giveup-eligible-qualifying", accountId: me.accountId, clickCount: 6,
        elapsedMs: 10_000, abandonedAt: "2026-07-14T02:00:05.000Z",
      });

      const { repository } = fixture();
      const outcomes = await repository.getAccountChallengeOutcomes(me);

      expect(outcomes.find((o) => o.challengeId === "challenge-0001")).toEqual({
        challengeId: "challenge-0001", outcome: "dnf", best: null, giveUpEligible: true,
      });
    });

    it("sets peeked: true once the account has given up on this challenge - giveUpEligible stays true too (the server reports both raw facts; the CLIENT is what combines them into 'hide the button once peeked')", async () => {
      const me: AuthorizedAccount = {
        accountId: "outcomes-peeked", displayName: "Casey", status: "claimed", aliases: [],
      };
      await insertAbandonedV2({
        id: "outcomes-peeked-run", accountId: me.accountId, clickCount: 6,
        elapsedMs: 10_000, abandonedAt: "2026-07-14T01:00:05.000Z",
      });
      const { repository } = fixture();
      await repository.giveUpChallenge(me, {
        challengeId: "challenge-0001", idempotencyKey: "outcomes-peeked-key",
      });

      const outcomes = await repository.getAccountChallengeOutcomes(me);

      expect(outcomes.find((o) => o.challengeId === "challenge-0001")).toEqual({
        challengeId: "challenge-0001", outcome: "dnf", best: null, giveUpEligible: true, peeked: true,
      });
    });
  });
});

describe("listDailyTrends (Increment 4; generalized to ALL challenges by FB-10, owner ruling 2026-07-20)", () => {
  // Owner ruling, 2026-07-25 ("metric-independent ranking changes"): the
  // inclusion guard is now a flat constant (`DAILY_TREND_INCLUSION_FLOOR`),
  // not reality-scaled off how many ACTIVE challenges exist in the window -
  // so this block no longer needs to neutralize the always-present seed
  // challenges (challenge-0001/2/3) to keep them from inflating a guard
  // denominator that doesn't exist anymore.

  it("computes avg placement/time/clicks per account across a window's challenges, deduping repeat attempts, applying the flat inclusion floor", async () => {
    await insertDailyChallenge({ id: "trend-d1", sortOrder: 501, createdAt: "2026-07-16T12:00:00.000Z" });
    await insertDailyChallenge({ id: "trend-d2", sortOrder: 502, createdAt: "2026-07-17T12:00:00.000Z" });
    await insertDailyChallenge({ id: "trend-d3", sortOrder: 503, createdAt: "2026-07-18T12:00:00.000Z" });
    await insertEditorialFeature(env.VWIKI_RACE_DB, { dailyDate: "2026-07-16", challengeId: "trend-d1", selectionSource: "automatic" });
    await insertEditorialFeature(env.VWIKI_RACE_DB, { dailyDate: "2026-07-17", challengeId: "trend-d2", selectionSource: "automatic" });
    await insertEditorialFeature(env.VWIKI_RACE_DB, { dailyDate: "2026-07-18", challengeId: "trend-d3", selectionSource: "automatic" });

    const accountA = "trend-account-a";
    const accountB = "trend-account-b";
    const accountC = "trend-account-c";
    // Day 1: A's worse attempt then a better one (dedup must keep the best) - A places 1st, B 2nd.
    await insertCompletedV2({ id: "d1-a-worse", accountId: accountA, elapsedMs: 9_000, completedAt: "2026-07-16T01:00:09.000Z", challengeId: "trend-d1" });
    await insertCompletedV2({ id: "d1-a-better", accountId: accountA, elapsedMs: 5_000, completedAt: "2026-07-16T01:00:05.000Z", challengeId: "trend-d1" });
    await insertCompletedV2({ id: "d1-b", accountId: accountB, elapsedMs: 8_000, completedAt: "2026-07-16T01:00:08.000Z", challengeId: "trend-d1" });
    // Day 2: C places 1st, A 2nd. B doesn't play day 2 at all - stays at a
    // single counted completion (day 1), one short of the flat floor of 2.
    await insertCompletedV2({ id: "d2-c", accountId: accountC, elapsedMs: 4_000, completedAt: "2026-07-17T01:00:04.000Z", challengeId: "trend-d2" });
    await insertCompletedV2({ id: "d2-a", accountId: accountA, elapsedMs: 9_000, completedAt: "2026-07-17T01:00:09.000Z", challengeId: "trend-d2" });
    // Day 3: only A plays, alone in 1st.
    await insertCompletedV2({ id: "d3-a", accountId: accountA, elapsedMs: 3_000, completedAt: "2026-07-18T01:00:03.000Z", challengeId: "trend-d3" });

    const { repository } = fixture();
    const { ranked, unranked } = await repository.listDailyTrends(7, "2026-07-18");

    // A: placements 1, 2, 1 -> avg 1.333... rounded to 1 decimal -> 1.3;
    // 3 counted completions clears the flat floor (2) -> ranked. avg
    // elapsed = (5000+9000+3000)/3 = 5666.67ms -> rounds to 5667; avg clicks
    // = 1 (insertCompletedV2 always writes click_count = 1). Ranking council
    // (2026-08-02): A's beats are day 1 (2-player field, placed 1st -> beat
    // 1.0) and day 2 (2-player field, placed 2nd -> beat 0.0); day 3 is solo
    // (ungraded) - gradedCount 2, beatRate mean(1, 0) = 0.5, below the
    // drop-worst threshold (4) so nothing is dropped.
    expect(ranked).toEqual([
      {
        accountId: accountA, displayName: null, avgPlacement: 1.3,
        beatRate: 0.5, gradedCount: 2, worstDropped: false,
        playedCount: 3, avgElapsedMs: 5667, avgClicks: 1,
      },
    ]);
    // B (1 completion) and C (1 completion) both stay one short of the
    // floor - neither DNFs nor a second challenge, just genuinely below it.
    // Both ARE graded (each raced A head-to-head on their one shared day) -
    // B lost (beat 0.0), C won (beat 1.0) - but the floor gate is checked
    // first, so both land in `unranked` regardless.
    expect(unranked.map((entry) => entry.accountId).sort()).toEqual([accountB, accountC].sort());
    expect(unranked.find((entry) => entry.accountId === accountB)).toEqual(
      { accountId: accountB, displayName: null, playedCount: 1, gradedCount: 1 },
    );
    expect(unranked.find((entry) => entry.accountId === accountC)).toEqual(
      { accountId: accountC, displayName: null, playedCount: 1, gradedCount: 1 },
    );
  });

  it("owner ruling, 2026-07-25: ranked entries carry avg time/clicks across their counted completions, distinct from avgPlacement", async () => {
    const accountId = "trend-avg-columns-account";
    await insertDailyChallenge({ id: "trend-avg-d1", sortOrder: 800, createdAt: "2026-07-17T12:00:00.000Z" });
    await insertEditorialFeature(env.VWIKI_RACE_DB, { dailyDate: "2026-07-17", challengeId: "trend-avg-d1", selectionSource: "automatic" });
    await insertCompletedV2({ id: "trend-avg-d1-run", accountId, elapsedMs: 4_000, completedAt: "2026-07-17T01:00:04.000Z", challengeId: "trend-avg-d1" });
    await env.VWIKI_RACE_DB.prepare("UPDATE runs SET click_count = 4 WHERE id = ?").bind("trend-avg-d1-run").run();

    await insertDailyChallenge({ id: "trend-avg-d2", sortOrder: 801, createdAt: "2026-07-18T12:00:00.000Z" });
    await insertEditorialFeature(env.VWIKI_RACE_DB, { dailyDate: "2026-07-18", challengeId: "trend-avg-d2", selectionSource: "automatic" });
    await insertCompletedV2({ id: "trend-avg-d2-run", accountId, elapsedMs: 8_000, completedAt: "2026-07-18T01:00:08.000Z", challengeId: "trend-avg-d2" });
    await env.VWIKI_RACE_DB.prepare("UPDATE runs SET click_count = 10 WHERE id = ?").bind("trend-avg-d2-run").run();
    // Ranking council (2026-08-02): "needs >= 1 graded race to rank" - a
    // slower opponent on day 2 only, so this account still places 1st there
    // (avgPlacement/avgElapsedMs/avgClicks below are all unaffected - they're
    // this account's OWN completions only) but now has a real head-to-head
    // result to grade, keeping it ranked instead of falling to the all-solo
    // "needs a graded race" runway.
    await insertCompletedV2({
      id: "trend-avg-d2-opponent-run", accountId: "trend-avg-columns-opponent",
      elapsedMs: 20_000, completedAt: "2026-07-18T01:00:20.000Z", challengeId: "trend-avg-d2",
    });

    const { repository } = fixture();
    const { ranked } = await repository.listDailyTrends(7, "2026-07-18");

    // Both of this account's own completions place 1st -> avgPlacement 1;
    // avg elapsed = (4000+8000)/2 = 6000ms; avg clicks = (4+10)/2 = 7 -
    // display-only, doesn't affect the sort. Day 1 is solo (ungraded); day 2
    // is a graded 2-player win (beat 1.0) - gradedCount 1, beatRate 1.
    expect(ranked).toEqual([
      {
        accountId, displayName: null, avgPlacement: 1,
        beatRate: 1, gradedCount: 1, worstDropped: false,
        playedCount: 2, avgElapsedMs: 6000, avgClicks: 7,
      },
    ]);
  });

  it("rounds avg elapsed to the nearest ms and avg clicks to one decimal", async () => {
    const accountId = "trend-avg-rounding-account";
    const days: Array<{
      id: string;
      sortOrder: number;
      dailyDate: string;
      completedAt: string;
      elapsedMs: number;
      clickCount: number;
    }> = [
      { id: "trend-avg-round-d1", sortOrder: 810, dailyDate: "2026-07-16", completedAt: "2026-07-16T01:00:01.000Z", elapsedMs: 1_000, clickCount: 1 },
      { id: "trend-avg-round-d2", sortOrder: 811, dailyDate: "2026-07-17", completedAt: "2026-07-17T01:00:02.000Z", elapsedMs: 2_000, clickCount: 2 },
      { id: "trend-avg-round-d3", sortOrder: 812, dailyDate: "2026-07-18", completedAt: "2026-07-18T01:00:02.000Z", elapsedMs: 2_000, clickCount: 2 },
    ];
    for (const day of days) {
      await insertDailyChallenge({ id: day.id, sortOrder: day.sortOrder, createdAt: `${day.dailyDate}T12:00:00.000Z` });
      await insertEditorialFeature(env.VWIKI_RACE_DB, { dailyDate: day.dailyDate, challengeId: day.id, selectionSource: "automatic" });
      const runId = `${day.id}-run`;
      await insertCompletedV2({ id: runId, accountId, elapsedMs: day.elapsedMs, completedAt: day.completedAt, challengeId: day.id });
      await env.VWIKI_RACE_DB.prepare("UPDATE runs SET click_count = ? WHERE id = ?").bind(day.clickCount, runId).run();
    }
    // Ranking council (2026-08-02): a slower opponent on day 3 only, so this
    // account needs >= 1 graded race to rank at all - its own avg
    // elapsed/clicks below are unaffected (its own completions only).
    await insertCompletedV2({
      id: "trend-avg-round-d3-opponent-run", accountId: "trend-avg-rounding-opponent",
      elapsedMs: 9_000, completedAt: "2026-07-18T01:00:09.000Z", challengeId: "trend-avg-round-d3",
    });

    const { repository } = fixture();
    const { ranked } = await repository.listDailyTrends(7, "2026-07-18");

    // avg elapsed = (1000+2000+2000)/3 = 1666.67 -> rounds to 1667ms;
    // avg clicks = (1+2+2)/3 = 1.667 -> rounds to 1.7 (one decimal). Day 3's
    // 2-player field (this account placed 1st) is the only graded race -
    // gradedCount 1, beatRate 1.
    expect(ranked).toEqual([
      {
        accountId, displayName: null, avgPlacement: 1,
        beatRate: 1, gradedCount: 1, worstDropped: false,
        playedCount: 3, avgElapsedMs: 1667, avgClicks: 1.7,
      },
    ]);
  });

  it("only counts challenges CREATED within the requested window; lifetime has no date bound", async () => {
    await insertDailyChallenge({ id: "trend-window-inside", sortOrder: 510, createdAt: "2026-07-18T12:00:00.000Z" });
    await insertDailyChallenge({ id: "trend-window-outside", sortOrder: 511, createdAt: "2026-07-01T12:00:00.000Z" });
    // Inside the 7d window ending 2026-07-18 (2026-07-12..2026-07-18).
    await insertEditorialFeature(env.VWIKI_RACE_DB, { dailyDate: "2026-07-18", challengeId: "trend-window-inside", selectionSource: "automatic" });
    // 17 days before "today" - outside the 7d window.
    await insertEditorialFeature(env.VWIKI_RACE_DB, { dailyDate: "2026-07-01", challengeId: "trend-window-outside", selectionSource: "automatic" });

    const accountId = "trend-window-account";
    await insertCompletedV2({ id: "window-inside-run", accountId, elapsedMs: 5_000, completedAt: "2026-07-18T01:00:05.000Z", challengeId: "trend-window-inside" });
    await insertCompletedV2({ id: "window-outside-run", accountId, elapsedMs: 5_000, completedAt: "2026-07-01T01:00:05.000Z", challengeId: "trend-window-outside" });
    // Ranking council (2026-08-02): a slower opponent on the in-window
    // challenge only, so lifetime's 2 completions include >= 1 graded race
    // (needed to rank at all) - the outside-window challenge stays solo,
    // irrelevant to this test's own window-boundary focus either way.
    await insertCompletedV2({
      id: "window-inside-opponent-run", accountId: "trend-window-opponent",
      elapsedMs: 9_000, completedAt: "2026-07-18T01:00:09.000Z", challengeId: "trend-window-inside",
    });

    const { repository } = fixture();
    const week = await repository.listDailyTrends(7, "2026-07-18");
    const lifetime = await repository.listDailyTrends(null, "2026-07-18");

    // Week only counts the in-window challenge - 1 completion, below the
    // flat floor of 2, stays unranked. Lifetime counts both - 2 completions
    // clears the floor, so it's ranked instead (owner ruling, 2026-07-25:
    // was also `unranked` before the guard became completions-only-and-flat,
    // since the pre-ruling reality-scaled lifetime guard was 3 here).
    expect(week.unranked.find((entry) => entry.accountId === accountId)?.playedCount).toBe(1);
    expect(week.ranked.find((entry) => entry.accountId === accountId)).toBeUndefined();
    expect(lifetime.ranked.find((entry) => entry.accountId === accountId)).toMatchObject({ playedCount: 2 });
    expect(lifetime.unranked.find((entry) => entry.accountId === accountId)).toBeUndefined();
  });

  it("ranks exactly at the flat inclusion floor (2 counted completions) and leaves one fewer completion unranked", async () => {
    const rankedAccount = "trend-guard-ranked";
    const unrankedAccount = "trend-guard-unranked";
    for (let index = 0; index < 2; index += 1) {
      const challengeId = `trend-guard-challenge-${index}`;
      const dailyDate = index === 0 ? "2026-07-17" : "2026-07-18";
      await insertDailyChallenge({ id: challengeId, sortOrder: 600 + index, createdAt: `${dailyDate}T12:00:00.000Z` });
      await insertEditorialFeature(env.VWIKI_RACE_DB, { dailyDate, challengeId, selectionSource: "automatic" });
      await insertCompletedV2({
        id: `${challengeId}-ranked`,
        accountId: rankedAccount,
        elapsedMs: 5_000,
        completedAt: `${dailyDate}T01:00:05.000Z`,
        challengeId,
      });
      if (index > 0) {
        // Skips the first challenge - exactly 1 completion, one short of
        // the flat floor of 2.
        await insertCompletedV2({
          id: `${challengeId}-unranked`,
          accountId: unrankedAccount,
          elapsedMs: 6_000,
          completedAt: `${dailyDate}T01:00:06.000Z`,
          challengeId,
        });
      }
    }

    const { repository } = fixture();
    const { ranked, unranked } = await repository.listDailyTrends(30, "2026-07-18");

    expect(ranked.find((entry) => entry.accountId === rankedAccount)).toMatchObject({ playedCount: 2 });
    expect(unranked.find((entry) => entry.accountId === unrankedAccount)).toMatchObject({ playedCount: 1 });
    expect(ranked.find((entry) => entry.accountId === unrankedAccount)).toBeUndefined();
  });

  it("does not truncate a single challenge's finishers at 100 (no LIMIT, unlike listChallengePlacements)", async () => {
    const challengeId = "trend-nolimit-challenge";
    await insertDailyChallenge({ id: challengeId, sortOrder: 700, createdAt: "2026-07-18T12:00:00.000Z" });
    await insertEditorialFeature(env.VWIKI_RACE_DB, { dailyDate: "2026-07-18", challengeId, selectionSource: "automatic" });
    const total = 105;
    for (let index = 0; index < total; index += 1) {
      await insertCompletedV2({
        id: `nolimit-run-${index}`,
        accountId: `nolimit-account-${index}`,
        elapsedMs: 1_000 + index,
        completedAt: "2026-07-18T01:00:00.000Z",
        challengeId,
      });
    }

    const { repository } = fixture();
    // Every one of these 105 accounts solos exactly this one challenge - a
    // single counted completion each, one short of the flat
    // `DAILY_TREND_INCLUSION_FLOOR` (2), so all 105 land in `unranked`, not
    // `ranked`. The no-LIMIT guarantee this test exists for applies equally
    // either way - `placements`, this query's own base CTE, has no LIMIT.
    const { unranked } = await repository.listDailyTrends(null, "2026-07-18");

    expect(unranked).toHaveLength(total);
    expect(unranked.find((entry) => entry.accountId === "nolimit-account-104")).toBeDefined();
  }, 20_000);

  it("excludes board_excluded runs from a challenge's placement computation", async () => {
    const challengeId = "trend-excluded-challenge";
    await insertDailyChallenge({ id: challengeId, sortOrder: 810, createdAt: "2026-07-18T12:00:00.000Z" });
    await insertEditorialFeature(env.VWIKI_RACE_DB, { dailyDate: "2026-07-18", challengeId, selectionSource: "automatic" });
    const accountId = "trend-excluded-account";
    await insertCompletedV2({ id: "excluded-run", accountId, elapsedMs: 3_000, completedAt: "2026-07-18T01:00:03.000Z", challengeId });
    await env.VWIKI_RACE_DB.prepare("UPDATE runs SET board_excluded = 1 WHERE id = ?").bind("excluded-run").run();

    const { repository } = fixture();
    const { ranked, unranked } = await repository.listDailyTrends(7, "2026-07-18");

    expect(ranked.find((entry) => entry.accountId === accountId)).toBeUndefined();
    expect(unranked.find((entry) => entry.accountId === accountId)).toBeUndefined();
  });

  it("resolves canonical accounts through account_aliases", async () => {
    const canonical = "trend-alias-canonical";
    const ghost = "trend-alias-ghost";
    const challengeId = "trend-alias-challenge";
    await insertDailyChallenge({ id: challengeId, sortOrder: 820, createdAt: "2026-07-18T12:00:00.000Z" });
    await insertEditorialFeature(env.VWIKI_RACE_DB, { dailyDate: "2026-07-18", challengeId, selectionSource: "automatic" });
    await insertCompletedV2({ id: "alias-ghost-run", accountId: ghost, elapsedMs: 4_000, completedAt: "2026-07-18T01:00:04.000Z", challengeId });
    await env.VWIKI_RACE_DB.prepare(
      `INSERT INTO account_aliases (alias_account_id, canonical_account_id, updated_at)
       VALUES (?, ?, '2026-07-18T00:00:00.000Z')`,
    ).bind(ghost, canonical).run();

    const { repository } = fixture();
    // A single completion stays below the flat inclusion floor (2) either
    // way, so it lands in `unranked` - alias resolution is what this test
    // actually covers, so it checks membership across both arrays rather
    // than pinning to a specific one.
    const { ranked, unranked } = await repository.listDailyTrends(7, "2026-07-18");
    const ids = [...ranked, ...unranked].map((entry) => entry.accountId);

    expect(ids).toContain(canonical);
    expect(ids).not.toContain(ghost);
  });

  it("sorts ranked entries by beat rate descending (ranking council, owner-picked Option 2, 2026-08-02: 'beat-rate ranking')", async () => {
    const high = "trend-beatrate-high";
    const low = "trend-beatrate-low";
    await insertAccountProfile(high, "High");
    await insertAccountProfile(low, "Low");
    // Two head-to-head challenges, `high` always faster - it wins both
    // (beat 1.0 each -> beatRate 1.0) and `low` loses both (beat 0.0 each ->
    // beatRate 0.0). Neither is registered as a daily feature - window
    // membership is by the challenge's own `created_at` (FB-10), not
    // `daily_features`, so that's not needed here (see the sibling
    // "FB-10: a non-daily (manual) challenge..." test above).
    for (const [index, dailyDate] of ["2026-07-17", "2026-07-18"].entries()) {
      const challengeId = `trend-beatrate-h2h-${index}`;
      await insertDailyChallenge({ id: challengeId, sortOrder: 6000 + index, createdAt: `${dailyDate}T12:00:00.000Z` });
      await insertCompletedV2({ id: `${challengeId}-high`, accountId: high, elapsedMs: 5_000, completedAt: `${dailyDate}T01:00:05.000Z`, challengeId });
      await insertCompletedV2({ id: `${challengeId}-low`, accountId: low, elapsedMs: 9_000, completedAt: `${dailyDate}T01:00:09.000Z`, challengeId });
    }

    const { repository } = fixture();
    const { ranked } = await repository.listDailyTrends(7, "2026-07-18");

    expect(ranked.map((entry) => entry.accountId)).toEqual([high, low]);
    expect(ranked.find((entry) => entry.accountId === high)).toMatchObject({ beatRate: 1, gradedCount: 2 });
    expect(ranked.find((entry) => entry.accountId === low)).toMatchObject({ beatRate: 0, gradedCount: 2 });
  });

  it("tiebreaks an equal beat rate by more graded races (owner spec: 'tiebreak = more graded races')", async () => {
    const moreGraded = "trend-beatrate-more-graded";
    const fewerGraded = "trend-beatrate-fewer-graded";
    await insertAccountProfile(moreGraded, "MoreGraded");
    await insertAccountProfile(fewerGraded, "FewerGraded");
    // moreGraded: 3 separate 2-player wins (beatRate 1.0, gradedCount 3) -
    // each opponent solos nothing else, so they stay below the floor and out
    // of `ranked` entirely (no effect on this test's own comparison).
    for (const [index, dailyDate] of ["2026-07-16", "2026-07-17", "2026-07-18"].entries()) {
      const challengeId = `trend-beatrate-more-${index}`;
      await insertDailyChallenge({ id: challengeId, sortOrder: 6010 + index, createdAt: `${dailyDate}T12:00:00.000Z` });
      await insertCompletedV2({ id: `${challengeId}-winner`, accountId: moreGraded, elapsedMs: 5_000, completedAt: `${dailyDate}T01:00:05.000Z`, challengeId });
      await insertCompletedV2({ id: `${challengeId}-opponent`, accountId: `trend-beatrate-more-opp-${index}`, elapsedMs: 9_000, completedAt: `${dailyDate}T01:00:09.000Z`, challengeId });
    }
    // fewerGraded: 2 separate 2-player wins (beatRate 1.0, gradedCount 2) -
    // the same perfect beat rate as moreGraded, but fewer graded races.
    for (const [index, dailyDate] of ["2026-07-17", "2026-07-18"].entries()) {
      const challengeId = `trend-beatrate-fewer-${index}`;
      await insertDailyChallenge({ id: challengeId, sortOrder: 6020 + index, createdAt: `${dailyDate}T12:00:00.000Z` });
      await insertCompletedV2({ id: `${challengeId}-winner`, accountId: fewerGraded, elapsedMs: 5_000, completedAt: `${dailyDate}T01:00:05.000Z`, challengeId });
      await insertCompletedV2({ id: `${challengeId}-opponent`, accountId: `trend-beatrate-fewer-opp-${index}`, elapsedMs: 9_000, completedAt: `${dailyDate}T01:00:09.000Z`, challengeId });
    }

    const { repository } = fixture();
    const { ranked } = await repository.listDailyTrends(7, "2026-07-18");

    expect(ranked.map((entry) => entry.accountId)).toEqual([moreGraded, fewerGraded]);
    expect(ranked.find((entry) => entry.accountId === moreGraded)).toMatchObject({ beatRate: 1, gradedCount: 3 });
    expect(ranked.find((entry) => entry.accountId === fewerGraded)).toMatchObject({ beatRate: 1, gradedCount: 2 });
  });

  it("tiebreaks an equal beat rate AND graded-race count by more played races (existing tiebreak preserved)", async () => {
    const morePlayed = "trend-beatrate-more-played";
    const fewerPlayed = "trend-beatrate-fewer-played";
    await insertAccountProfile(morePlayed, "MorePlayed");
    await insertAccountProfile(fewerPlayed, "FewerPlayed");
    // Both: 2 separate 2-player wins (beatRate 1.0, gradedCount 2).
    for (const [index, dailyDate] of ["2026-07-17", "2026-07-18"].entries()) {
      const morePlayedChallengeId = `trend-beatrate-moreplayed-h2h-${index}`;
      await insertDailyChallenge({ id: morePlayedChallengeId, sortOrder: 6030 + index, createdAt: `${dailyDate}T12:00:00.000Z` });
      await insertCompletedV2({ id: `${morePlayedChallengeId}-winner`, accountId: morePlayed, elapsedMs: 5_000, completedAt: `${dailyDate}T01:00:05.000Z`, challengeId: morePlayedChallengeId });
      await insertCompletedV2({ id: `${morePlayedChallengeId}-opponent`, accountId: `trend-beatrate-moreplayed-opp-${index}`, elapsedMs: 9_000, completedAt: `${dailyDate}T01:00:09.000Z`, challengeId: morePlayedChallengeId });

      const fewerPlayedChallengeId = `trend-beatrate-fewerplayed-h2h-${index}`;
      await insertDailyChallenge({ id: fewerPlayedChallengeId, sortOrder: 6040 + index, createdAt: `${dailyDate}T12:00:00.000Z` });
      await insertCompletedV2({ id: `${fewerPlayedChallengeId}-winner`, accountId: fewerPlayed, elapsedMs: 5_000, completedAt: `${dailyDate}T01:00:05.000Z`, challengeId: fewerPlayedChallengeId });
      await insertCompletedV2({ id: `${fewerPlayedChallengeId}-opponent`, accountId: `trend-beatrate-fewerplayed-opp-${index}`, elapsedMs: 9_000, completedAt: `${dailyDate}T01:00:09.000Z`, challengeId: fewerPlayedChallengeId });
    }
    // `morePlayed` also banks an extra SOLO completion - solo, so it never
    // touches gradedCount/beatRate, but it does bump playedCount to 3.
    await insertDailyChallenge({ id: "trend-beatrate-moreplayed-solo", sortOrder: 6050, createdAt: "2026-07-16T12:00:00.000Z" });
    await insertCompletedV2({ id: "trend-beatrate-moreplayed-solo-run", accountId: morePlayed, elapsedMs: 5_000, completedAt: "2026-07-16T01:00:05.000Z", challengeId: "trend-beatrate-moreplayed-solo" });

    const { repository } = fixture();
    const { ranked } = await repository.listDailyTrends(7, "2026-07-18");

    expect(ranked.map((entry) => entry.accountId)).toEqual([morePlayed, fewerPlayed]);
    expect(ranked.find((entry) => entry.accountId === morePlayed)).toMatchObject({ beatRate: 1, gradedCount: 2, playedCount: 3 });
    expect(ranked.find((entry) => entry.accountId === fewerPlayed)).toMatchObject({ beatRate: 1, gradedCount: 2, playedCount: 2 });
  });

  it("breaks a full beat-rate/graded-count/played-count tie alphabetically by display name (existing tiebreak preserved)", async () => {
    const beta = "trend-order-beta";
    const alpha = "trend-order-alpha";
    await insertAccountProfile(beta, "Beta");
    await insertAccountProfile(alpha, "Alpha");
    // Both: 3 separate 2-player wins each (beatRate 1.0, gradedCount 3,
    // playedCount 3) on disjoint calendar dates within the 7d window - a
    // full tie across every ranked metric except display name.
    const betaDailies = ["2026-07-13", "2026-07-14", "2026-07-15"];
    const alphaDailies = ["2026-07-16", "2026-07-17", "2026-07-18"];
    for (const [index, dailyDate] of betaDailies.entries()) {
      const challengeId = `trend-order-beta-${index}`;
      await insertDailyChallenge({ id: challengeId, sortOrder: 920 + index, createdAt: `${dailyDate}T12:00:00.000Z` });
      await insertCompletedV2({ id: `${challengeId}-run`, accountId: beta, elapsedMs: 5_000, completedAt: `${dailyDate}T01:00:05.000Z`, challengeId });
      await insertCompletedV2({ id: `${challengeId}-opponent`, accountId: `trend-order-beta-opp-${index}`, elapsedMs: 9_000, completedAt: `${dailyDate}T01:00:09.000Z`, challengeId });
    }
    for (const [index, dailyDate] of alphaDailies.entries()) {
      const challengeId = `trend-order-alpha-${index}`;
      await insertDailyChallenge({ id: challengeId, sortOrder: 930 + index, createdAt: `${dailyDate}T12:00:00.000Z` });
      await insertCompletedV2({ id: `${challengeId}-run`, accountId: alpha, elapsedMs: 5_000, completedAt: `${dailyDate}T01:00:05.000Z`, challengeId });
      await insertCompletedV2({ id: `${challengeId}-opponent`, accountId: `trend-order-alpha-opp-${index}`, elapsedMs: 9_000, completedAt: `${dailyDate}T01:00:09.000Z`, challengeId });
    }

    const { repository } = fixture();
    const { ranked } = await repository.listDailyTrends(7, "2026-07-18");

    expect(ranked.map((entry) => entry.accountId)).toEqual([alpha, beta]);
  });

  it("owner ruling, 2026-07-25: a board-visible DNF no longer counts toward playedCount at all - only completions do", async () => {
    const accountId = "trend-dnf-account";
    // 1 solo finish - exactly 1 counted completion.
    await insertDailyChallenge({ id: "trend-dnf-finish-0", sortOrder: 3000, createdAt: "2026-07-01T12:00:00.000Z" });
    await insertEditorialFeature(env.VWIKI_RACE_DB, { dailyDate: "2026-07-01", challengeId: "trend-dnf-finish-0", selectionSource: "automatic" });
    await insertCompletedV2({ id: "trend-dnf-finish-0-run", accountId, elapsedMs: 5_000, completedAt: "2026-07-01T01:00:05.000Z", challengeId: "trend-dnf-finish-0" });
    // 3 board-visible DNF-only days (well above MIN_COUNTED_DNF_CLICKS).
    // Pre-2026-07-25, each of these would have added to `playedCount` (F2,
    // amended by FB-7) - now none of them do, for this guard specifically;
    // they still count toward "played" everywhere else (listChallengeDnfs,
    // listAllPlayersRoster, getAccountDailyStreak - all unchanged).
    for (let index = 0; index < 3; index += 1) {
      const dailyDate = `2026-07-${String(9 + index).padStart(2, "0")}`;
      const challengeId = `trend-dnf-dnf-${index}`;
      await insertDailyChallenge({ id: challengeId, sortOrder: 3100 + index, createdAt: `${dailyDate}T12:00:00.000Z` });
      await insertEditorialFeature(env.VWIKI_RACE_DB, { dailyDate, challengeId, selectionSource: "automatic" });
      await insertAbandonedV2({ id: `${challengeId}-run`, accountId, clickCount: 2, elapsedMs: 3_000, abandonedAt: `${dailyDate}T01:00:03.000Z`, challengeId });
    }

    const { repository } = fixture();
    const { ranked, unranked } = await repository.listDailyTrends(30, "2026-07-18");

    // Exactly 1 counted completion despite 3 additional DNF days - stays
    // below the flat floor of 2, unranked.
    expect(ranked.find((entry) => entry.accountId === accountId)).toBeUndefined();
    expect(unranked.find((entry) => entry.accountId === accountId)).toEqual({
      accountId, displayName: null, playedCount: 1, gradedCount: 0,
    });
  });

  it("owner ruling, 2026-07-25: an account whose participation is entirely DNFs has zero counted completions and appears in neither array", async () => {
    const accountId = "trend-all-dnf-account";
    for (let index = 0; index < 10; index += 1) {
      const dailyDate = `2026-07-${String(index + 1).padStart(2, "0")}`;
      const challengeId = `trend-all-dnf-${index}`;
      await insertDailyChallenge({ id: challengeId, sortOrder: 3200 + index, createdAt: `${dailyDate}T12:00:00.000Z` });
      await insertEditorialFeature(env.VWIKI_RACE_DB, { dailyDate, challengeId, selectionSource: "automatic" });
      await insertAbandonedV2({ id: `${challengeId}-run`, accountId, clickCount: 2, elapsedMs: 3_000, abandonedAt: `${dailyDate}T01:00:03.000Z`, challengeId });
    }

    const { repository } = fixture();
    const { ranked, unranked } = await repository.listDailyTrends(30, "2026-07-18");

    // Zero counted completions - unlike before 2026-07-25 (10 DNFs used to
    // clear a reality-scaled guard on playedCount alone), a DNF-only
    // account no longer surfaces here at all, ranked or unranked. It's
    // still visible elsewhere (`listAllPlayersRoster`'s census is
    // unaffected by this ruling).
    expect(ranked.find((entry) => entry.accountId === accountId)).toBeUndefined();
    expect(unranked.find((entry) => entry.accountId === accountId)).toBeUndefined();
  });

  it("FB-7 (owner ruling, 2026-07-19): a challenge whose only interaction is a 1-click DNF is NOT played", async () => {
    const accountId = "trend-subthreshold-dnf-account";
    const challengeId = "trend-subthreshold-dnf-challenge";
    await insertDailyChallenge({ id: challengeId, sortOrder: 3300, createdAt: "2026-07-18T12:00:00.000Z" });
    await insertEditorialFeature(env.VWIKI_RACE_DB, { dailyDate: "2026-07-18", challengeId, selectionSource: "automatic" });
    await insertAbandonedV2({
      id: "subthreshold-dnf-run", accountId, clickCount: 1, elapsedMs: 1_000,
      abandonedAt: "2026-07-18T01:00:01.000Z", challengeId,
    });

    const { repository } = fixture();
    const { ranked, unranked } = await repository.listDailyTrends(7, "2026-07-18");

    expect(ranked.find((entry) => entry.accountId === accountId)).toBeUndefined();
    expect(unranked.find((entry) => entry.accountId === accountId)).toBeUndefined();
  });

  it("FB-7 (owner ruling, 2026-07-19): a sub-threshold DNF is NOT played, even on a non-daily (manual) challenge", async () => {
    const accountId = "trend-manual-subthreshold-dnf-account";
    const challengeId = "trend-manual-subthreshold-dnf-challenge";
    // No `insertEditorialFeature` - a plain manual challenge, never featured
    // as a daily. Proves the FB-7 threshold applies uniformly, not just to
    // `daily_features`-backed challenges.
    await insertDailyChallenge({ id: challengeId, sortOrder: 3310, createdAt: "2026-07-18T12:00:00.000Z" });
    await insertAbandonedV2({
      id: "manual-subthreshold-dnf-run", accountId, clickCount: 1, elapsedMs: 1_000,
      abandonedAt: "2026-07-18T01:00:01.000Z", challengeId,
    });

    const { repository } = fixture();
    const { ranked, unranked } = await repository.listDailyTrends(7, "2026-07-18");

    expect(ranked.find((entry) => entry.accountId === accountId)).toBeUndefined();
    expect(unranked.find((entry) => entry.accountId === accountId)).toBeUndefined();
  });

  it("FB-10: a non-daily (manual) challenge created inside the window counts toward playedCount", async () => {
    const challengeId = "trend-manual-in-window";
    // Deliberately no `insertEditorialFeature` - a plain manual challenge,
    // never featured as a daily. Pre-FB-10, `listDailyTrends` could never
    // see this at all (the exact gap `listAllPlayersRoster` was built to
    // work around) - it's now first-class.
    await insertDailyChallenge({ id: challengeId, sortOrder: 4000, createdAt: "2026-07-15T12:00:00.000Z" });
    const accountId = "trend-manual-account";
    await insertCompletedV2({ id: "manual-in-window-run", accountId, elapsedMs: 4_000, completedAt: "2026-07-15T20:00:00.000Z", challengeId });

    const { repository } = fixture();
    const { ranked, unranked, guard } = await repository.listDailyTrends(7, "2026-07-18");

    // Owner ruling, 2026-07-25: guard is the flat inclusion floor (2), not
    // reality-scaled off catalog size - 1 completion stays below it.
    expect(guard).toBe(2);
    expect(ranked).toEqual([]);
    expect(unranked).toEqual([{ accountId, displayName: null, playedCount: 1, gradedCount: 0 }]);
  });

  it("FB-10: a challenge created OUTSIDE the 7d window doesn't count, even with an in-window run", async () => {
    const challengeId = "trend-manual-outside-window";
    // Created 10 days before "today" - outside the 7d window (start = 2026-07-12).
    await insertDailyChallenge({ id: challengeId, sortOrder: 4010, createdAt: "2026-07-08T12:00:00.000Z" });
    const accountId = "trend-manual-outside-account";
    // The RUN itself lands well inside the window - window membership is by
    // the CHALLENGE's own creation date, never the run's own timestamp.
    await insertCompletedV2({ id: "manual-outside-window-run", accountId, elapsedMs: 4_000, completedAt: "2026-07-18T01:00:00.000Z", challengeId });

    const { repository } = fixture();
    const { ranked, unranked } = await repository.listDailyTrends(7, "2026-07-18");

    expect(ranked.find((entry) => entry.accountId === accountId)).toBeUndefined();
    expect(unranked.find((entry) => entry.accountId === accountId)).toBeUndefined();
  });

  it("FB-10: a run on a challenge that's since been deactivated still counts toward playedCount", async () => {
    const playedChallengeId = "trend-guard-active-3";
    await insertDailyChallenge({ id: playedChallengeId, sortOrder: 4022, createdAt: "2026-07-16T12:00:00.000Z" });
    const retiredChallengeId = "trend-guard-retired";
    await insertDailyChallenge({ id: retiredChallengeId, sortOrder: 4023, createdAt: "2026-07-17T12:00:00.000Z" });
    await env.VWIKI_RACE_DB.prepare("UPDATE challenges SET is_active = 0 WHERE id = ?").bind(retiredChallengeId).run();

    const accountId = "trend-guard-retired-player";
    // Played BOTH the still-active challenge and the now-retired one.
    await insertCompletedV2({ id: "active-run", accountId, elapsedMs: 4_000, completedAt: "2026-07-16T20:00:00.000Z", challengeId: playedChallengeId });
    await insertCompletedV2({ id: "retired-run", accountId, elapsedMs: 5_000, completedAt: "2026-07-17T20:00:00.000Z", challengeId: retiredChallengeId });
    // Ranking council (2026-08-02): a slower opponent on the still-active
    // challenge only, so this account has >= 1 graded race (needed to rank
    // at all) - orthogonal to this test's own retired-challenge focus.
    await insertCompletedV2({
      id: "active-run-opponent", accountId: "trend-guard-retired-opponent",
      elapsedMs: 9_000, completedAt: "2026-07-16T20:00:01.000Z", challengeId: playedChallengeId,
    });

    const { repository } = fixture();
    const { ranked, guard } = await repository.listDailyTrends(7, "2026-07-18");

    expect(guard).toBe(2);
    // playedCount = 2: the retired challenge's own run still counts toward
    // this account's numerator, clearing the flat floor even though the
    // challenge itself can no longer be raced fresh.
    expect(ranked.find((entry) => entry.accountId === accountId)).toMatchObject({ playedCount: 2 });
  });

  it("FB-10: lifetime aggregates across every challenge ever - daily-origin or manual - regardless of any window", async () => {
    const dailyChallengeId = "trend-lifetime-daily";
    const manualChallengeId = "trend-lifetime-manual";
    await insertDailyChallenge({ id: dailyChallengeId, sortOrder: 4030, createdAt: "2026-07-18T12:00:00.000Z" });
    await insertEditorialFeature(env.VWIKI_RACE_DB, { dailyDate: "2026-07-18", challengeId: dailyChallengeId, selectionSource: "automatic" });
    // Created 6 months before "today" - outside even the 30d window, and
    // never featured as a daily at all.
    await insertDailyChallenge({ id: manualChallengeId, sortOrder: 4031, createdAt: "2026-01-15T12:00:00.000Z" });

    const accountId = "trend-lifetime-account";
    await insertCompletedV2({ id: "lifetime-daily-run", accountId, elapsedMs: 4_000, completedAt: "2026-07-18T20:00:00.000Z", challengeId: dailyChallengeId });
    await insertCompletedV2({ id: "lifetime-manual-run", accountId, elapsedMs: 4_000, completedAt: "2026-01-16T20:00:00.000Z", challengeId: manualChallengeId });

    const { repository } = fixture();
    const lifetime = await repository.listDailyTrends(null, "2026-07-18");
    const thirtyDay = await repository.listDailyTrends(30, "2026-07-18");

    const lifetimeEntry = [...lifetime.ranked, ...lifetime.unranked].find((entry) => entry.accountId === accountId);
    expect(lifetimeEntry?.playedCount).toBe(2);

    const thirtyDayEntry = [...thirtyDay.ranked, ...thirtyDay.unranked].find((entry) => entry.accountId === accountId);
    expect(thirtyDayEntry?.playedCount).toBe(1);
  });

  describe("beat-rate ranking (ranking council, owner-picked Option 2, 2026-08-02)", () => {
    it("grades a 2-player board to exactly 1.0 (won) / 0.0 (lost) - the ruling's own worked example", async () => {
      const winner = "trend-beatrate-2p-winner";
      const loser = "trend-beatrate-2p-loser";
      await insertDailyChallenge({ id: "trend-beatrate-2p", sortOrder: 6100, createdAt: "2026-07-18T12:00:00.000Z" });
      await insertCompletedV2({ id: "trend-beatrate-2p-winner-run", accountId: winner, elapsedMs: 5_000, completedAt: "2026-07-18T01:00:05.000Z", challengeId: "trend-beatrate-2p" });
      await insertCompletedV2({ id: "trend-beatrate-2p-loser-run", accountId: loser, elapsedMs: 9_000, completedAt: "2026-07-18T01:00:09.000Z", challengeId: "trend-beatrate-2p" });
      // Both need a 2nd counted completion to clear the flat inclusion
      // floor - solo, so it doesn't touch either account's beat rate.
      await insertDailyChallenge({ id: "trend-beatrate-2p-solo-winner", sortOrder: 6101, createdAt: "2026-07-17T12:00:00.000Z" });
      await insertCompletedV2({ id: "trend-beatrate-2p-winner-solo-run", accountId: winner, elapsedMs: 5_000, completedAt: "2026-07-17T01:00:05.000Z", challengeId: "trend-beatrate-2p-solo-winner" });
      await insertDailyChallenge({ id: "trend-beatrate-2p-solo-loser", sortOrder: 6102, createdAt: "2026-07-17T12:00:00.000Z" });
      await insertCompletedV2({ id: "trend-beatrate-2p-loser-solo-run", accountId: loser, elapsedMs: 5_000, completedAt: "2026-07-17T01:00:05.000Z", challengeId: "trend-beatrate-2p-solo-loser" });

      const { repository } = fixture();
      const { ranked } = await repository.listDailyTrends(7, "2026-07-18");

      expect(ranked.find((entry) => entry.accountId === winner)).toMatchObject({ beatRate: 1, gradedCount: 1 });
      expect(ranked.find((entry) => entry.accountId === loser)).toMatchObject({ beatRate: 0, gradedCount: 1 });
    });

    it("RULING: an all-solo account that clears the completion floor still needs >= 1 graded race to rank - it lands in `unranked` with `gradedCount: 0` instead", async () => {
      const accountId = "trend-beatrate-all-solo";
      await insertDailyChallenge({ id: "trend-beatrate-all-solo-1", sortOrder: 6110, createdAt: "2026-07-17T12:00:00.000Z" });
      await insertCompletedV2({ id: "trend-beatrate-all-solo-1-run", accountId, elapsedMs: 4_000, completedAt: "2026-07-17T01:00:04.000Z", challengeId: "trend-beatrate-all-solo-1" });
      await insertDailyChallenge({ id: "trend-beatrate-all-solo-2", sortOrder: 6111, createdAt: "2026-07-18T12:00:00.000Z" });
      await insertCompletedV2({ id: "trend-beatrate-all-solo-2-run", accountId, elapsedMs: 4_000, completedAt: "2026-07-18T01:00:04.000Z", challengeId: "trend-beatrate-all-solo-2" });

      const { repository } = fixture();
      const { ranked, unranked, guard } = await repository.listDailyTrends(7, "2026-07-18");

      expect(guard).toBe(2);
      expect(ranked.find((entry) => entry.accountId === accountId)).toBeUndefined();
      expect(unranked.find((entry) => entry.accountId === accountId)).toEqual({
        accountId, displayName: null, playedCount: 2, gradedCount: 0,
      });
    });

    it("drops the single worst graded race once an account reaches exactly 4 graded races in-window ('exactly-4-graded triggers drop-worst')", async () => {
      const accountId = "trend-beatrate-drop-worst";
      // 3 wins (beat 1.0 each) + 1 loss (beat 0.0) = 4 graded races. Without
      // the drop, the mean would be 0.75; with the worst (the 0.0 loss)
      // dropped, the mean of the remaining three 1.0s is 1.0.
      const races: Array<{ dailyDate: string; won: boolean }> = [
        { dailyDate: "2026-07-15", won: true },
        { dailyDate: "2026-07-16", won: true },
        { dailyDate: "2026-07-17", won: true },
        { dailyDate: "2026-07-18", won: false },
      ];
      for (const [index, race] of races.entries()) {
        const challengeId = `trend-beatrate-drop-worst-${index}`;
        await insertDailyChallenge({ id: challengeId, sortOrder: 6120 + index, createdAt: `${race.dailyDate}T12:00:00.000Z` });
        await insertCompletedV2({
          id: `${challengeId}-subject`, accountId,
          elapsedMs: race.won ? 5_000 : 9_000,
          completedAt: `${race.dailyDate}T01:00:0${race.won ? 5 : 9}.000Z`,
          challengeId,
        });
        await insertCompletedV2({
          id: `${challengeId}-opponent`, accountId: `trend-beatrate-drop-worst-opp-${index}`,
          elapsedMs: race.won ? 9_000 : 5_000,
          completedAt: `${race.dailyDate}T01:00:0${race.won ? 9 : 5}.000Z`,
          challengeId,
        });
      }

      const { repository } = fixture();
      const { ranked } = await repository.listDailyTrends(7, "2026-07-18");

      expect(ranked.find((entry) => entry.accountId === accountId)).toMatchObject({
        beatRate: 1, gradedCount: 4, worstDropped: true, playedCount: 4,
      });
    });

    it("does NOT drop a race at exactly one below the drop-worst threshold (3 graded)", async () => {
      const accountId = "trend-beatrate-no-drop-at-3";
      const races: Array<{ dailyDate: string; won: boolean }> = [
        { dailyDate: "2026-07-16", won: true },
        { dailyDate: "2026-07-17", won: true },
        { dailyDate: "2026-07-18", won: false },
      ];
      for (const [index, race] of races.entries()) {
        const challengeId = `trend-beatrate-no-drop-${index}`;
        await insertDailyChallenge({ id: challengeId, sortOrder: 6130 + index, createdAt: `${race.dailyDate}T12:00:00.000Z` });
        await insertCompletedV2({
          id: `${challengeId}-subject`, accountId,
          elapsedMs: race.won ? 5_000 : 9_000,
          completedAt: `${race.dailyDate}T01:00:0${race.won ? 5 : 9}.000Z`,
          challengeId,
        });
        await insertCompletedV2({
          id: `${challengeId}-opponent`, accountId: `trend-beatrate-no-drop-opp-${index}`,
          elapsedMs: race.won ? 9_000 : 5_000,
          completedAt: `${race.dailyDate}T01:00:0${race.won ? 9 : 5}.000Z`,
          challengeId,
        });
      }

      const { repository } = fixture();
      const { ranked } = await repository.listDailyTrends(7, "2026-07-18");

      // Mean of all 3: (1 + 1 + 0) / 3 = 0.6666... -> rounds to 0.6667.
      expect(ranked.find((entry) => entry.accountId === accountId)).toMatchObject({
        beatRate: 0.6667, gradedCount: 3, worstDropped: false, playedCount: 3,
      });
    });

    it("recomputes statelessly per window - a worst race dropped in a wider window never 'resurrects' once the window narrows past it; the same 4 races evaluated fresh over a wider window still drop the worst independently", async () => {
      const accountId = "trend-beatrate-stateless";
      // 4 graded races across the lifetime catalog: the oldest (outside the
      // 7d window ending 2026-07-18, but inside 30d) is the worst (a loss);
      // the 3 most recent (inside 7d) are all wins.
      const races: Array<{ dailyDate: string; won: boolean }> = [
        { dailyDate: "2026-06-25", won: false },
        { dailyDate: "2026-07-16", won: true },
        { dailyDate: "2026-07-17", won: true },
        { dailyDate: "2026-07-18", won: true },
      ];
      for (const [index, race] of races.entries()) {
        const challengeId = `trend-beatrate-stateless-${index}`;
        await insertDailyChallenge({ id: challengeId, sortOrder: 6140 + index, createdAt: `${race.dailyDate}T12:00:00.000Z` });
        await insertCompletedV2({
          id: `${challengeId}-subject`, accountId,
          elapsedMs: race.won ? 5_000 : 9_000,
          completedAt: `${race.dailyDate}T01:00:0${race.won ? 5 : 9}.000Z`,
          challengeId,
        });
        await insertCompletedV2({
          id: `${challengeId}-opponent`, accountId: `trend-beatrate-stateless-opp-${index}`,
          elapsedMs: race.won ? 9_000 : 5_000,
          completedAt: `${race.dailyDate}T01:00:0${race.won ? 9 : 5}.000Z`,
          challengeId,
        });
      }

      const { repository } = fixture();
      // 30d window: all 4 races in scope, exactly at the drop-worst
      // threshold - the 2026-06-25 loss is dropped, mean of the remaining
      // three wins is 1.0.
      const thirtyDay = await repository.listDailyTrends(30, "2026-07-18");
      expect(thirtyDay.ranked.find((entry) => entry.accountId === accountId)).toMatchObject({
        beatRate: 1, gradedCount: 4, worstDropped: true, playedCount: 4,
      });
      // 7d window: the 2026-06-25 loss falls OUT of scope entirely (not
      // "restored" from a drop - it was never counted here at all) - only 3
      // graded races remain, below the threshold, so nothing is dropped.
      // Recomputing fresh from this window's own races alone gives the same
      // beatRate either way (all 3 in-window races are wins), proving there
      // is no persisted "already dropped" state carried between calls.
      const week = await repository.listDailyTrends(7, "2026-07-18");
      expect(week.ranked.find((entry) => entry.accountId === accountId)).toMatchObject({
        beatRate: 1, gradedCount: 3, worstDropped: false, playedCount: 3,
      });
    });
  });
});

describe("listDailyTrends - D1 bind-cap regression (FB-10 fixer pass)", () => {
  it(
    "aggregates across 150 challenges created inside a 30d window via a fixed 2-bind created_at range (D1 caps bound params at ~100/statement; Miniflare doesn't enforce it, so bind-arg count is asserted directly)",
    async () => {
      const accountId = "trend-bindcap-account";
      const total = 150;
      for (let index = 0; index < total; index += 1) {
        const challengeId = `trend-bindcap-challenge-${index}`;
        // All created "today" (well inside the 30d window ending
        // 2026-07-18) - the point is many CHALLENGES in-window, not many
        // runs on one challenge (that's `listChallengePlacements`'s own
        // no-LIMIT test above).
        await insertDailyChallenge({ id: challengeId, sortOrder: 5000 + index, createdAt: "2026-07-18T12:00:00.000Z" });
        await insertCompletedV2({
          id: `${challengeId}-run`,
          accountId,
          elapsedMs: 4_000 + index,
          completedAt: "2026-07-18T20:00:00.000Z",
          challengeId,
        });
      }

      const { db: countingDb, maxBindArgs } = bindCountingDb(env.VWIKI_RACE_DB);
      const repository = createD1TrackingRepository({
        db: countingDb,
        now: () => new Date("2026-07-18T01:00:00.000Z"),
        randomId: () => "unused",
      });

      // Correctness at scale: every one of the 150 in-window challenges
      // counts toward this account's played total.
      const { ranked, unranked } = await repository.listDailyTrends(30, "2026-07-18");
      const entry = [...ranked, ...unranked].find((row) => row.accountId === accountId);
      expect(entry?.playedCount).toBe(total);

      // The hard fuse itself: the pre-fix implementation filtered the main
      // query with a per-challenge `IN (?,?,...)` list built from every
      // challenge created inside the window - at this same 150-challenge
      // scale it would bind ~150 params. Cloudflare D1 caps bound
      // parameters at ~100 per statement, so that shape 500s in real D1;
      // Miniflare doesn't enforce the cap, so a naive "does it throw" test
      // can't catch this by construction - the rewritten filter uses a
      // `created_at >= ? AND created_at < ?` subquery, exactly 2 fixed
      // binds no matter how many challenges exist in the window (owner
      // ruling, 2026-07-25, dropped the query's only other bind -
      // `MIN_COUNTED_DNF_CLICKS` - entirely, once DNFs stopped counting
      // toward this guard at all), so this stays small and constant
      // regardless of catalog size.
      expect(maxBindArgs()).toBeLessThanOrEqual(5);
    },
    20_000,
  );
});

describe("listAllPlayersRoster (PKG-14: direct owner feedback - lifetime/board stats must include everyone who's played)", () => {
  it("includes an account whose only run is on a custom (non-daily) challenge - the exact gap listDailyTrends has", async () => {
    const accountId = "roster-custom-only";
    await insertAccountProfile(accountId, "FranTheGreat");
    // Default challenge-0001 - a seeded challenge with no daily_features
    // row at all, i.e. purely "custom" from this query's point of view.
    await insertCompletedV2({ id: "roster-custom-run", accountId, elapsedMs: 4_000, completedAt: "2026-07-18T01:00:04.000Z" });

    const { repository } = fixture();
    const roster = await repository.listAllPlayersRoster();

    expect(roster.find((entry) => entry.accountId === accountId)).toEqual({
      accountId, displayName: "FranTheGreat", racesStarted: 1, finishes: 1, wins: 1,
    });
  });

  it("counts races started, finishes, and wins separately - a DNF-only account has 0 finishes/wins but still appears", async () => {
    const finisherAccount = "roster-two-runs-finisher";
    const winnerAccount = "roster-other-winner";
    const dnfOnlyAccount = "roster-dnf-only";
    // `finisherAccount` finishes both challenge-0001 and challenge-0002, but
    // `winnerAccount` beats them on both - two finishes, zero wins.
    await insertCompletedV2({ id: "roster-run-1", accountId: finisherAccount, elapsedMs: 4_000, completedAt: "2026-07-18T01:00:04.000Z", challengeId: "challenge-0001" });
    await insertCompletedV2({ id: "roster-run-2", accountId: finisherAccount, elapsedMs: 5_000, completedAt: "2026-07-18T01:00:05.000Z", challengeId: "challenge-0002" });
    await insertCompletedV2({ id: "roster-run-1-winner", accountId: winnerAccount, elapsedMs: 1_000, completedAt: "2026-07-18T01:00:01.000Z", challengeId: "challenge-0001" });
    await insertCompletedV2({ id: "roster-run-2-winner", accountId: winnerAccount, elapsedMs: 1_000, completedAt: "2026-07-18T01:00:01.000Z", challengeId: "challenge-0002" });
    await insertAbandonedV2({ id: "roster-dnf-run", accountId: dnfOnlyAccount, clickCount: 2, elapsedMs: 3_000, abandonedAt: "2026-07-18T01:00:03.000Z", challengeId: "challenge-0003" });

    const { repository } = fixture();
    const roster = await repository.listAllPlayersRoster();

    expect(roster.find((entry) => entry.accountId === finisherAccount)).toMatchObject({
      racesStarted: 2, finishes: 2, wins: 0,
    });
    expect(roster.find((entry) => entry.accountId === dnfOnlyAccount)).toMatchObject({
      racesStarted: 1, finishes: 0, wins: 0,
    });
    expect(roster.find((entry) => entry.accountId === winnerAccount)).toMatchObject({
      racesStarted: 2, finishes: 2, wins: 2,
    });
  });

  it("excludes board_excluded runs entirely - a zz*/zephyr-style test account never appears", async () => {
    const accountId = "roster-excluded-account";
    await insertCompletedV2({ id: "roster-excluded-run", accountId, elapsedMs: 4_000, completedAt: "2026-07-18T01:00:04.000Z", challengeId: "challenge-0001" });
    await env.VWIKI_RACE_DB.prepare("UPDATE runs SET board_excluded = 1 WHERE id = ?").bind("roster-excluded-run").run();

    const { repository } = fixture();
    const roster = await repository.listAllPlayersRoster();

    expect(roster.find((entry) => entry.accountId === accountId)).toBeUndefined();
  });

  it("resolves canonical accounts through account_aliases, same as listDailyTrends/listChallengePlacements", async () => {
    const canonical = "roster-alias-canonical";
    const ghost = "roster-alias-ghost";
    await insertCompletedV2({ id: "roster-alias-run", accountId: ghost, elapsedMs: 4_000, completedAt: "2026-07-18T01:00:04.000Z", challengeId: "challenge-0001" });
    await env.VWIKI_RACE_DB.prepare(
      `INSERT INTO account_aliases (alias_account_id, canonical_account_id, updated_at)
       VALUES (?, ?, '2026-07-18T00:00:00.000Z')`,
    ).bind(ghost, canonical).run();

    const { repository } = fixture();
    const roster = await repository.listAllPlayersRoster();
    const ids = roster.map((entry) => entry.accountId);

    expect(ids).toContain(canonical);
    expect(ids).not.toContain(ghost);
    // Never double-counted under both identities.
    expect(roster.find((entry) => entry.accountId === canonical)).toMatchObject({ racesStarted: 1 });
  });

  it("is independent of daily_features entirely - a catalog with zero dailies ever still returns every custom-challenge player", async () => {
    const accountId = "roster-no-dailies-account";
    await insertCompletedV2({ id: "roster-no-dailies-run", accountId, elapsedMs: 4_000, completedAt: "2026-07-18T01:00:04.000Z", challengeId: "challenge-0001" });

    const { repository } = fixture();
    const roster = await repository.listAllPlayersRoster();

    expect(roster.find((entry) => entry.accountId === accountId)).toBeDefined();
  });

  it("FB-7 (owner ruling, 2026-07-19): racesStarted is unaffected by the DNF click threshold - even a 1-click (or 0-click) run counts", async () => {
    const oneClickAccount = "roster-one-click-account";
    const zeroClickAccount = "roster-zero-click-account";
    await insertAbandonedV2({
      id: "roster-one-click-run", accountId: oneClickAccount, clickCount: 1,
      elapsedMs: 1_000, abandonedAt: "2026-07-18T01:00:01.000Z", challengeId: "challenge-0001",
    });
    await insertLegacyRun({ id: "roster-zero-click-run", accountId: zeroClickAccount, challengeId: "challenge-0002" });
    await env.VWIKI_RACE_DB.prepare(
      `UPDATE runs SET status='abandoned', protocol_version=2, click_count=0,
         abandoned_at='2026-07-18T01:00:01.000Z', elapsed_ms=1000,
         wall_elapsed_ms=1000 WHERE id='roster-zero-click-run'`,
    ).run();

    const { repository } = fixture();
    const roster = await repository.listAllPlayersRoster();

    expect(roster.find((entry) => entry.accountId === oneClickAccount)).toMatchObject({
      racesStarted: 1, finishes: 0, wins: 0,
    });
    expect(roster.find((entry) => entry.accountId === zeroClickAccount)).toMatchObject({
      racesStarted: 1, finishes: 0, wins: 0,
    });
  });
});

describe("sweepZzExcludedTestAccountRuns (owner ruling, 2026-07-25 - auto zz-sweep)", () => {
  it("flips board_excluded=1 for a zz-prefixed account's still-included runs and returns the changed-row count", async () => {
    const accountId = "zztest-sweep-account";
    await insertAccountProfile(accountId, "zztest");
    await insertCompletedV2({ id: "zz-sweep-run", accountId, elapsedMs: 4_000, completedAt: "2026-07-18T01:00:04.000Z" });

    const { repository } = fixture();
    await expect(repository.sweepZzExcludedTestAccountRuns()).resolves.toBe(1);
    await expect(env.VWIKI_RACE_DB.prepare(
      "SELECT board_excluded FROM runs WHERE id = 'zz-sweep-run'",
    ).first()).resolves.toEqual({ board_excluded: 1 });
  });

  it("is idempotent - a second call is a no-op once caught up", async () => {
    const accountId = "zztest-idempotent-account";
    await insertAccountProfile(accountId, "zztest2");
    await insertCompletedV2({ id: "zz-idempotent-run", accountId, elapsedMs: 4_000, completedAt: "2026-07-18T01:00:04.000Z" });

    const { repository } = fixture();
    await expect(repository.sweepZzExcludedTestAccountRuns()).resolves.toBe(1);
    await expect(repository.sweepZzExcludedTestAccountRuns()).resolves.toBe(0);
  });

  it("never touches a non-zz account's runs", async () => {
    const accountId = "regular-player-account";
    await insertAccountProfile(accountId, "Vijay");
    await insertCompletedV2({ id: "regular-run", accountId, elapsedMs: 4_000, completedAt: "2026-07-18T01:00:04.000Z" });

    const { repository } = fixture();
    await expect(repository.sweepZzExcludedTestAccountRuns()).resolves.toBe(0);
    await expect(env.VWIKI_RACE_DB.prepare(
      "SELECT board_excluded FROM runs WHERE id = 'regular-run'",
    ).first()).resolves.toEqual({ board_excluded: 0 });
  });

  it("returns 0 when there is nothing to sweep at all", async () => {
    const { repository } = fixture();
    await expect(repository.sweepZzExcludedTestAccountRuns()).resolves.toBe(0);
  });

  it("sweeps every still-included run for a zz account, not just one", async () => {
    const accountId = "zztest-multi-run-account";
    await insertAccountProfile(accountId, "zzmulti");
    await insertCompletedV2({ id: "zz-multi-run-1", accountId, elapsedMs: 4_000, completedAt: "2026-07-18T01:00:04.000Z", challengeId: "challenge-0001" });
    await insertCompletedV2({ id: "zz-multi-run-2", accountId, elapsedMs: 5_000, completedAt: "2026-07-18T01:00:05.000Z", challengeId: "challenge-0002" });

    const { repository } = fixture();
    await expect(repository.sweepZzExcludedTestAccountRuns()).resolves.toBe(2);
  });
});

describe("getAccountDailyStreak (Increment 4)", () => {
  it("FB-10 (owner ruling, 2026-07-20): a non-daily (manual) challenge does NOT extend the streak - streak stays daily-only", async () => {
    // FB-10 generalized `listDailyTrends`'s 7d/30d/lifetime windows to every
    // challenge, but the owner explicitly did NOT ask for the streak to
    // follow - it's the daily-ritual metric, and stays keyed off
    // `daily_features` alone (`getAccountDailyStreak` itself is untouched
    // by FB-10). A manual challenge - no `daily_features` row at all - must
    // never move it, even though it now counts fully toward trends.
    const accountId = "streak-manual-only";
    const challengeId = "streak-manual-challenge";
    await insertDailyChallenge({ id: challengeId, sortOrder: 1900, createdAt: "2026-07-18T12:00:00.000Z" });
    // Deliberately no `insertEditorialFeature` - a plain manual challenge.
    await insertCompletedV2({ id: "streak-manual-run", accountId, elapsedMs: 4_000, completedAt: "2026-07-18T01:00:04.000Z", challengeId });

    const { repository } = fixture();
    await expect(repository.getAccountDailyStreak(accountId, "2026-07-18")).resolves.toBe(0);
  });

  it("counts consecutive played Central dates ending today", async () => {
    const accountId = "streak-consecutive";
    for (const dailyDate of ["2026-07-16", "2026-07-17", "2026-07-18"]) {
      const challengeId = `streak-consecutive-${dailyDate}`;
      await insertDailyChallenge({ id: challengeId, sortOrder: 1000 + Number(dailyDate.slice(-2)) });
      await insertEditorialFeature(env.VWIKI_RACE_DB, { dailyDate, challengeId, selectionSource: "automatic" });
      await insertCompletedV2({ id: `${challengeId}-run`, accountId, elapsedMs: 4_000, completedAt: `${dailyDate}T01:00:04.000Z`, challengeId });
    }

    const { repository } = fixture();
    await expect(repository.getAccountDailyStreak(accountId, "2026-07-18")).resolves.toBe(3);
  });

  it("silently resets on a missed day - a played day before a miss doesn't count", async () => {
    const accountId = "streak-missed-day";
    const played = ["2026-07-16", "2026-07-18"]; // 2026-07-17 has a daily but is NOT played.
    for (const dailyDate of ["2026-07-16", "2026-07-17", "2026-07-18"]) {
      const challengeId = `streak-missed-${dailyDate}`;
      await insertDailyChallenge({ id: challengeId, sortOrder: 1100 + Number(dailyDate.slice(-2)) });
      await insertEditorialFeature(env.VWIKI_RACE_DB, { dailyDate, challengeId, selectionSource: "automatic" });
      if (played.includes(dailyDate)) {
        await insertCompletedV2({ id: `${challengeId}-run`, accountId, elapsedMs: 4_000, completedAt: `${dailyDate}T01:00:04.000Z`, challengeId });
      }
    }

    const { repository } = fixture();
    // Today (07-18) counts; yesterday (07-17) wasn't played -> silent reset,
    // the earlier 07-16 play doesn't carry through the gap.
    await expect(repository.getAccountDailyStreak(accountId, "2026-07-18")).resolves.toBe(1);
  });

  it("doesn't break the streak when today simply hasn't been played yet", async () => {
    const accountId = "streak-today-pending";
    for (const dailyDate of ["2026-07-16", "2026-07-17", "2026-07-18"]) {
      const challengeId = `streak-pending-${dailyDate}`;
      await insertDailyChallenge({ id: challengeId, sortOrder: 1200 + Number(dailyDate.slice(-2)) });
      await insertEditorialFeature(env.VWIKI_RACE_DB, { dailyDate, challengeId, selectionSource: "automatic" });
      if (dailyDate !== "2026-07-18") {
        await insertCompletedV2({ id: `${challengeId}-run`, accountId, elapsedMs: 4_000, completedAt: `${dailyDate}T01:00:04.000Z`, challengeId });
      }
    }

    const { repository } = fixture();
    await expect(repository.getAccountDailyStreak(accountId, "2026-07-18")).resolves.toBe(2);
  });

  it("a DNF today counts as played and extends the streak (F2: DNF counts the same as a finish)", async () => {
    // Pre-F2 this DNF didn't count at all, so today was simply skipped
    // (grace) and only yesterday's finish counted (streak 1). F2 makes a
    // board-visible DNF "played" unconditionally - today is no exception -
    // so today's DNF now genuinely extends yesterday's finish into a
    // 2-day streak.
    const accountId = "streak-today-dnf";
    const yesterdayChallengeId = "streak-dnf-yesterday";
    const todayChallengeId = "streak-dnf-today";
    await insertDailyChallenge({ id: yesterdayChallengeId, sortOrder: 1300 });
    await insertDailyChallenge({ id: todayChallengeId, sortOrder: 1301 });
    await insertEditorialFeature(env.VWIKI_RACE_DB, { dailyDate: "2026-07-17", challengeId: yesterdayChallengeId, selectionSource: "automatic" });
    await insertEditorialFeature(env.VWIKI_RACE_DB, { dailyDate: "2026-07-18", challengeId: todayChallengeId, selectionSource: "automatic" });
    await insertCompletedV2({ id: "streak-dnf-yesterday-run", accountId, elapsedMs: 4_000, completedAt: "2026-07-17T01:00:04.000Z", challengeId: yesterdayChallengeId });
    await insertAbandonedV2({ id: "streak-dnf-today-run", accountId, clickCount: 3, elapsedMs: 5_000, abandonedAt: "2026-07-18T01:00:05.000Z", challengeId: todayChallengeId });

    const { repository } = fixture();
    await expect(repository.getAccountDailyStreak(accountId, "2026-07-18")).resolves.toBe(2);
  });

  it("a DNF-only yesterday keeps the streak alive (F2), with today still in grace (unplayed, not a break)", async () => {
    const accountId = "streak-dnf-yesterday-alive";
    const dayBeforeChallengeId = "streak-dnf-alive-daybefore";
    const yesterdayChallengeId = "streak-dnf-alive-yesterday";
    await insertDailyChallenge({ id: dayBeforeChallengeId, sortOrder: 1350 });
    await insertDailyChallenge({ id: yesterdayChallengeId, sortOrder: 1351 });
    await insertEditorialFeature(env.VWIKI_RACE_DB, { dailyDate: "2026-07-16", challengeId: dayBeforeChallengeId, selectionSource: "automatic" });
    await insertEditorialFeature(env.VWIKI_RACE_DB, { dailyDate: "2026-07-17", challengeId: yesterdayChallengeId, selectionSource: "automatic" });
    await insertCompletedV2({ id: "streak-dnf-alive-daybefore-run", accountId, elapsedMs: 4_000, completedAt: "2026-07-16T01:00:04.000Z", challengeId: dayBeforeChallengeId });
    await insertAbandonedV2({ id: "streak-dnf-alive-yesterday-run", accountId, clickCount: 2, elapsedMs: 3_000, abandonedAt: "2026-07-17T01:00:03.000Z", challengeId: yesterdayChallengeId });
    // Today (2026-07-18) has no daily_features row at all here - the walk
    // hasn't reached it yet either way (grace), so it's irrelevant to this
    // scenario.

    const { repository } = fixture();
    await expect(repository.getAccountDailyStreak(accountId, "2026-07-18")).resolves.toBe(2);
  });

  it("FB-7 (owner ruling, 2026-07-19): a 1-click DNF today is a sub-threshold non-attempt and does NOT extend the streak", async () => {
    const accountId = "streak-subthreshold-today";
    const yesterdayChallengeId = "streak-subthreshold-yesterday";
    const todayChallengeId = "streak-subthreshold-today-challenge";
    await insertDailyChallenge({ id: yesterdayChallengeId, sortOrder: 1360 });
    await insertDailyChallenge({ id: todayChallengeId, sortOrder: 1361 });
    await insertEditorialFeature(env.VWIKI_RACE_DB, { dailyDate: "2026-07-17", challengeId: yesterdayChallengeId, selectionSource: "automatic" });
    await insertEditorialFeature(env.VWIKI_RACE_DB, { dailyDate: "2026-07-18", challengeId: todayChallengeId, selectionSource: "automatic" });
    await insertCompletedV2({ id: "streak-subthreshold-yesterday-run", accountId, elapsedMs: 4_000, completedAt: "2026-07-17T01:00:04.000Z", challengeId: yesterdayChallengeId });
    await insertAbandonedV2({ id: "streak-subthreshold-today-run", accountId, clickCount: 1, elapsedMs: 1_000, abandonedAt: "2026-07-18T01:00:01.000Z", challengeId: todayChallengeId });

    const { repository } = fixture();
    // Today's DNF doesn't count as played (sub-threshold), so it's treated
    // as unplayed-so-far (grace) rather than extending or breaking the
    // streak - yesterday's finish alone gives a streak of 1.
    await expect(repository.getAccountDailyStreak(accountId, "2026-07-18")).resolves.toBe(1);
  });

  it("is alias-resolved", async () => {
    const canonical = "streak-alias-canonical";
    const ghost = "streak-alias-ghost";
    const challengeId = "streak-alias-challenge";
    await insertDailyChallenge({ id: challengeId, sortOrder: 1400 });
    await insertEditorialFeature(env.VWIKI_RACE_DB, { dailyDate: "2026-07-18", challengeId, selectionSource: "automatic" });
    await insertCompletedV2({ id: "streak-alias-run", accountId: ghost, elapsedMs: 4_000, completedAt: "2026-07-18T01:00:04.000Z", challengeId });
    await env.VWIKI_RACE_DB.prepare(
      `INSERT INTO account_aliases (alias_account_id, canonical_account_id, updated_at)
       VALUES (?, ?, '2026-07-18T00:00:00.000Z')`,
    ).bind(ghost, canonical).run();

    const { repository } = fixture();
    await expect(repository.getAccountDailyStreak(canonical, "2026-07-18")).resolves.toBe(1);
  });

  it("returns 0 for an account that has never played", async () => {
    const { repository } = fixture();
    await expect(repository.getAccountDailyStreak("streak-never-played", "2026-07-18")).resolves.toBe(0);
  });

  it("treats a genuine gap in daily_features itself as a break, same as a missed day", async () => {
    const accountId = "streak-catalog-gap";
    // 2026-07-17 has no daily_features row at all (a real catalog gap).
    for (const dailyDate of ["2026-07-16", "2026-07-18"]) {
      const challengeId = `streak-gap-${dailyDate}`;
      await insertDailyChallenge({ id: challengeId, sortOrder: 1500 + Number(dailyDate.slice(-2)) });
      await insertEditorialFeature(env.VWIKI_RACE_DB, { dailyDate, challengeId, selectionSource: "automatic" });
      await insertCompletedV2({ id: `${challengeId}-run`, accountId, elapsedMs: 4_000, completedAt: `${dailyDate}T01:00:04.000Z`, challengeId });
    }

    const { repository } = fixture();
    await expect(repository.getAccountDailyStreak(accountId, "2026-07-18")).resolves.toBe(1);
  });
});

describe("getAccountDailyStreak - D1 bind-cap regression (F1)", () => {
  it(
    "computes a streak across 150 daily_features rows via a single fixed-bind join (D1 caps bound params at ~100/statement; Miniflare doesn't enforce it, so bind-arg count is asserted directly)",
    async () => {
      const accountId = "streak-bindcap-account";
      const total = 150;
      for (let index = 0; index < total; index += 1) {
        const dailyDate = centralDateDaysBefore("2026-07-18", index);
        const challengeId = `streak-bindcap-challenge-${index}`;
        await insertDailyChallenge({ id: challengeId, sortOrder: 2000 + index });
        await insertEditorialFeature(env.VWIKI_RACE_DB, { dailyDate, challengeId, selectionSource: "automatic" });
        await insertCompletedV2({
          id: `${challengeId}-run`,
          accountId,
          elapsedMs: 4_000,
          completedAt: `${dailyDate}T01:00:04.000Z`,
          challengeId,
        });
      }

      const { db: countingDb, maxBindArgs } = bindCountingDb(env.VWIKI_RACE_DB);
      const repository = createD1TrackingRepository({
        db: countingDb,
        now: () => new Date("2026-07-18T01:00:00.000Z"),
        randomId: () => "unused",
      });

      // Correctness at scale: an unbroken 150-day streak.
      await expect(repository.getAccountDailyStreak(accountId, "2026-07-18")).resolves.toBe(total);

      // The hard fuse itself: the pre-fix implementation bound one
      // parameter per daily_features row fetched (an `IN (...)` list), so
      // at this same 150-row scale it would have bound ~151 params -
      // Cloudflare D1 caps bound parameters at ~100 per statement, so that
      // shape 500s in real D1. Miniflare doesn't enforce the cap, so a
      // naive "does it throw" test can't catch this by construction - the
      // rewritten single join uses exactly 2 fixed binds (`todayCentral`,
      // `accountId`) no matter how many dailies exist, so this stays small
      // and constant regardless of history size.
      expect(maxBindArgs()).toBeLessThanOrEqual(5);
    },
    20_000,
  );
});

describe("getPlayAnotherSuggestion (Increment 5)", () => {
  it("suggests the most popular active challenge the account has never started", async () => {
    await insertReadyChallenge({ id: "suggest-popular", startPageId: 9201, targetPageId: 9202 });
    await insertReadyChallenge({ id: "suggest-quiet", startPageId: 9203, targetPageId: 9204 });
    await insertCompletedV2({
      id: "suggest-popular-run-1", accountId: "suggest-other-1", elapsedMs: 4_000,
      completedAt: "2026-07-14T01:00:04.000Z", challengeId: "suggest-popular",
    });
    await insertCompletedV2({
      id: "suggest-popular-run-2", accountId: "suggest-other-2", elapsedMs: 5_000,
      completedAt: "2026-07-14T01:00:05.000Z", challengeId: "suggest-popular",
    });
    await insertCompletedV2({
      id: "suggest-quiet-run", accountId: "suggest-other-3", elapsedMs: 3_000,
      completedAt: "2026-07-14T01:00:03.000Z", challengeId: "suggest-quiet",
    });

    const me: AuthorizedAccount = {
      accountId: "suggest-account", displayName: "Casey", status: "claimed", aliases: [],
    };
    const { repository } = fixture();
    const suggestion = await repository.getPlayAnotherSuggestion(me, "2026-07-20");

    expect(suggestion?.id).toBe("suggest-popular");
  });

  it("breaks a popularity tie by lower sort_order", async () => {
    // startPageId 9301 -> sort_order 9401 (higher); 9205 -> sort_order 9305 (lower).
    await insertReadyChallenge({ id: "suggest-tie-higher-sort", startPageId: 9301, targetPageId: 9302 });
    await insertReadyChallenge({ id: "suggest-tie-lower-sort", startPageId: 9205, targetPageId: 9206 });
    await insertCompletedV2({
      id: "suggest-tie-a", accountId: "suggest-tie-other-a", elapsedMs: 4_000,
      completedAt: "2026-07-14T01:00:04.000Z", challengeId: "suggest-tie-higher-sort",
    });
    await insertCompletedV2({
      id: "suggest-tie-b", accountId: "suggest-tie-other-b", elapsedMs: 4_000,
      completedAt: "2026-07-14T01:00:04.000Z", challengeId: "suggest-tie-lower-sort",
    });

    const me: AuthorizedAccount = {
      accountId: "suggest-tie-account", displayName: "Casey", status: "claimed", aliases: [],
    };
    const { repository } = fixture();
    const suggestion = await repository.getPlayAnotherSuggestion(me, "2026-07-20");

    expect(suggestion?.id).toBe("suggest-tie-lower-sort");
  });

  it("excludes a challenge the account started with 0 clicks, even though it's popular (broader than 'played')", async () => {
    await insertReadyChallenge({ id: "suggest-zero-click-popular", startPageId: 9401, targetPageId: 9402 });
    await insertCompletedV2({
      id: "suggest-zero-other", accountId: "suggest-zero-other-account", elapsedMs: 4_000,
      completedAt: "2026-07-14T01:00:04.000Z", challengeId: "suggest-zero-click-popular",
    });
    const me: AuthorizedAccount = {
      accountId: "suggest-zero-account", displayName: "Casey", status: "claimed", aliases: [],
    };
    await insertLegacyRun({
      id: "suggest-zero-my-run", accountId: me.accountId, challengeId: "suggest-zero-click-popular",
    });

    const { repository } = fixture();
    const suggestion = await repository.getPlayAnotherSuggestion(me, "2026-07-20");

    expect(suggestion?.id).not.toBe("suggest-zero-click-popular");
  });

  it("excludes today's daily even if it's the most popular unplayed challenge", async () => {
    await insertDailyChallenge({ id: "suggest-daily-challenge", sortOrder: 9500 });
    await insertEditorialFeature(env.VWIKI_RACE_DB, {
      dailyDate: "2026-07-20", challengeId: "suggest-daily-challenge", selectionSource: "automatic",
    });
    await insertCompletedV2({
      id: "suggest-daily-run", accountId: "suggest-daily-other-account", elapsedMs: 4_000,
      completedAt: "2026-07-14T01:00:04.000Z", challengeId: "suggest-daily-challenge",
    });

    const me: AuthorizedAccount = {
      accountId: "suggest-daily-account", displayName: "Casey", status: "claimed", aliases: [],
    };
    const { repository } = fixture();
    const suggestion = await repository.getPlayAnotherSuggestion(me, "2026-07-20");

    expect(suggestion?.id).not.toBe("suggest-daily-challenge");
  });

  it("returns null when the account has started every active, non-daily challenge", async () => {
    const me: AuthorizedAccount = {
      accountId: "suggest-exhausted-account", displayName: "Casey", status: "claimed", aliases: [],
    };
    // Abandoned (not active) 0-click runs - a single account can only have
    // one *active* run at a time, but "started" (this method's bar) counts
    // any run row regardless of status/clicks.
    await insertAbandonedV2({
      id: "suggest-exhausted-1", accountId: me.accountId, clickCount: 0, elapsedMs: 1_000,
      abandonedAt: "2026-07-14T01:00:01.000Z", challengeId: "challenge-0001",
    });
    await insertAbandonedV2({
      id: "suggest-exhausted-2", accountId: me.accountId, clickCount: 0, elapsedMs: 1_000,
      abandonedAt: "2026-07-14T01:00:01.000Z", challengeId: "challenge-0002",
    });
    await insertAbandonedV2({
      id: "suggest-exhausted-3", accountId: me.accountId, clickCount: 0, elapsedMs: 1_000,
      abandonedAt: "2026-07-14T01:00:01.000Z", challengeId: "challenge-0003",
    });

    const { repository } = fixture();
    const suggestion = await repository.getPlayAnotherSuggestion(me, "2026-07-20");

    expect(suggestion).toBeNull();
  });

  it("resolves the canonical account through account_aliases so a claimed ghost isn't re-suggested a challenge it already played", async () => {
    const canonical = "suggest-alias-canonical";
    const ghost = "suggest-alias-ghost";
    await insertReadyChallenge({ id: "suggest-alias-popular", startPageId: 9601, targetPageId: 9602 });
    await insertCompletedV2({
      id: "suggest-alias-ghost-run", accountId: ghost, elapsedMs: 4_000,
      completedAt: "2026-07-14T01:00:04.000Z", challengeId: "suggest-alias-popular",
    });
    await env.VWIKI_RACE_DB.prepare(
      `INSERT INTO account_aliases (alias_account_id, canonical_account_id, updated_at)
       VALUES (?, ?, '2026-07-14T01:00:00.000Z')`,
    ).bind(ghost, canonical).run();

    const { repository } = fixture();
    const suggestion = await repository.getPlayAnotherSuggestion({
      accountId: canonical, displayName: "Casey", status: "claimed", aliases: [],
    }, "2026-07-20");

    expect(suggestion?.id).not.toBe("suggest-alias-popular");
  });
});

describe("beginRandomChallengeAttempt / finishRandomChallengeAttempt (Increment 5)", () => {
  const me: AuthorizedAccount = {
    accountId: "random-lock-account", displayName: "Casey", status: "claimed", aliases: [],
  };

  it("acquires the lock for a fresh idempotency key", async () => {
    const { repository } = fixture();

    await expect(repository.beginRandomChallengeAttempt(me, "key-1")).resolves.toBe("ok");
  });

  it("rejects a second concurrent different-key request while one is pending", async () => {
    const { repository } = fixture();

    await expect(repository.beginRandomChallengeAttempt(me, "key-1")).resolves.toBe("ok");
    await expect(repository.beginRandomChallengeAttempt(me, "key-2")).resolves.toBe("in_progress");
  });

  it("allows a new attempt once the prior one finishes", async () => {
    const { repository } = fixture();

    await repository.beginRandomChallengeAttempt(me, "key-1");
    await repository.finishRandomChallengeAttempt(me, "accepted", "challenge-0099");

    await expect(repository.beginRandomChallengeAttempt(me, "key-2")).resolves.toBe("ok");
  });

  it("reclaims a stale lock past the TTL without waiting for finish (crashed-worker recovery)", async () => {
    const clock = { now: "2026-07-14T01:00:00.000Z" };
    const { repository } = fixture(clock);

    await repository.beginRandomChallengeAttempt(me, "key-1"); // never finished
    clock.now = "2026-07-14T01:02:00.000Z"; // 2 minutes later, past the 60s stale threshold

    await expect(repository.beginRandomChallengeAttempt(me, "key-2")).resolves.toBe("ok");
  });

  it("does not reclaim a pending lock before the stale threshold", async () => {
    const clock = { now: "2026-07-14T01:00:00.000Z" };
    const { repository } = fixture(clock);

    await repository.beginRandomChallengeAttempt(me, "key-1");
    clock.now = "2026-07-14T01:00:30.000Z"; // 30s later, still within the 60s window

    await expect(repository.beginRandomChallengeAttempt(me, "key-2")).resolves.toBe("in_progress");
  });

  it("rejects with quota_exceeded once the hourly cap is reached, and releases the lock rather than leaving it stuck", async () => {
    const clock = { now: "2026-07-14T01:00:00.000Z" };
    const { repository } = fixture(clock);
    for (let index = 0; index < 3; index += 1) {
      await insertOriginSourceChallenge({
        id: `random-quota-${index}`,
        startPageId: 9700 + index,
        targetPageId: 9800 + index,
        createdByAccountId: me.accountId,
        createdAt: "2026-07-14T00:50:00.000Z", // 10 minutes ago - inside the hour window
      });
    }

    await expect(repository.beginRandomChallengeAttempt(me, "quota-key-1")).resolves.toBe("quota_exceeded");
    // A different key immediately afterwards still sees quota_exceeded (not
    // in_progress) - proof the lock was released, not left dangling.
    await expect(repository.beginRandomChallengeAttempt(me, "quota-key-2")).resolves.toBe("quota_exceeded");
  });

  it("does not count another account's random challenges toward this account's quota", async () => {
    const { repository } = fixture();
    for (let index = 0; index < 3; index += 1) {
      await insertOriginSourceChallenge({
        id: `random-other-account-quota-${index}`,
        startPageId: 9750 + index,
        targetPageId: 9850 + index,
        createdByAccountId: "random-lock-someone-else",
        createdAt: "2026-07-14T00:50:00.000Z",
      });
    }

    await expect(repository.beginRandomChallengeAttempt(me, "not-my-quota")).resolves.toBe("ok");
  });

  it("does not count a manual (non-random) challenge toward the quota", async () => {
    const { repository } = fixture();
    for (let index = 0; index < 3; index += 1) {
      await insertOriginSourceChallenge({
        id: `random-manual-not-quota-${index}`,
        startPageId: 9770 + index,
        targetPageId: 9870 + index,
        createdByAccountId: me.accountId,
        createdAt: "2026-07-14T00:50:00.000Z",
        source: "curated",
      });
    }

    await expect(repository.beginRandomChallengeAttempt(me, "curated-not-quota")).resolves.toBe("ok");
  });

  it("does not count a random challenge created over an hour ago toward the quota", async () => {
    const clock = { now: "2026-07-14T01:00:00.000Z" };
    const { repository } = fixture(clock);
    for (let index = 0; index < 3; index += 1) {
      await insertOriginSourceChallenge({
        id: `random-expired-quota-${index}`,
        startPageId: 9790 + index,
        targetPageId: 9890 + index,
        createdByAccountId: me.accountId,
        createdAt: "2026-07-14T00:00:00.000Z", // a full hour+ before `clock.now`
      });
    }

    await expect(repository.beginRandomChallengeAttempt(me, "aged-out-quota")).resolves.toBe("ok");
  });
});

describe("GET /api/v2/boards/trends", () => {
  it("returns window/guard/ranked/unranked, unauthenticated", async () => {
    const challengeId = "boards-trends-route-challenge";
    await insertDailyChallenge({ id: challengeId, sortOrder: 1600, createdAt: "2026-07-18T12:00:00.000Z" });
    await insertEditorialFeature(env.VWIKI_RACE_DB, { dailyDate: "2026-07-18", challengeId, selectionSource: "automatic" });
    await insertCompletedV2({ id: "boards-trends-route-run", accountId: "boards-trends-account", elapsedMs: 4_000, completedAt: "2026-07-18T01:00:04.000Z", challengeId });

    const { repository } = fixture({ now: "2026-07-18T20:00:00.000Z" });
    const worker = createWorker({
      now: () => new Date("2026-07-18T20:00:00.000Z"),
      createTracking: () => ({
        handlers: createApiHandlers(repository),
        identity: {},
        runProtocol: repository,
        authorize: async () => account,
      } as unknown as WorkerTracking),
    });

    const response = await worker.fetch(
      new Request("https://worker.example/api/v2/boards/trends?window=7"),
      workerEnv(),
    );

    expect(response.status).toBe(200);
    // Owner ruling, 2026-07-25: guard is the flat inclusion floor (2) - the
    // single completion here stays unranked.
    await expect(response.json()).resolves.toEqual({
      window: "7",
      guard: 2,
      ranked: [],
      unranked: [
        { accountId: "boards-trends-account", displayName: null, playedCount: 1, gradedCount: 0 },
      ],
    });
  });

  it("rejects an invalid window with 400", async () => {
    const { repository } = fixture();
    const worker = createWorker({
      now: () => new Date("2026-07-18T20:00:00.000Z"),
      createTracking: () => ({
        handlers: createApiHandlers(repository),
        identity: {},
        runProtocol: repository,
        authorize: async () => account,
      } as unknown as WorkerTracking),
    });

    const response = await worker.fetch(
      new Request("https://worker.example/api/v2/boards/trends?window=nope"),
      workerEnv(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_window" } });
  });

  it("PKG-14: window=lifetime folds in the all-players roster (custom-only racers included); 7d never carries one", async () => {
    const dailyChallengeId = "boards-trends-roster-daily";
    await insertDailyChallenge({ id: dailyChallengeId, sortOrder: 1700, createdAt: "2026-07-18T12:00:00.000Z" });
    await insertEditorialFeature(env.VWIKI_RACE_DB, { dailyDate: "2026-07-18", challengeId: dailyChallengeId, selectionSource: "automatic" });
    await insertAccountProfile("roster-route-daily-player", "Vijay");
    await insertCompletedV2({
      id: "boards-trends-roster-daily-run", accountId: "roster-route-daily-player",
      elapsedMs: 4_000, completedAt: "2026-07-18T01:00:04.000Z", challengeId: dailyChallengeId,
    });
    // A custom (non-daily) challenge, played by an account that never
    // touches a daily. Pre-FB-10, `listDailyTrends` could never see this
    // account at all (the roster was the only place it showed up); FB-10
    // (owner ruling, 2026-07-20) generalized trends to every challenge, so
    // this account is now ALSO a first-class lifetime trends entry, not
    // just a roster row - both are asserted below.
    await insertAccountProfile("roster-route-custom-player", "FranTheGreat");
    await insertCompletedV2({
      id: "boards-trends-roster-custom-run", accountId: "roster-route-custom-player",
      elapsedMs: 6_000, completedAt: "2026-07-18T01:00:06.000Z", challengeId: "challenge-0001",
    });

    const { repository } = fixture({ now: "2026-07-18T20:00:00.000Z" });
    const worker = createWorker({
      now: () => new Date("2026-07-18T20:00:00.000Z"),
      createTracking: () => ({
        handlers: createApiHandlers(repository),
        identity: {},
        runProtocol: repository,
        authorize: async () => account,
      } as unknown as WorkerTracking),
    });

    const lifetimeResponse = await worker.fetch(
      new Request("https://worker.example/api/v2/boards/trends?window=lifetime"),
      workerEnv(),
    );
    expect(lifetimeResponse.status).toBe(200);
    const lifetimeBody = await lifetimeResponse.json() as {
      guard: number;
      ranked: Array<{ accountId: string }>;
      unranked: Array<{ accountId: string }>;
      roster: Array<{ accountId: string }>;
    };
    expect(lifetimeBody.roster.map((entry) => entry.accountId).sort()).toEqual(
      ["roster-route-custom-player", "roster-route-daily-player"].sort(),
    );
    // Owner ruling, 2026-07-25: both accounts solo their one challenge each
    // - a single completion, one short of the flat inclusion floor (2) -
    // so both stay unranked (not "ranked" as under the old reality-scaled
    // ceil(1/3)=1 guard). The roster above is still the one place both show
    // up unconditionally.
    expect(lifetimeBody.guard).toBe(2);
    expect(lifetimeBody.ranked).toEqual([]);
    expect(lifetimeBody.unranked.map((entry) => entry.accountId).sort()).toEqual(
      ["roster-route-custom-player", "roster-route-daily-player"].sort(),
    );

    const sevenDayResponse = await worker.fetch(
      new Request("https://worker.example/api/v2/boards/trends?window=7"),
      workerEnv(),
    );
    const sevenDayBody = await sevenDayResponse.json() as { roster?: unknown };
    expect(sevenDayBody.roster).toBeUndefined();
  });
});

describe("GET /api/v2/challenges/:id/board", () => {
  it("returns the challenge id, deduped placements, and DNFs together, unauthenticated", async () => {
    await insertCompletedV2({
      id: "board-route-completed",
      accountId: "board-route-account-a",
      elapsedMs: 4_000,
      completedAt: "2026-07-14T01:00:04.000Z",
    });
    await insertAbandonedV2({
      id: "board-route-dnf",
      accountId: "board-route-account-b",
      clickCount: 3,
      elapsedMs: 5_000,
      abandonedAt: "2026-07-14T01:00:05.000Z",
    });

    const { repository } = fixture();
    const worker = createWorker({
      createTracking: () => ({
        handlers: createApiHandlers(repository),
        identity: {},
        runProtocol: repository,
        authorize: async () => account,
      } as unknown as WorkerTracking),
    });

    const response = await worker.fetch(
      new Request("https://worker.example/api/v2/challenges/challenge-0001/board"),
      workerEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      challengeId: "challenge-0001",
      placements: [
        {
          accountId: "board-route-account-a",
          displayName: null,
          placement: 1,
          elapsedMs: 4_000,
          clickCount: 1,
          // PKG-03 remainder fix: the surviving best attempt's own run id,
          // so Challenge Detail can link this row to its winning path once
          // the viewer has played (invariant 5) - see ChallengeBoardPlacement's
          // doc comment (domain/types.ts).
          runId: "board-route-completed",
        },
      ],
      dnfs: [
        {
          accountId: "board-route-account-b",
          displayName: null,
          clickCount: 3,
          elapsedMs: 5_000,
        },
      ],
    });
  });
});

describe("GET /api/v2/challenges/summary", () => {
  it("returns the aggregate for every active challenge, unauthenticated, with public cache headers", async () => {
    await insertCompletedV2({
      id: "summary-route-completed", accountId: "summary-route-account", elapsedMs: 4_000,
      completedAt: "2026-07-14T01:00:04.000Z", challengeId: "challenge-0001",
    });

    const { repository } = fixture();
    const worker = createWorker({
      createTracking: () => ({
        handlers: createApiHandlers(repository),
        identity: {},
        runProtocol: repository,
        authorize: async () => account,
      } as unknown as WorkerTracking),
    });

    const response = await worker.fetch(
      new Request("https://worker.example/api/v2/challenges/summary"),
      workerEnv(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=60");
    const body = await response.json() as { challenges: Array<{ challengeId: string }> };
    expect(body.challenges.find((entry) => entry.challengeId === "challenge-0001")).toEqual({
      challengeId: "challenge-0001",
      playerCount: 1,
      best: { elapsedMs: 4_000, clickCount: 1 },
    });
  });
});

describe("GET /api/v2/account/challenge-outcomes", () => {
  it("returns the caller's outcomes, authenticated", async () => {
    await insertCompletedV2({
      id: "outcomes-route-completed", accountId: account.accountId, elapsedMs: 4_000,
      completedAt: "2026-07-14T01:00:04.000Z", challengeId: "challenge-0001",
    });

    const { repository } = fixture();
    const worker = createWorker({
      createTracking: () => ({
        handlers: createApiHandlers(repository),
        identity: {},
        runProtocol: repository,
        authorize: async () => account,
      } as unknown as WorkerTracking),
    });

    const response = await worker.fetch(
      new Request("https://worker.example/api/v2/account/challenge-outcomes", {
        headers: { Authorization: "Bearer test" },
      }),
      workerEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      outcomes: [
        { challengeId: "challenge-0001", outcome: "completed", best: { elapsedMs: 4_000, clickCount: 1 } },
      ],
    });
  });
});

describe("GET /api/v2/challenges/suggestion", () => {
  it("returns the play-another suggestion for the caller, authenticated", async () => {
    await insertReadyChallenge({ id: "suggestion-route-popular", startPageId: 9901, targetPageId: 9902 });
    await insertCompletedV2({
      id: "suggestion-route-other", accountId: "suggestion-route-other-account", elapsedMs: 4_000,
      completedAt: "2026-07-14T01:00:04.000Z", challengeId: "suggestion-route-popular",
    });

    const { repository } = fixture({ now: "2026-07-20T12:00:00.000Z" });
    const worker = createWorker({
      now: () => new Date("2026-07-20T12:00:00.000Z"),
      createTracking: () => ({
        handlers: createApiHandlers(repository),
        identity: {},
        runProtocol: repository,
        authorize: async () => account,
      } as unknown as WorkerTracking),
    });

    const response = await worker.fetch(
      new Request("https://worker.example/api/v2/challenges/suggestion", {
        headers: { Authorization: "Bearer test" },
      }),
      workerEnv(),
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { challenge: { id: string } | null };
    expect(body.challenge?.id).toBe("suggestion-route-popular");
  });

  it("returns { challenge: null } once every active challenge has been started", async () => {
    await insertAbandonedV2({
      id: "suggestion-route-exhausted-1", accountId: account.accountId, clickCount: 0, elapsedMs: 1_000,
      abandonedAt: "2026-07-14T01:00:01.000Z", challengeId: "challenge-0001",
    });
    await insertAbandonedV2({
      id: "suggestion-route-exhausted-2", accountId: account.accountId, clickCount: 0, elapsedMs: 1_000,
      abandonedAt: "2026-07-14T01:00:01.000Z", challengeId: "challenge-0002",
    });
    await insertAbandonedV2({
      id: "suggestion-route-exhausted-3", accountId: account.accountId, clickCount: 0, elapsedMs: 1_000,
      abandonedAt: "2026-07-14T01:00:01.000Z", challengeId: "challenge-0003",
    });

    const { repository } = fixture({ now: "2026-07-20T12:00:00.000Z" });
    const worker = createWorker({
      now: () => new Date("2026-07-20T12:00:00.000Z"),
      createTracking: () => ({
        handlers: createApiHandlers(repository),
        identity: {},
        runProtocol: repository,
        authorize: async () => account,
      } as unknown as WorkerTracking),
    });

    const response = await worker.fetch(
      new Request("https://worker.example/api/v2/challenges/suggestion", {
        headers: { Authorization: "Bearer test" },
      }),
      workerEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ challenge: null });
  });
});

describe("POST /api/v2/challenges/random", () => {
  function randomCandidate(overrides: Partial<{
    startTitle: string; startPageId: number; startAllowedLinkCount: number;
    targetTitle: string; targetPageId: number; selectedScore: number;
  }> = {}) {
    return {
      startTitle: "Random Start",
      startPageId: 8_001,
      startAllowedLinkCount: 8,
      targetTitle: "Random Target",
      targetPageId: 8_002,
      selectedScore: 42,
      ...overrides,
    };
  }

  function randomChallengeWorker(
    repository: ReturnType<typeof createD1TrackingRepository>,
    findRandomCandidate: (request: { dailyDate: string; flavor: string }) => Promise<unknown>,
  ) {
    return createWorker({
      createTracking: () => ({
        handlers: createApiHandlers(repository, {
          findRandomCandidate: findRandomCandidate as never,
        }),
        identity: {},
        runProtocol: repository,
        authorize: async () => account,
      } as unknown as WorkerTracking),
    });
  }

  it("creates a fresh random challenge, attributed to the caller, source='wikipedia_random'/origin='manual'", async () => {
    const { repository } = fixture();
    const findRandomCandidate = vi.fn(async () => randomCandidate());
    const worker = randomChallengeWorker(repository, findRandomCandidate);

    const response = await worker.fetch(new Request("https://worker.example/api/v2/challenges/random", {
      method: "POST",
      headers: { Authorization: "Bearer test", "Content-Type": "application/json", "Idempotency-Key": "random-1" },
      body: JSON.stringify({}),
    }), workerEnv());

    expect(response.status).toBe(200);
    const body = await response.json() as { challenge: { id: string; createdBy?: { accountId: string } } };
    expect(body.challenge.createdBy?.accountId).toBe(account.accountId);
    await expect(scalar(
      `SELECT count(*) FROM challenges WHERE id = '${body.challenge.id}'
       AND origin = 'manual' AND source = 'wikipedia_random'
       AND created_by_account_id = '${account.accountId}'`,
    )).resolves.toBe(1);
    expect(findRandomCandidate).toHaveBeenCalledWith(expect.objectContaining({ flavor: "recognizable" }));
  });

  it("returns 429 with Retry-After once the hourly quota is exceeded", async () => {
    for (let index = 0; index < 3; index += 1) {
      await insertOriginSourceChallenge({
        id: `random-route-quota-${index}`,
        startPageId: 9_910 + index,
        targetPageId: 9_920 + index,
        createdByAccountId: account.accountId,
        createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      });
    }
    const { repository } = fixture();
    const findRandomCandidate = vi.fn(async () => randomCandidate());
    const worker = randomChallengeWorker(repository, findRandomCandidate);

    const response = await worker.fetch(new Request("https://worker.example/api/v2/challenges/random", {
      method: "POST",
      headers: { Authorization: "Bearer test", "Content-Type": "application/json", "Idempotency-Key": "random-quota" },
      body: JSON.stringify({}),
    }), workerEnv());

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("3600");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "random_challenge_quota_exceeded" } });
    expect(findRandomCandidate).not.toHaveBeenCalled();
  });

  it("rejects a second concurrent different-key request while one is still in flight", async () => {
    const { repository } = fixture();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const findRandomCandidate = vi.fn(async () => {
      await firstGate;
      return randomCandidate();
    });
    const worker = randomChallengeWorker(repository, findRandomCandidate);

    const firstResponsePromise = worker.fetch(new Request("https://worker.example/api/v2/challenges/random", {
      method: "POST",
      headers: { Authorization: "Bearer test", "Content-Type": "application/json", "Idempotency-Key": "concurrent-1" },
      body: JSON.stringify({}),
    }), workerEnv());
    // Give the first request's beginRandomChallengeAttempt a turn to land
    // before firing the second, so it's genuinely holding the lock.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const secondResponse = await worker.fetch(new Request("https://worker.example/api/v2/challenges/random", {
      method: "POST",
      headers: { Authorization: "Bearer test", "Content-Type": "application/json", "Idempotency-Key": "concurrent-2" },
      body: JSON.stringify({}),
    }), workerEnv());

    expect(secondResponse.status).toBe(429);
    await expect(secondResponse.json()).resolves.toMatchObject({
      error: { code: "random_challenge_in_progress" },
    });

    releaseFirst();
    const firstResponse = await firstResponsePromise;
    expect(firstResponse.status).toBe(200);
  });

  it("returns a retryable 503 when the candidate machinery can't find a usable pair", async () => {
    const { repository } = fixture();
    const findRandomCandidate = vi.fn(async () => {
      throw new DailyChallengeCandidateError("daily_candidate_unavailable");
    });
    const worker = randomChallengeWorker(repository, findRandomCandidate);

    const response = await worker.fetch(new Request("https://worker.example/api/v2/challenges/random", {
      method: "POST",
      headers: { Authorization: "Bearer test", "Content-Type": "application/json", "Idempotency-Key": "unavailable-1" },
      body: JSON.stringify({}),
    }), workerEnv());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "random_challenge_unavailable" } });

    // The lock was released on failure, so a fresh attempt isn't blocked.
    const findRandomCandidateRetry = vi.fn(async () => randomCandidate());
    const retryWorker = randomChallengeWorker(repository, findRandomCandidateRetry);
    const retryResponse = await retryWorker.fetch(new Request("https://worker.example/api/v2/challenges/random", {
      method: "POST",
      headers: { Authorization: "Bearer test", "Content-Type": "application/json", "Idempotency-Key": "unavailable-2" },
      body: JSON.stringify({}),
    }), workerEnv());
    expect(retryResponse.status).toBe(200);
  });

  it("enforces the burst rate limiter binding when present", async () => {
    const { repository } = fixture();
    const worker = randomChallengeWorker(repository, vi.fn(async () => randomCandidate()));
    const env = { ...workerEnv(), RANDOM_CHALLENGE_RATE_LIMITER: { limit: async () => ({ success: false }) } };

    const response = await worker.fetch(new Request("https://worker.example/api/v2/challenges/random", {
      method: "POST",
      headers: { Authorization: "Bearer test", "Content-Type": "application/json", "Idempotency-Key": "burst-1" },
      body: JSON.stringify({}),
    }), env);

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "random_challenge_rate_limited" } });
  });

  it("enforces a separate global/IP rate limiter binding, leaving the per-account limiter untouched", async () => {
    const { repository } = fixture();
    const worker = randomChallengeWorker(repository, vi.fn(async () => randomCandidate()));
    const accountLimiter = vi.fn(async () => ({ success: true }));
    const env = {
      ...workerEnv(),
      RANDOM_CHALLENGE_IP_RATE_LIMITER: { limit: async () => ({ success: false }) },
      RANDOM_CHALLENGE_RATE_LIMITER: { limit: accountLimiter },
    };

    const response = await worker.fetch(new Request("https://worker.example/api/v2/challenges/random", {
      method: "POST",
      headers: {
        Authorization: "Bearer test",
        "Content-Type": "application/json",
        "Idempotency-Key": "ip-burst-1",
        "CF-Connecting-IP": "203.0.113.9",
      },
      body: JSON.stringify({}),
    }), env);

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "random_challenge_ip_rate_limited" },
    });
    expect(accountLimiter).not.toHaveBeenCalled();
  });

  it("proceeds when the global/IP rate limiter binding is absent (fail-open)", async () => {
    const { repository } = fixture();
    const worker = randomChallengeWorker(repository, vi.fn(async () => randomCandidate()));
    const env = workerEnv();
    expect((env as Record<string, unknown>).RANDOM_CHALLENGE_IP_RATE_LIMITER).toBeUndefined();

    const response = await worker.fetch(new Request("https://worker.example/api/v2/challenges/random", {
      method: "POST",
      headers: {
        Authorization: "Bearer test",
        "Content-Type": "application/json",
        "Idempotency-Key": "ip-absent-1",
        "CF-Connecting-IP": "203.0.113.9",
      },
      body: JSON.stringify({}),
    }), env);

    expect(response.status).toBe(200);
  });

  it("enforces the global/IP ceiling before the per-account burst guard", async () => {
    const { repository } = fixture();
    const worker = randomChallengeWorker(repository, vi.fn(async () => randomCandidate()));
    const callOrder: string[] = [];
    const env = {
      ...workerEnv(),
      RANDOM_CHALLENGE_IP_RATE_LIMITER: {
        limit: async () => {
          callOrder.push("ip");
          return { success: true };
        },
      },
      RANDOM_CHALLENGE_RATE_LIMITER: {
        limit: async () => {
          callOrder.push("account");
          return { success: true };
        },
      },
    };

    const response = await worker.fetch(new Request("https://worker.example/api/v2/challenges/random", {
      method: "POST",
      headers: {
        Authorization: "Bearer test",
        "Content-Type": "application/json",
        "Idempotency-Key": "ip-order-1",
        "CF-Connecting-IP": "203.0.113.9",
      },
      body: JSON.stringify({}),
    }), env);

    expect(response.status).toBe(200);
    expect(callOrder).toEqual(["ip", "account"]);
  });
});

function fixture(
  clock: { now: string } = { now: "2026-07-14T01:00:00.000Z" },
  firstId = "run-1",
) {
  let id = 0;
  return {
    repository: createD1TrackingRepository({
      db: env.VWIKI_RACE_DB,
      now: () => new Date(clock.now),
      randomId: () => (id++ === 0 ? firstId : `${firstId}-generated-${id}`),
    }),
  };
}

/**
 * F1 regression harness: wraps a real D1 database so every `.bind(...)`
 * call made through it is recorded, without mutating the underlying
 * `env.VWIKI_RACE_DB` binding. Miniflare doesn't enforce D1's real ~100
 * bound-param-per-statement cap, so a query that binds one parameter per
 * row (the pre-fix `getAccountDailyStreak` shape) never throws locally at
 * any row count - this lets a test assert the *structural* fix (bind count
 * stays small and fixed) instead of relying on an exception that Miniflare
 * simply won't produce.
 */
function bindCountingDb(real: D1DatabaseLike): { db: D1DatabaseLike; maxBindArgs: () => number } {
  let max = 0;
  const db: D1DatabaseLike = {
    prepare(sql: string) {
      const stmt = real.prepare(sql);
      return {
        bind(...values: unknown[]) {
          max = Math.max(max, values.length);
          return stmt.bind(...values);
        },
        all<T = unknown>() {
          return stmt.all<T>();
        },
        first<T = unknown>() {
          return stmt.first<T>();
        },
        run() {
          return stmt.run();
        },
      };
    },
  };
  return { db, maxBindArgs: () => max };
}

async function recordTwoNonTerminalClicks(
  repository: ReturnType<typeof createD1TrackingRepository>,
  clock: { now: string },
): Promise<void> {
  clock.now = "2026-07-14T01:00:01.000Z";
  await repository.recordClickV2(account, {
    ...targetClick,
    destinationTitle: "Orbit",
    destinationPageId: 1234,
    decisionElapsedMs: 1000,
  });
  clock.now = "2026-07-14T01:00:02.000Z";
  await repository.recordClickV2(account, {
    ...targetClick,
    clientEventId: "00000000-0000-4000-8000-000000000102",
    expectedStepNumber: 2,
    sourceTitle: "Orbit",
    sourcePageId: 1234,
    destinationTitle: "Nebula",
    destinationPageId: 5555,
    decisionElapsedMs: 2000,
  });
}

async function insertLegacyRun(input: {
  id: string;
  accountId: string;
  challengeId?: string;
}) {
  const at = "2026-07-14T00:00:00.000Z";
  await env.VWIKI_RACE_DB.prepare(
    `INSERT INTO runs
       (id, challenge_id, account_id, canonical_account_id, status, started_at,
        click_count, start_title, target_title, start_page_id, target_page_id,
        last_page_id, last_title, expires_at, ranked_eligible, protocol_version,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, 0, 'Moon', 'Gravity', 19331, 38579,
             19331, 'Moon', ?, 0, 1, ?, ?)`,
  ).bind(
    input.id,
    input.challengeId ?? "challenge-0001",
    input.accountId,
    input.accountId,
    at,
    "2026-07-15T00:00:00.000Z",
    at,
    at,
  ).run();
}

async function insertCompletedV2(input: {
  id: string;
  accountId: string;
  elapsedMs: number;
  completedAt: string;
  challengeId?: string;
}) {
  await env.VWIKI_RACE_DB.prepare(
    `INSERT INTO runs
       (id, challenge_id, account_id, canonical_account_id, status, started_at,
        completed_at, elapsed_ms, wall_elapsed_ms, click_count, start_title,
        target_title, final_title, start_page_id, target_page_id, last_page_id,
        last_title, expires_at, ranked_eligible, protocol_version, created_at,
        updated_at)
     VALUES (?, ?, ?, ?, 'completed',
             '2026-07-14T01:00:00.000Z', ?, ?, ?, 1, 'Moon', 'Gravity',
             'Gravity', 19331, 38579, 38579, 'Gravity',
             '2026-07-15T01:00:00.000Z', 1, 2,
             '2026-07-14T01:00:00.000Z', ?)`,
  ).bind(
    input.id,
    input.challengeId ?? "challenge-0001",
    input.accountId,
    input.accountId,
    input.completedAt,
    input.elapsedMs,
    input.elapsedMs,
    input.completedAt,
  ).run();
}

async function insertAbandonedV2(input: {
  id: string;
  accountId: string;
  clickCount: number;
  elapsedMs: number;
  abandonedAt: string;
  challengeId?: string;
}) {
  await env.VWIKI_RACE_DB.prepare(
    `INSERT INTO runs
       (id, challenge_id, account_id, canonical_account_id, status, started_at,
        abandoned_at, elapsed_ms, wall_elapsed_ms, click_count, start_title,
        target_title, start_page_id, target_page_id, last_page_id,
        last_title, expires_at, ranked_eligible, protocol_version, created_at,
        updated_at)
     VALUES (?, ?, ?, ?, 'abandoned',
             '2026-07-14T01:00:00.000Z', ?, ?, ?, ?, 'Moon', 'Gravity',
             19331, 38579, 38579, 'Gravity',
             '2026-07-15T01:00:00.000Z', 0, 2,
             '2026-07-14T01:00:00.000Z', ?)`,
  ).bind(
    input.id,
    input.challengeId ?? "challenge-0001",
    input.accountId,
    input.accountId,
    input.abandonedAt,
    input.elapsedMs,
    input.elapsedMs,
    input.clickCount,
    input.abandonedAt,
  ).run();
}

async function insertCompletedLegacy(input: {
  id: string;
  accountId: string;
  elapsedMs: number;
  clickCount: number;
  completedAt: string;
}) {
  await env.VWIKI_RACE_DB.prepare(
    `INSERT INTO runs
       (id, challenge_id, account_id, canonical_account_id, status, started_at,
        completed_at, elapsed_ms, wall_elapsed_ms, click_count, start_title,
        target_title, final_title, start_page_id, target_page_id, last_page_id,
        last_title, expires_at, ranked_eligible, protocol_version, created_at,
        updated_at)
     VALUES (?, 'challenge-0001', ?, ?, 'completed',
             '2026-07-14T01:00:00.000Z', ?, ?, ?, ?, 'Moon', 'Gravity',
             'Gravity', 19331, 38579, 38579, 'Gravity',
             '2026-07-15T01:00:00.000Z', 0, 1,
             '2026-07-14T01:00:00.000Z', ?)`,
  ).bind(
    input.id,
    input.accountId,
    input.accountId,
    input.completedAt,
    input.elapsedMs,
    input.elapsedMs,
    input.clickCount,
    input.completedAt,
  ).run();
}

async function insertFinalizedOperation(input: {
  operation: "create_challenge" | "start";
  key: string;
  accountId: string;
  outcome: "accepted" | "rejected";
  createdAt: string;
}) {
  await env.VWIKI_RACE_DB.prepare(
    `INSERT INTO operation_idempotency
       (operation, idempotency_key, canonical_account_id, request_fingerprint,
        outcome_status, error_code, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    input.operation,
    input.key,
    input.accountId,
    `fingerprint-${input.key}`,
    input.outcome,
    input.outcome === "rejected" ? "test_rejection" : null,
    input.createdAt,
  ).run();
}

function createLegacyCreationWorker(
  repository: ReturnType<typeof createD1TrackingRepository>,
  validateChallengeArticles: ValidateChallengeArticles,
) {
  return createWorker({
    createTracking: () => ({
      handlers: createApiHandlers(repository, { validateChallengeArticles }),
      identity: {},
      runProtocol: repository,
      authorize: async () => account,
    } as unknown as WorkerTracking),
  });
}

function legacyCreationRequest() {
  return () => new Request("https://worker.example/api/challenges", {
    method: "POST",
    headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
    body: JSON.stringify({
      startTitle: "Mars",
      targetTitle: "Water",
      creatorDisplayName: "Ignored Browser Name",
    }),
  });
}

function workerEnv() {
  return {
    VWIKI_RACE_DB: env.VWIKI_RACE_DB,
    VGAMES_URL: "https://vgames.example",
    CLICK_RATE_LIMITER: { limit: async () => ({ success: true }) },
    ACCOUNT_READ_RATE_LIMITER: { limit: async () => ({ success: true }) },
    CHALLENGE_CREATE_RATE_LIMITER: { limit: async () => ({ success: true }) },
  };
}

async function columns(table: string): Promise<string[]> {
  const results = await tableInfo(table);
  return results.map((row) => row.name);
}

async function tableInfo(table: string): Promise<Array<{
  name: string;
  notnull: number;
  dflt_value: string | null;
}>> {
  const { results } = await env.VWIKI_RACE_DB.prepare(
    `PRAGMA table_info(${table})`,
  ).all<{
    name: string;
    notnull: number;
    dflt_value: string | null;
  }>();
  return results;
}

async function schemaSql(type: "table" | "index", name: string): Promise<string> {
  const row = await env.VWIKI_RACE_DB.prepare(
    "SELECT sql FROM sqlite_master WHERE type = ? AND name = ?",
  ).bind(type, name).first<{ sql: string }>();
  expect(row?.sql, `${type} ${name} should exist`).toBeTruthy();
  return row?.sql ?? "";
}

function normalizeSql(sql: string): string {
  return sql.toLowerCase().replace(/\s+/g, " ").trim();
}

async function count(table: string): Promise<number> {
  return scalar(`SELECT COUNT(*) FROM ${table}`);
}

async function scalar(sql: string): Promise<number> {
  const row = await env.VWIKI_RACE_DB.prepare(sql).first<Record<string, number>>();
  return Number(Object.values(row ?? {})[0] ?? 0);
}

async function insertEditorialNomination(
  db: D1DatabaseLike,
  input: { id: string; challengeId: string; status: "pending" | "approved" },
): Promise<void> {
  await db.prepare(
    `INSERT INTO daily_nominations
       (id, challenge_id, nominated_by_account_id, nominated_by_display_name,
        status, confidence, classifier_version, created_at, updated_at)
     VALUES (?, ?, 'nominator', 'Nominator', ?, 'unclassified', 'test-v1',
             '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z')`,
  ).bind(input.id, input.challengeId, input.status).run();
}

async function insertEditorialQueue(
  db: D1DatabaseLike,
  input: {
    id: string;
    challengeId: string;
    source: "community" | "admin";
    nominationId?: string;
    flavor?: "recognizable" | "weird" | "hard";
    status?: "queued" | "removed";
  },
): Promise<void> {
  await db.prepare(
    `INSERT INTO daily_queue_entries
       (id, challenge_id, nomination_id, flavor, source, status,
        queued_by_account_id, queued_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'editor',
             '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z')`,
  ).bind(
    input.id,
    input.challengeId,
    input.nominationId ?? null,
    input.flavor ?? "recognizable",
    input.source,
    input.status ?? "queued",
  ).run();
}

async function insertReadyChallenge(input: {
  id: string;
  startPageId: number;
  targetPageId: number;
}): Promise<void> {
  await env.VWIKI_RACE_DB.prepare(
    `INSERT INTO challenges
       (id, label, start_title, target_title, start_page_id, target_page_id,
        validation_status, ruleset, sort_order, is_active, created_at, origin, source)
     VALUES (?, ?, ?, ?, ?, ?, 'ready', 'ranked_classic',
             100 + ?, 1, '2026-07-14T01:00:00.000Z', 'manual', 'curated')`,
  ).bind(
    input.id,
    input.id,
    `Start ${input.startPageId}`,
    `Target ${input.targetPageId}`,
    input.startPageId,
    input.targetPageId,
    input.startPageId,
  ).run();
}

/** Increment 5: a manual, `source`-tagged challenge for random-quota tests. */
async function insertOriginSourceChallenge(input: {
  id: string;
  startPageId: number;
  targetPageId: number;
  createdByAccountId: string;
  createdAt: string;
  origin?: "manual" | "daily";
  source?: "curated" | "wikipedia_random";
}): Promise<void> {
  await env.VWIKI_RACE_DB.prepare(
    `INSERT INTO challenges
       (id, label, start_title, target_title, start_page_id, target_page_id,
        validation_status, ruleset, sort_order, is_active, created_at,
        created_by_account_id, created_by_display_name, created_by_identity_status,
        origin, source)
     VALUES (?, ?, ?, ?, ?, ?, 'ready', 'ranked_classic',
             300 + ?, 1, ?, ?, 'Random Bot', 'claimed', ?, ?)`,
  ).bind(
    input.id,
    input.id,
    `Start ${input.startPageId}`,
    `Target ${input.targetPageId}`,
    input.startPageId,
    input.targetPageId,
    input.startPageId,
    input.createdAt,
    input.createdByAccountId,
    input.origin ?? "manual",
    input.source ?? "wikipedia_random",
  ).run();
}

async function insertEditorialFeature(
  db: D1DatabaseLike,
  input: {
    dailyDate: string;
    challengeId: string;
    selectionSource: "automatic" | "community" | "admin";
    queueEntryId?: string;
  },
): Promise<void> {
  await db.prepare(
    `INSERT INTO daily_features
       (daily_date, challenge_id, flavor, selection_source, queue_entry_id,
        classifier_version, created_at)
     VALUES (?, ?, 'recognizable', ?, ?, 'test-v1', '2026-07-17T00:00:00.000Z')`,
  ).bind(
    input.dailyDate,
    input.challengeId,
    input.selectionSource,
    input.queueEntryId ?? null,
  ).run();
}

async function insertDailyChallenge(
  input: { id: string; sortOrder: number; createdAt?: string; isActive?: boolean },
): Promise<void> {
  await env.VWIKI_RACE_DB.prepare(
    `INSERT INTO challenges
       (id, label, start_title, target_title, ruleset, sort_order, is_active, created_at)
     VALUES (?, ?, 'Moon', 'Gravity', 'ranked_classic', ?, ?, ?)`,
  ).bind(
    input.id,
    input.id,
    input.sortOrder,
    input.isActive === false ? 0 : 1,
    // FB-10: `listDailyTrends` windows a challenge by the Central date of
    // its OWN `created_at`, not `daily_features.daily_date` - callers that
    // pair this with `insertEditorialFeature({ dailyDate, ... })` and care
    // about window membership must pass a matching `createdAt` (noon UTC on
    // that date is safely the same Central calendar day under both CDT and
    // CST, so callers can just do `${dailyDate}T12:00:00.000Z`). Callers
    // that don't care (e.g. `getAccountDailyStreak`, which stays
    // daily-only) can omit it and keep this untouched-since-Increment-4
    // default.
    input.createdAt ?? "2026-07-14T00:00:00.000Z",
  ).run();
}

async function insertAccountProfile(accountId: string, publicName: string): Promise<void> {
  await env.VWIKI_RACE_DB.prepare(
    `INSERT INTO account_profiles (account_id, public_name, identity_status, updated_at)
     VALUES (?, ?, 'claimed', '2026-07-14T00:00:00.000Z')`,
  ).bind(accountId, publicName).run();
}

/**
 * "I gave up" (owner spec, 2026-08-02): directly seeds the durable
 * `operation_idempotency` 'solution_peek' fact `giveUpChallenge` writes,
 * without going through the give-up eligibility flow - lets disclosure-guard
 * tests exercise "already peeked" independently of how a peek gets created.
 */
async function insertPeek(accountId: string, challengeId: string): Promise<void> {
  await env.VWIKI_RACE_DB.prepare(
    `INSERT INTO operation_idempotency
       (operation, idempotency_key, canonical_account_id, request_fingerprint,
        resource_id, outcome_status, created_at)
     VALUES ('solution_peek', ?, ?, 'test-fingerprint', ?, 'accepted', '2026-07-14T01:00:00.000Z')`,
  ).bind(`${accountId}:${challengeId}`, accountId, challengeId).run();
}

// GR-1: bulk-inserts a run's `run_path_steps` rows (source/destination
// titles + step number, matching `ChallengePathStepEntry`'s `{n, from, to}`
// - clicked_anchor_text/destination_page_id/elapsed_since_start_ms are
// dummy values, since `getChallengePaths` never reads them).
async function insertPathSteps(
  runId: string,
  steps: Array<{ n: number; from: string; to: string }>,
): Promise<void> {
  for (const step of steps) {
    await env.VWIKI_RACE_DB.prepare(
      `INSERT INTO run_path_steps
         (run_id, step_number, source_title, clicked_anchor_text, destination_title,
          destination_page_id, elapsed_since_start_ms, created_at)
       VALUES (?, ?, ?, 'link', ?, 1, ?, '2026-07-14T01:00:00.000Z')`,
    ).bind(runId, step.n, step.from, step.to, step.n * 1000).run();
  }
}

async function runStatus(runId: string): Promise<string | undefined> {
  return (await runSnapshot(runId))?.status as string | undefined;
}

async function runSnapshot(runId: string): Promise<Record<string, unknown> | null> {
  return env.VWIKI_RACE_DB.prepare("SELECT * FROM runs WHERE id = ?").bind(runId).first();
}

async function operationRow(operation: string, key: string): Promise<Record<string, unknown> | null> {
  return env.VWIKI_RACE_DB.prepare(
    "SELECT * FROM operation_idempotency WHERE operation = ? AND idempotency_key = ?",
  ).bind(operation, key).first();
}
