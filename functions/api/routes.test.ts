import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  handlers: {
    listChallenges: vi.fn(),
    upsertPlayer: vi.fn(),
    startRun: vi.fn(),
    recordClick: vi.fn(),
    completeRun: vi.fn(),
    abandonRun: vi.fn(),
    listLeaderboard: vi.fn(),
    getRunPath: vi.fn(),
  },
}));

vi.mock("../_shared/createTrackingContext", () => ({
  createTrackingContext: () => ({
    handlers: mockState.handlers,
    json: (value: unknown, init?: ResponseInit) =>
      Response.json(value, init),
    error: (caught: unknown) =>
      Response.json(
        {
          error: {
            code: "test_error",
            message: caught instanceof Error ? caught.message : "failed",
          },
        },
        { status: 500 },
      ),
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
  });

  it("routes player creation requests", async () => {
    mockState.handlers.upsertPlayer.mockResolvedValue({
      player: { id: "player-1", displayName: "Vijay" },
    });
    const route = await import("./players");

    const response = await route.onRequestPost(
      context(
        new Request("https://example.com/api/players", {
          method: "POST",
          body: JSON.stringify({ displayName: "Vijay" }),
        }),
      ),
    );

    await expect(response.json()).resolves.toEqual({
      player: { id: "player-1", displayName: "Vijay" },
    });
    expect(mockState.handlers.upsertPlayer).toHaveBeenCalledWith({
      displayName: "Vijay",
    });
  });

  it("routes run click requests with the run id", async () => {
    mockState.handlers.recordClick.mockResolvedValue({ clickCount: 1 });
    const route = await import("./runs/[runId]/click");

    const response = await route.onRequestPost(
      context(
        new Request("https://example.com/api/runs/run-1/click", {
          method: "POST",
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
    expect(mockState.handlers.recordClick).toHaveBeenCalledWith("run-1", {
      sourceTitle: "Moon",
      clickedAnchorText: "orbit",
      requestedTitle: "Orbit",
      destinationTitle: "Orbit",
    });
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
