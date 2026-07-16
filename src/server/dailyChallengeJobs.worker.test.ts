import { env } from "cloudflare:workers";
import { applyD1Migrations, createScheduledController } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthorizedAccount } from "../domain/types";
import { createD1TrackingRepository } from "./d1TrackingRepository";
import {
  centralDailyDateAtFive,
  createWorker,
  type Env as WorkerEnv,
  type WorkerTracking,
} from "./worker";

beforeEach(async () => {
  await env.VWIKI_RACE_DB.exec(`
    DELETE FROM daily_challenge_jobs;
    DELETE FROM operation_idempotency;
    DELETE FROM challenges WHERE id NOT IN ('challenge-0001', 'challenge-0002', 'challenge-0003');
    UPDATE challenge_number_sequence SET next_sort_order = 4 WHERE sequence_name = 'global';
  `);
});

describe("daily challenge D1 jobs", () => {
  it.each([
    ["summer", "2026-07-15T10:00:00.000Z", "2026-07-15"],
    ["winter", "2026-01-15T11:00:00.000Z", "2026-01-15"],
    ["spring DST boundary", "2026-03-08T10:00:00.000Z", "2026-03-08"],
    ["fall DST boundary", "2026-11-01T11:00:00.000Z", "2026-11-01"],
  ])("recognizes the 5:00 AM Central %s trigger", (_season, timestamp, dailyDate) => {
    expect(centralDailyDateAtFive(new Date(timestamp))).toBe(dailyDate);
  });

  it.each([
    ["summer", "2026-07-15T11:00:00.000Z"],
    ["winter", "2026-01-15T10:00:00.000Z"],
  ])("exits before building tracking for the alternate %s trigger", async (_season, timestamp) => {
    const createTracking = vi.fn();
    const worker = createWorker({ createTracking });

    await worker.scheduled(createScheduledController({
      scheduledTime: new Date(timestamp),
      cron: timestamp.includes("T10:") ? "0 10 * * *" : "0 11 * * *",
    }), env as unknown as WorkerEnv);

    expect(createTracking).not.toHaveBeenCalled();
  });

  it("applies migrations 0001 through 0004 in order and seeds the global sequence", async () => {
    await applyD1Migrations(
      env.MIGRATION_TEST_DB,
      env.TEST_MIGRATIONS.slice(0, 3),
      "daily_challenge_full_migration",
    );
    await env.MIGRATION_TEST_DB.prepare(
      `INSERT INTO challenges
         (id, label, start_title, target_title, ruleset, sort_order, is_active,
          created_at, created_by_account_id, created_by_display_name,
          created_by_identity_status, start_page_id, target_page_id, validation_status)
       VALUES ('challenge-0015', 'Challenge #15', 'A', 'B', 'ranked_classic', 15,
               1, '2026-07-15T00:00:00.000Z', 'creator', 'Creator', 'claimed',
               1, 2, 'ready')`,
    ).run();
    await applyD1Migrations(
      env.MIGRATION_TEST_DB,
      env.TEST_MIGRATIONS,
      "daily_challenge_full_migration",
    );
    await expect(env.MIGRATION_TEST_DB.prepare(
      "SELECT next_sort_order FROM challenge_number_sequence WHERE sequence_name = 'global'",
    ).first()).resolves.toEqual({ next_sort_order: 16 });
    const repository = createD1TrackingRepository({
      db: env.MIGRATION_TEST_DB,
      now: () => new Date("2026-07-15T07:00:00.000Z"),
      randomId: () => "migration-lease",
    });
    await repository.ensureDailyChallengeJob("2026-07-15");
    const job = await repository.claimDueDailyChallengeJob();
    const daily = await repository.acceptDailyChallenge(job!, {
      startTitle: "Daily start",
      startPageId: 101,
      targetTitle: "Daily target",
      targetPageId: 102,
    });
    expect(daily).toMatchObject({
      id: "challenge-0016",
      label: "Challenge #16",
      dailyDate: "2026-07-15",
    });
    await expect(env.MIGRATION_TEST_DB.prepare(
      "SELECT next_sort_order FROM challenge_number_sequence WHERE sequence_name = 'global'",
    ).first()).resolves.toEqual({ next_sort_order: 17 });
    await expect(env.MIGRATION_TEST_DB.prepare(
      "INSERT INTO challenges (id, label, start_title, target_title, ruleset, sort_order, is_active, created_at, daily_date) VALUES ('duplicate-daily', 'Duplicate', 'A', 'B', 'ranked_classic', 17, 1, '2026-07-15T00:00:00.000Z', '2026-07-15')",
    ).run()).rejects.toThrow(/constraint/i);
  });

  it.each(["2026-02-30", "2026-04-31", "2025-02-29"])(
    "rejects calendar-overflow daily date %s at the repository boundary",
    async (dailyDate) => {
      const repository = createD1TrackingRepository({ db: env.VWIKI_RACE_DB });
      await expect(repository.ensureDailyChallengeJob(dailyDate)).rejects.toMatchObject({
        code: "invalid_daily_date",
        status: 400,
      });
    },
  );

  it("returns complete manual provenance for creation and idempotent replay", async () => {
    const repository = createD1TrackingRepository({ db: env.VWIKI_RACE_DB });
    const account: AuthorizedAccount = {
      accountId: "provenance-account",
      displayName: "Provenance",
      status: "claimed",
      aliases: [],
    };
    const input = {
      startTitle: "Start",
      startPageId: 101,
      startAllowedLinkCount: 1,
      targetTitle: "Target",
      targetPageId: 102,
      idempotencyKey: "daily-provenance-replay",
      requestFingerprint: "daily-provenance-fingerprint",
    };

    const created = await repository.createChallengeV2(account, input);
    await expect(repository.createChallengeV2(account, input)).resolves.toEqual(created);
    expect(created).toMatchObject({
      mode: "solo",
      origin: "manual",
      dailyDate: null,
      source: "curated",
    });
  });

  it("allocates manual legacy, manual v2, and daily challenges from one sequence", async () => {
    const repository = createD1TrackingRepository({ db: env.VWIKI_RACE_DB });
    const legacy = await repository.createChallenge({
      startTitle: "Legacy start",
      targetTitle: "Legacy target",
      creatorAccountId: "legacy-account",
      creatorDisplayName: "Legacy",
      creatorIdentityStatus: "claimed",
    });
    const v2 = await repository.createChallengeV2({
      accountId: "v2-account", displayName: "V2", status: "claimed", aliases: [],
    }, {
      startTitle: "V2 start", startPageId: 301, startAllowedLinkCount: 1,
      targetTitle: "V2 target", targetPageId: 302,
      idempotencyKey: "sequence-v2", requestFingerprint: "sequence-v2-fingerprint",
    });
    await repository.ensureDailyChallengeJob("2026-07-15");
    const job = await repository.claimDueDailyChallengeJob();
    const daily = await repository.acceptDailyChallenge(job!, {
      startTitle: "Daily start", startPageId: 401,
      targetTitle: "Daily target", targetPageId: 402,
    });

    expect([legacy.id, v2.id, daily.id]).toEqual([
      "challenge-0004", "challenge-0005", "challenge-0006",
    ]);
    expect(daily.label).toBe("Challenge #6");
  });

  it("keeps late UTC dates in the durable backlog with bounded retry backoff", async () => {
    const clock = { now: "2026-07-16T00:00:00.000Z" };
    const repository = createD1TrackingRepository({
      db: env.VWIKI_RACE_DB,
      now: () => new Date(clock.now),
      randomId: (() => { let value = 0; return () => `backoff-${++value}`; })(),
    });
    await repository.ensureDailyChallengeJob("2026-07-14");
    const first = await repository.claimDueDailyChallengeJob();
    await repository.failDailyChallengeJob(first!, "daily_candidate_unavailable");
    await expect(env.VWIKI_RACE_DB.prepare(
      "SELECT status, next_attempt_at FROM daily_challenge_jobs WHERE daily_date = '2026-07-14'",
    ).first()).resolves.toEqual({
      status: "pending",
      next_attempt_at: "2026-07-16T01:00:00.000Z",
    });

    clock.now = "2026-07-16T01:00:00.000Z";
    const second = await repository.claimDueDailyChallengeJob();
    await repository.failDailyChallengeJob(second!, "daily_candidate_timeout");
    await expect(env.VWIKI_RACE_DB.prepare(
      "SELECT next_attempt_at FROM daily_challenge_jobs WHERE daily_date = '2026-07-14'",
    ).first()).resolves.toEqual({ next_attempt_at: "2026-07-16T03:00:00.000Z" });
  });

  it("creates the Central scheduled-date job and lets only the lease winner fetch Wikipedia", async () => {
    const repository = createD1TrackingRepository({ db: env.VWIKI_RACE_DB });
    const findCandidate = vi.fn(async () => ({
      startTitle: "Start",
      startPageId: 201,
      targetTitle: "Target",
      targetPageId: 202,
    }));
    const worker = (createWorker as unknown as (options: {
      createTracking: () => WorkerTracking;
      createDailyCandidateSource: () => { findCandidate(): Promise<{
        startTitle: string; startPageId: number; targetTitle: string; targetPageId: number;
      }> };
    }) => { scheduled: (controller: { scheduledTime: number }, env: unknown) => Promise<void> })({
      createTracking: () => ({ handlers: {}, identity: {}, runProtocol: repository, authorize: async () => {
        throw new Error("not used");
      } } as unknown as WorkerTracking),
      createDailyCandidateSource: () => ({ findCandidate }),
    });

    await Promise.all([
      worker.scheduled(createScheduledController({
        scheduledTime: new Date("2026-07-15T10:00:00.000Z"),
        cron: "0 10 * * *",
      }), env),
      worker.scheduled(createScheduledController({
        scheduledTime: new Date("2026-07-15T10:00:00.000Z"),
        cron: "0 10 * * *",
      }), env),
    ]);

    expect(findCandidate).toHaveBeenCalledTimes(1);
    await expect(env.VWIKI_RACE_DB.prepare(
      "SELECT id, daily_date FROM challenges WHERE daily_date = '2026-07-15'",
    ).first()).resolves.toEqual({ id: "challenge-0004", daily_date: "2026-07-15" });
  });

  it("uses the hourly retry trigger only to claim an existing due job", async () => {
    const clock = { now: "2026-07-15T10:00:00.000Z" };
    const repository = createD1TrackingRepository({
      db: env.VWIKI_RACE_DB,
      now: () => new Date(clock.now),
      randomId: (() => { let index = 0; return () => `retry-${++index}`; })(),
    });
    await repository.ensureDailyChallengeJob("2026-07-15");
    const first = await repository.claimDueDailyChallengeJob();
    await repository.failDailyChallengeJob(first!, "daily_candidate_unavailable");
    clock.now = "2026-07-15T11:17:00.000Z";
    const findCandidate = vi.fn(async () => ({
      startTitle: "Retry start",
      startPageId: 501,
      targetTitle: "Retry target",
      targetPageId: 502,
    }));
    const worker = createWorker({
      createTracking: () => ({
        handlers: {},
        identity: {},
        runProtocol: repository,
        authorize: async () => { throw new Error("not used"); },
      } as unknown as WorkerTracking),
      createDailyCandidateSource: () => ({ findCandidate }),
      now: () => new Date(clock.now),
    });

    await worker.scheduled(createScheduledController({
      scheduledTime: new Date(clock.now),
      cron: "17 * * * *",
    }), env as unknown as WorkerEnv);

    expect(findCandidate).toHaveBeenCalledTimes(1);
    await expect(env.VWIKI_RACE_DB.prepare(
      "SELECT daily_date FROM challenges WHERE start_title = 'Retry start'",
    ).first()).resolves.toEqual({ daily_date: "2026-07-15" });
    await expect(env.VWIKI_RACE_DB.prepare(
      "SELECT count(*) count FROM daily_challenge_jobs",
    ).first()).resolves.toEqual({ count: 1 });
  });

  it("does not contact Wikipedia when the hourly retry trigger has no due job", async () => {
    const findCandidate = vi.fn();
    const repository = createD1TrackingRepository({ db: env.VWIKI_RACE_DB });
    const worker = createWorker({
      createTracking: () => ({
        handlers: {},
        identity: {},
        runProtocol: repository,
        authorize: async () => { throw new Error("not used"); },
      } as unknown as WorkerTracking),
      createDailyCandidateSource: () => ({ findCandidate }),
      now: () => new Date("2026-07-15T11:17:00.000Z"),
    });

    await worker.scheduled(createScheduledController({
      scheduledTime: new Date("2026-07-15T11:17:00.000Z"),
      cron: "17 * * * *",
    }), env as unknown as WorkerEnv);

    expect(findCandidate).not.toHaveBeenCalled();
  });

  it("leases one oldest due job, reclaims an expired lease, and accepts the next global number", async () => {
    const clock = { now: "2026-07-15T01:00:00.000Z" };
    const repository = createD1TrackingRepository({
      db: env.VWIKI_RACE_DB,
      now: () => new Date(clock.now),
      randomId: (() => {
        let index = 0;
        return () => `lease-${++index}`;
      })(),
    });

    await repository.ensureDailyChallengeJob("2026-07-14");
    const first = await repository.claimDueDailyChallengeJob();
    expect(first).toMatchObject({ dailyDate: "2026-07-14", leaseToken: "lease-1" });
    await expect(repository.claimDueDailyChallengeJob()).resolves.toBeNull();

    clock.now = "2026-07-15T01:10:01.000Z";
    const reclaimed = await repository.claimDueDailyChallengeJob();
    expect(reclaimed).toMatchObject({ dailyDate: "2026-07-14", leaseToken: "lease-3", attemptCount: 2 });
    const challenge = await repository.acceptDailyChallenge(reclaimed!, {
      startTitle: "Start",
      startPageId: 10,
      targetTitle: "Target",
      targetPageId: 20,
    });
    expect(challenge).toMatchObject({
      id: "challenge-0004",
      label: "Challenge #4",
      mode: "daily",
      origin: "daily",
      dailyDate: "2026-07-14",
      source: "wikipedia_random",
    });
    await expect(env.VWIKI_RACE_DB.prepare(
      "SELECT status, accepted_challenge_id FROM daily_challenge_jobs WHERE daily_date = '2026-07-14'",
    ).first()).resolves.toEqual({ status: "accepted", accepted_challenge_id: "challenge-0004" });
  });

  it("ignores a trigger dated more than five minutes in the future", async () => {
    const createTracking = vi.fn();
    const worker = createWorker({
      createTracking,
      now: () => new Date("2026-07-15T22:00:00.000Z"),
    });

    await worker.scheduled(createScheduledController({
      scheduledTime: new Date("2026-07-16T10:00:00.000Z"),
      cron: "0 10 * * *",
    }), env as unknown as WorkerEnv);

    expect(createTracking).not.toHaveBeenCalled();
  });
});
