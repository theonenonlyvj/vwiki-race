import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./http";
import { createVGamesIdentityClient } from "./vgamesIdentityClient";

describe("server VGames identity client", () => {
  it("creates VWiki Race ghost accounts through auth quick", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ accountId: "acc-guest", token: "jwt-guest" }),
    );
    const client = createVGamesIdentityClient({
      baseUrl: "https://vgames.example",
      fetchImpl,
    });

    await expect(
      client.quick({
        deviceCredential: "cred-123456789012",
        displayName: "Casey",
      }),
    ).resolves.toEqual({
      accountId: "acc-guest",
      displayName: "Casey",
      token: "jwt-guest",
      status: "ghost",
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://vgames.example/auth/quick",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          deviceCredential: "cred-123456789012",
          displayName: "Casey",
          game: "vwiki-race",
        }),
      }),
    );
  });

  it("secures a guest and refreshes the token through login", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ ok: true }))
      .mockResolvedValueOnce(
        Response.json({ accountId: "acc-claimed", token: "jwt-claimed" }),
      );
    const client = createVGamesIdentityClient({
      baseUrl: "https://vgames.example/",
      fetchImpl,
    });

    await expect(
      client.secure({
        deviceCredential: "cred-123456789012",
        token: "jwt-guest",
        username: "vijay",
        password: "secret-pass",
      }),
    ).resolves.toEqual({
      accountId: "acc-claimed",
      displayName: "vijay",
      token: "jwt-claimed",
      status: "claimed",
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "https://vgames.example/auth/set-credentials",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer jwt-guest",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ username: "vijay", password: "secret-pass" }),
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "https://vgames.example/auth/login",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          username: "vijay",
          password: "secret-pass",
          deviceCredential: "cred-123456789012",
        }),
      }),
    );
  });

  it("logs into an existing secured account", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ accountId: "acc-claimed", token: "jwt-claimed" }),
    );
    const client = createVGamesIdentityClient({
      baseUrl: "https://vgames.example",
      fetchImpl,
    });

    await expect(
      client.login({
        deviceCredential: "cred-123456789012",
        username: "vijay",
        password: "secret-pass",
      }),
    ).resolves.toMatchObject({
      accountId: "acc-claimed",
      displayName: "vijay",
      status: "claimed",
    });
  });

  it("introspects VGames tokens", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        valid: true,
        accountId: "acc-1",
        status: "claimed",
        displayName: "Casey",
        aliases: ["old-casey"],
      }),
    );
    const client = createVGamesIdentityClient({
      baseUrl: "https://vgames.example",
      fetchImpl,
    });

    await expect(client.introspect("jwt-1")).resolves.toEqual({
      valid: true,
      accountId: "acc-1",
      status: "claimed",
      displayName: "Casey",
      aliases: ["old-casey"],
    });
  });

  it("still rejects introspection receipts with an unrecognized status", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        valid: true,
        accountId: "acc-1",
        status: "merged",
        displayName: "Casey",
        aliases: [],
      }),
    );
    const client = createVGamesIdentityClient({
      baseUrl: "https://vgames.example",
      fetchImpl,
    });

    await expect(client.introspect("jwt-1")).rejects.toMatchObject({
      code: "invalid_vgames_identity_response",
      status: 502,
    });
  });

  it("defaults a blank displayName and drops non-string aliases instead of failing", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        valid: true,
        accountId: "acc-1",
        status: "claimed",
        displayName: "   ",
        aliases: [42],
      }),
    );
    const client = createVGamesIdentityClient({
      baseUrl: "https://vgames.example",
      fetchImpl,
    });

    await expect(client.introspect("jwt-1")).resolves.toEqual({
      valid: true,
      accountId: "acc-1",
      status: "claimed",
      displayName: "acc-1",
      aliases: [],
    });
  });

  it("accepts the live viota payload with no displayName or aliases", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        valid: true,
        accountId: "acc-1",
        status: "ghost",
      }),
    );
    const client = createVGamesIdentityClient({
      baseUrl: "https://vgames.example",
      fetchImpl,
    });

    await expect(client.introspect("jwt-1")).resolves.toEqual({
      valid: true,
      accountId: "acc-1",
      status: "ghost",
      displayName: "acc-1",
      aliases: [],
    });
  });

  it("preserves VGames error codes for the consumer", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ error: "username_taken" }, { status: 409 }),
    );
    const client = createVGamesIdentityClient({
      baseUrl: "https://vgames.example",
      fetchImpl,
    });

    await expect(
      client.quick({
        deviceCredential: "cred-123456789012",
        displayName: "Casey",
      }),
    ).rejects.toMatchObject({
      code: "username_taken",
      message: "username_taken",
      status: 409,
    });
  });

  it("preserves an upstream Retry-After boundary", async () => {
    const client = createVGamesIdentityClient({
      baseUrl: "https://vgames.example",
      fetchImpl: vi.fn(async () => Response.json(
        { error: "rate_limited" },
        { status: 429, headers: { "Retry-After": "7" } },
      )),
    });

    await expect(client.login({
      deviceCredential: "cred-123456789012",
      username: "vijay",
      password: "secret-pass",
    })).rejects.toMatchObject({
      code: "rate_limited",
      retryAfterSeconds: 7,
      status: 429,
    });
  });

  it("maps a rejected service-binding request to a retryable API error", async () => {
    const client = createVGamesIdentityClient({
      baseUrl: "https://vgames.example",
      fetchImpl: vi.fn(async () => {
        throw new TypeError("binding unavailable");
      }),
    });

    await expect(client.login({
      deviceCredential: "cred-123456789012",
      username: "vijay",
      password: "secret-pass",
    })).rejects.toMatchObject({
      code: "vgames_identity_unavailable",
      status: 503,
    });
  });

  it("aborts a hung service-binding request at the upstream deadline", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(
          Response.json({ accountId: "too-late", token: "too-late" }),
        ), 30);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        });
      }));
    const options = {
      baseUrl: "https://vgames.example",
      fetchImpl,
      requestTimeoutMs: 5,
    };
    const client = createVGamesIdentityClient(options);
    const request = client.login({
      deviceCredential: "cred-123456789012",
      username: "vijay",
      password: "secret-pass",
    });
    const outcome = request.then(
      (value) => ({ status: "resolved" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );

    await vi.advanceTimersByTimeAsync(30);
    expect(await outcome).toMatchObject({
      status: "rejected",
      error: {
        code: "vgames_identity_timeout",
        status: 504,
      },
    });
    vi.useRealTimers();
  });

  it("keeps the upstream deadline active while consuming the response body", async () => {
    vi.useFakeTimers();
    const observed: { bindingSignal: AbortSignal | null } = { bindingSignal: null };
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      observed.bindingSignal = init?.signal ?? null;
      const body = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => {
            controller.error(new DOMException("Aborted", "AbortError"));
          });
        },
      });
      return new Response(body, {
        headers: { "Content-Type": "application/json" },
      });
    });
    const client = createVGamesIdentityClient({
      baseUrl: "https://vgames.example",
      fetchImpl,
      requestTimeoutMs: 5,
    });
    const outcome = client.login({
      deviceCredential: "cred-123456789012",
      username: "vijay",
      password: "secret-pass",
    }).then(
      (value) => ({ status: "resolved" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );

    await vi.advanceTimersByTimeAsync(30);
    expect(observed.bindingSignal?.aborted).toBe(true);
    expect(await outcome).toMatchObject({
      status: "rejected",
      error: {
        code: "vgames_identity_timeout",
        status: 504,
      },
    });
    vi.useRealTimers();
  });

  it("maps a failed response body stream to a retryable API error", async () => {
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.error(new TypeError("binding body failed"));
      },
    }), {
      headers: { "Content-Type": "application/json" },
    }));
    const client = createVGamesIdentityClient({
      baseUrl: "https://vgames.example",
      fetchImpl,
    });

    await expect(client.login({
      deviceCredential: "cred-123456789012",
      username: "vijay",
      password: "secret-pass",
    })).rejects.toMatchObject({
      code: "vgames_identity_unavailable",
      status: 503,
    });
  });

  describe("LR-2: proxy-side retry", () => {
    it("retries login once on a binding failure and succeeds", async () => {
      const fetchImpl = vi
        .fn()
        .mockRejectedValueOnce(new TypeError("binding unavailable"))
        .mockResolvedValueOnce(Response.json({ accountId: "acc-claimed", token: "jwt-claimed" }));
      const client = createVGamesIdentityClient({ baseUrl: "https://vgames.example", fetchImpl });

      await expect(client.login({
        deviceCredential: "cred-123456789012",
        username: "vijay",
        password: "secret-pass",
      })).resolves.toMatchObject({ accountId: "acc-claimed", status: "claimed" });

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(fetchImpl).toHaveBeenNthCalledWith(
        1,
        "https://vgames.example/auth/login",
        expect.anything(),
      );
      expect(fetchImpl).toHaveBeenNthCalledWith(
        2,
        "https://vgames.example/auth/login",
        expect.anything(),
      );
    });

    it("retries guest (quick) and introspect once on a stall", async () => {
      const stallThenSucceed = () => {
        let call = 0;
        return vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
          call += 1;
          if (call === 1) {
            return new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () =>
                reject(new DOMException("Aborted", "AbortError")),
              );
            });
          }
          return Promise.resolve(Response.json({ accountId: "acc-guest", token: "jwt-guest" }));
        });
      };

      vi.useFakeTimers();
      try {
        const quickFetch = stallThenSucceed();
        const quickClient = createVGamesIdentityClient({
          baseUrl: "https://vgames.example",
          fetchImpl: quickFetch,
        });
        const quick = quickClient.quick({
          deviceCredential: "cred-123456789012",
          displayName: "Casey",
        });
        await vi.runAllTimersAsync();
        await expect(quick).resolves.toMatchObject({ accountId: "acc-guest" });
        expect(quickFetch).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }

      vi.useFakeTimers();
      try {
        const introspectFetch = vi
          .fn()
          .mockRejectedValueOnce(new TypeError("binding unavailable"))
          .mockResolvedValueOnce(Response.json({ valid: true, accountId: "acc-1", status: "ghost" }));
        const introspectClient = createVGamesIdentityClient({
          baseUrl: "https://vgames.example",
          fetchImpl: introspectFetch,
        });
        await expect(introspectClient.introspect("jwt-1")).resolves.toMatchObject({
          valid: true,
          accountId: "acc-1",
        });
        expect(introspectFetch).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("never retries a real upstream answer (e.g. invalid credentials)", async () => {
      const fetchImpl = vi.fn(async () =>
        Response.json({ error: "invalid_credentials" }, { status: 401 }),
      );
      const client = createVGamesIdentityClient({ baseUrl: "https://vgames.example", fetchImpl });

      await expect(client.login({
        deviceCredential: "cred-123456789012",
        username: "vijay",
        password: "wrong",
      })).rejects.toMatchObject({ code: "invalid_credentials", status: 401 });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("maps upstream failures to the existing error copy once both attempts are exhausted (no new strings)", async () => {
      const fetchImpl = vi.fn(async () => {
        throw new TypeError("binding unavailable");
      });
      const client = createVGamesIdentityClient({ baseUrl: "https://vgames.example", fetchImpl });

      await expect(client.login({
        deviceCredential: "cred-123456789012",
        username: "vijay",
        password: "secret-pass",
      })).rejects.toMatchObject({
        code: "vgames_identity_unavailable",
        message: "VGames identity is temporarily unavailable.",
        status: 503,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("NOT retried (verified non-idempotent): a set-credentials binding failure fails secure() after exactly one attempt", async () => {
      const fetchImpl = vi.fn(async () => {
        throw new TypeError("binding unavailable");
      });
      const client = createVGamesIdentityClient({ baseUrl: "https://vgames.example", fetchImpl });

      await expect(client.secure({
        deviceCredential: "cred-123456789012",
        token: "jwt-guest",
        username: "vijay",
        password: "secret-pass",
      })).rejects.toMatchObject({ code: "vgames_identity_unavailable", status: 503 });

      // Exactly one call to set-credentials, no retry, and login() (the
      // second step) is never reached once the first step fails.
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl).toHaveBeenCalledWith(
        "https://vgames.example/auth/set-credentials",
        expect.anything(),
      );
    });

    it("logs a structured, greppable line per attempt with route/attempt/upstreamMs/outcome", async () => {
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
      try {
        const fetchImpl = vi
          .fn()
          .mockRejectedValueOnce(new TypeError("binding unavailable"))
          .mockResolvedValueOnce(Response.json({ accountId: "acc-claimed", token: "jwt-claimed" }));
        const client = createVGamesIdentityClient({ baseUrl: "https://vgames.example", fetchImpl });

        await client.login({
          deviceCredential: "cred-123456789012",
          username: "vijay",
          password: "secret-pass",
        });

        const identityLogCalls = infoSpy.mock.calls.filter(([tag]) => tag === "vgames_identity_call");
        expect(identityLogCalls).toHaveLength(2);
        const first = JSON.parse(identityLogCalls[0]![1] as string);
        const second = JSON.parse(identityLogCalls[1]![1] as string);
        expect(first).toMatchObject({
          route: "/auth/login",
          attempt: 1,
          outcome: "vgames_identity_unavailable",
        });
        expect(typeof first.upstreamMs).toBe("number");
        expect(second).toMatchObject({ route: "/auth/login", attempt: 2, outcome: "ok" });
      } finally {
        infoSpy.mockRestore();
      }
    });
  });
});
