import { describe, expect, it, vi } from "vitest";
import { createVWikiRaceApiClient } from "./vwikiRaceApiClient";

describe("VWiki Race API client", () => {
  it("calls server tracking endpoints with VGames bearer auth for writes", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      const responses: Record<string, unknown> = {
        "/api/challenges": {
          challenges: [
            {
              id: "challenge-0001",
              label: "Challenge #1",
              mode: "daily",
              start: { title: "Moon" },
              target: { title: "Gravity" },
              ruleset: "ranked_classic",
              source: "curated",
            },
          ],
        },
        "/api/runs/start": {
          run: {
            id: "run-1",
            challengeId: "challenge-0001",
            accountId: "acc-1",
            status: "active",
            startTitle: "Moon",
            targetTitle: "Gravity",
            clickCount: 0,
            startedAt: "2026-07-14T01:00:00.000Z",
          },
        },
        "/api/runs/run-1/click": { clickCount: 1 },
        "/api/runs/run-1/complete": {
          leaderboardRow: {
            rank: 1,
            runId: "run-1",
            challengeId: "challenge-0001",
            accountId: "acc-1",
            displayName: "Vijay",
            elapsedMs: 1500,
            clickCount: 1,
            completedAt: "2026-07-14T01:00:01.500Z",
            pathPreview: [],
          },
        },
        "/api/challenges/challenge-0001/leaderboard": {
          leaderboard: [],
        },
        "/api/runs/run-1/path": { path: [] },
      };

      return new Response(JSON.stringify(responses[path]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const client = createVWikiRaceApiClient(fetchImpl);

    expect((await client.listChallenges()).at(0)?.label).toBe("Challenge #1");
    expect(
      await client.startRun({
        challengeId: "challenge-0001",
        publicName: "Vijay",
      }, "jwt-claimed"),
    ).toMatchObject({ id: "run-1", clickCount: 0 });
    expect(
      await client.recordClick("run-1", {
        sourceTitle: "Moon",
        clickedAnchorText: "gravity",
        requestedTitle: "Gravity",
        destinationTitle: "Gravity",
        destinationPageId: 123,
        clientTimestampMs: 1500,
      }, "jwt-claimed"),
    ).toEqual({ clickCount: 1 });
    expect(
      await client.completeRun("run-1", {
        finalTitle: "Gravity",
        clientTimestampMs: 1500,
      }, "jwt-claimed"),
    ).toMatchObject({ rank: 1, elapsedMs: 1500 });
    expect(await client.listLeaderboard("challenge-0001")).toEqual([]);
    expect(await client.getRunPath("run-1")).toEqual([]);

    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/runs/start",
      expect.objectContaining({
        body: JSON.stringify({
          challengeId: "challenge-0001",
          publicName: "Vijay",
        }),
        headers: expect.objectContaining({
          Authorization: "Bearer jwt-claimed",
        }),
        method: "POST",
      }),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/runs/run-1/click",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer jwt-claimed",
        }),
        method: "POST",
      }),
    );
  });

  it("surfaces server error messages", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({ error: { message: "Display name is required" } }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
    const client = createVWikiRaceApiClient(fetchImpl);

    await expect(
      client.startRun(
        { challengeId: "challenge-0001", publicName: "" },
        "jwt-claimed",
      ),
    ).rejects.toThrow(
      "Display name is required",
    );
  });

  it("creates challenges through the server", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
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
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
    const client = createVWikiRaceApiClient(fetchImpl);

    await expect(
      client.createChallenge(
        {
          startTitle: "Mars",
          targetTitle: "Water",
          creatorDisplayName: "Vijay",
        },
        "jwt-claimed",
      ),
    ).resolves.toMatchObject({
      id: "challenge-0002",
      label: "Challenge #2",
      start: { title: "Mars" },
      target: { title: "Water" },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/challenges",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer jwt-claimed",
        }),
        body: JSON.stringify({
          startTitle: "Mars",
          targetTitle: "Water",
          creatorDisplayName: "Vijay",
        }),
      }),
    );
  });
});
