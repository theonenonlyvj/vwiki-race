import { env } from "cloudflare:workers";
import { applyD1Migrations, createScheduledController } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthorizedAccount } from "../domain/types";
import { createD1TrackingRepository } from "./d1TrackingRepository";
import { ApiError } from "./http";
import {
  centralDailyDateAtFive,
  createWorker,
  type Env as WorkerEnv,
  type WorkerTracking,
} from "./worker";

beforeEach(async () => {
  await env.VWIKI_RACE_DB.exec(`
    DELETE FROM daily_challenge_jobs;
    DELETE FROM daily_features;
    DELETE FROM daily_queue_entries;
    DELETE FROM daily_nominations;
    DELETE FROM operation_idempotency;
    DELETE FROM challenges WHERE id NOT IN ('challenge-0001', 'challenge-0002', 'challenge-0003');
    UPDATE challenge_number_sequence SET next_sort_order = 4 WHERE sequence_name = 'global';
  `);
});

describe("daily challenge D1 jobs", () => {
  it("skips scheduled work while maintenance mode is active", async () => {
    const createTracking = vi.fn();
    const worker = createWorker({ createTracking });

    await worker.scheduled(createScheduledController({
      scheduledTime: new Date("2026-07-17T23:17:00.000Z"),
      cron: "17 * * * *",
    }), {
      ...(env as unknown as WorkerEnv),
      MAINTENANCE_MODE: "true",
    });

    expect(createTracking).not.toHaveBeenCalled();
  });

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
      disposition: "created",
      nomination: "not_requested",
      challenge: {
        mode: "solo",
        origin: "manual",
        dailyDate: null,
        source: "curated",
      },
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

    expect([legacy.id, v2.challenge.id, daily.id]).toEqual([
      "challenge-0004", "challenge-0005", "challenge-0006",
    ]);
    expect(daily.label).toBe("Challenge #6");
  });

  it("keeps late UTC dates in the durable backlog with bounded, 60-minute-capped retry backoff", async () => {
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
      next_attempt_at: "2026-07-16T00:15:00.000Z",
    });

    clock.now = "2026-07-16T00:15:00.000Z";
    const second = await repository.claimDueDailyChallengeJob();
    await repository.failDailyChallengeJob(second!, "daily_candidate_timeout");
    await expect(env.VWIKI_RACE_DB.prepare(
      "SELECT next_attempt_at FROM daily_challenge_jobs WHERE daily_date = '2026-07-14'",
    ).first()).resolves.toEqual({ next_attempt_at: "2026-07-16T00:45:00.000Z" });

    clock.now = "2026-07-16T00:45:00.000Z";
    const third = await repository.claimDueDailyChallengeJob();
    await repository.failDailyChallengeJob(third!, "daily_candidate_unavailable");
    await expect(env.VWIKI_RACE_DB.prepare(
      "SELECT next_attempt_at FROM daily_challenge_jobs WHERE daily_date = '2026-07-14'",
    ).first()).resolves.toEqual({ next_attempt_at: "2026-07-16T01:30:00.000Z" });

    // 2026-07-18 incident: by the 4th consecutive failure, the old [1,2,4,6]
    // hour ladder had already grown to 6 hours and jumped past the next
    // day's 5:00 AM Central drop. Every subsequent attempt must now stay
    // capped at 60 minutes so the hourly retry trigger always sees this job
    // due again within the hour, no matter how many times it has failed.
    clock.now = "2026-07-16T01:30:00.000Z";
    const fourth = await repository.claimDueDailyChallengeJob();
    await repository.failDailyChallengeJob(fourth!, "daily_candidate_unavailable");
    await expect(env.VWIKI_RACE_DB.prepare(
      "SELECT next_attempt_at FROM daily_challenge_jobs WHERE daily_date = '2026-07-14'",
    ).first()).resolves.toEqual({ next_attempt_at: "2026-07-16T02:30:00.000Z" });

    clock.now = "2026-07-16T02:30:00.000Z";
    const fifth = await repository.claimDueDailyChallengeJob();
    await repository.failDailyChallengeJob(fifth!, "daily_candidate_unavailable");
    await expect(env.VWIKI_RACE_DB.prepare(
      "SELECT next_attempt_at FROM daily_challenge_jobs WHERE daily_date = '2026-07-14'",
    ).first()).resolves.toEqual({ next_attempt_at: "2026-07-16T03:30:00.000Z" });
  });

  it("creates the Central scheduled-date job and lets only the lease winner fetch Wikipedia", async () => {
    const repository = createD1TrackingRepository({ db: env.VWIKI_RACE_DB });
    const findCandidate = vi.fn(async () => ({
      startTitle: "Start",
      startPageId: 201,
      startAllowedLinkCount: 8,
      targetTitle: "Target",
      targetPageId: 202,
      selectedScore: 79,
    }));
    const worker = (createWorker as unknown as (options: {
      createTracking: () => WorkerTracking;
      createDailyCandidateSource: () => { findCandidate(request: { dailyDate: string; flavor: string }): Promise<{
        startTitle: string; startPageId: number; targetTitle: string; targetPageId: number;
        selectedScore: number;
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

    expect(findCandidate).toHaveBeenCalledWith({ dailyDate: "2026-07-15", flavor: "recognizable" });
    await expect(env.VWIKI_RACE_DB.prepare(
      "SELECT id, daily_date FROM challenges WHERE daily_date = '2026-07-15'",
    ).first()).resolves.toEqual({ id: "challenge-0004", daily_date: "2026-07-15" });
  });

  it("derives the weird flavor from a Thursday Central scheduled date", async () => {
    const timestamp = "2026-07-16T10:00:00.000Z";
    const repository = createD1TrackingRepository({
      db: env.VWIKI_RACE_DB,
      now: () => new Date(timestamp),
    });
    const findCandidate = vi.fn(async () => ({
      startTitle: "Start",
      startPageId: 201,
      startAllowedLinkCount: 8,
      targetTitle: "Target",
      targetPageId: 202,
      selectedScore: 74,
    }));
    const worker = createWorker({
      createTracking: () => ({
        handlers: {},
        identity: {},
        runProtocol: repository,
        authorize: async () => { throw new Error("not used"); },
      } as unknown as WorkerTracking),
      createDailyCandidateSource: () => ({ findCandidate }),
      now: () => new Date(timestamp),
    });

    await worker.scheduled(createScheduledController({
      scheduledTime: new Date(timestamp),
      cron: "0 10 * * *",
    }), env as unknown as WorkerEnv);

    expect(findCandidate).toHaveBeenCalledWith({ dailyDate: "2026-07-16", flavor: "weird" });
  });

  it("uses the hourly retry trigger only to claim an existing due job", async () => {
    const clock = { now: "2026-07-15T10:00:00.000Z" };
    const repository = createD1TrackingRepository({
      db: env.VWIKI_RACE_DB,
      now: () => new Date(clock.now),
      randomId: (() => { let index = 0; return () => `retry-${++index}`; })(),
    });
    await repository.ensureDailyChallengeJob("2026-07-11");
    const first = await repository.claimDueDailyChallengeJob();
    await repository.failDailyChallengeJob(first!, "daily_candidate_unavailable");
    clock.now = "2026-07-15T11:17:00.000Z";
    const findCandidate = vi.fn(async () => ({
      startTitle: "Retry start",
      startPageId: 501,
      startAllowedLinkCount: 8,
      targetTitle: "Retry target",
      targetPageId: 502,
      selectedScore: 68,
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

    expect(findCandidate).toHaveBeenCalledWith({ dailyDate: "2026-07-11", flavor: "hard" });
    await expect(env.VWIKI_RACE_DB.prepare(
      "SELECT daily_date FROM challenges WHERE start_title = 'Retry start'",
    ).first()).resolves.toEqual({ daily_date: "2026-07-11" });
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

  it("features a queued old challenge atomically without consuming a challenge number", async () => {
    const clock = { now: "2026-07-16T10:00:00.000Z" };
    const repository = createD1TrackingRepository({
      db: env.VWIKI_RACE_DB,
      now: () => new Date(clock.now),
      randomId: (() => {
        let index = 0;
        return () => `queued-feature-${++index}`;
      })(),
    });
    await env.VWIKI_RACE_DB.prepare(
      `INSERT INTO challenges
         (id, label, start_title, target_title, start_page_id, target_page_id,
          validation_status, ruleset, sort_order, is_active, created_at,
          origin, source)
       VALUES ('old-queued-challenge', 'Old queued challenge', 'Old start', 'Old target',
               7001, 7002, 'ready', 'ranked_classic', 40, 1, ?, 'manual', 'curated')`,
    ).bind(clock.now).run();

    const queued = await repository.queueDailyChallenge({
      challengeId: "old-queued-challenge",
      flavor: "weird",
      actorAccountId: "admin-account",
      idempotencyKey: "queue-old-challenge",
    });
    await repository.ensureDailyChallengeJob("2026-07-16");
    const job = await repository.claimDueDailyChallengeJob();
    const featured = await repository.acceptDailyFeature(job!, {
      kind: "queued",
      queueEntryId: queued.id,
      classifierVersion: "editorial-v1",
    });

    expect(featured).toMatchObject({
      id: "old-queued-challenge",
      origin: "daily",
      dailyDate: "2026-07-16",
      source: "curated",
      dailyFeature: {
        dailyDate: "2026-07-16",
        flavor: "weird",
        selectionSource: "admin",
      },
    });
    await expect(env.VWIKI_RACE_DB.prepare(
      "SELECT next_sort_order FROM challenge_number_sequence WHERE sequence_name = 'global'",
    ).first()).resolves.toEqual({ next_sort_order: 4 });
    await expect(env.VWIKI_RACE_DB.prepare(
      "SELECT status, consumed_daily_date FROM daily_queue_entries WHERE id = ?",
    ).bind(queued.id).first()).resolves.toEqual({
      status: "consumed",
      consumed_daily_date: "2026-07-16",
    });
    await expect(env.VWIKI_RACE_DB.prepare(
      "SELECT status, accepted_challenge_id FROM daily_challenge_jobs WHERE daily_date = '2026-07-16'",
    ).first()).resolves.toEqual({
      status: "accepted",
      accepted_challenge_id: "old-queued-challenge",
    });
  });

  it("consumes a matching queued candidate before constructing the editorial source", async () => {
    const timestamp = "2026-07-16T10:00:00.000Z";
    const repository = createD1TrackingRepository({
      db: env.VWIKI_RACE_DB,
      now: () => new Date(timestamp),
    });
    await env.VWIKI_RACE_DB.prepare(
      `INSERT INTO challenges
         (id, label, start_title, target_title, start_page_id, target_page_id,
          validation_status, ruleset, sort_order, is_active, created_at,
          origin, source)
       VALUES ('queue-first-challenge', 'Queue first', 'Queued start', 'Queued target',
               7101, 7102, 'ready', 'ranked_classic', 40, 1, ?, 'manual', 'curated')`,
    ).bind(timestamp).run();
    await repository.queueDailyChallenge({
      challengeId: "queue-first-challenge",
      flavor: "weird",
      actorAccountId: "admin-account",
      idempotencyKey: "queue-first",
    });
    const findCandidate = vi.fn();
    const createDailyCandidateSource = vi.fn(() => ({ findCandidate }));
    const worker = createWorker({
      createTracking: () => ({
        handlers: {},
        identity: {},
        runProtocol: repository,
        authorize: async () => { throw new Error("not used"); },
      } as unknown as WorkerTracking),
      createDailyCandidateSource,
      now: () => new Date(timestamp),
    });

    await worker.scheduled(createScheduledController({
      scheduledTime: new Date(timestamp),
      cron: "0 10 * * *",
    }), env as unknown as WorkerEnv);

    expect(createDailyCandidateSource).not.toHaveBeenCalled();
    expect(findCandidate).not.toHaveBeenCalled();
    await expect(env.VWIKI_RACE_DB.prepare(
      "SELECT challenge_id, selection_source FROM daily_features WHERE daily_date = '2026-07-16'",
    ).first()).resolves.toEqual({
      challenge_id: "queue-first-challenge",
      selection_source: "admin",
    });
  });

  it("invalidates an unusable queued candidate and falls back to automatic selection", async () => {
    const timestamp = "2026-07-16T10:00:00.000Z";
    const repository = createD1TrackingRepository({
      db: env.VWIKI_RACE_DB,
      now: () => new Date(timestamp),
    });
    await env.VWIKI_RACE_DB.prepare(
      `INSERT INTO challenges
         (id, label, start_title, target_title, start_page_id, target_page_id,
          validation_status, ruleset, sort_order, is_active, created_at,
          origin, source)
       VALUES ('invalid-queue-challenge', 'Invalid queue', 'Queued start', 'Queued target',
               7201, 7202, 'ready', 'ranked_classic', 40, 1, ?, 'manual', 'curated')`,
    ).bind(timestamp).run();
    const queued = await repository.queueDailyChallenge({
      challengeId: "invalid-queue-challenge",
      flavor: "weird",
      actorAccountId: "admin-account",
      idempotencyKey: "invalid-queue",
    });
    await env.VWIKI_RACE_DB.prepare(
      "UPDATE challenges SET is_active = 0 WHERE id = 'invalid-queue-challenge'",
    ).run();
    const findCandidate = vi.fn(async () => ({
      startTitle: "Automatic start",
      startPageId: 7203,
      startAllowedLinkCount: 8,
      targetTitle: "Automatic target",
      targetPageId: 7204,
      selectedScore: 79,
    }));
    const worker = createWorker({
      createTracking: () => ({
        handlers: {},
        identity: {},
        runProtocol: repository,
        authorize: async () => { throw new Error("not used"); },
      } as unknown as WorkerTracking),
      createDailyCandidateSource: () => ({ findCandidate }),
      now: () => new Date(timestamp),
    });

    await worker.scheduled(createScheduledController({
      scheduledTime: new Date(timestamp),
      cron: "0 10 * * *",
    }), env as unknown as WorkerEnv);

    expect(findCandidate).toHaveBeenCalledWith({ dailyDate: "2026-07-16", flavor: "weird" });
    await expect(env.VWIKI_RACE_DB.prepare(
      "SELECT status FROM daily_queue_entries WHERE id = ?",
    ).bind(queued.id).first()).resolves.toEqual({ status: "invalid" });
    await expect(env.VWIKI_RACE_DB.prepare(
      "SELECT selection_source, selected_score FROM daily_features WHERE daily_date = '2026-07-16'",
    ).first()).resolves.toEqual({ selection_source: "automatic", selected_score: 79 });
  });

  it("accepts automatic editorial candidates through the daily feature contract", async () => {
    const job = {
      dailyDate: "2026-07-15",
      attemptCount: 1,
      leaseToken: "automatic-feature-lease",
      leaseExpiresAt: "2026-07-15T10:10:00.000Z",
    };
    const acceptDailyFeature = vi.fn(async () => ({ id: "challenge-automatic" }));
    const acceptDailyChallenge = vi.fn();
    const repository = {
      ensureDailyChallengeJob: vi.fn(async () => undefined),
      claimDueDailyChallengeJob: vi.fn(async () => job),
      failDailyChallengeJob: vi.fn(async () => undefined),
      findQueuedDailyCandidate: vi.fn(async () => null),
      acceptDailyFeature,
      acceptDailyChallenge,
    };
    const worker = createWorker({
      createTracking: () => ({
        handlers: {},
        identity: {},
        runProtocol: repository,
        authorize: async () => { throw new Error("not used"); },
      } as unknown as WorkerTracking),
      createDailyCandidateSource: () => ({
        findCandidate: vi.fn(async () => ({
          startTitle: "Automatic start",
          startPageId: 7301,
          startAllowedLinkCount: 8,
          targetTitle: "Automatic target",
          targetPageId: 7302,
          selectedScore: 79,
        })),
      }),
      now: () => new Date("2026-07-15T10:00:00.000Z"),
    });

    await worker.scheduled(createScheduledController({
      scheduledTime: new Date("2026-07-15T10:00:00.000Z"),
      cron: "0 10 * * *",
    }), env as unknown as WorkerEnv);

    expect(acceptDailyFeature).toHaveBeenCalledWith(job, {
      kind: "automatic",
      candidate: {
        startTitle: "Automatic start",
        startPageId: 7301,
        startAllowedLinkCount: 8,
        targetTitle: "Automatic target",
        targetPageId: 7302,
      },
      classifierVersion: "editorial-v1",
      selectedScore: 79,
    });
    expect(acceptDailyChallenge).not.toHaveBeenCalled();
  });

  it("reuses one editorial candidate source across scheduled attempts in the same Worker isolate", async () => {
    const jobs = [
      {
        dailyDate: "2026-07-15",
        attemptCount: 1,
        leaseToken: "shared-source-lease-1",
        leaseExpiresAt: "2026-07-15T10:10:00.000Z",
      },
      {
        dailyDate: "2026-07-16",
        attemptCount: 1,
        leaseToken: "shared-source-lease-2",
        leaseExpiresAt: "2026-07-16T10:10:00.000Z",
      },
    ];
    const findCandidate = vi.fn(async () => ({
      startTitle: "Automatic start",
      startPageId: 7301,
      startAllowedLinkCount: 8,
      targetTitle: "Automatic target",
      targetPageId: 7302,
      selectedScore: 79,
    }));
    const createDailyCandidateSource = vi.fn(() => ({ findCandidate }));
    const repository = {
      ensureDailyChallengeJob: vi.fn(async () => undefined),
      claimDueDailyChallengeJob: vi.fn()
        .mockResolvedValueOnce(jobs[0])
        .mockResolvedValueOnce(jobs[1]),
      failDailyChallengeJob: vi.fn(async () => undefined),
      findQueuedDailyCandidate: vi.fn(async () => null),
      acceptDailyFeature: vi.fn(async () => ({ id: "challenge-automatic" })),
    };
    const worker = createWorker({
      createTracking: () => ({
        handlers: {},
        identity: {},
        runProtocol: repository,
        authorize: async () => { throw new Error("not used"); },
      } as unknown as WorkerTracking),
      createDailyCandidateSource,
      now: () => new Date("2026-07-16T10:00:00.000Z"),
    });

    await worker.scheduled(createScheduledController({
      scheduledTime: new Date("2026-07-15T10:00:00.000Z"),
      cron: "0 10 * * *",
    }), env as unknown as WorkerEnv);
    await worker.scheduled(createScheduledController({
      scheduledTime: new Date("2026-07-16T10:00:00.000Z"),
      cron: "0 10 * * *",
    }), env as unknown as WorkerEnv);

    expect(createDailyCandidateSource).toHaveBeenCalledTimes(1);
    expect(findCandidate).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a lost lease", "daily_feature_lease_lost"],
    ["another accepted date selection", "daily_feature_date_conflict"],
  ])("does not retry the queue or construct the evaluator after %s", async (_reason, code) => {
    const job = {
      dailyDate: "2026-07-15",
      attemptCount: 1,
      leaseToken: "terminal-lease",
      leaseExpiresAt: "2026-07-15T10:10:00.000Z",
    };
    const findQueuedDailyCandidate = vi.fn(async () => ({ id: "queue-terminal" }));
    const acceptDailyFeature = vi.fn(async () => {
      throw new ApiError(code, "Daily feature acceptance did not complete.", 500);
    });
    const failDailyChallengeJob = vi.fn(async () => undefined);
    const createDailyCandidateSource = vi.fn(() => ({ findCandidate: vi.fn() }));
    const worker = createWorker({
      createTracking: () => ({
        handlers: {},
        identity: {},
        runProtocol: {
          ensureDailyChallengeJob: vi.fn(async () => undefined),
          claimDueDailyChallengeJob: vi.fn(async () => job),
          failDailyChallengeJob,
          findQueuedDailyCandidate,
          acceptDailyFeature,
        },
        authorize: async () => { throw new Error("not used"); },
      } as unknown as WorkerTracking),
      createDailyCandidateSource,
      now: () => new Date("2026-07-15T10:00:00.000Z"),
    });

    await expect(worker.scheduled(createScheduledController({
      scheduledTime: new Date("2026-07-15T10:00:00.000Z"),
      cron: "0 10 * * *",
    }), env as unknown as WorkerEnv)).rejects.toMatchObject({ code });

    expect(findQueuedDailyCandidate).toHaveBeenCalledTimes(1);
    expect(acceptDailyFeature).toHaveBeenCalledTimes(1);
    expect(createDailyCandidateSource).not.toHaveBeenCalled();
    expect(failDailyChallengeJob).toHaveBeenCalledWith(job, code);
  });

  it("bounds queue-selection retries before falling back to one automatic evaluation", async () => {
    const job = {
      dailyDate: "2026-07-15",
      attemptCount: 1,
      leaseToken: "queue-race-lease",
      leaseExpiresAt: "2026-07-15T10:10:00.000Z",
    };
    const findQueuedDailyCandidate = vi.fn(async () => ({ id: "queue-race" }));
    const acceptDailyFeature = vi.fn()
      .mockRejectedValueOnce(new ApiError(
        "daily_queue_selection_changed",
        "Daily feature acceptance did not complete.",
        500,
      ))
      .mockRejectedValueOnce(new ApiError(
        "daily_queue_selection_changed",
        "Daily feature acceptance did not complete.",
        500,
      ))
      .mockRejectedValueOnce(new ApiError(
        "daily_queue_selection_changed",
        "Daily feature acceptance did not complete.",
        500,
      ))
      .mockResolvedValueOnce({ id: "challenge-automatic" });
    const findCandidate = vi.fn(async () => ({
      startTitle: "Automatic start",
      startPageId: 7401,
      startAllowedLinkCount: 8,
      targetTitle: "Automatic target",
      targetPageId: 7402,
      selectedScore: 83,
    }));
    const createDailyCandidateSource = vi.fn(() => ({ findCandidate }));
    const worker = createWorker({
      createTracking: () => ({
        handlers: {},
        identity: {},
        runProtocol: {
          ensureDailyChallengeJob: vi.fn(async () => undefined),
          claimDueDailyChallengeJob: vi.fn(async () => job),
          failDailyChallengeJob: vi.fn(async () => undefined),
          findQueuedDailyCandidate,
          acceptDailyFeature,
        },
        authorize: async () => { throw new Error("not used"); },
      } as unknown as WorkerTracking),
      createDailyCandidateSource,
      now: () => new Date("2026-07-15T10:00:00.000Z"),
    });

    await worker.scheduled(createScheduledController({
      scheduledTime: new Date("2026-07-15T10:00:00.000Z"),
      cron: "0 10 * * *",
    }), env as unknown as WorkerEnv);

    expect(findQueuedDailyCandidate).toHaveBeenCalledTimes(3);
    expect(createDailyCandidateSource).toHaveBeenCalledTimes(1);
    expect(findCandidate).toHaveBeenCalledTimes(1);
    expect(acceptDailyFeature).toHaveBeenCalledTimes(4);
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
