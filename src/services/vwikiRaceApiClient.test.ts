import { describe, expect, it, vi } from "vitest";
import { createVWikiRaceApiClient } from "./vwikiRaceApiClient";

const apiOrigin = "https://vwikirace-api.example.workers.dev";

describe("VWiki Race API client", () => {
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
    expect(await client.getRunPath("run-1")).toEqual([]);

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
      id: "challenge-0002",
      label: "Challenge #2",
      start: { title: "Mars" },
      target: { title: "Water" },
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

  it.each([
    ["daily source", { origin: "daily", source: "curated", dailyDate: "2026-07-15" }],
    ["daily date omission", { origin: "daily", source: "wikipedia_random" }],
    ["daily date format", { origin: "daily", source: "wikipedia_random", dailyDate: "2026-7-15" }],
    ["daily calendar date", { origin: "daily", source: "wikipedia_random", dailyDate: "2026-02-30" }],
    ["manual source", { origin: "manual", source: "wikipedia_random" }],
    ["manual daily date", { origin: "manual", source: "curated", dailyDate: "2026-07-15" }],
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

  it("authenticates active-run paths while keeping completed disclosure public", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ path: [] }));
    const client = createVWikiRaceApiClient(fetchImpl, { apiOrigin });

    await expect(client.getActiveRunPath("run-active", "jwt-owner")).resolves.toEqual([]);
    await expect(client.getRunPath("run-completed")).resolves.toEqual([]);

    expect(fetchImpl).toHaveBeenCalledWith(
      `${apiOrigin}/api/v2/runs/run-active/recovery-path`,
      expect.objectContaining({
        headers: { Authorization: "Bearer jwt-owner" },
      }),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      `${apiOrigin}/api/v2/runs/run-completed/path`,
      expect.objectContaining({ headers: undefined }),
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
    await expect(client.getRunPath("run-1"))
      .rejects.toMatchObject({ code: "invalid_response", status: 502 });
  });

  it("requires leaderboard provenance and accepts historical runs", async () => {
    const historical = {
      rank: 1,
      runId: "run-historical",
      challengeId: "challenge-0001",
      accountId: "account-1",
      displayName: "franelpana",
      elapsedMs: 413077,
      clickCount: 14,
      completedAt: "2026-07-14T01:06:53.077Z",
      protocolVersion: 1,
    };
    const responses = [
      Response.json({ leaderboard: [historical] }),
      Response.json({ leaderboard: [{ ...historical, protocolVersion: undefined }] }),
    ];
    const fetchImpl = vi.fn(async () => responses.shift() ?? Response.json({}));
    const client = createVWikiRaceApiClient(fetchImpl, { apiOrigin });

    await expect(client.listLeaderboard("challenge-0001")).resolves.toEqual([historical]);
    await expect(client.listLeaderboard("challenge-0001"))
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

    await client.getRunPath("run-1");
    await client.getRunPath("run-1");
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
          : Response.json({ challenge: validChallenge() }),
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

function validChallenge() {
  return {
    id: "challenge-0002",
    label: "Challenge #2",
    mode: "daily",
    start: { title: "Mars" },
    target: { title: "Water" },
    ruleset: "ranked_classic",
    source: "curated",
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
