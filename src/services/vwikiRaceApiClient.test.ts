import { describe, expect, it, vi } from "vitest";
import {
  createVWikiRaceApiClient,
  type VWikiRaceApiClient,
  type VWikiRaceDailyAdminApiClient,
} from "./vwikiRaceApiClient";

const apiOrigin = "https://vwikirace-api.example.workers.dev";

describe("VWiki Race API client", () => {
  it("requires the production client contract to include Daily administration", () => {
    const requireDailyAdmin = (client: VWikiRaceDailyAdminApiClient) => client;
    const declaredClient: VWikiRaceApiClient = createVWikiRaceApiClient(
      vi.fn(),
      { apiOrigin },
    );

    expect(requireDailyAdmin(declaredClient)).toBe(declaredClient);
  });

  it("calls server tracking endpoints with VGames bearer auth for writes", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      const responses: Record<string, unknown> = {
        [`${apiOrigin}/api/v2/challenges`]: {
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
        [`${apiOrigin}/api/v2/runs/start`]: {
          run: {
            id: "run-1",
            challengeId: "challenge-0001",
            accountId: "acc-1",
            canonicalAccountId: "acc-1",
            status: "active",
            startTitle: "Moon",
            targetTitle: "Gravity",
            clickCount: 0,
            startedAt: "2026-07-14T01:00:00.000Z",
            protocolVersion: 2,
          },
        },
        [`${apiOrigin}/api/v2/runs/run-1/click`]: {
          transition: { runId: "run-1", clickCount: 1, runStatus: "active" },
        },
        [`${apiOrigin}/api/v2/challenges/challenge-0001/leaderboard`]: {
          leaderboard: [],
        },
        [`${apiOrigin}/api/v2/runs/run-1/path`]: { path: [] },
      };

      return new Response(JSON.stringify(responses[path]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const client = createVWikiRaceApiClient(fetchImpl, { apiOrigin });

    expect((await client.listChallenges()).at(0)?.label).toBe("Challenge #1");
    expect(
      await client.startRun({
        challengeId: "challenge-0001",
      }, "jwt-claimed"),
    ).toMatchObject({ id: "run-1", clickCount: 0 });
    expect(
      await client.recordClick("run-1", {
        clientEventId: "00000000-0000-4000-8000-000000000001",
        expectedStepNumber: 1,
        sourceTitle: "Moon",
        sourcePageId: 19331,
        sourceRevisionId: 1,
        clickedAnchorText: "gravity",
        requestedTitle: "Gravity",
        destinationTitle: "Gravity",
        destinationPageId: 123,
        decisionElapsedMs: 1500,
        clientObservedAt: "2026-07-14T01:00:01.500Z",
      }, "jwt-claimed"),
    ).toMatchObject({ transition: { clickCount: 1 } });
    expect(await client.listLeaderboard("challenge-0001")).toEqual([]);
    expect(await client.getRunPath("run-1", "jwt-claimed")).toEqual([]);

    expect(fetchImpl).toHaveBeenCalledWith(
      `${apiOrigin}/api/v2/runs/start`,
      expect.objectContaining({
        body: JSON.stringify({
          challengeId: "challenge-0001",
        }),
        headers: expect.objectContaining({
          Authorization: "Bearer jwt-claimed",
        }),
        method: "POST",
      }),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      `${apiOrigin}/api/v2/runs/run-1/click`,
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
    const client = createVWikiRaceApiClient(fetchImpl, { apiOrigin });

    await expect(
      client.startRun(
        { challengeId: "challenge-0001" },
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
          disposition: "created",
          nomination: "not_requested",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
    const client = createVWikiRaceApiClient(fetchImpl, { apiOrigin });

    await expect(
      client.createChallenge(
        {
          startTitle: "Mars",
          targetTitle: "Water",
        },
        "jwt-claimed",
      ),
    ).resolves.toMatchObject({
      challenge: {
        id: "challenge-0002",
        label: "Challenge #2",
        start: { title: "Mars" },
        target: { title: "Water" },
      },
      disposition: "created",
      nomination: "not_requested",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `${apiOrigin}/api/v2/challenges`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer jwt-claimed",
        }),
        body: JSON.stringify({
          startTitle: "Mars",
          targetTitle: "Water",
        }),
      }),
    );
  });

  it("sends nomination intent and returns only the expanded creation outcome", async () => {
    const outcome = validCreateOutcome({
      challenge: validChallenge({
        origin: "daily",
        mode: "daily",
        dailyDate: "2026-07-18",
        dailyFeature: {
          dailyDate: "2026-07-18",
          flavor: "weird",
          selectionSource: "community",
        },
      }),
      nomination: "pending",
    });
    const fetchImpl = vi.fn(async () => Response.json(outcome));
    const client = createVWikiRaceApiClient(fetchImpl, { apiOrigin });

    await expect(client.createChallenge({
      startTitle: "Mars",
      targetTitle: "Water",
      nominateForDaily: true,
    }, "jwt-claimed")).resolves.toEqual(outcome);

    expect(fetchImpl).toHaveBeenCalledWith(
      `${apiOrigin}/api/v2/challenges`,
      expect.objectContaining({
        body: JSON.stringify({
          startTitle: "Mars",
          targetTitle: "Water",
          nominateForDaily: true,
        }),
      }),
    );
  });

  it.each([
    ["legacy create payload", { challenge: validChallenge() }],
    ["unknown creation disposition", validCreateOutcome({ disposition: "accepted" as never })],
    ["unknown nomination disposition", validCreateOutcome({ nomination: "queued" as never })],
    ["malformed Daily feature", validCreateOutcome({
      challenge: validChallenge({ dailyFeature: { dailyDate: "2026-07-18", flavor: "easy", selectionSource: "community" } }),
    })],
  ])("rejects a %s creation response", async (_case, response) => {
    const client = createVWikiRaceApiClient(
      vi.fn(async () => Response.json(response)),
      { apiOrigin },
    );

    await expect(client.createChallenge(
      { startTitle: "Mars", targetTitle: "Water" },
      "jwt-claimed",
    )).rejects.toMatchObject({ code: "invalid_response", status: 502 });
  });

  it("validates capabilities and every Daily moderation response", async () => {
    const nomination = validDailyNomination();
    const queueEntry = validDailyQueueEntry();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = String(input);
      const method = init?.method ?? "GET";
      if (requestUrl.endsWith("/capabilities")) return Response.json({ canManageDailies: true });
      if (requestUrl.endsWith("/admin/dailies")) {
        return Response.json({ nominations: [nomination], queueEntries: [queueEntry] });
      }
      if (requestUrl.endsWith("/approve")) return Response.json(queueEntry);
      if (requestUrl.endsWith("/decline")) return Response.json(nomination);
      if (requestUrl.endsWith("/admin/daily-queue") && method === "POST") return Response.json(queueEntry);
      if (requestUrl.endsWith("/admin/daily-queue/queue-1") && method === "DELETE") return Response.json(queueEntry);
      throw new Error(`Unexpected request ${method} ${requestUrl}`);
    });
    const client = createVWikiRaceApiClient(fetchImpl, { apiOrigin });

    await expect(client.getCapabilities("jwt-admin")).resolves.toEqual({ canManageDailies: true });
    await expect(client.getDailyAdminState("jwt-admin")).resolves.toEqual({
      nominations: [nomination],
      queueEntries: [queueEntry],
    });
    await expect(client.approveDailyNomination("nomination-1", { flavor: "weird" }, "jwt-admin"))
      .resolves.toEqual(queueEntry);
    await expect(client.declineDailyNomination("nomination-1", "jwt-admin"))
      .resolves.toEqual(nomination);
    await expect(client.queueDailyChallenge({ challengeId: "challenge-0002", flavor: "hard" }, "jwt-admin"))
      .resolves.toEqual(queueEntry);
    await expect(client.removeDailyQueueEntry("queue-1", "jwt-admin"))
      .resolves.toEqual(queueEntry);

    expect(fetchImpl).toHaveBeenCalledWith(
      `${apiOrigin}/api/v2/admin/daily-queue/queue-1`,
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({}),
        headers: expect.objectContaining({ Authorization: "Bearer jwt-admin", "Idempotency-Key": expect.any(String) }),
      }),
    );
  });

  it.each([
    ["capabilities", "/api/v2/accounts/me/capabilities", { canManageDailies: "yes" }],
    ["admin state", "/api/v2/admin/dailies", { nominations: [{ id: "nomination-1" }], queueEntries: [] }],
    ["approved queue entry", "/api/v2/admin/daily-nominations/nomination-1/approve", { id: "queue-1" }],
    ["declined nomination", "/api/v2/admin/daily-nominations/nomination-1/decline", { id: "nomination-1" }],
    ["direct queue entry", "/api/v2/admin/daily-queue", { id: "queue-1" }],
    ["removed queue entry", "/api/v2/admin/daily-queue/queue-1", { id: "queue-1" }],
  ] as const)("rejects malformed %s responses", async (_case, path, response) => {
    const client = createVWikiRaceApiClient(
      vi.fn(async () => Response.json(response)),
      { apiOrigin },
    );

    const request = path.endsWith("capabilities")
      ? client.getCapabilities("jwt-admin")
      : path.endsWith("/dailies")
        ? client.getDailyAdminState("jwt-admin")
        : path.endsWith("/approve")
          ? client.approveDailyNomination("nomination-1", { flavor: "weird" }, "jwt-admin")
          : path.endsWith("/decline")
            ? client.declineDailyNomination("nomination-1", "jwt-admin")
            : path.endsWith("queue-1")
              ? client.removeDailyQueueEntry("queue-1", "jwt-admin")
              : client.queueDailyChallenge({ challengeId: "challenge-0002", flavor: "hard" }, "jwt-admin");

    await expect(request).rejects.toMatchObject({ code: "invalid_response", status: 502 });
  });

  it("invalidates an in-flight catalog request after create and Daily administration mutations", async () => {
    const pendingCatalogs: Array<ReturnType<typeof deferred<Response>>> = [];
    let catalogReads = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = String(input);
      const method = init?.method ?? "GET";
      if (requestUrl === `${apiOrigin}/api/v2/challenges` && method === "GET") {
        catalogReads += 1;
        if (catalogReads % 2 === 1) {
          const pending = deferred<Response>();
          pendingCatalogs.push(pending);
          return pending.promise;
        }
        return Response.json({ challenges: [] });
      }
      if (requestUrl.includes("/approve") || requestUrl.includes("/daily-queue")) {
        return Response.json(validDailyQueueEntry());
      }
      if (requestUrl.includes("/decline")) return Response.json(validDailyNomination());
      return Response.json(validCreateOutcome());
    });
    const client = createVWikiRaceApiClient(fetchImpl, { apiOrigin });
    const mutations = [
      () => client.createChallenge({ startTitle: "Mars", targetTitle: "Water" }, "jwt-admin"),
      () => client.approveDailyNomination("nomination-1", { flavor: "weird" }, "jwt-admin"),
      () => client.declineDailyNomination("nomination-1", "jwt-admin"),
      () => client.queueDailyChallenge({ challengeId: "challenge-0002", flavor: "hard" }, "jwt-admin"),
      () => client.removeDailyQueueEntry("queue-1", "jwt-admin"),
    ];

    for (const mutate of mutations) {
      const staleCatalog = client.listChallenges();
      await vi.waitFor(() => expect(catalogReads % 2).toBe(1));
      await mutate();
      await expect(client.listChallenges()).resolves.toEqual([]);
      pendingCatalogs.shift()?.resolve(Response.json({ challenges: [] }));
      await staleCatalog;
    }

    expect(catalogReads).toBe(10);
  });

  it("deduplicates concurrent catalog and leaderboard reads by resolved URL", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/leaderboard")) {
        return Response.json({ leaderboard: [] });
      }
      return Response.json({ challenges: [] });
    });
    const client = createVWikiRaceApiClient(fetchImpl, { apiOrigin });

    await Promise.all([
      client.listChallenges(),
      client.listChallenges(),
      client.listLeaderboard("challenge-0001"),
      client.listLeaderboard("challenge-0001"),
    ]);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledWith(
      `${apiOrigin}/api/v2/challenges`,
      expect.anything(),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      `${apiOrigin}/api/v2/challenges/challenge-0001/leaderboard`,
      expect.anything(),
    );
  });

  it("rejects malformed challenge entries instead of exposing them to React", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ challenges: [{ id: 42 }] }));
    const client = createVWikiRaceApiClient(fetchImpl, { apiOrigin });

    await expect(client.listChallenges()).rejects.toMatchObject({
      code: "invalid_response",
      status: 502,
    });
  });

  it("accepts coherent manual, daily, and legacy curated challenge provenance", async () => {
    const challenges = [
      validChallenge(),
      { ...validChallenge(), id: "challenge-manual", origin: "manual", dailyDate: null },
      {
        ...validChallenge(),
        id: "challenge-daily",
        origin: "daily",
        source: "wikipedia_random",
        dailyDate: "2026-07-15",
      },
    ];
    const client = createVWikiRaceApiClient(
      vi.fn(async () => Response.json({ challenges })),
      { apiOrigin },
    );

    await expect(client.listChallenges()).resolves.toEqual(challenges);
  });

  it("accepts a manual, randomly-sourced challenge (Increment 5: POST /api/v2/challenges/random)", async () => {
    // d1TrackingRepository's mapChallengeRow: a random-challenge creation
    // has no dailyFeature/dailyDate but DOES carry `source: "wikipedia_random"`
    // - distinct from both a typed-in manual challenge (source: "curated")
    // and an actual Daily (origin: "daily", a real calendar date).
    const challenge = {
      ...validChallenge(),
      id: "challenge-random-1",
      origin: "manual",
      source: "wikipedia_random",
      dailyDate: null,
    };
    const client = createVWikiRaceApiClient(
      vi.fn(async () => Response.json({ challenges: [challenge] })),
      { apiOrigin },
    );

    await expect(client.listChallenges()).resolves.toEqual([challenge]);
  });

  it.each([
    ["Daily feature mode", {
      mode: "solo",
      origin: "daily",
      source: "curated",
      dailyDate: "2026-07-18",
      dailyFeature: {
        dailyDate: "2026-07-18",
        flavor: "weird",
        selectionSource: "community",
      },
    }],
    ["daily source", { origin: "daily", source: "curated", dailyDate: "2026-07-15" }],
    ["daily date omission", { origin: "daily", source: "wikipedia_random" }],
    ["daily date format", { origin: "daily", source: "wikipedia_random", dailyDate: "2026-7-15" }],
    ["daily calendar date", { origin: "daily", source: "wikipedia_random", dailyDate: "2026-02-30" }],
    ["manual daily date (curated)", { origin: "manual", source: "curated", dailyDate: "2026-07-15" }],
    ["manual daily date (random)", { origin: "manual", source: "wikipedia_random", dailyDate: "2026-07-15" }],
    ["legacy source", { source: "wikipedia_random" }],
    ["legacy daily date", { source: "curated", dailyDate: "2026-07-15" }],
    ["unknown origin", { origin: "scheduled", source: "wikipedia_random", dailyDate: "2026-07-15" }],
  ])("rejects incoherent %s provenance", async (_case, override) => {
    const client = createVWikiRaceApiClient(
      vi.fn(async () => Response.json({
        challenges: [{ ...validChallenge(), ...override }],
      })),
      { apiOrigin },
    );

    await expect(client.listChallenges()).rejects.toMatchObject({
      code: "invalid_response",
      status: 502,
    });
  });

  it.each([
    ["mode", { mode: "tournament" }],
    ["ruleset", { ruleset: "casual" }],
    ["source", { source: "submitted" }],
    ["article pageId", { start: { title: "Mars", pageId: "123" } }],
    ["label", { label: 42 }],
    ["sortOrder", { sortOrder: "2" }],
    ["isActive", { isActive: "yes" }],
    ["dateKey", { dateKey: 20260714 }],
    ["creator fields", {
      createdBy: { accountId: "acc-1", identityStatus: "claimed" },
    }],
    ["creator identityStatus", {
      createdBy: {
        accountId: "acc-1",
        displayName: "Casey",
        identityStatus: "admin",
      },
    }],
  ])("rejects a challenge with malformed %s", async (_field, override) => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ challenges: [{ ...validChallenge(), ...override }] }),
    );
    const client = createVWikiRaceApiClient(fetchImpl, { apiOrigin });

    await expect(client.listChallenges()).rejects.toMatchObject({
      code: "invalid_response",
      status: 502,
    });
  });

  it("adds an idempotency key to retryable v2 mutations", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        challenge: {
          id: "challenge-0002",
          label: "Challenge #2",
          mode: "daily",
          start: { title: "Mars" },
          target: { title: "Water" },
          ruleset: "ranked_classic",
          source: "curated",
        },
        disposition: "created",
        nomination: "not_requested",
      }),
    );
    const client = createVWikiRaceApiClient(fetchImpl, { apiOrigin });

    await client.createChallenge(
      { startTitle: "Mars", targetTitle: "Water" },
      "jwt-claimed",
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      `${apiOrigin}/api/v2/challenges`,
      expect.objectContaining({
        headers: expect.objectContaining({
          "Idempotency-Key": expect.any(String),
        }),
      }),
    );
  });

  it("reuses one deterministic idempotency key across separate abandon calls", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({
      runId: "globally-unique-run-1",
      runStatus: "abandoned",
    }));
    const client = createVWikiRaceApiClient(fetchImpl, { apiOrigin });

    await client.abandonRun("globally-unique-run-1", "jwt-claimed");
    await client.abandonRun("globally-unique-run-1", "jwt-claimed");

    const keys = fetchImpl.mock.calls.map(([, init]) =>
      (init?.headers as Record<string, string> | undefined)?.["Idempotency-Key"]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toContain("globally-unique-run-1");
    expect(fetchImpl.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({}));
  });

  it("authenticates both active-run recovery paths and completed-run disclosure paths", async () => {
    // FB-4 (council 2026-07-19, owner decision 10): completed-run
    // disclosure stopped being public this package - the server's own
    // viewer-finished guard (getPublicRunPath's doc comment,
    // trackingRepository.ts) needs a real bearer token, since a
    // board-visible placement's `runId` is now discoverable via a totally
    // public, unauthenticated board fetch.
    const fetchImpl = vi.fn(async () => Response.json({ path: [] }));
    const client = createVWikiRaceApiClient(fetchImpl, { apiOrigin });

    await expect(client.getActiveRunPath("run-active", "jwt-owner")).resolves.toEqual([]);
    await expect(client.getRunPath("run-completed", "jwt-viewer")).resolves.toEqual([]);

    expect(fetchImpl).toHaveBeenCalledWith(
      `${apiOrigin}/api/v2/runs/run-active/recovery-path`,
      expect.objectContaining({
        headers: { Authorization: "Bearer jwt-owner" },
      }),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      `${apiOrigin}/api/v2/runs/run-completed/path`,
      expect.objectContaining({
        headers: { Authorization: "Bearer jwt-viewer" },
      }),
    );
  });

  it("rejects malformed run, leaderboard, and path rows", async () => {
    const responses = [
      Response.json({ run: { id: "run-1" } }),
      Response.json({ leaderboard: [{}] }),
      Response.json({ path: [{}] }),
    ];
    const fetchImpl = vi.fn(async () => responses.shift() ?? Response.json({}));
    const client = createVWikiRaceApiClient(fetchImpl, { apiOrigin });

    await expect(
      client.startRun({ challengeId: "challenge-0001" }, "jwt-claimed"),
    ).rejects.toMatchObject({ code: "invalid_response", status: 502 });
    await expect(client.listLeaderboard("challenge-0001"))
      .rejects.toMatchObject({ code: "invalid_response", status: 502 });
    await expect(client.getRunPath("run-1", "jwt-claimed"))
      .rejects.toMatchObject({ code: "invalid_response", status: 502 });
  });

  it("requires leaderboard provenance and accepts historical runs", async () => {
    const historical = {
      rank: 1,
      runId: "run-historical",
      challengeId: "challenge-0001",
      accountId: "account-1",
      displayName: "franelpana",
      status: "completed",
      isRepeatRun: false,
      startedAt: "2026-07-14T01:00:00.000Z",
      elapsedMs: 413077,
      clickCount: 14,
      completedAt: "2026-07-14T01:06:53.077Z",
      protocolVersion: 1,
    };
    const dnf = {
      ...historical,
      rank: 2,
      runId: "run-dnf",
      status: "abandoned",
      isRepeatRun: true,
      elapsedMs: 180_000,
      clickCount: 3,
      completedAt: undefined,
      abandonedAt: "2026-07-14T01:03:00.000Z",
      protocolVersion: 2,
    };
    const responses = [
      Response.json({ leaderboard: [historical, dnf] }),
      Response.json({ leaderboard: [{ ...historical, protocolVersion: undefined }] }),
    ];
    const fetchImpl = vi.fn(async () => responses.shift() ?? Response.json({}));
    const client = createVWikiRaceApiClient(fetchImpl, { apiOrigin });

    await expect(client.listLeaderboard("challenge-0001")).resolves.toEqual([
      historical,
      dnf,
    ]);
    await expect(client.listLeaderboard("challenge-0001"))
      .rejects.toMatchObject({ code: "invalid_response", status: 502 });
  });

  it("fetches the daily board with placements and DNFs", async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      challengeId: "challenge-0001",
      placements: [
        { accountId: "acc-1", displayName: "Vijay", placement: 1, elapsedMs: 4_000, clickCount: 3 },
      ],
      dnfs: [
        { accountId: "acc-2", displayName: null, clickCount: 2, elapsedMs: 2_000 },
      ],
    }));
    const client = createVWikiRaceApiClient(fetchImpl, { apiOrigin });

    await expect(client.getChallengeBoard("challenge-0001")).resolves.toEqual({
      challengeId: "challenge-0001",
      placements: [
        { accountId: "acc-1", displayName: "Vijay", placement: 1, elapsedMs: 4_000, clickCount: 3 },
      ],
      dnfs: [
        { accountId: "acc-2", displayName: null, clickCount: 2, elapsedMs: 2_000 },
      ],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `${apiOrigin}/api/v2/challenges/challenge-0001/board`,
      expect.anything(),
    );
  });

  it("rejects a malformed daily board response", async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      challengeId: "challenge-0001",
      placements: [{ accountId: "acc-1" }],
      dnfs: [],
    }));
    const client = createVWikiRaceApiClient(fetchImpl, { apiOrigin });

    await expect(client.getChallengeBoard("challenge-0001"))
      .rejects.toMatchObject({ code: "invalid_response", status: 502 });
  });

  it.each(["completed", "abandoned"] as const)(
    "rejects a %s run from start-run responses",
    async (status) => {
      const fetchImpl = vi.fn(async () => Response.json({
        run: { ...validActiveRun(), status },
      }));
      const client = createVWikiRaceApiClient(fetchImpl, { apiOrigin });

      await expect(client.startRun(
        { challengeId: "challenge-0001" },
        "jwt-claimed",
      )).rejects.toMatchObject({ code: "invalid_response", status: 502 });
    },
  );

  it("accepts only null or exactly active responses from active discovery", async () => {
    const activeRun = {
      id: "run-1",
      challengeId: "challenge-0001",
      accountId: "acc-1",
      canonicalAccountId: "acc-1",
      status: "active",
      startTitle: "Moon",
      targetTitle: "Gravity",
      clickCount: 0,
      startedAt: "2026-07-14T01:00:00.000Z",
      protocolVersion: 2,
    };
    const validResponses = [
      Response.json({ run: null }),
      Response.json({ run: activeRun }),
    ];
    const validClient = createVWikiRaceApiClient(
      vi.fn(async () => validResponses.shift() as Response),
      { apiOrigin },
    );
    await expect(validClient.getActiveRun("jwt")).resolves.toBeNull();
    await expect(validClient.getActiveRun("jwt")).resolves.toMatchObject({ status: "active" });

    for (const run of [
      { ...activeRun, status: "completed" },
      { ...activeRun, status: "abandoned" },
      { ...activeRun, status: undefined },
    ]) {
      const client = createVWikiRaceApiClient(
        vi.fn(async () => Response.json({ run })),
        { apiOrigin },
      );
      await expect(client.getActiveRun("jwt")).rejects.toMatchObject({
        code: "invalid_response",
        status: 502,
      });
    }
  });

  it("uses 10 second read and 15 second mutation timeouts", async () => {
    await expectFirstAttemptTimeout("read", 10_000);
    await expectFirstAttemptTimeout("mutation", 15_000);
  });

  it("caches resolved lazy paths and account stats, then invalidates stats on mutation", async () => {
    const stats = {
      totals: {
        attempts: 1,
        completed: 1,
        abandoned: 0,
        timedCompleted: 1,
        totalClicks: 2,
        bestClicks: 2,
        bestElapsedMs: 1500,
        averageClicks: 2,
        averageElapsedMs: 1500,
      },
      topStarts: [],
      topTargets: [],
      mostVisited: [],
      dailyStreak: 0,
      trend30: { avgPlacement: null, playedCount: 0, ranked: false, guard: 10 },
    };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const requestUrl = String(input);
      if (requestUrl.endsWith("/path")) {
        return Response.json({ path: [] });
      }
      if (requestUrl.endsWith("/stats")) {
        return Response.json({ stats });
      }
      if (requestUrl.endsWith("/abandon")) {
        return Response.json({ runId: "run-1", runStatus: "abandoned" });
      }
      throw new Error(`Unexpected request ${requestUrl}`);
    });
    const client = createVWikiRaceApiClient(fetchImpl, { apiOrigin });

    await client.getRunPath("run-1", "jwt-claimed");
    await client.getRunPath("run-1", "jwt-claimed");
    await client.getAccountStats("jwt-claimed");
    await client.getAccountStats("jwt-claimed");
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    await client.abandonRun("run-1", "jwt-claimed", { recoveryProtocolVersion: 1 });
    await client.getAccountStats("jwt-claimed");
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(fetchImpl).toHaveBeenCalledWith(
      `${apiOrigin}/api/v2/runs/run-1/abandon`,
      expect.objectContaining({
        body: JSON.stringify({ recoveryProtocolVersion: 1 }),
      }),
    );
  });

  it("obsoletes pending stats reads when a mutation succeeds", async () => {
    const oldStatsResponse = deferred<Response>();
    const freshStatsResponse = deferred<Response>();
    let statsRequests = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const requestUrl = String(input);
      if (requestUrl.endsWith("/stats")) {
        statsRequests += 1;
        return statsRequests === 1
          ? oldStatsResponse.promise
          : freshStatsResponse.promise;
      }
      if (requestUrl.endsWith("/abandon")) {
        return Response.json({ runId: "run-1", runStatus: "abandoned" });
      }
      throw new Error(`Unexpected request ${requestUrl}`);
    });
    const client = createVWikiRaceApiClient(fetchImpl, { apiOrigin });
    const oldRead = client.getAccountStats("jwt-claimed");
    await vi.waitFor(() => expect(statsRequests).toBe(1));

    await client.abandonRun("run-1", "jwt-claimed");
    const freshRead = client.getAccountStats("jwt-claimed");
    await vi.waitFor(() => expect(statsRequests).toBe(2));
    freshStatsResponse.resolve(Response.json({ stats: accountStats(2) }));
    await expect(freshRead).resolves.toMatchObject({ totals: { attempts: 2 } });

    oldStatsResponse.resolve(Response.json({ stats: accountStats(1) }));
    await expect(oldRead).resolves.toMatchObject({ totals: { attempts: 1 } });
    await expect(client.getAccountStats("jwt-claimed")).resolves.toMatchObject({
      totals: { attempts: 2 },
    });
    expect(statsRequests).toBe(2);
  });

  it("requires numeric zero averages in empty account stats", async () => {
    const validClient = createVWikiRaceApiClient(
      vi.fn(async () => Response.json({ stats: accountStats(0) })),
      { apiOrigin },
    );
    await expect(validClient.getAccountStats("jwt")).resolves.toMatchObject({
      totals: { averageClicks: 0, averageElapsedMs: 0 },
    });

    const invalidClient = createVWikiRaceApiClient(
      vi.fn(async () => Response.json({
        stats: {
          ...accountStats(0),
          totals: {
            ...accountStats(0).totals,
            averageClicks: null,
            averageElapsedMs: null,
          },
        },
      })),
      { apiOrigin },
    );
    await expect(invalidClient.getAccountStats("jwt")).rejects.toMatchObject({
      code: "invalid_response",
      status: 502,
    });
  });

  it("rejects account stats missing the Increment 4 streak/trend30 fields", async () => {
    const { dailyStreak: _streak, trend30: _trend30, ...withoutTrend } = accountStats(0);
    const client = createVWikiRaceApiClient(
      vi.fn(async () => Response.json({ stats: withoutTrend })),
      { apiOrigin },
    );
    await expect(client.getAccountStats("jwt")).rejects.toMatchObject({
      code: "invalid_response",
      status: 502,
    });
  });

  it("fetches and validates Boards' rolling-trend response", async () => {
    const trends = {
      window: "7" as const,
      guard: 3,
      ranked: [
        { accountId: "acc-1", displayName: "Vijay", avgPlacement: 1.3, playedCount: 3 },
      ],
      unranked: [
        { accountId: "acc-2", displayName: "Casey", playedCount: 1 },
      ],
    };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(`${apiOrigin}/api/v2/boards/trends?window=7`);
      return Response.json(trends);
    });
    const client = createVWikiRaceApiClient(fetchImpl, { apiOrigin });

    await expect(client.getBoardsTrends("7")).resolves.toEqual(trends);
  });

  it("rejects a malformed Boards trend response", async () => {
    const client = createVWikiRaceApiClient(
      vi.fn(async () => Response.json({ window: "7", guard: 3, ranked: [{}], unranked: [] })),
      { apiOrigin },
    );
    await expect(client.getBoardsTrends("7")).rejects.toMatchObject({
      code: "invalid_response",
      status: 502,
    });
  });

  it("PKG-14: fetches and validates Lifetime's roster - absent entirely on 7d/30d, present on lifetime", async () => {
    const withoutRoster = { window: "7" as const, guard: 3, ranked: [], unranked: [] };
    const withRoster = {
      window: "lifetime" as const,
      guard: 2,
      ranked: [],
      unranked: [],
      roster: [
        { accountId: "acc-fran", displayName: "FranTheGreat", racesStarted: 1, finishes: 0, wins: 0 },
        { accountId: "acc-loller", displayName: "lollerskates", racesStarted: 2, finishes: 2, wins: 1 },
      ],
    };
    const client = createVWikiRaceApiClient(
      vi.fn(async (input: RequestInfo | URL) =>
        Response.json(String(input).includes("window=lifetime") ? withRoster : withoutRoster)),
      { apiOrigin },
    );

    await expect(client.getBoardsTrends("7")).resolves.toEqual(withoutRoster);
    await expect(client.getBoardsTrends("lifetime")).resolves.toEqual(withRoster);
  });

  it("rejects a Boards trend response whose roster entry is missing a count field", async () => {
    const client = createVWikiRaceApiClient(
      vi.fn(async () => Response.json({
        window: "lifetime", guard: 2, ranked: [], unranked: [],
        roster: [{ accountId: "acc-1", displayName: "Vijay", racesStarted: 1, finishes: 1 }],
      })),
      { apiOrigin },
    );
    await expect(client.getBoardsTrends("lifetime")).rejects.toMatchObject({
      code: "invalid_response",
      status: 502,
    });
  });

  it("preserves Retry-After for quota responses", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({
        error: { code: "challenge_create_daily_limit", message: "Daily limit reached." },
      }),
      {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "45" },
      },
    ));
    const client = createVWikiRaceApiClient(fetchImpl, { apiOrigin });

    await expect(client.createChallenge(
      { startTitle: "Mars", targetTitle: "Water" },
      "jwt-claimed",
    )).rejects.toMatchObject({
      code: "challenge_create_daily_limit",
      status: 429,
      retryAfterMs: 45_000,
    });
  });

  it("fetches Browse's per-challenge summary aggregate (Increment 5)", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(`${apiOrigin}/api/v2/challenges/summary`);
      return Response.json({
        challenges: [
          { challengeId: "challenge-0001", playerCount: 5, best: { elapsedMs: 38_000, clickCount: 5 } },
          { challengeId: "challenge-0002", playerCount: 2, best: null },
        ],
      });
    });
    const client = createVWikiRaceApiClient(fetchImpl, { apiOrigin });

    await expect(client.getChallengesSummary()).resolves.toEqual([
      { challengeId: "challenge-0001", playerCount: 5, best: { elapsedMs: 38_000, clickCount: 5 } },
      { challengeId: "challenge-0002", playerCount: 2, best: null },
    ]);
  });

  it("rejects a malformed challenges-summary response", async () => {
    const client = createVWikiRaceApiClient(
      vi.fn(async () => Response.json({ challenges: [{ challengeId: "challenge-0001" }] })),
      { apiOrigin },
    );
    await expect(client.getChallengesSummary()).rejects.toMatchObject({
      code: "invalid_response",
      status: 502,
    });
  });

  it("fetches the caller's bulk state-chip outcomes (Increment 5, authenticated)", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`${apiOrigin}/api/v2/account/challenge-outcomes`);
      expect(init?.headers).toMatchObject({ Authorization: "Bearer jwt-claimed" });
      return Response.json({
        outcomes: [
          { challengeId: "challenge-0001", outcome: "completed", best: { elapsedMs: 42_000, clickCount: 6 } },
          { challengeId: "challenge-0002", outcome: "dnf", best: null },
        ],
      });
    });
    const client = createVWikiRaceApiClient(fetchImpl, { apiOrigin });

    await expect(client.getAccountChallengeOutcomes("jwt-claimed")).resolves.toEqual([
      { challengeId: "challenge-0001", outcome: "completed", best: { elapsedMs: 42_000, clickCount: 6 } },
      { challengeId: "challenge-0002", outcome: "dnf", best: null },
    ]);
  });

  it("rejects a completed outcome missing its best time/clicks, and a dnf outcome carrying one", async () => {
    const missingBest = createVWikiRaceApiClient(
      vi.fn(async () => Response.json({
        outcomes: [{ challengeId: "challenge-0001", outcome: "completed", best: null }],
      })),
      { apiOrigin },
    );
    await expect(missingBest.getAccountChallengeOutcomes("jwt")).rejects.toMatchObject({
      code: "invalid_response",
      status: 502,
    });

    const dnfWithBest = createVWikiRaceApiClient(
      vi.fn(async () => Response.json({
        outcomes: [{ challengeId: "challenge-0001", outcome: "dnf", best: { elapsedMs: 1, clickCount: 1 } }],
      })),
      { apiOrigin },
    );
    await expect(dnfWithBest.getAccountChallengeOutcomes("jwt")).rejects.toMatchObject({
      code: "invalid_response",
      status: 502,
    });
  });

  it("fetches the Play-another suggestion, including the null 'started everything' case", async () => {
    const responses = [
      Response.json({ challenge: validChallenge({ id: "challenge-0002" }) }),
      Response.json({ challenge: null }),
    ];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`${apiOrigin}/api/v2/challenges/suggestion`);
      expect(init?.headers).toMatchObject({ Authorization: "Bearer jwt-claimed" });
      return responses.shift() as Response;
    });
    const client = createVWikiRaceApiClient(fetchImpl, { apiOrigin });

    await expect(client.getPlayAnotherSuggestion("jwt-claimed")).resolves.toMatchObject({
      id: "challenge-0002",
    });
    await expect(client.getPlayAnotherSuggestion("jwt-claimed")).resolves.toBeNull();
  });

  it("creates a random challenge with a fresh idempotency key and the extended timeout, invalidating catalog+stats caches", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === `${apiOrigin}/api/v2/challenges/random`) {
        expect(init?.method).toBe("POST");
        expect(init?.body).toBe(JSON.stringify({}));
        expect(init?.headers).toMatchObject({
          Authorization: "Bearer jwt-claimed",
          "Idempotency-Key": expect.any(String),
        });
        return Response.json(validCreateOutcome({ challenge: validChallenge({ id: "challenge-0099" }) }));
      }
      if (path === `${apiOrigin}/api/v2/challenges`) {
        return Response.json({ challenges: [] });
      }
      if (path === `${apiOrigin}/api/v2/accounts/me/stats`) {
        return Response.json({ stats: accountStats(0) });
      }
      throw new Error(`Unexpected request ${path}`);
    });
    const client = createVWikiRaceApiClient(fetchImpl, { apiOrigin });

    // Warm both caches so we can prove the mutation invalidates them.
    await client.listChallenges();
    const statsPromise = client.getAccountStats("jwt-claimed");

    await expect(client.createRandomChallenge("jwt-claimed")).resolves.toMatchObject({
      challenge: { id: "challenge-0099" },
      disposition: "created",
    });
    await statsPromise;

    const catalogCallsBefore = fetchImpl.mock.calls.filter(
      ([input]) => String(input) === `${apiOrigin}/api/v2/challenges`,
    ).length;
    await client.listChallenges();
    expect(fetchImpl.mock.calls.filter(
      ([input]) => String(input) === `${apiOrigin}/api/v2/challenges`,
    ).length).toBeGreaterThan(catalogCallsBefore);
  });

  it("surfaces a 429 in-progress/quota error with Retry-After, and a 503 candidate-unavailable error, from random-challenge creation", async () => {
    const inProgress = createVWikiRaceApiClient(
      vi.fn(async () => new Response(
        JSON.stringify({
          error: {
            code: "random_challenge_in_progress",
            message: "A random challenge request is already in progress for this account.",
          },
        }),
        { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "5" } },
      )),
      { apiOrigin },
    );
    await expect(inProgress.createRandomChallenge("jwt-claimed")).rejects.toMatchObject({
      code: "random_challenge_in_progress",
      status: 429,
      retryAfterMs: 5_000,
    });

    const unavailable = createVWikiRaceApiClient(
      vi.fn(async () => new Response(
        JSON.stringify({
          error: {
            code: "random_challenge_unavailable",
            message: "Could not find a random challenge right now. Try again.",
          },
        }),
        { status: 503, headers: { "Content-Type": "application/json", "Retry-After": "5" } },
      )),
      { apiOrigin },
    );
    await expect(unavailable.createRandomChallenge("jwt-claimed")).rejects.toMatchObject({
      code: "random_challenge_unavailable",
      status: 503,
    });
  });

  it("does not automatically retry a timed-out random-challenge request (a client-side timeout doesn't mean the server stopped)", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        const signal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        });
      });
      const client = createVWikiRaceApiClient(fetchImpl, { apiOrigin });

      const request = client.createRandomChallenge("jwt-claimed");
      const assertion = expect(request).rejects.toMatchObject({ code: "timeout", status: 504 });
      await vi.advanceTimersByTimeAsync(35_000);
      await assertion;
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
  });
});

function accountStats(attempts: number) {
  return {
    totals: {
      attempts,
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
    dailyStreak: 0,
    trend30: { avgPlacement: null, playedCount: 0, ranked: false, guard: 10 },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function expectFirstAttemptTimeout(
  kind: "read" | "mutation",
  timeoutMs: number,
): Promise<void> {
  vi.useFakeTimers();
  const signals: AbortSignal[] = [];
  const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal;
    if (!signal) {
      throw new Error("Expected an abort signal.");
    }
    signals.push(signal);
    if (signals.length > 1) {
      return Promise.resolve(
        kind === "read"
          ? Response.json({ challenges: [] })
          : Response.json(validCreateOutcome()),
      );
    }
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () =>
        reject(new DOMException("Aborted", "AbortError")));
    });
  });
  const client = createVWikiRaceApiClient(fetchImpl, { apiOrigin });
  const request = kind === "read"
    ? client.listChallenges()
    : client.createChallenge(
        { startTitle: "Mars", targetTitle: "Water" },
        "jwt-claimed",
      );

  try {
    await vi.advanceTimersByTimeAsync(timeoutMs - 1);
    expect(signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signals[0]?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(250);
    await request;
  } finally {
    await vi.runAllTimersAsync();
    vi.useRealTimers();
  }
}

function validChallenge(overrides: Record<string, unknown> = {}) {
  return {
    id: "challenge-0002",
    label: "Challenge #2",
    mode: "daily",
    start: { title: "Mars" },
    target: { title: "Water" },
    ruleset: "ranked_classic",
    source: "curated",
    ...overrides,
  };
}

function validCreateOutcome(overrides: Record<string, unknown> = {}) {
  return {
    challenge: validChallenge(),
    disposition: "created",
    nomination: "not_requested",
    ...overrides,
  };
}

function validDailyNomination(overrides: Record<string, unknown> = {}) {
  return {
    id: "nomination-1",
    challengeId: "challenge-0002",
    nominatedByAccountId: "account-1",
    nominatedByDisplayName: "Vijay",
    status: "pending",
    recognizableScore: 80,
    weirdScore: 74,
    hardScore: 48,
    suggestedFlavor: "weird",
    confidence: "high",
    classifierVersion: "editorial-v1",
    reviewedByAccountId: null,
    reviewedAt: null,
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
    ...overrides,
  };
}

function validDailyQueueEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "queue-1",
    challengeId: "challenge-0002",
    nominationId: "nomination-1",
    flavor: "weird",
    source: "community",
    status: "queued",
    queuedByAccountId: "admin-1",
    queuedAt: "2026-07-17T00:00:00.000Z",
    consumedDailyDate: null,
    consumedAt: null,
    updatedAt: "2026-07-17T00:00:00.000Z",
    ...overrides,
  };
}

function validActiveRun() {
  return {
    id: "run-1",
    challengeId: "challenge-0001",
    accountId: "acc-1",
    canonicalAccountId: "acc-1",
    status: "active",
    startTitle: "Moon",
    targetTitle: "Gravity",
    clickCount: 0,
    startedAt: "2026-07-14T01:00:00.000Z",
    protocolVersion: 2,
  };
}
