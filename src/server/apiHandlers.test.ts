import { describe, expect, it, vi } from "vitest";
import { createApiHandlers } from "./apiHandlers";
import { ApiError } from "./http";
import type { TrackingRepository } from "./trackingRepository";
import { createWorker, type Env as WorkerEnv, type WorkerTracking } from "./worker";
import {
  fingerprintCreateChallengeRequest,
  legacyCreateOperationKey,
} from "./runProtocol";

function fakeRepository(): TrackingRepository {
  return {
    listChallenges: vi.fn(async () => []),
    createChallenge: vi.fn(async ({ startTitle, targetTitle }) => ({
      id: "challenge-0002",
      label: "Challenge #2",
      sortOrder: 2,
      isActive: true,
      mode: "daily" as const,
      start: { title: startTitle },
      target: { title: targetTitle },
      ruleset: "ranked_classic" as const,
      source: "curated" as const,
      createdBy: {
        accountId: "acc-1",
        displayName: "Vijay",
        identityStatus: "claimed" as const,
      },
    })),
    upsertAccountProfile: vi.fn(async ({ publicName }) => ({
      accountId: "acc-1",
      publicName,
      identityStatus: "claimed" as const,
    })),
    startRun: vi.fn(async () => ({
      id: "run-1",
      challengeId: "challenge-0001",
      accountId: "acc-1",
      status: "active" as const,
      startTitle: "Moon",
      targetTitle: "Gravity",
      clickCount: 0,
      startedAt: "2026-07-14T00:00:00.000Z",
    })),
    recordClick: vi.fn(async () => ({ clickCount: 1 })),
    completeRun: vi.fn(async () => ({
      runId: "run-1",
      challengeId: "challenge-0001",
      accountId: "acc-1",
      displayName: "Vijay",
      status: "completed" as const,
      isRepeatRun: false,
      startedAt: "2026-07-14T00:00:00.000Z",
      elapsedMs: 1200,
      clickCount: 1,
      completedAt: "2026-07-14T00:00:01.200Z",
      protocolVersion: 1 as const,
      pathPreview: [],
      rank: 1,
    })),
    abandonRun: vi.fn(async () => ({ status: "abandoned" as const })),
    listLeaderboard: vi.fn(async () => []),
    getRunPath: vi.fn(async () => []),
  };
}

describe("api handlers", () => {
  it("uses a stored nomination suggestion unless an administrator overrides its flavor", async () => {
    const repository = fakeRepository();
    const approveDailyNomination = vi.fn(async (input) => ({
      id: "queue-1",
      challengeId: "challenge-1",
      nominationId: input.nominationId,
      flavor: input.flavor,
      source: "community" as const,
      status: "queued" as const,
      queuedByAccountId: input.actorAccountId,
      queuedAt: "2026-07-17T00:00:00.000Z",
      consumedDailyDate: null,
      consumedAt: null,
      updatedAt: "2026-07-17T00:00:00.000Z",
    }));
    Object.assign(repository, {
      listDailyAdminState: vi.fn(async () => ({
        nominations: [{
          id: "nomination-1",
          challengeId: "challenge-1",
          nominatedByAccountId: "nominator",
          nominatedByDisplayName: "Nominator",
          status: "pending" as const,
          recognizableScore: 10,
          weirdScore: 20,
          hardScore: 30,
          suggestedFlavor: "weird" as const,
          confidence: "high" as const,
          classifierVersion: "editorial-v1",
          reviewedByAccountId: null,
          reviewedAt: null,
          createdAt: "2026-07-17T00:00:00.000Z",
          updatedAt: "2026-07-17T00:00:00.000Z",
        }],
        queueEntries: [],
      })),
      approveDailyNomination,
    });
    const handlers = createApiHandlers(repository) as unknown as {
      approveDailyNomination(
        actorAccountId: string,
        nominationId: string,
        flavor: "recognizable" | "weird" | "hard" | undefined,
        idempotencyKey: string,
      ): Promise<unknown>;
    };

    await expect(handlers.approveDailyNomination(
      "admin-account", "nomination-1", undefined, "approve-suggested",
    )).resolves.toMatchObject({ flavor: "weird" });
    await expect(handlers.approveDailyNomination(
      "admin-account", "nomination-1", "hard", "approve-override",
    )).resolves.toMatchObject({ flavor: "hard" });
    expect(approveDailyNomination).toHaveBeenNthCalledWith(1, {
      actorAccountId: "admin-account",
      nominationId: "nomination-1",
      flavor: "weird",
      idempotencyKey: "approve-suggested",
    });
    expect(approveDailyNomination).toHaveBeenNthCalledWith(2, {
      actorAccountId: "admin-account",
      nominationId: "nomination-1",
      flavor: "hard",
      idempotencyKey: "approve-override",
    });
  });

  it("rejects approval without an override or stored suggestion", async () => {
    const repository = fakeRepository();
    const approveDailyNomination = vi.fn();
    Object.assign(repository, {
      listDailyAdminState: vi.fn(async () => ({
        nominations: [{
          id: "nomination-1",
          challengeId: "challenge-1",
          nominatedByAccountId: "nominator",
          nominatedByDisplayName: "Nominator",
          status: "pending" as const,
          recognizableScore: null,
          weirdScore: null,
          hardScore: null,
          suggestedFlavor: null,
          confidence: "unclassified" as const,
          classifierVersion: "editorial-v1",
          reviewedByAccountId: null,
          reviewedAt: null,
          createdAt: "2026-07-17T00:00:00.000Z",
          updatedAt: "2026-07-17T00:00:00.000Z",
        }],
        queueEntries: [],
      })),
      approveDailyNomination,
    });
    const handlers = createApiHandlers(repository) as unknown as {
      approveDailyNomination(
        actorAccountId: string,
        nominationId: string,
        flavor: undefined,
        idempotencyKey: string,
      ): Promise<unknown>;
    };

    await expect(handlers.approveDailyNomination(
      "admin-account", "nomination-1", undefined, "approve-unsuggested",
    )).rejects.toMatchObject({
      code: "daily_nomination_flavor_required",
      status: 400,
    });
    expect(approveDailyNomination).not.toHaveBeenCalled();
  });

  it("includes daily nomination intent in replay fingerprints", async () => {
    const omitted = await fingerprintCreateChallengeRequest({
      startTitle: "Mars",
      targetTitle: "Water",
    });
    const falseIntent = await fingerprintCreateChallengeRequest({
      startTitle: "Mars",
      targetTitle: "Water",
      nominateForDaily: false,
    });
    const withNomination = await fingerprintCreateChallengeRequest({
      startTitle: "Mars",
      targetTitle: "Water",
      nominateForDaily: true,
    });

    expect(omitted).toBe("fd7a3dec3a835a7f66c7c102a6edc9072be9b275e891426aef8f22a89f6e5973");
    expect(falseIntent).toBe(omitted);
    expect(withNomination).not.toBe(omitted);
  });

  it("keeps legacy creation operation keys byte-for-byte historical", async () => {
    const omitted = await legacyCreateOperationKey("acc-1", {
      startTitle: "Mars",
      targetTitle: "Water",
    });
    const falseIntent = await legacyCreateOperationKey("acc-1", {
      startTitle: "Mars",
      targetTitle: "Water",
      nominateForDaily: false,
    });
    const trueIntent = await legacyCreateOperationKey("acc-1", {
      startTitle: "Mars",
      targetTitle: "Water",
      nominateForDaily: true,
    });

    expect(omitted).toBe("legacy-create:a8c575307ebdea6a0193bd900d768437693766523cdbfaa720160ccb60676d07");
    expect(falseIntent).toBe(omitted);
    expect(trueIntent).toBe(omitted);
  });

  it.each([
    ["claimed", "pending"],
    ["ghost", "account_required"],
  ] as const)(
    "passes nomination intent and expanded outcome for %s accounts",
    async (status, nomination) => {
      const repository = fakeRepository();
      const outcome = {
        challenge: {
          id: "challenge-0002",
          mode: "solo" as const,
          start: { title: "Mars", pageId: 123 },
          target: { title: "Water", pageId: 456 },
          ruleset: "ranked_classic" as const,
          source: "curated" as const,
        },
        disposition: "created" as const,
        nomination,
      };
      const createChallengeV2 = vi.fn(async () => outcome);
      Object.assign(repository, {
        findChallengeCreationReplay: vi.fn(async () => null),
        createChallengeV2,
      });
      const handlers = createApiHandlers(repository, {
        validateChallengeArticles: vi.fn(async () => ({
          start: { title: "Mars", pageId: 123, allowedLinkCount: 1 },
          target: { title: "Water", pageId: 456, allowedLinkCount: 1 },
        })),
      });

      await expect(handlers.createChallengeV2(
        {
          accountId: "acc-1",
          displayName: "Casey",
          status,
          aliases: [],
        },
        { startTitle: "Mars", targetTitle: "Water", nominateForDaily: true },
        "create-key",
      )).resolves.toEqual(outcome);
      expect(createChallengeV2).toHaveBeenCalledWith(
        expect.objectContaining({ status }),
        expect.objectContaining({
          idempotencyKey: "create-key",
          nominateForDaily: true,
          dailyClassification: expect.objectContaining({
            confidence: "unclassified",
            classifierVersion: "editorial-v1",
          }),
        }),
      );
    },
  );

  it("normalizes a legacy challenge-only replay into the expanded outcome", async () => {
    const repository = fakeRepository();
    const legacyChallenge = {
      id: "challenge-0002",
      mode: "solo" as const,
      start: { title: "Mars", pageId: 123 },
      target: { title: "Water", pageId: 456 },
      ruleset: "ranked_classic" as const,
      source: "curated" as const,
    };
    Object.assign(repository, {
      findChallengeCreationReplay: vi.fn(async () => legacyChallenge),
      createChallengeV2: vi.fn(),
    });
    const handlers = createApiHandlers(repository);

    await expect(handlers.createChallengeV2(
      {
        accountId: "acc-1",
        displayName: "Casey",
        status: "claimed",
        aliases: [],
      },
      { startTitle: "Mars", targetTitle: "Water" },
      "legacy-key",
    )).resolves.toEqual({
      challenge: legacyChallenge,
      disposition: "created",
      nomination: "not_requested",
    });
  });

  it("rejects a non-boolean nomination intent before replay lookup", async () => {
    const repository = fakeRepository();
    const replay = vi.fn(async () => null);
    Object.assign(repository, { findChallengeCreationReplay: replay });
    const handlers = createApiHandlers(repository);

    await expect(handlers.createChallengeV2(
      {
        accountId: "acc-1",
        displayName: "Casey",
        status: "claimed",
        aliases: [],
      },
      { startTitle: "Mars", targetTitle: "Water", nominateForDaily: "yes" as never },
      "create-key",
    )).rejects.toMatchObject({ code: "invalid_nomination_intent", status: 400 });
    expect(replay).not.toHaveBeenCalled();
  });

  it("uses an unclassified editorial-v1 input when daily classification fails", async () => {
    const repository = fakeRepository();
    const createChallengeV2 = vi.fn(async () => ({
      challenge: {
        id: "challenge-0002",
        mode: "solo" as const,
        start: { title: "Mars", pageId: 123 },
        target: { title: "Water", pageId: 456 },
        ruleset: "ranked_classic" as const,
        source: "curated" as const,
      },
      disposition: "created" as const,
      nomination: "pending" as const,
    }));
    Object.assign(repository, {
      findChallengeCreationReplay: vi.fn(async () => null),
      createChallengeV2,
    });
    const handlers = createApiHandlers(repository, {
      validateChallengeArticles: vi.fn(async () => ({
        start: { title: "Mars", pageId: 123, allowedLinkCount: 1 },
        target: { title: "Water", pageId: 456, allowedLinkCount: 1 },
      })),
      classifyDaily: vi.fn(async () => {
        throw new Error("classifier unavailable");
      }),
    });

    await handlers.createChallengeV2(
      {
        accountId: "acc-1",
        displayName: "Casey",
        status: "claimed",
        aliases: [],
      },
      { startTitle: "Mars", targetTitle: "Water", nominateForDaily: true },
      "create-key",
    );

    expect(createChallengeV2).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        dailyClassification: {
          recognizableScore: null,
          weirdScore: null,
          hardScore: null,
          suggestedFlavor: null,
          confidence: "unclassified",
          classifierVersion: "editorial-v1",
        },
      }),
    );
  });

  it("does not classify ordinary or guest challenge creation", async () => {
    const repository = fakeRepository();
    const classifyDaily = vi.fn(async () => ({
      recognizableScore: 80,
      weirdScore: 10,
      hardScore: 20,
      suggestedFlavor: "recognizable" as const,
      confidence: "high" as const,
      classifierVersion: "editorial-v1",
    }));
    Object.assign(repository, {
      findChallengeCreationReplay: vi.fn(async () => null),
      createChallengeV2: vi.fn(async () => ({
        challenge: {
          id: "challenge-0002",
          mode: "solo" as const,
          start: { title: "Mars", pageId: 123 },
          target: { title: "Water", pageId: 456 },
          ruleset: "ranked_classic" as const,
          source: "curated" as const,
        },
        disposition: "created" as const,
        nomination: "not_requested" as const,
      })),
    });
    const handlers = createApiHandlers(repository, {
      validateChallengeArticles: vi.fn(async () => ({
        start: { title: "Mars", pageId: 123, allowedLinkCount: 1 },
        target: { title: "Water", pageId: 456, allowedLinkCount: 1 },
      })),
      classifyDaily,
    });

    await handlers.createChallengeV2(
      { accountId: "claimed", displayName: "Casey", status: "claimed", aliases: [] },
      { startTitle: "Mars", targetTitle: "Water", nominateForDaily: false },
      "ordinary-create",
    );
    await handlers.createChallengeV2(
      { accountId: "guest", displayName: "Guest", status: "ghost", aliases: [] },
      { startTitle: "Mars", targetTitle: "Water", nominateForDaily: true },
      "guest-create",
    );

    expect(classifyDaily).not.toHaveBeenCalled();
  });

  it("requires a public account name before starting a run", async () => {
    const handlers = createApiHandlers(fakeRepository());

    await expect(
      handlers.startRun({
        challengeId: "challenge-0001",
        accountId: "acc-1",
        publicName: "   ",
        identityStatus: "claimed",
      }),
    ).rejects.toMatchObject({
      code: "invalid_public_name",
      status: 400,
    });
  });

  it("trims account profile names before starting a run", async () => {
    const repository = fakeRepository();
    const handlers = createApiHandlers(repository);

    await expect(
      handlers.startRun({
        challengeId: "challenge-0001",
        accountId: "acc-1",
        publicName: "  Vijay  ",
        identityStatus: "claimed",
      }),
    ).resolves.toMatchObject({ run: { id: "run-1" } });

    expect(repository.startRun).toHaveBeenCalledWith({
      challengeId: "challenge-0001",
      accountId: "acc-1",
      publicName: "Vijay",
      identityStatus: "claimed",
    });
  });

  it("creates a challenge with trimmed article titles", async () => {
    const repository = fakeRepository();
    const validateChallengeArticles = vi.fn(async () => ({
      start: { title: "Mars", pageId: 123, allowedLinkCount: 1 },
      target: { title: "Water", pageId: 456, allowedLinkCount: 1 },
    }));
    const handlers = createApiHandlers(repository, {
      validateChallengeArticles,
    });

    await expect(
      handlers.createChallenge({
        startTitle: "  Mars  ",
        targetTitle: "  Water  ",
        creatorAccountId: "acc-1",
        creatorDisplayName: "  Vijay  ",
        creatorIdentityStatus: "claimed",
      }),
    ).resolves.toEqual({
      challenge: {
        id: "challenge-0002",
        label: "Challenge #2",
        sortOrder: 2,
        isActive: true,
        mode: "daily",
        start: { title: "Mars" },
        target: { title: "Water" },
        ruleset: "ranked_classic",
        source: "curated",
        createdBy: {
          accountId: "acc-1",
          displayName: "Vijay",
          identityStatus: "claimed",
        },
      },
    });

    expect(repository.createChallenge).toHaveBeenCalledWith({
      startTitle: "Mars",
      targetTitle: "Water",
      creatorAccountId: "acc-1",
      creatorDisplayName: "Vijay",
      creatorIdentityStatus: "claimed",
    });
    expect(validateChallengeArticles).toHaveBeenCalledWith({
      startTitle: "Mars",
      targetTitle: "Water",
    });
  });

  it("requires both challenge titles", async () => {
    const handlers = createApiHandlers(fakeRepository());

    await expect(
      handlers.createChallenge({
        startTitle: "",
        targetTitle: "Gravity",
        creatorAccountId: "acc-1",
        creatorDisplayName: "Vijay",
        creatorIdentityStatus: "claimed",
      }),
    ).rejects.toMatchObject({
      code: "invalid_start_title",
      status: 400,
    });
  });

  it("rejects invalid Wikipedia article challenges before writing", async () => {
    const repository = fakeRepository();
    const validateChallengeArticles = vi.fn(async () => {
      throw Object.assign(new Error("That start article does not exist."), {
        code: "invalid_start_article",
        status: 400,
      });
    });
    const handlers = createApiHandlers(repository, {
      validateChallengeArticles,
    });

    await expect(
      handlers.createChallenge({
        startTitle: "asdfasdf",
        targetTitle: "asdfasdfa",
        creatorAccountId: "acc-1",
        creatorDisplayName: "Vijay",
        creatorIdentityStatus: "claimed",
      }),
    ).rejects.toMatchObject({
      code: "invalid_start_article",
      status: 400,
    });
    expect(repository.createChallenge).not.toHaveBeenCalled();
  });

  it("replays a committed creation before Wikipedia validation", async () => {
    const repository = fakeRepository();
    const committed = {
      id: "challenge-0002",
      label: "Challenge #2",
      sortOrder: 2,
      isActive: true,
      mode: "daily" as const,
      start: { title: "Mars", pageId: 123 },
      target: { title: "Water", pageId: 456 },
      ruleset: "ranked_classic" as const,
      source: "curated" as const,
    };
    const preflight = vi.fn(async () => committed);
    Object.assign(repository, { findChallengeCreationReplay: preflight });
    const validateChallengeArticles = vi.fn(async () => {
      throw new Error("Wikipedia is unavailable");
    });
    const handlers = createApiHandlers(repository, { validateChallengeArticles });

    await expect(handlers.createChallengeV2(
      {
        accountId: "acc-1",
        displayName: "Canonical Vijay",
        status: "claimed",
        aliases: [],
      },
      { startTitle: "Mars", targetTitle: "Water" },
      "same-key",
    )).resolves.toEqual({
      challenge: committed,
      disposition: "created",
      nomination: "not_requested",
    });
    expect(preflight).toHaveBeenCalled();
    expect(validateChallengeArticles).not.toHaveBeenCalled();
  });

  it("starts a run through the repository", async () => {
    const repository = fakeRepository();
    const handlers = createApiHandlers(repository);

    await expect(
      handlers.startRun({
        challengeId: "challenge-0001",
        accountId: "acc-1",
        publicName: "Vijay",
        identityStatus: "claimed",
      }),
    ).resolves.toMatchObject({ run: { id: "run-1" } });
  });

  it("records clicks with required titles and anchor text", async () => {
    const repository = fakeRepository();
    const handlers = createApiHandlers(repository);

    await expect(
      handlers.recordClick("run-1", "acc-1", {
        sourceTitle: "Moon",
        clickedAnchorText: "orbit",
        requestedTitle: "Orbit",
        destinationTitle: "Orbit",
        clientTimestampMs: 1784000000000,
      }),
    ).resolves.toEqual({ clickCount: 1 });

    expect(repository.recordClick).toHaveBeenCalledWith("run-1", "acc-1", {
      sourceTitle: "Moon",
      clickedAnchorText: "orbit",
      requestedTitle: "Orbit",
      destinationTitle: "Orbit",
      destinationPageId: undefined,
      clientTimestampMs: 1784000000000,
    });
  });

  it("rejects completion without a final title", async () => {
    const handlers = createApiHandlers(fakeRepository());

    await expect(
      handlers.completeRun("run-1", "acc-1", { finalTitle: "" }),
    ).rejects.toMatchObject({
      code: "invalid_final_title",
      status: 400,
    });
  });
});

describe("Worker API route versions", () => {
  it("returns a retryable response without building tracking in maintenance mode", async () => {
    const createTracking = vi.fn();
    const worker = createWorker({ createTracking });
    const maintenanceEnv = {
      ALLOWED_ORIGINS: "https://vwikirace.pages.dev",
      MAINTENANCE_MODE: "true",
    } as unknown as WorkerEnv;

    const response = await worker.fetch(new Request(
      "https://worker.example/api/v2/challenges",
      { headers: { Origin: "https://vwikirace.pages.dev" } },
    ), maintenanceEnv);

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://vwikirace.pages.dev",
    );
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "service_unavailable",
        message: "VWiki Race is briefly unavailable for maintenance.",
      },
    });
    expect(createTracking).not.toHaveBeenCalled();
  });

  it("keeps legacy routes while dispatching the complete v2 matrix", async () => {
    const tracking = fakeWorkerTracking();
    const worker = createWorker({ createTracking: () => tracking });
    const env = {
      VWIKI_RACE_DB: {} as D1Database,
      VGAMES_URL: "https://vgames.example",
      ALLOWED_ORIGINS: "https://vwikirace.pages.dev,https://preview.example",
      CLICK_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
      ACCOUNT_READ_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
      CHALLENGE_CREATE_RATE_LIMITER: { limit: async () => ({ success: true }) },
    };

    const allowedPreflight = await worker.fetch(
      new Request("https://worker.example/api/v2/challenges", {
        method: "OPTIONS",
        headers: { Origin: "https://preview.example" },
      }),
      env,
    );
    expect(allowedPreflight.status).toBe(204);
    expect(allowedPreflight.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://preview.example",
    );
    expect(allowedPreflight.headers.get("Access-Control-Allow-Headers")).toBe(
      "Authorization, Content-Type, Idempotency-Key",
    );

    const routes: Array<[string, string, unknown?]> = [
      ["GET", "/api/v2/challenges"],
      ["POST", "/api/v2/challenges", {
        startTitle: "Moon",
        targetTitle: "Gravity",
        nominateForDaily: true,
        creatorDisplayName: "browser name is ignored",
      }],
      ["POST", "/api/v2/runs/start", {
        challengeId: "challenge-0001",
        publicName: "browser name is ignored",
      }],
      ["GET", "/api/v2/runs/active"],
      ["POST", "/api/v2/runs/run-1/click", {
        clientEventId: "00000000-0000-4000-8000-000000000001",
        expectedStepNumber: 1,
        sourceTitle: "Moon",
        sourcePageId: 19331,
        sourceRevisionId: 1,
        clickedAnchorText: "gravity",
        requestedTitle: "Gravity",
        destinationTitle: "Gravity",
        destinationPageId: 38579,
        decisionElapsedMs: 1000,
      }],
      ["POST", "/api/v2/runs/run-1/abandon"],
      ["GET", "/api/v2/runs/run-1/path"],
      ["GET", "/api/v2/challenges/challenge-0001/leaderboard"],
      ["GET", "/api/v2/accounts/me/stats"],
      ["POST", "/api/v2/identity/guest", {
        deviceCredential: "credential",
        displayName: "Casey",
      }],
      ["POST", "/api/v2/identity/secure", {
        deviceCredential: "credential",
        token: "jwt-1",
        username: "casey",
        password: "secret",
      }],
      ["POST", "/api/v2/identity/login", {
        deviceCredential: "credential",
        username: "casey",
        password: "secret",
      }],
    ];

    for (const [method, path, body] of routes) {
      const response = await worker.fetch(
        new Request(`https://worker.example${path}`, {
          method,
          headers: body === undefined ? undefined : {
            "Content-Type": "application/json",
            ...(path.includes("/identity/") ? {} : { "Idempotency-Key": "test-idempotency-key" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
        env,
      );
      expect(response.status, `${method} ${path}`).not.toBe(404);
      if (method === "GET" && path.endsWith("/leaderboard")) {
        expect(response.headers.get("Cache-Control")).toBe("no-store");
      }
      if (method === "GET" && path === "/api/v2/challenges") {
        expect(response.headers.get("Cache-Control")).toBe("public, max-age=60");
      }
    }

    expect(tracking.handlers.createChallengeV2).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acc-1", displayName: "Casey" }),
      expect.objectContaining({
        startTitle: "Moon",
        targetTitle: "Gravity",
        nominateForDaily: true,
      }),
      "test-idempotency-key",
    );
    expect(tracking.runProtocol?.startRunV2).toHaveBeenCalled();

    expect(
      (await worker.fetch(new Request("https://worker.example/api/challenges"), env)).status,
    ).toBe(200);
    expect(
      (await worker.fetch(new Request("https://worker.example/not-a-route"), env)).status,
    ).toBe(404);
  });

  it("applies canonical legacy creation, eligible path, and click policies", async () => {
    const tracking = fakeWorkerTracking();
    const worker = createWorker({ createTracking: () => tracking });
    const limit = vi.fn(async () => ({ success: true }));
    const env = {
      VWIKI_RACE_DB: {} as D1Database,
      VGAMES_URL: "https://vgames.example",
      CLICK_RATE_LIMITER: { limit },
      ACCOUNT_READ_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
      CHALLENGE_CREATE_RATE_LIMITER: { limit: async () => ({ success: true }) },
    };

    const created = await worker.fetch(new Request("https://worker.example/api/challenges", {
      method: "POST",
      headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      body: JSON.stringify({
        startTitle: "Mars",
        targetTitle: "Water",
        creatorDisplayName: "Browser Impostor",
      }),
    }), env);
    expect(created.status).toBe(200);
    expect(tracking.handlers.createChallenge).not.toHaveBeenCalled();
    expect(tracking.handlers.createChallengeV2).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: "Casey", aliases: [] }),
      { startTitle: "Mars", targetTitle: "Water" },
      expect.stringMatching(/^legacy-create:/),
    );

    await worker.fetch(new Request("https://worker.example/api/runs/run-1/path"), env);
    expect(tracking.runProtocol?.getPublicRunPath).toHaveBeenCalledWith("run-1");
    expect(tracking.handlers.getRunPath).not.toHaveBeenCalled();

    await worker.fetch(new Request("https://worker.example/api/runs/run-1/click", {
      method: "POST",
      headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceTitle: "Moon",
        clickedAnchorText: "gravity",
        requestedTitle: "Gravity",
        destinationTitle: "Gravity",
      }),
    }), env);
    expect(limit).toHaveBeenCalledWith({ key: "acc-1" });
  });

  it("fails closed when required rate limit bindings are missing", async () => {
    const tracking = fakeWorkerTracking();
    const worker = createWorker({ createTracking: () => tracking });
    const env = {
      VWIKI_RACE_DB: {} as D1Database,
      VGAMES_URL: "https://vgames.example",
    } as unknown as WorkerEnv;

    const click = await worker.fetch(new Request("https://worker.example/api/v2/runs/run-1/click", {
      method: "POST",
      headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      body: JSON.stringify({
        clientEventId: "00000000-0000-4000-8000-000000000001",
        expectedStepNumber: 1,
        sourceTitle: "Moon",
        sourcePageId: 19331,
        clickedAnchorText: "gravity",
        requestedTitle: "Gravity",
        destinationTitle: "Gravity",
        destinationPageId: 38579,
        decisionElapsedMs: 1000,
      }),
    }), env);
    expect(click.status).toBe(503);
    await expect(click.json()).resolves.toMatchObject({
      error: { code: "rate_limiter_unavailable" },
    });

    const stats = await worker.fetch(
      new Request("https://worker.example/api/v2/accounts/me/stats", {
        headers: { Authorization: "Bearer test" },
      }),
      env,
    );
    expect(stats.status).toBe(503);

    const challenge = await worker.fetch(new Request(
      "https://worker.example/api/v2/challenges",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer test",
          "Content-Type": "application/json",
          "Idempotency-Key": "missing-limit",
        },
        body: JSON.stringify({ startTitle: "Moon", targetTitle: "Gravity" }),
      },
    ), env);
    expect(challenge.status).toBe(503);
    expect(tracking.handlers.createChallengeV2).not.toHaveBeenCalled();
  });

  it("returns typed limiter rejections with Retry-After on legacy and v2 routes", async () => {
    const tracking = fakeWorkerTracking();
    const worker = createWorker({ createTracking: () => tracking });
    const clickLimit = vi.fn(async () => ({ success: false }));
    const readLimit = vi.fn(async () => ({ success: false }));
    const createLimit = vi.fn(async () => ({ success: false }));
    const env = {
      VWIKI_RACE_DB: {} as D1Database,
      VGAMES_URL: "https://vgames.example",
      CLICK_RATE_LIMITER: { limit: clickLimit },
      ACCOUNT_READ_RATE_LIMITER: { limit: readLimit },
      CHALLENGE_CREATE_RATE_LIMITER: { limit: createLimit },
    };

    const clickResponse = await worker.fetch(new Request(
      "https://worker.example/api/runs/run-1/click",
      {
        method: "POST",
        headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceTitle: "Moon",
          clickedAnchorText: "gravity",
          requestedTitle: "Gravity",
          destinationTitle: "Gravity",
        }),
      },
    ), env);
    expect(clickResponse.status).toBe(429);
    expect(clickResponse.headers.get("Retry-After")).toBe("60");
    await expect(clickResponse.json()).resolves.toMatchObject({
      error: { code: "click_rate_limited" },
    });
    expect(clickLimit).toHaveBeenCalledWith({ key: "acc-1" });

    const statsResponse = await worker.fetch(new Request(
      "https://worker.example/api/v2/accounts/me/stats",
      { headers: { Authorization: "Bearer test" } },
    ), env);
    expect(statsResponse.status).toBe(429);
    expect(statsResponse.headers.get("Retry-After")).toBe("60");

    const challengeResponse = await worker.fetch(new Request(
      "https://worker.example/api/v2/challenges",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer test",
          "Content-Type": "application/json",
          "Idempotency-Key": "rate-limited-create",
        },
        body: JSON.stringify({ startTitle: "Moon", targetTitle: "Gravity" }),
      },
    ), env);
    expect(challengeResponse.status).toBe(429);
    expect(challengeResponse.headers.get("Retry-After")).toBe("60");
    await expect(challengeResponse.json()).resolves.toMatchObject({
      error: { code: "challenge_create_rate_limited" },
    });
    expect(createLimit).toHaveBeenCalledWith({ key: "acc-1" });
    expect(tracking.handlers.createChallengeV2).not.toHaveBeenCalled();
    await expect(statsResponse.json()).resolves.toMatchObject({
      error: { code: "account_read_rate_limited" },
    });
    expect(readLimit).toHaveBeenCalledWith({ key: "stats:acc-1" });

    const activeResponse = await worker.fetch(new Request(
      "https://worker.example/api/v2/runs/active",
      { headers: { Authorization: "Bearer test" } },
    ), env);
    expect(activeResponse.status).toBe(429);
    expect(readLimit).toHaveBeenCalledWith({ key: "active:acc-1" });
  });

  it("enforces exact challenge, click, anchor, and display-name limits", async () => {
    const tracking = fakeWorkerTracking();
    const worker = createWorker({ createTracking: () => tracking });
    const env = {
      VWIKI_RACE_DB: {} as D1Database,
      VGAMES_URL: "https://vgames.example",
      CLICK_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
      ACCOUNT_READ_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
      CHALLENGE_CREATE_RATE_LIMITER: { limit: async () => ({ success: true }) },
    };
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      worker.fetch(new Request(`https://worker.example${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      }), env);

    expect((await post("/api/v2/challenges", {
      startTitle: "s".repeat(2048),
      targetTitle: "Water",
    }, { Authorization: "Bearer test", "Idempotency-Key": "limit-key" })).status).toBe(200);
    expect((await post("/api/v2/challenges", {
      startTitle: "s".repeat(2049),
      targetTitle: "Water",
    }, { Authorization: "Bearer test", "Idempotency-Key": "limit-key-2" })).status).toBe(400);

    const clickBody = {
      clientEventId: "00000000-0000-4000-8000-000000000001",
      expectedStepNumber: 1,
      sourceTitle: "s".repeat(512),
      sourcePageId: 1,
      clickedAnchorText: "a".repeat(512),
      requestedTitle: "r".repeat(512),
      destinationTitle: "d".repeat(512),
      destinationPageId: 2,
      decisionElapsedMs: 1,
    };
    expect((await post("/api/v2/runs/run-1/click", clickBody, {
      Authorization: "Bearer test",
    })).status).toBe(200);
    expect((await post("/api/v2/runs/run-1/click", {
      ...clickBody,
      clickedAnchorText: "a".repeat(513),
    }, { Authorization: "Bearer test" })).status).toBe(400);

    expect((await post("/api/v2/identity/guest", {
      deviceCredential: "credential",
      displayName: "d".repeat(24),
    })).status).toBe(200);
    expect((await post("/api/v2/identity/guest", {
      deviceCredential: "credential",
      displayName: "d".repeat(25),
    })).status).toBe(400);
  });

  it.each(["/api/v2", "/api"])(
    "validates bounded identity payloads before VGames on %s routes",
    async (prefix) => {
      const tracking = fakeWorkerTracking();
      const worker = createWorker({ createTracking: () => tracking });
      const env = {
        VWIKI_RACE_DB: {} as D1Database,
        VGAMES_URL: "https://vgames.example",
        CLICK_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
        ACCOUNT_READ_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
      CHALLENGE_CREATE_RATE_LIMITER: { limit: async () => ({ success: true }) },
      };
      const post = (route: string, body: unknown) => worker.fetch(new Request(
        `https://worker.example${prefix}/identity/${route}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      ), env);
      const invalidRequests: Array<[string, unknown]> = [
        ["guest", null],
        ["guest", { deviceCredential: 7, displayName: "Casey" }],
        ["guest", { deviceCredential: "d".repeat(513), displayName: "Casey" }],
        ["guest", { deviceCredential: "device", displayName: "d".repeat(25) }],
        ["secure", {
          deviceCredential: "device", token: null, username: "casey", password: "secret",
        }],
        ["secure", {
          deviceCredential: "device", token: "t".repeat(8193), username: "casey", password: "secret",
        }],
        ["secure", {
          deviceCredential: "device", token: "token", username: "u".repeat(65), password: "secret",
        }],
        ["login", {
          deviceCredential: "device", username: "casey", password: ["secret"],
        }],
        ["login", {
          deviceCredential: "device", username: "casey", password: "p".repeat(1025),
        }],
      ];

      for (const [route, body] of invalidRequests) {
        const response = await post(route, body);
        expect(response.status, `${prefix}/identity/${route}`).toBe(400);
      }
      expect(tracking.identity.quick).not.toHaveBeenCalled();
      expect(tracking.identity.secure).not.toHaveBeenCalled();
      expect(tracking.identity.login).not.toHaveBeenCalled();

      expect((await post("guest", {
        deviceCredential: "d".repeat(512),
        displayName: "n".repeat(24),
      })).status).toBe(200);
      expect((await post("secure", {
        deviceCredential: "d".repeat(512),
        token: "t".repeat(8192),
        username: "u".repeat(64),
        password: "p".repeat(1024),
      })).status).toBe(200);
      expect((await post("login", {
        deviceCredential: "d".repeat(512),
        username: "u".repeat(64),
        password: "p".repeat(1024),
      })).status).toBe(200);
    },
  );

  it("requires nonnegative safe-integer decision elapsed time", async () => {
    const tracking = fakeWorkerTracking();
    const worker = createWorker({ createTracking: () => tracking });
    const env = {
      VWIKI_RACE_DB: {} as D1Database,
      VGAMES_URL: "https://vgames.example",
      CLICK_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
      ACCOUNT_READ_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
      CHALLENGE_CREATE_RATE_LIMITER: { limit: async () => ({ success: true }) },
    };
    const body = {
      clientEventId: "00000000-0000-4000-8000-000000000001",
      expectedStepNumber: 1,
      sourceTitle: "Moon",
      sourcePageId: 19331,
      clickedAnchorText: "gravity",
      requestedTitle: "Gravity",
      destinationTitle: "Gravity",
      destinationPageId: 38579,
      decisionElapsedMs: 0,
    };
    const post = (decisionElapsedMs: number) => worker.fetch(new Request(
      "https://worker.example/api/v2/runs/run-1/click",
      {
        method: "POST",
        headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, decisionElapsedMs }),
      },
    ), env);

    expect((await post(0)).status).toBe(200);
    vi.mocked(tracking.runProtocol!.recordClickV2).mockClear();
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      const response = await post(value);
      expect(response.status, String(value)).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "invalid_decision_time" },
      });
    }
    expect(tracking.runProtocol?.recordClickV2).not.toHaveBeenCalled();
  });

  it("passes literal protocol-1 recovery and rejects other values", async () => {
    const tracking = fakeWorkerTracking();
    const worker = createWorker({ createTracking: () => tracking });
    const env = {
      VWIKI_RACE_DB: {} as D1Database,
      VGAMES_URL: "https://vgames.example",
      CLICK_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
      ACCOUNT_READ_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
      CHALLENGE_CREATE_RATE_LIMITER: { limit: async () => ({ success: true }) },
    };
    const request = (value: unknown) => new Request(
      "https://worker.example/api/v2/runs/run-1/abandon",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer test",
          "Content-Type": "application/json",
          "Idempotency-Key": "abandon-key",
        },
        body: JSON.stringify({ recoveryProtocolVersion: value }),
      },
    );

    expect((await worker.fetch(request(1), env)).status).toBe(200);
    expect(tracking.runProtocol?.abandonRunV2).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ recoveryProtocolVersion: 1 }),
    );
    expect((await worker.fetch(request(2), env)).status).toBe(400);
  });
});

describe("editorial daily administration routes", () => {
  it("grants daily moderation capabilities only to claimed configured account IDs", async () => {
    const tracking = fakeWorkerTracking();
    tracking.authorize = vi.fn(async () => ({
      accountId: "canonical-admin",
      displayName: "Administrator",
      aliases: ["old-admin-handle"],
      status: "claimed" as const,
    }));
    const worker = createWorker({ createTracking: () => tracking });

    const response = await worker.fetch(new Request(
      "https://worker.example/api/v2/accounts/me/capabilities",
      { headers: { Authorization: "Bearer test" } },
    ), editorialWorkerEnv("  canonical-admin, , second-admin  "));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ canManageDailies: true });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("does not authorize display-name or alias impersonation", async () => {
    const tracking = fakeWorkerTracking();
    tracking.authorize = vi.fn(async () => ({
      accountId: "ordinary-account",
      displayName: "canonical-admin",
      aliases: ["canonical-admin"],
      status: "claimed" as const,
    }));
    const worker = createWorker({ createTracking: () => tracking });
    const env = editorialWorkerEnv("canonical-admin");

    const capabilities = await worker.fetch(new Request(
      "https://worker.example/api/v2/accounts/me/capabilities",
      { headers: { Authorization: "Bearer test" } },
    ), env);
    const admin = await worker.fetch(new Request(
      "https://worker.example/api/v2/admin/dailies",
      { headers: { Authorization: "Bearer test" } },
    ), env);

    await expect(capabilities.json()).resolves.toEqual({ canManageDailies: false });
    expect(admin.status).toBe(403);
    const adminBody = await admin.text();
    expect(JSON.parse(adminBody)).toEqual({
      error: { code: "forbidden", message: "Forbidden." },
    });
    expect(adminBody).not.toContain("canonical-admin");
  });

  it("returns generic forbidden responses for every admin route before mutation validation", async () => {
    const tracking = fakeWorkerTracking();
    tracking.authorize = vi.fn(async () => ({
      accountId: "ordinary-account",
      displayName: "Administrator",
      aliases: [],
      status: "claimed" as const,
    }));
    const worker = createWorker({ createTracking: () => tracking });
    const env = editorialWorkerEnv("canonical-admin");
    const requests = [
      ["GET", "/api/v2/admin/dailies"],
      ["POST", "/api/v2/admin/daily-nominations/nomination-1/approve"],
      ["POST", "/api/v2/admin/daily-nominations/nomination-1/decline"],
      ["POST", "/api/v2/admin/daily-queue"],
      ["DELETE", "/api/v2/admin/daily-queue/queue-1"],
    ] as const;

    for (const [method, pathname] of requests) {
      const response = await worker.fetch(new Request(`https://worker.example${pathname}`, {
        method,
        headers: { Authorization: "Bearer test" },
      }), env);
      expect(response.status, `${method} ${pathname}`).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: { code: "forbidden", message: "Forbidden." },
      });
    }
  });

  it("maps failed admin authentication to the same generic forbidden response", async () => {
    const tracking = fakeWorkerTracking();
    tracking.authorize = vi.fn(async () => {
      throw new ApiError("unauthorized", "Sign in before changing VWiki Race.", 401);
    });
    const worker = createWorker({ createTracking: () => tracking });

    const response = await worker.fetch(new Request(
      "https://worker.example/api/v2/admin/dailies",
    ), editorialWorkerEnv("canonical-admin"));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "forbidden", message: "Forbidden." },
    });
  });

  it("returns false daily moderation capabilities for a configured ghost account", async () => {
    const tracking = fakeWorkerTracking();
    tracking.authorize = vi.fn(async () => ({
      accountId: "canonical-admin",
      displayName: "Guest administrator",
      aliases: [],
      status: "ghost" as const,
    }));
    const worker = createWorker({ createTracking: () => tracking });

    const response = await worker.fetch(new Request(
      "https://worker.example/api/v2/accounts/me/capabilities",
      { headers: { Authorization: "Bearer test" } },
    ), editorialWorkerEnv("canonical-admin"));

    await expect(response.json()).resolves.toEqual({ canManageDailies: false });
  });

  it.each([
    ["approval", "POST", "/api/v2/admin/daily-nominations/nomination-1/approve", { flavor: "weird" }],
    ["decline", "POST", "/api/v2/admin/daily-nominations/nomination-1/decline", {}],
    ["direct queue", "POST", "/api/v2/admin/daily-queue", { challengeId: "challenge-1", flavor: "hard" }],
    ["queue deletion", "DELETE", "/api/v2/admin/daily-queue/queue-1", {}],
  ] as const)("requires an idempotency key before daily moderation %s", async (
    _operation,
    method,
    pathname,
    body,
  ) => {
    const tracking = fakeWorkerTracking();
    const approveDailyNomination = vi.fn();
    const declineDailyNomination = vi.fn();
    const queueDailyChallenge = vi.fn();
    const removeDailyQueueEntry = vi.fn();
    Object.assign(tracking.handlers, {
      approveDailyNomination,
      declineDailyNomination,
      queueDailyChallenge,
      removeDailyQueueEntry,
    });
    tracking.authorize = vi.fn(async () => claimedAdmin());
    const worker = createWorker({ createTracking: () => tracking });

    const response = await worker.fetch(new Request(
      `https://worker.example${pathname}`,
      {
        method,
        headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    ), editorialWorkerEnv("canonical-admin"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_idempotency_key" },
    });
    expect(approveDailyNomination).not.toHaveBeenCalled();
    expect(declineDailyNomination).not.toHaveBeenCalled();
    expect(queueDailyChallenge).not.toHaveBeenCalled();
    expect(removeDailyQueueEntry).not.toHaveBeenCalled();
  });

  it("propagates the canonical administrator through decline, direct queue, and deletion", async () => {
    const tracking = fakeWorkerTracking();
    const declineDailyNomination = vi.fn(async () => ({ id: "nomination-1" }));
    const queueDailyChallenge = vi.fn(async () => ({ id: "queue-1" }));
    const removeDailyQueueEntry = vi.fn(async () => ({ id: "queue-1" }));
    Object.assign(tracking.handlers, {
      declineDailyNomination,
      queueDailyChallenge,
      removeDailyQueueEntry,
    });
    tracking.authorize = vi.fn(async () => claimedAdmin());
    const worker = createWorker({ createTracking: () => tracking });
    const env = editorialWorkerEnv("canonical-admin");

    const decline = await worker.fetch(new Request(
      "https://worker.example/api/v2/admin/daily-nominations/nomination%2D1/decline",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer test",
          "Content-Type": "application/json",
          "Idempotency-Key": "decline-1",
        },
        body: "{}",
      },
    ), env);
    const queue = await worker.fetch(new Request(
      "https://worker.example/api/v2/admin/daily-queue",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer test",
          "Content-Type": "application/json",
          "Idempotency-Key": "queue-1",
        },
        body: JSON.stringify({ challengeId: "challenge-1", flavor: "hard" }),
      },
    ), env);
    const remove = await worker.fetch(new Request(
      "https://worker.example/api/v2/admin/daily-queue/queue%2D1",
      {
        method: "DELETE",
        headers: {
          Authorization: "Bearer test",
          "Content-Type": "application/json",
          "Idempotency-Key": "remove-1",
        },
        body: "{}",
      },
    ), env);

    expect([decline.status, queue.status, remove.status]).toEqual([200, 200, 200]);
    expect(declineDailyNomination).toHaveBeenCalledWith(
      "canonical-admin", "nomination-1", "decline-1",
    );
    expect(queueDailyChallenge).toHaveBeenCalledWith(
      "canonical-admin", "challenge-1", "hard", "queue-1",
    );
    expect(removeDailyQueueEntry).toHaveBeenCalledWith(
      "canonical-admin", "queue-1", "remove-1",
    );
  });

  it.each([
    ["approval extra field", "POST", "/api/v2/admin/daily-nominations/nomination-1/approve", { flavor: "weird", extra: true }, "invalid_request"],
    ["approval flavor", "POST", "/api/v2/admin/daily-nominations/nomination-1/approve", { flavor: 1 }, "invalid_daily_flavor"],
    ["decline body", "POST", "/api/v2/admin/daily-nominations/nomination-1/decline", { flavor: "hard" }, "invalid_request"],
    ["queue challenge", "POST", "/api/v2/admin/daily-queue", { challengeId: 1, flavor: "hard" }, "invalid_challenge_id"],
    ["queue extra field", "POST", "/api/v2/admin/daily-queue", { challengeId: "challenge-1", flavor: "hard", extra: true }, "invalid_request"],
    ["deletion body", "DELETE", "/api/v2/admin/daily-queue/queue-1", { extra: true }, "invalid_request"],
  ] as const)("rejects a strict or wrong daily moderation %s", async (
    _case,
    method,
    pathname,
    body,
    code,
  ) => {
    const tracking = fakeWorkerTracking();
    const mutation = vi.fn();
    Object.assign(tracking.handlers, {
      approveDailyNomination: mutation,
      declineDailyNomination: mutation,
      queueDailyChallenge: mutation,
      removeDailyQueueEntry: mutation,
    });
    tracking.authorize = vi.fn(async () => claimedAdmin());
    const worker = createWorker({ createTracking: () => tracking });

    const response = await worker.fetch(new Request(`https://worker.example${pathname}`, {
      method,
      headers: {
        Authorization: "Bearer test",
        "Content-Type": "application/json",
        "Idempotency-Key": "strict-body",
      },
      body: JSON.stringify(body),
    }), editorialWorkerEnv("canonical-admin"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
    expect(mutation).not.toHaveBeenCalled();
  });

  it.each([
    ["GET", "/api/v2/admin/daily-nominations/nomination-1/approve"],
    ["DELETE", "/api/v2/admin/daily-nominations/nomination-1/decline"],
    ["PUT", "/api/v2/admin/daily-queue"],
    ["POST", "/api/v2/admin/daily-queue/queue-1"],
  ] as const)("does not dispatch the wrong moderation method %s %s", async (method, pathname) => {
    const tracking = fakeWorkerTracking();
    const mutation = vi.fn();
    Object.assign(tracking.handlers, {
      approveDailyNomination: mutation,
      declineDailyNomination: mutation,
      queueDailyChallenge: mutation,
      removeDailyQueueEntry: mutation,
    });
    tracking.authorize = vi.fn(async () => claimedAdmin());
    const worker = createWorker({ createTracking: () => tracking });

    const response = await worker.fetch(new Request(`https://worker.example${pathname}`, {
      method,
      headers: { Authorization: "Bearer test" },
    }), editorialWorkerEnv("canonical-admin"));

    expect(response.status).toBe(404);
    expect(mutation).not.toHaveBeenCalled();
  });

  it("rejects limited administrators and fails closed without the admin limiter", async () => {
    const tracking = fakeWorkerTracking();
    const declineDailyNomination = vi.fn();
    Object.assign(tracking.handlers, { declineDailyNomination });
    tracking.authorize = vi.fn(async () => claimedAdmin());
    const worker = createWorker({ createTracking: () => tracking });
    const limitedEnv = editorialWorkerEnv("canonical-admin");
    const limit = vi.fn(async () => ({ success: false }));
    limitedEnv.DAILY_ADMIN_RATE_LIMITER = { limit };
    const request = () => new Request(
      "https://worker.example/api/v2/admin/daily-nominations/nomination-1/decline",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer test",
          "Content-Type": "application/json",
          "Idempotency-Key": "decline-limited",
        },
        body: "{}",
      },
    );

    const limited = await worker.fetch(request(), limitedEnv);
    const unavailableEnv = editorialWorkerEnv("canonical-admin");
    delete unavailableEnv.DAILY_ADMIN_RATE_LIMITER;
    const unavailable = await worker.fetch(request(), unavailableEnv);

    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toMatchObject({
      error: { code: "daily_admin_rate_limited" },
    });
    expect(limit).toHaveBeenCalledWith({ key: "decline:canonical-admin" });
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toMatchObject({
      error: { code: "rate_limiter_unavailable" },
    });
    expect(declineDailyNomination).not.toHaveBeenCalled();
  });

  it("redacts malformed and oversized moderation IDs from request logs", async () => {
    const tracking = fakeWorkerTracking();
    tracking.authorize = vi.fn(async () => claimedAdmin());
    const worker = createWorker({ createTracking: () => tracking });
    const env = editorialWorkerEnv("canonical-admin");
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const oversizedNominationId = `private-nomination-${"x".repeat(220)}`;
    const oversizedQueueId = `private-queue-${"y".repeat(220)}`;

    try {
      const malformed = await worker.fetch(new Request(
        "https://worker.example/api/v2/admin/daily-nominations/%E0%A4%A-secret-admin-id/approve",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer test",
            "Content-Type": "application/json",
            "Idempotency-Key": "malformed-log",
          },
          body: "{}",
        },
      ), env);
      const oversized = await worker.fetch(new Request(
        `https://worker.example/api/v2/admin/daily-nominations/${oversizedNominationId}/decline`,
        {
          method: "POST",
          headers: {
            Authorization: "Bearer test",
            "Content-Type": "application/json",
            "Idempotency-Key": "oversized-log",
          },
          body: "{}",
        },
      ), env);
      const queue = await worker.fetch(new Request(
        `https://worker.example/api/v2/admin/daily-queue/${oversizedQueueId}`,
        {
          method: "DELETE",
          headers: {
            Authorization: "Bearer test",
            "Content-Type": "application/json",
            "Idempotency-Key": "oversized-queue-log",
          },
          body: "{}",
        },
      ), env);

      expect([malformed.status, oversized.status, queue.status]).toEqual([400, 400, 400]);
      const logs = consoleInfo.mock.calls.map(([line]) => JSON.parse(String(line)) as { route: string });
      expect(logs.map(({ route }) => route)).toEqual([
        "/api/v2/admin/daily-nominations/:nominationId/approve",
        "/api/v2/admin/daily-nominations/:nominationId/decline",
        "/api/v2/admin/daily-queue/:queueEntryId",
      ]);
      const serialized = JSON.stringify(logs);
      expect(serialized).not.toContain("secret-admin-id");
      expect(serialized).not.toContain("private-nomination");
      expect(serialized).not.toContain("private-queue");
    } finally {
      consoleInfo.mockRestore();
    }
  });

  it("strictly decodes path IDs and passes the claimed actor to daily moderation", async () => {
    const tracking = fakeWorkerTracking();
    const approveDailyNomination = vi.fn(async () => ({ id: "queue-1" }));
    Object.assign(tracking.handlers, { approveDailyNomination });
    tracking.authorize = vi.fn(async () => claimedAdmin());
    const worker = createWorker({ createTracking: () => tracking });
    const env = editorialWorkerEnv("canonical-admin");

    const malformed = await worker.fetch(new Request(
      "https://worker.example/api/v2/admin/daily-nominations/%E0%A4%A/approve",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer test",
          "Content-Type": "application/json",
          "Idempotency-Key": "malformed-path",
        },
        body: "{}",
      },
    ), env);
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({
      error: { code: "invalid_daily_nomination_id" },
    });

    const response = await worker.fetch(new Request(
      "https://worker.example/api/v2/admin/daily-nominations/nomination%2D1/approve",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer test",
          "Content-Type": "application/json",
          "Idempotency-Key": "approve-1",
        },
        body: JSON.stringify({ flavor: "hard" }),
      },
    ), env);
    expect(response.status).toBe(200);
    expect(approveDailyNomination).toHaveBeenCalledWith(
      "canonical-admin", "nomination-1", "hard", "approve-1",
    );
  });
});

function editorialWorkerEnv(dailyAdmins: string): WorkerEnv {
  return {
    VWIKI_RACE_DB: {} as D1Database,
    VGAMES_URL: "https://vgames.example",
    DAILY_ADMIN_ACCOUNT_IDS: dailyAdmins,
    CLICK_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
    ACCOUNT_READ_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
    CHALLENGE_CREATE_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
    DAILY_ADMIN_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
  } as unknown as WorkerEnv;
}

function claimedAdmin() {
  return {
    accountId: "canonical-admin",
    displayName: "Administrator",
    aliases: [],
    status: "claimed" as const,
  };
}

function fakeWorkerTracking(): WorkerTracking {
  const handlers = {
    listChallenges: vi.fn(async () => ({ challenges: [] })),
    createChallenge: vi.fn(async () => ({ challenge: {} })),
    createChallengeV2: vi.fn(async () => ({ challenge: {} })),
    startRun: vi.fn(async () => ({ run: {} })),
    recordClick: vi.fn(async () => ({ clickCount: 1 })),
    completeRun: vi.fn(async () => ({ leaderboardRow: {} })),
    abandonRun: vi.fn(async () => ({ status: "abandoned" as const })),
    listLeaderboard: vi.fn(async () => ({ leaderboard: [] })),
    getRunPath: vi.fn(async () => ({ path: [] })),
  };
  const identity = {
    quick: vi.fn(async () => ({
      accountId: "acc-1",
      displayName: "Casey",
      token: "jwt-1",
      status: "ghost" as const,
    })),
    secure: vi.fn(async () => ({
      accountId: "acc-1",
      displayName: "Casey",
      token: "jwt-1",
      status: "claimed" as const,
    })),
    login: vi.fn(async () => ({
      accountId: "acc-1",
      displayName: "Casey",
      token: "jwt-1",
      status: "claimed" as const,
    })),
    introspect: vi.fn(async () => ({
      valid: true as const,
      accountId: "acc-1",
      displayName: "Casey",
      aliases: [],
      status: "claimed" as const,
    })),
  };

  return {
    handlers,
    identity,
    authorize: vi.fn(async () => ({
      accountId: "acc-1",
      displayName: "Casey",
      aliases: [],
      status: "claimed" as const,
    })),
    runProtocol: {
      createChallengeV2: vi.fn(),
      startRunV2: vi.fn(async () => ({ id: "run-1", protocolVersion: 2 })),
      recordClickV2: vi.fn(async () => ({ transition: { runId: "run-1", clickCount: 1, runStatus: "active" } })),
      abandonRunV2: vi.fn(async () => ({ runId: "run-1", runStatus: "abandoned" })),
      findActiveRun: vi.fn(async () => null),
      getAccountStats: vi.fn(async () => ({ totals: {}, topStarts: [], topTargets: [], mostVisited: [] })),
      getPublicRunPath: vi.fn(async () => []),
      findChallengeCreationReplay: vi.fn(async () => null),
    },
  } as unknown as WorkerTracking;
}
