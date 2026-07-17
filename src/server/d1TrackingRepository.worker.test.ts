import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthorizedAccount } from "../domain/types";
import { createApiHandlers } from "./apiHandlers";
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
    DELETE FROM daily_features WHERE challenge_id NOT IN ('challenge-0001', 'challenge-0002', 'challenge-0003');
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
    // Cross the 2-click resumability floor so this run is discoverable as
    // active; a bare 0-click run is deliberately not surfaced (see the
    // "2-click floor" describe block).
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

describe("2-click floor for resumable protocol-2 runs", () => {
  it("does not surface a 0-click active run from findActiveRun", async () => {
    const { repository } = fixture();
    const created = await repository.startRunV2(account, start);
    expect(created).toMatchObject({ clickCount: 0, status: "active" });

    await expect(repository.findActiveRun(account)).resolves.toBeNull();
  });

  it("does not surface a 1-click active run from findActiveRun", async () => {
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
    await expect(repository.findActiveRun(account)).resolves.toBeNull();
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
      // The fresh run is itself sub-threshold (0 clicks), so it is not yet a
      // resumable "active run" either -- confirm no run leaked through as active.
      await expect(runSnapshot(second.id)).resolves.toMatchObject({
        status: "active",
        click_count: 0,
      });
      await expect(repository.findActiveRun(account)).resolves.toBeNull();
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
    await insertEditorialFeature(env.VWIKI_RACE_DB, {
      dailyDate: "2026-07-20",
      challengeId: created.challenge.id,
      selectionSource: "automatic",
    });

    const duplicate = await repository.createChallengeV2({
      ...account,
      accountId: "account-late-nominator",
    }, {
      startTitle: "Mercury",
      startPageId: 901,
      startAllowedLinkCount: 20,
      targetTitle: "Tides",
      targetPageId: 902,
      idempotencyKey: "featured-duplicate",
      nominateForDaily: true,
    });

    expect(duplicate).toMatchObject({
      disposition: "existing",
      nomination: "previously_featured",
      challenge: { id: created.challenge.id },
    });
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
    await expect(repository.getPublicRunPath("same-dnf")).resolves.toHaveLength(2);
    expect(rows.some((row) => row.runId === "zero-click-dnf")).toBe(false);
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
    await expect(repository.getPublicRunPath("public-path-run")).resolves.toEqual([
      expect.objectContaining({ destinationTitle: "Gravity", stepNumber: 1 }),
    ]);
    await expect(repository.getPublicRunPath("private-path-run")).rejects.toMatchObject({
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
    await expect(repository.getPublicRunPath("historical-path-run")).resolves.toEqual([
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
    await expect(repository.getPublicRunPath("malformed-historical-path"))
      .rejects.toMatchObject({ code: "run_path_not_found", status: 404 });
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
      // Cross the 2-click resumability floor so this run is discoverable as
      // active; a bare 0-click run is deliberately not surfaced.
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
    });
    await expect(count("account_profiles")).resolves.toBe(0);
    await expect(count("account_aliases")).resolves.toBe(1);
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
}) {
  await env.VWIKI_RACE_DB.prepare(
    `INSERT INTO runs
       (id, challenge_id, account_id, canonical_account_id, status, started_at,
        completed_at, elapsed_ms, wall_elapsed_ms, click_count, start_title,
        target_title, final_title, start_page_id, target_page_id, last_page_id,
        last_title, expires_at, ranked_eligible, protocol_version, created_at,
        updated_at)
     VALUES (?, 'challenge-0001', ?, ?, 'completed',
             '2026-07-14T01:00:00.000Z', ?, ?, ?, 1, 'Moon', 'Gravity',
             'Gravity', 19331, 38579, 38579, 'Gravity',
             '2026-07-15T01:00:00.000Z', 1, 2,
             '2026-07-14T01:00:00.000Z', ?)`,
  ).bind(
    input.id,
    input.accountId,
    input.accountId,
    input.completedAt,
    input.elapsedMs,
    input.elapsedMs,
    input.completedAt,
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
  input: { id: string; challengeId: string; source: "community" | "admin"; nominationId?: string },
): Promise<void> {
  await db.prepare(
    `INSERT INTO daily_queue_entries
       (id, challenge_id, nomination_id, flavor, source, status,
        queued_by_account_id, queued_at, updated_at)
     VALUES (?, ?, ?, 'recognizable', ?, 'queued', 'editor',
             '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z')`,
  ).bind(input.id, input.challengeId, input.nominationId ?? null, input.source).run();
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
