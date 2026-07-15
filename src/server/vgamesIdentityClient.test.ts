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

  it("rejects merged or malformed introspection receipts", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          valid: true,
          accountId: "acc-1",
          status: "merged",
          displayName: "Casey",
          aliases: [],
        }),
      )
      .mockResolvedValueOnce(
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

    await expect(client.introspect("jwt-1")).rejects.toMatchObject({
      code: "invalid_vgames_identity_response",
      status: 502,
    });
    await expect(client.introspect("jwt-2")).rejects.toMatchObject({
      code: "invalid_vgames_identity_response",
      status: 502,
    });
  });

  it("turns VGames failures into API errors", async () => {
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
      code: "vgames_identity_failed",
      status: 409,
    });
  });
});
