import { describe, expect, it, vi } from "vitest";
import { createApiHandlers } from "./apiHandlers";
import type { TrackingRepository } from "./trackingRepository";

function fakeRepository(): TrackingRepository {
  return {
    listChallenges: vi.fn(async () => []),
    upsertPlayer: vi.fn(async ({ displayName }) => ({
      id: "player-1",
      displayName,
    })),
    startRun: vi.fn(async () => ({
      id: "run-1",
      challengeId: "challenge-0001",
      playerId: "player-1",
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
      playerId: "player-1",
      displayName: "Vijay",
      elapsedMs: 1200,
      clickCount: 1,
      completedAt: "2026-07-14T00:00:01.200Z",
      pathPreview: [],
      rank: 1,
    })),
    abandonRun: vi.fn(async () => ({ status: "abandoned" as const })),
    listLeaderboard: vi.fn(async () => []),
    getRunPath: vi.fn(async () => []),
  };
}

describe("api handlers", () => {
  it("requires a non-empty display name", async () => {
    const handlers = createApiHandlers(fakeRepository());

    await expect(
      handlers.upsertPlayer({ displayName: "   " }),
    ).rejects.toMatchObject({
      code: "invalid_display_name",
      status: 400,
    });
  });

  it("trims display names before saving players", async () => {
    const repository = fakeRepository();
    const handlers = createApiHandlers(repository);

    await expect(
      handlers.upsertPlayer({ displayName: "  Vijay  " }),
    ).resolves.toEqual({
      player: { id: "player-1", displayName: "Vijay" },
    });

    expect(repository.upsertPlayer).toHaveBeenCalledWith({
      displayName: "Vijay",
      playerId: undefined,
    });
  });

  it("starts a run through the repository", async () => {
    const repository = fakeRepository();
    const handlers = createApiHandlers(repository);

    await expect(
      handlers.startRun({
        challengeId: "challenge-0001",
        playerId: "player-1",
      }),
    ).resolves.toMatchObject({ run: { id: "run-1" } });
  });

  it("records clicks with required titles and anchor text", async () => {
    const repository = fakeRepository();
    const handlers = createApiHandlers(repository);

    await expect(
      handlers.recordClick("run-1", {
        sourceTitle: "Moon",
        clickedAnchorText: "orbit",
        requestedTitle: "Orbit",
        destinationTitle: "Orbit",
        clientTimestampMs: 1784000000000,
      }),
    ).resolves.toEqual({ clickCount: 1 });

    expect(repository.recordClick).toHaveBeenCalledWith("run-1", {
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
      handlers.completeRun("run-1", { finalTitle: "" }),
    ).rejects.toMatchObject({
      code: "invalid_final_title",
      status: 400,
    });
  });
});
