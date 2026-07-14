import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  handlers: {
    listChallenges: vi.fn(),
    createChallenge: vi.fn(),
    startRun: vi.fn(),
    recordClick: vi.fn(),
    completeRun: vi.fn(),
    abandonRun: vi.fn(),
    listLeaderboard: vi.fn(),
    getRunPath: vi.fn(),
  },
  authorize: vi.fn(),
  identity: {
    quick: vi.fn(),
    secure: vi.fn(),
    login: vi.fn(),
    introspect: vi.fn(),
  },
}));

vi.mock("../_shared/createTrackingContext", () => ({
  createTrackingContext: () => ({
    handlers: mockState.handlers,
    identity: mockState.identity,
    authorize: mockState.authorize,
    json: (value: unknown, init?: ResponseInit) =>
      Response.json(value, init),
    error: (caught: unknown) => {
      const error =
        caught && typeof caught === "object"
          ? (caught as { code?: unknown; message?: unknown; status?: unknown })
          : {};
      return Response.json(
        {
          error: {
            code: typeof error.code === "string" ? error.code : "test_error",
            message:
              typeof error.message === "string" ? error.message : "failed",
          },
        },
        { status: typeof error.status === "number" ? error.status : 500 },
      );
    },
    readJson: (request: Request) => request.json(),
  }),
  singleParam: (value: string | string[] | undefined) =>
    Array.isArray(value) ? (value[0] ?? "") : (value ?? ""),
}));

function context(
  request: Request,
  params: Record<string, string> = {},
): EventContext<Record<string, string>, string, unknown> {
  return {
    request,
    env: {},
    params,
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    next: vi.fn(),
    data: {},
    functionPath: "/api/test",
  };
}

describe("Cloudflare API routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.authorize.mockResolvedValue({
      accountId: "acc-claimed",
      status: "claimed",
    });
  });

  it("routes guest identity requests", async () => {
    mockState.identity.quick.mockResolvedValue({
      accountId: "acc-guest",
      displayName: "Casey",
      token: "jwt-guest",
      status: "ghost",
    });
    const route = await import("./identity/guest");

    const response = await route.onRequestPost(
      context(
        new Request("https://example.com/api/identity/guest", {
          method: "POST",
          body: JSON.stringify({
            deviceCredential: "cred-123456789012",
            displayName: "Casey",
          }),
        }),
      ),
    );

    await expect(response.json()).resolves.toEqual({
      accountId: "acc-guest",
      displayName: "Casey",
      token: "jwt-guest",
      status: "ghost",
    });
    expect(mockState.identity.quick).toHaveBeenCalledWith({
      deviceCredential: "cred-123456789012",
      displayName: "Casey",
    });
  });

  it("routes secure guest identity requests", async () => {
    mockState.identity.secure.mockResolvedValue({
      accountId: "acc-claimed",
      displayName: "vijay",
      token: "jwt-claimed",
      status: "claimed",
    });
    const route = await import("./identity/secure");

    const response = await route.onRequestPost(
      context(
        new Request("https://example.com/api/identity/secure", {
          method: "POST",
          body: JSON.stringify({
            deviceCredential: "cred-123456789012",
            token: "jwt-guest",
            username: "vijay",
            password: "secret-pass",
          }),
        }),
      ),
    );

    await expect(response.json()).resolves.toEqual({
      accountId: "acc-claimed",
      displayName: "vijay",
      token: "jwt-claimed",
      status: "claimed",
    });
    expect(mockState.identity.secure).toHaveBeenCalledWith({
      deviceCredential: "cred-123456789012",
      token: "jwt-guest",
      username: "vijay",
      password: "secret-pass",
    });
  });

  it("routes login identity requests", async () => {
    mockState.identity.login.mockResolvedValue({
      accountId: "acc-claimed",
      displayName: "vijay",
      token: "jwt-claimed",
      status: "claimed",
    });
    const route = await import("./identity/login");

    const response = await route.onRequestPost(
      context(
        new Request("https://example.com/api/identity/login", {
          method: "POST",
          body: JSON.stringify({
            deviceCredential: "cred-123456789012",
            username: "vijay",
            password: "secret-pass",
          }),
        }),
      ),
    );

    await expect(response.json()).resolves.toMatchObject({
      accountId: "acc-claimed",
      token: "jwt-claimed",
    });
    expect(mockState.identity.login).toHaveBeenCalledWith({
      deviceCredential: "cred-123456789012",
      username: "vijay",
      password: "secret-pass",
    });
  });

  it("routes challenge creation requests for authenticated sessions", async () => {
    mockState.handlers.createChallenge.mockResolvedValue({
      challenge: {
        id: "challenge-0002",
        label: "Challenge #2",
        mode: "daily",
        start: { title: "Mars" },
        target: { title: "Water" },
        ruleset: "ranked_classic",
        source: "curated",
        createdBy: {
          accountId: "acc-claimed",
          displayName: "Vijay",
          identityStatus: "claimed",
        },
      },
    });
    const route = await import("./challenges");

    const response = await route.onRequestPost(
      context(
        new Request("https://example.com/api/challenges", {
          method: "POST",
          headers: { Authorization: "Bearer jwt-claimed" },
          body: JSON.stringify({
            startTitle: "Mars",
            targetTitle: "Water",
            creatorDisplayName: "Vijay",
          }),
        }),
      ),
    );

    await expect(response.json()).resolves.toMatchObject({
      challenge: {
        id: "challenge-0002",
        label: "Challenge #2",
      },
    });
    expect(mockState.handlers.createChallenge).toHaveBeenCalledWith({
      startTitle: "Mars",
      targetTitle: "Water",
      creatorAccountId: "acc-claimed",
      creatorDisplayName: "Vijay",
      creatorIdentityStatus: "claimed",
    });
    expect(mockState.authorize).toHaveBeenCalled();
  });

  it("rejects challenge creation without a VGames session", async () => {
    mockState.authorize.mockRejectedValue({
      code: "unauthorized",
      message: "Sign in before changing VWiki Race.",
      status: 401,
    });
    const route = await import("./challenges");

    const response = await route.onRequestPost(
      context(
        new Request("https://example.com/api/challenges", {
          method: "POST",
          body: JSON.stringify({ startTitle: "Mars", targetTitle: "Water" }),
        }),
      ),
    );

    expect(response.status).toBe(401);
    expect(mockState.handlers.createChallenge).not.toHaveBeenCalled();
  });

  it("routes run starts with the authorized VGames account", async () => {
    mockState.handlers.startRun.mockResolvedValue({
      run: {
        id: "run-1",
        challengeId: "challenge-0001",
        accountId: "acc-claimed",
        status: "active",
        startTitle: "Moon",
        targetTitle: "Gravity",
        clickCount: 0,
        startedAt: "2026-07-14T00:00:00.000Z",
      },
    });
    const route = await import("./runs/start");

    const response = await route.onRequestPost(
      context(
        new Request("https://example.com/api/runs/start", {
          method: "POST",
          headers: { Authorization: "Bearer jwt-claimed" },
          body: JSON.stringify({
            challengeId: "challenge-0001",
            publicName: "Vijay",
          }),
        }),
      ),
    );

    await expect(response.json()).resolves.toMatchObject({
      run: { id: "run-1", accountId: "acc-claimed" },
    });
    expect(mockState.handlers.startRun).toHaveBeenCalledWith({
      challengeId: "challenge-0001",
      accountId: "acc-claimed",
      publicName: "Vijay",
      identityStatus: "claimed",
    });
  });

  it("routes run click requests with the authorized VGames account", async () => {
    mockState.handlers.recordClick.mockResolvedValue({ clickCount: 1 });
    const route = await import("./runs/[runId]/click");

    const response = await route.onRequestPost(
      context(
        new Request("https://example.com/api/runs/run-1/click", {
          method: "POST",
          headers: { Authorization: "Bearer jwt-claimed" },
          body: JSON.stringify({
            sourceTitle: "Moon",
            clickedAnchorText: "orbit",
            requestedTitle: "Orbit",
            destinationTitle: "Orbit",
          }),
        }),
        { runId: "run-1" },
      ),
    );

    await expect(response.json()).resolves.toEqual({ clickCount: 1 });
    expect(mockState.handlers.recordClick).toHaveBeenCalledWith(
      "run-1",
      "acc-claimed",
      {
        sourceTitle: "Moon",
        clickedAnchorText: "orbit",
        requestedTitle: "Orbit",
        destinationTitle: "Orbit",
      },
    );
  });

  it("routes run completion with the authorized VGames account", async () => {
    mockState.handlers.completeRun.mockResolvedValue({
      leaderboardRow: {
        rank: 1,
        runId: "run-1",
        challengeId: "challenge-0001",
        accountId: "acc-claimed",
        displayName: "Vijay",
        elapsedMs: 1500,
        clickCount: 1,
        completedAt: "2026-07-14T00:00:01.500Z",
        pathPreview: [],
      },
    });
    const route = await import("./runs/[runId]/complete");

    const response = await route.onRequestPost(
      context(
        new Request("https://example.com/api/runs/run-1/complete", {
          method: "POST",
          headers: { Authorization: "Bearer jwt-claimed" },
          body: JSON.stringify({
            finalTitle: "Gravity",
            clientTimestampMs: 1784000001500,
          }),
        }),
        { runId: "run-1" },
      ),
    );

    await expect(response.json()).resolves.toMatchObject({
      leaderboardRow: { runId: "run-1", accountId: "acc-claimed" },
    });
    expect(mockState.handlers.completeRun).toHaveBeenCalledWith(
      "run-1",
      "acc-claimed",
      {
        finalTitle: "Gravity",
        clientTimestampMs: 1784000001500,
      },
    );
  });

  it("routes run abandonment with the authorized VGames account", async () => {
    mockState.handlers.abandonRun.mockResolvedValue({ status: "abandoned" });
    const route = await import("./runs/[runId]/abandon");

    const response = await route.onRequestPost(
      context(
        new Request("https://example.com/api/runs/run-1/abandon", {
          method: "POST",
          headers: { Authorization: "Bearer jwt-claimed" },
        }),
        { runId: "run-1" },
      ),
    );

    await expect(response.json()).resolves.toEqual({ status: "abandoned" });
    expect(mockState.handlers.abandonRun).toHaveBeenCalledWith(
      "run-1",
      "acc-claimed",
    );
  });

  it("routes challenge leaderboard reads with the challenge id", async () => {
    mockState.handlers.listLeaderboard.mockResolvedValue({ leaderboard: [] });
    const route = await import("./challenges/[challengeId]/leaderboard");

    const response = await route.onRequestGet(
      context(
        new Request(
          "https://example.com/api/challenges/challenge-0001/leaderboard",
        ),
        { challengeId: "challenge-0001" },
      ),
    );

    await expect(response.json()).resolves.toEqual({ leaderboard: [] });
    expect(mockState.handlers.listLeaderboard).toHaveBeenCalledWith(
      "challenge-0001",
    );
  });
});
