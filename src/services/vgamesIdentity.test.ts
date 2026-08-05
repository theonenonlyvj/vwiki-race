import { describe, expect, it, vi } from "vitest";
import {
  createVGamesIdentityClient,
  createVGamesIdentityRepository,
  isAccountAlreadySecuredFailure,
  type StorageLike,
  vgamesIdentityErrorMessage,
} from "./vgamesIdentity";
import { ApiRequestError } from "./apiRequest";

const apiOrigin = "https://vwikirace-api.example.workers.dev";

function memoryStorage(): StorageLike {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

function fixedCrypto(): Pick<Crypto, "getRandomValues"> {
  return {
    getRandomValues<T extends ArrayBufferView | null>(array: T): T {
      const bytes = array as Uint8Array;
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = index + 1;
      }
      return array;
    },
  };
}

describe("VGames identity repository", () => {
  const legacySessionStorageKey = `${["viki", "pedia"].join("")}:vgames-session`;

  it("mints and persists a stable 256-bit device credential", () => {
    const storage = memoryStorage();
    const repository = createVGamesIdentityRepository(storage, fixedCrypto());

    expect(repository.getDeviceCredential()).toBe(
      "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
    );
    expect(createVGamesIdentityRepository(storage).getDeviceCredential()).toBe(
      "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
    );
  });

  it("persists and clears the current identity session", () => {
    const storage = memoryStorage();
    const repository = createVGamesIdentityRepository(storage);

    repository.saveSession({
      accountId: "acc-1",
      displayName: "Vijay",
      token: "jwt-1",
      status: "ghost",
    });

    expect(createVGamesIdentityRepository(storage).getSession()).toEqual({
      accountId: "acc-1",
      displayName: "Vijay",
      token: "jwt-1",
      status: "ghost",
    });

    repository.clearSession();

    expect(repository.getSession()).toBeNull();
  });

  // Session durability (owner ask 2026-07-25): the chosen display name
  // outlives the session on purpose - the device credential survives every
  // clear, and guest identity is a get-or-create keyed by it server-side,
  // so the name is the only piece a wipe used to lose.
  it("remembers the last display name across clearSession and repository instances", () => {
    const storage = memoryStorage();
    const repository = createVGamesIdentityRepository(storage);

    expect(repository.getLastDisplayName()).toBeNull();

    repository.saveSession({
      accountId: "acc-1",
      displayName: "Nimbus",
      token: "jwt-1",
      status: "ghost",
    });
    repository.clearSession();

    expect(repository.getSession()).toBeNull();
    expect(repository.getLastDisplayName()).toBe("Nimbus");
    // Survives a full reload (a brand-new repository over the same storage).
    expect(createVGamesIdentityRepository(storage).getLastDisplayName()).toBe("Nimbus");
  });

  it("captures the name from a session written by an older build when clearing it", () => {
    const storage = memoryStorage();
    // Seeded session only - no last-display-name key exists yet (the shape
    // every real device had before this feature shipped).
    storage.setItem(
      "vwiki-race:vgames-session",
      JSON.stringify({ accountId: "acc-1", displayName: "Vijay", token: "jwt-1", status: "claimed" }),
    );
    const repository = createVGamesIdentityRepository(storage);

    // Readable even before any write, via the live-session fallback...
    expect(repository.getLastDisplayName()).toBe("Vijay");

    // ...and durably captured by the clear itself.
    repository.clearSession();
    expect(storage.getItem("vwiki-race:vgames-last-display-name")).toBe("Vijay");
    expect(createVGamesIdentityRepository(storage).getLastDisplayName()).toBe("Vijay");
  });

  it("clears invalid cached sessions", () => {
    const storage = memoryStorage();
    storage.setItem(
      "vwiki-race:vgames-session",
      JSON.stringify({ accountId: "acc-1" }),
    );

    expect(createVGamesIdentityRepository(storage).getSession()).toBeNull();
    expect(storage.getItem("vwiki-race:vgames-session")).toBeNull();
  });

  it("migrates valid legacy sessions to the VWiki Race storage key", () => {
    const storage = memoryStorage();
    storage.setItem(
      legacySessionStorageKey,
      JSON.stringify({
        accountId: "acc-1",
        displayName: "Vijay",
        token: "jwt-guest",
        status: "ghost",
      }),
    );

    expect(createVGamesIdentityRepository(storage).getSession()).toEqual({
      accountId: "acc-1",
      displayName: "Vijay",
      token: "jwt-guest",
      status: "ghost",
    });
    expect(storage.getItem(legacySessionStorageKey)).toBeNull();
    expect(JSON.parse(storage.getItem("vwiki-race:vgames-session") ?? "{}")).toEqual({
      accountId: "acc-1",
      displayName: "Vijay",
      token: "jwt-guest",
      status: "ghost",
    });
  });

  it("keeps identity usable in tab memory when browser storage is blocked", () => {
    const storage: StorageLike = {
      getItem: () => {
        throw new DOMException("Storage blocked", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("Storage blocked", "SecurityError");
      },
      removeItem: () => {
        throw new DOMException("Storage blocked", "SecurityError");
      },
    };
    const repository = createVGamesIdentityRepository(storage, fixedCrypto());

    const credential = repository.getDeviceCredential();
    expect(repository.getDeviceCredential()).toBe(credential);
    expect(repository.getSession()).toBeNull();

    const session = {
      accountId: "acc-1",
      displayName: "Vijay",
      token: "jwt-1",
      status: "claimed" as const,
    };
    repository.saveSession(session);
    expect(repository.getSession()).toEqual(session);

    repository.clearSession();
    expect(repository.getSession()).toBeNull();
  });
});

describe("VGames identity client", () => {
  it("creates a guest through the VWiki Race identity proxy", async () => {
    const fetchImpl = vi.fn(async () => {
      return Response.json({
        accountId: "acc-guest",
        displayName: "Casey",
        token: "jwt-guest",
        status: "ghost",
      });
    });
    const client = createVGamesIdentityClient(fetchImpl, { apiOrigin });

    await expect(
      client.playAsGuest({
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
      `${apiOrigin}/api/v2/identity/guest`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          deviceCredential: "cred-123456789012",
          displayName: "Casey",
        }),
      }),
    );
  });

  it("secures a guest through the VWiki Race identity proxy", async () => {
    const fetchImpl = vi.fn(async () => {
      return Response.json({
        accountId: "acc-claimed",
        displayName: "casey",
        token: "jwt-claimed",
        status: "claimed",
      });
    });
    const client = createVGamesIdentityClient(fetchImpl, { apiOrigin });

    await expect(
      client.secureGuest({
        deviceCredential: "cred-123456789012",
        token: "jwt-guest",
        username: "casey",
        password: "secret-pass",
      }),
    ).resolves.toMatchObject({
      accountId: "acc-claimed",
      displayName: "casey",
      token: "jwt-claimed",
      status: "claimed",
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      `${apiOrigin}/api/v2/identity/secure`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          deviceCredential: "cred-123456789012",
          token: "jwt-guest",
          username: "casey",
          password: "secret-pass",
        }),
      }),
    );
  });

  it("logs in through the VWiki Race identity proxy", async () => {
    const fetchImpl = vi.fn(async () => {
      return Response.json({
        accountId: "acc-claimed",
        displayName: "casey",
        token: "jwt-claimed",
        status: "claimed",
      });
    });
    const client = createVGamesIdentityClient(fetchImpl, { apiOrigin });

    await expect(
      client.login({
        deviceCredential: "cred-123456789012",
        username: "casey",
        password: "secret-pass",
      }),
    ).resolves.toMatchObject({
      accountId: "acc-claimed",
      displayName: "casey",
      token: "jwt-claimed",
      status: "claimed",
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      `${apiOrigin}/api/v2/identity/login`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          deviceCredential: "cred-123456789012",
          username: "casey",
          password: "secret-pass",
        }),
      }),
    );
  });

  it("retries one transient login failure with the same operation key", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: "vgames_identity_unavailable", message: "Try again." } },
          { status: 503 },
        ),
      )
      .mockResolvedValueOnce(Response.json({
        accountId: "acc-claimed",
        displayName: "casey",
        token: "jwt-claimed",
        status: "claimed",
      }));
    const client = createVGamesIdentityClient(fetchImpl, { apiOrigin });

    await expect(client.login({
      deviceCredential: "cred-123456789012",
      username: "casey",
      password: "secret-pass",
    })).resolves.toMatchObject({ accountId: "acc-claimed", status: "claimed" });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const firstHeaders = fetchImpl.mock.calls[0]?.[1]?.headers as Record<string, string>;
    const secondHeaders = fetchImpl.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(firstHeaders["Idempotency-Key"]).toMatch(/\S/);
    expect(secondHeaders["Idempotency-Key"]).toBe(firstHeaders["Idempotency-Key"]);
  });

  it("LR-2: logs in via a 3-attempt ladder (4s/8s/15s), reporting each retry ordinal, on the same operation key", async () => {
    vi.useFakeTimers();
    try {
      const session = {
        accountId: "acc-claimed",
        displayName: "casey",
        token: "jwt-claimed",
        status: "claimed",
      };
      const fetchImpl = vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            const attempt = fetchImpl.mock.calls.length;
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
            if (attempt === 3) {
              resolve(Response.json(session));
            }
          }),
      );
      const onRetry = vi.fn();
      const client = createVGamesIdentityClient(fetchImpl, { apiOrigin });

      const login = client.login(
        {
          deviceCredential: "cred-123456789012",
          username: "casey",
          password: "secret-pass",
        },
        { onRetry },
      );
      const assertion = expect(login).resolves.toMatchObject({
        accountId: "acc-claimed",
        status: "claimed",
      });

      // Attempt 1 is cut at the 4s leash (not 15s) and reports retry
      // ordinal 1.
      await vi.advanceTimersByTimeAsync(4_000);
      expect(onRetry).toHaveBeenNthCalledWith(1, 1);
      await vi.advanceTimersByTimeAsync(650); // jittered gap
      expect(fetchImpl).toHaveBeenCalledTimes(2);

      // Attempt 2 is cut at 8s and reports retry ordinal 2.
      await vi.advanceTimersByTimeAsync(8_000);
      expect(onRetry).toHaveBeenNthCalledWith(2, 2);
      await vi.advanceTimersByTimeAsync(650);
      expect(fetchImpl).toHaveBeenCalledTimes(3);

      // Same idempotency key on all three attempts - one login, however
      // many attempts it takes.
      const keys = fetchImpl.mock.calls.map(
        ([, init]) => (init?.headers as Record<string, string>)["Idempotency-Key"],
      );
      expect(new Set(keys).size).toBe(1);
      expect(keys[0]).toMatch(/\S/);

      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("LR-2: ladders playAsGuest identically, on its own idempotency key", async () => {
    vi.useFakeTimers();
    try {
      const session = {
        accountId: "acc-guest",
        displayName: "Casey",
        token: "jwt-guest",
        status: "ghost",
      };
      const fetchImpl = vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            const attempt = fetchImpl.mock.calls.length;
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
            if (attempt === 2) {
              resolve(Response.json(session));
            }
          }),
      );
      const onRetry = vi.fn();
      const client = createVGamesIdentityClient(fetchImpl, { apiOrigin });

      const guest = client.playAsGuest(
        { deviceCredential: "cred-123456789012", displayName: "Casey" },
        { onRetry },
      );
      const assertion = expect(guest).resolves.toMatchObject({ accountId: "acc-guest" });

      await vi.advanceTimersByTimeAsync(4_000);
      expect(onRetry).toHaveBeenNthCalledWith(1, 1);
      await vi.advanceTimersByTimeAsync(650);
      expect(fetchImpl).toHaveBeenCalledTimes(2);

      const firstHeaders = fetchImpl.mock.calls[0]?.[1]?.headers as Record<string, string>;
      const secondHeaders = fetchImpl.mock.calls[1]?.[1]?.headers as Record<string, string>;
      expect(secondHeaders["Idempotency-Key"]).toBe(firstHeaders["Idempotency-Key"]);

      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("LR-2 (verified non-idempotent): secureGuest keeps a single full-budget attempt with no automatic retry", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          }),
      );
      const client = createVGamesIdentityClient(fetchImpl, { apiOrigin });

      const secure = client.secureGuest({
        deviceCredential: "cred-123456789012",
        token: "jwt-guest",
        username: "casey",
        password: "secret-pass",
      });
      const assertion = expect(secure).rejects.toMatchObject({ code: "timeout" });

      // Keeps the full 15s budget on its one attempt (no 4s/8s ladder leash)
      // - set-credentials+login is a two-step server-side mutation that
      // can't be safely replayed on a client-observed timeout.
      await vi.advanceTimersByTimeAsync(14_999);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);

      await assertion;
      expect(fetchImpl).toHaveBeenCalledTimes(1); // no retry, ever
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces identity API error messages", async () => {
    const fetchImpl = vi.fn(async () => {
      return Response.json(
        { error: { message: "That name is already taken." } },
        { status: 409 },
      );
    });
    const client = createVGamesIdentityClient(fetchImpl, { apiOrigin });

    await expect(
      client.playAsGuest({
        deviceCredential: "cred-123456789012",
        displayName: "Vijay",
      }),
    ).rejects.toThrow("That name is already taken.");
  });

  it("rejects malformed successful identity responses", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ accountId: "acc-guest" }));
    const client = createVGamesIdentityClient(fetchImpl, { apiOrigin });

    await expect(
      client.playAsGuest({
        deviceCredential: "cred-123456789012",
        displayName: "Casey",
      }),
    ).rejects.toMatchObject({ code: "invalid_response", status: 502 });
  });
});

describe("VGames identity error copy", () => {
  it("maps reserved account and guest names to actionable messages", () => {
    expect(
      vgamesIdentityErrorMessage(
        new ApiRequestError("username_taken", "username_taken", 409),
        "fallback",
      ),
    ).toBe("That VGames username is already taken.");
    expect(
      vgamesIdentityErrorMessage(
        new ApiRequestError("name_reserved", "name_reserved", 409),
        "fallback",
      ),
    ).toMatch(/belongs to an existing VGames account/i);
  });

  // LR-2: connectivity-class failures (client-side timeout/network error, or
  // the proxy's own upstream-timeout/-unavailable mapping) used to fall
  // through to the raw pass-through below and surface strings like "VGames
  // identity timed out." verbatim - confusing, developer-facing copy that
  // is exactly what the owner saw in the field. One honest message for all
  // of them now, regardless of which identity flow (login/guest/create)
  // hit it or how many ladder attempts preceded it.
  it.each([
    ["timeout", "API request timed out."],
    ["network_error", "API request could not be completed."],
    ["vgames_identity_timeout", "VGames identity timed out."],
    ["vgames_identity_unavailable", "VGames identity is temporarily unavailable."],
  ])(
    "maps the connectivity-class code %s to one honest message instead of the raw upstream string",
    (code, rawMessage) => {
      expect(
        vgamesIdentityErrorMessage(new ApiRequestError(code, rawMessage, 503), "fallback"),
      ).toBe("VGames identity is having a moment — try once more.");
    },
  );

  // P0 fix (2026-08-05, live report "Rob couldn't create an account"):
  // confirmed live against prod that replaying a successful secureGuest
  // call (same token/username/password) answers viota's own `not_ghost`
  // rejection, not a repeat success - and with no case for it, that raw
  // code used to reach the player verbatim. App.tsx's createVGamesAccount
  // now intercepts this and attempts a login-recovery first (see its own
  // doc comment); this mapping is the defense-in-depth fallback for if that
  // recovery is ever bypassed.
  it("maps the already-secured code to an actionable message instead of the raw 'not_ghost' string", () => {
    expect(isAccountAlreadySecuredFailure(new ApiRequestError("not_ghost", "not_ghost", 409)))
      .toBe(true);
    expect(isAccountAlreadySecuredFailure(new ApiRequestError("invalid_credentials", "invalid_credentials", 401)))
      .toBe(false);
    expect(
      vgamesIdentityErrorMessage(new ApiRequestError("not_ghost", "not_ghost", 409), "fallback"),
    ).toBe("This device already has a VGames account. Log in instead.");
  });

  it("still surfaces the fallback for an unrecognized failed-identity code with no message", () => {
    expect(
      vgamesIdentityErrorMessage(
        new ApiRequestError("vgames_identity_failed", "vgames_identity_failed", 500),
        "fallback",
      ),
    ).toBe("fallback");
  });
});
