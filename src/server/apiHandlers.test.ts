import { describe, expect, it, vi } from "vitest";
import { createApiHandlers } from "./apiHandlers";
import type { TrackingRepository } from "./trackingRepository";
import { createWorker, type Env as WorkerEnv, type WorkerTracking } from "./worker";

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
    )).resolves.toEqual({ challenge: committed });
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
      expect.objectContaining({ startTitle: "Moon", targetTitle: "Gravity" }),
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
