import { describe, expect, it } from "vitest";
import { ApiError } from "./http";
import {
  createD1TrackingRepository,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
} from "./d1TrackingRepository";

class MemoryD1 implements D1DatabaseLike {
  readonly challenges = [
    {
      id: "challenge-0001",
      label: "Challenge #1",
      start_title: "Moon",
      target_title: "Gravity",
      ruleset: "ranked_classic",
      sort_order: 1,
      is_active: 1,
      created_at: "2026-07-14T00:00:00.000Z",
      created_by_account_id: "acc-vijay",
      created_by_display_name: "theonenonlyvj",
      created_by_identity_status: "claimed",
    },
  ];
  readonly accountProfiles = new Map<
    string,
    {
      account_id: string;
      public_name: string;
      identity_status: string;
      updated_at: string;
    }
  >();
  readonly runs = new Map<string, Record<string, unknown>>();
  readonly runEvents: Record<string, unknown>[] = [];
  readonly pathSteps: Record<string, unknown>[] = [];

  prepare(sql: string): D1PreparedStatementLike {
    return new MemoryStatement(this, sql);
  }
}

class MemoryStatement implements D1PreparedStatementLike {
  private values: unknown[] = [];

  constructor(
    private readonly db: MemoryD1,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]): D1PreparedStatementLike {
    this.values = values;
    return this;
  }

  async all<T = unknown>(): Promise<{ results: T[] }> {
    return { results: this.queryRows() as T[] };
  }

  async first<T = unknown>(): Promise<T | null> {
    return (this.queryRows()[0] as T | undefined) ?? null;
  }

  async run(): Promise<void> {
    const sql = this.sql.toLowerCase();

    if (sql.startsWith("insert into account_profiles")) {
      const [accountId, publicName, identityStatus, updatedAt] = this.values;
      this.db.accountProfiles.set(String(accountId), {
        account_id: String(accountId),
        public_name: String(publicName),
        identity_status: String(identityStatus),
        updated_at: String(updatedAt),
      });
      return;
    }

    if (sql.startsWith("insert into challenges")) {
      const [
        id,
        label,
        startTitle,
        targetTitle,
        ruleset,
        sortOrder,
        isActive,
        createdAt,
        creatorAccountId,
        creatorDisplayName,
        creatorIdentityStatus,
      ] = this.values;
      this.db.challenges.push({
        id: String(id),
        label: String(label),
        start_title: String(startTitle),
        target_title: String(targetTitle),
        ruleset: String(ruleset),
        sort_order: Number(sortOrder),
        is_active: Number(isActive),
        created_at: String(createdAt),
        created_by_account_id: String(creatorAccountId),
        created_by_display_name: String(creatorDisplayName),
        created_by_identity_status: String(creatorIdentityStatus),
      });
      return;
    }

    if (sql.startsWith("insert into runs")) {
      const [
        id,
        challengeId,
        accountId,
        status,
        startedAt,
        clickCount,
        startTitle,
        targetTitle,
        createdAt,
        updatedAt,
      ] = this.values;
      this.db.runs.set(String(id), {
        id,
        challenge_id: challengeId,
        account_id: accountId,
        status,
        started_at: startedAt,
        completed_at: null,
        abandoned_at: null,
        elapsed_ms: null,
        click_count: clickCount,
        start_title: startTitle,
        target_title: targetTitle,
        final_title: null,
        created_at: createdAt,
        updated_at: updatedAt,
      });
      return;
    }

    if (sql.startsWith("insert into run_events")) {
      const [
        id,
        runId,
        eventType,
        stepNumber,
        sourceTitle,
        clickedAnchorText,
        requestedTitle,
        destinationTitle,
        destinationPageId,
        clientTimestampMs,
        createdAt,
      ] = this.values;
      this.db.runEvents.push({
        id,
        run_id: runId,
        event_type: eventType,
        step_number: stepNumber,
        source_title: sourceTitle,
        clicked_anchor_text: clickedAnchorText,
        requested_title: requestedTitle,
        destination_title: destinationTitle,
        destination_page_id: destinationPageId,
        client_timestamp_ms: clientTimestampMs,
        created_at: createdAt,
      });
      return;
    }

    if (sql.startsWith("insert into run_path_steps")) {
      const [
        runId,
        stepNumber,
        sourceTitle,
        clickedAnchorText,
        destinationTitle,
        destinationPageId,
        elapsedSinceStartMs,
        createdAt,
      ] = this.values;
      this.db.pathSteps.push({
        run_id: runId,
        step_number: stepNumber,
        source_title: sourceTitle,
        clicked_anchor_text: clickedAnchorText,
        destination_title: destinationTitle,
        destination_page_id: destinationPageId,
        elapsed_since_start_ms: elapsedSinceStartMs,
        created_at: createdAt,
      });
      return;
    }

    if (sql.startsWith("update runs set click_count")) {
      const [clickCount, updatedAt, runId] = this.values;
      Object.assign(this.requireRun(String(runId)), {
        click_count: clickCount,
        updated_at: updatedAt,
      });
      return;
    }

    if (sql.startsWith("update runs set status = 'completed'")) {
      const [completedAt, elapsedMs, finalTitle, updatedAt, runId] = this.values;
      Object.assign(this.requireRun(String(runId)), {
        status: "completed",
        completed_at: completedAt,
        elapsed_ms: elapsedMs,
        final_title: finalTitle,
        updated_at: updatedAt,
      });
      return;
    }

    if (sql.startsWith("update runs set status = 'abandoned'")) {
      const [abandonedAt, updatedAt, runId] = this.values;
      Object.assign(this.requireRun(String(runId)), {
        status: "abandoned",
        abandoned_at: abandonedAt,
        updated_at: updatedAt,
      });
      return;
    }

    throw new Error(`Unhandled run SQL: ${this.sql}`);
  }

  private queryRows(): Record<string, unknown>[] {
    const sql = this.sql.toLowerCase();

    if (sql.includes("from challenges") && sql.includes("where is_active")) {
      return this.db.challenges
        .filter((row) => row.is_active === 1)
        .sort((a, b) => a.sort_order - b.sort_order);
    }

    if (sql.includes("from challenges") && sql.includes("order by sort_order desc")) {
      return this.db.challenges
        .slice()
        .sort((a, b) => b.sort_order - a.sort_order)
        .slice(0, 1);
    }

    if (sql.includes("from challenges") && sql.includes("where id = ?")) {
      const [id] = this.values;
      return this.db.challenges.filter((row) => row.id === id);
    }

    if (sql.includes("from runs") && sql.includes("where id = ?")) {
      const [id] = this.values;
      const run = this.db.runs.get(String(id));
      return run ? [run] : [];
    }

    if (sql.includes("from runs") && sql.includes("left join account_profiles")) {
      const [challengeId] = this.values;
      return [...this.db.runs.values()]
        .filter(
          (run) =>
            run.challenge_id === challengeId && run.status === "completed",
        )
        .map((run) => ({
          ...run,
          display_name:
            this.db.accountProfiles.get(String(run.account_id))?.public_name ??
            "Unknown",
        }));
    }

    if (sql.includes("from run_path_steps")) {
      const [runId] = this.values;
      return this.db.pathSteps
        .filter((row) => row.run_id === runId)
        .sort(
          (a, b) => Number(a.step_number) - Number(b.step_number),
        );
    }

    throw new Error(`Unhandled query SQL: ${this.sql}`);
  }

  private requireRun(runId: string): Record<string, unknown> {
    const run = this.db.runs.get(runId);
    if (!run) {
      throw new Error(`Missing run ${runId}`);
    }
    return run;
  }
}

describe("D1 tracking repository", () => {
  it("exposes the protocol-2 atomic run methods", () => {
    const repository = createD1TrackingRepository({ db: new MemoryD1() });

    expect(repository).toMatchObject({
      startRunV2: expect.any(Function),
      recordClickV2: expect.any(Function),
      abandonRunV2: expect.any(Function),
      findActiveRun: expect.any(Function),
    });
  });

  it("lists seeded challenges and assigns the next challenge number", async () => {
    const db = new MemoryD1();
    const repository = createD1TrackingRepository({
      db,
      now: () => new Date("2026-07-14T01:00:00.000Z"),
      randomId: () => "challenge-random-id",
    });

    await expect(repository.listChallenges()).resolves.toMatchObject([
      {
        id: "challenge-0001",
        label: "Challenge #1",
        start: { title: "Moon" },
        target: { title: "Gravity" },
      },
    ]);

    await expect(
      repository.createChallenge({
        startTitle: "Mars",
        targetTitle: "Water",
        creatorAccountId: "acc-1",
        creatorDisplayName: "Vijay",
        creatorIdentityStatus: "claimed",
      }),
    ).resolves.toMatchObject({
      id: "challenge-0002",
      label: "Challenge #2",
      start: { title: "Mars" },
      target: { title: "Water" },
      createdBy: {
        accountId: "acc-1",
        displayName: "Vijay",
        identityStatus: "claimed",
      },
    });
  });

  it("starts account-keyed runs and records owned clicks", async () => {
    const db = new MemoryD1();
    const repository = createD1TrackingRepository({
      db,
      now: () => new Date("2026-07-14T01:00:00.000Z"),
      randomId: () => "run-1",
    });

    const run = await repository.startRun({
      challengeId: "challenge-0001",
      accountId: "acc-1",
      publicName: "Guest Vijay",
      identityStatus: "ghost",
    });

    expect(run).toMatchObject({
      id: "run-1",
      accountId: "acc-1",
      startTitle: "Moon",
      targetTitle: "Gravity",
      clickCount: 0,
    });
    expect(db.accountProfiles.get("acc-1")).toMatchObject({
      public_name: "Guest Vijay",
      identity_status: "ghost",
    });

    await expect(
      repository.recordClick("run-1", "acc-1", {
        sourceTitle: "Moon",
        clickedAnchorText: "gravity",
        requestedTitle: "Gravity",
        destinationTitle: "Gravity",
        destinationPageId: 123,
        clientTimestampMs: 1784000000000,
      }),
    ).resolves.toEqual({ clickCount: 1 });
    expect(db.pathSteps).toHaveLength(1);
  });

  it("rejects run mutations from a different account", async () => {
    const repository = createD1TrackingRepository({
      db: new MemoryD1(),
      now: () => new Date("2026-07-14T01:00:00.000Z"),
      randomId: () => "run-1",
    });

    await repository.startRun({
      challengeId: "challenge-0001",
      accountId: "acc-owner",
      publicName: "Owner",
      identityStatus: "ghost",
    });

    await expect(
      repository.recordClick("run-1", "acc-other", {
        sourceTitle: "Moon",
        clickedAnchorText: "gravity",
        requestedTitle: "Gravity",
        destinationTitle: "Gravity",
      }),
    ).rejects.toMatchObject({
      code: "run_forbidden",
      status: 403,
    });
  });

  it("uses the latest account profile name for leaderboard rows", async () => {
    let currentTime = "2026-07-14T01:00:00.000Z";
    let nextId = 0;
    const db = new MemoryD1();
    const repository = createD1TrackingRepository({
      db,
      now: () => new Date(currentTime),
      randomId: () => (nextId += 1) === 1 ? "run-1" : `event-${nextId}`,
    });

    await repository.startRun({
      challengeId: "challenge-0001",
      accountId: "acc-1",
      publicName: "Guest Vijay",
      identityStatus: "ghost",
    });
    currentTime = "2026-07-14T01:00:01.500Z";
    await repository.recordClick("run-1", "acc-1", {
      sourceTitle: "Moon",
      clickedAnchorText: "gravity",
      requestedTitle: "Gravity",
      destinationTitle: "Gravity",
    });
    await repository.completeRun("run-1", "acc-1", {
      finalTitle: "Gravity",
      clientTimestampMs: 1784000001500,
    });

    await repository.upsertAccountProfile({
      accountId: "acc-1",
      publicName: "vijay",
      identityStatus: "claimed",
    });

    await expect(repository.listLeaderboard("challenge-0001")).resolves.toEqual([
      expect.objectContaining({
        rank: 1,
        runId: "run-1",
        accountId: "acc-1",
        displayName: "vijay",
        elapsedMs: 1500,
        clickCount: 1,
      }),
    ]);
  });
});
