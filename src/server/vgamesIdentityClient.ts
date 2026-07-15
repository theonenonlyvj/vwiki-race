import type { VGamesIdentitySession } from "../services/vgamesIdentity";
import { ApiError } from "./http";

export interface VGamesIdentityClient {
  quick(input: {
    deviceCredential: string;
    displayName: string;
  }): Promise<VGamesIdentitySession>;
  secure(input: {
    deviceCredential: string;
    token: string;
    username: string;
    password: string;
  }): Promise<VGamesIdentitySession>;
  login(input: {
    deviceCredential: string;
    username: string;
    password: string;
  }): Promise<VGamesIdentitySession>;
  introspect(token: string): Promise<VGamesIntrospection>;
}

export type VGamesIntrospection =
  | {
      valid: true;
      accountId: string;
      status: "ghost" | "claimed";
      displayName: string;
      aliases: string[];
    }
  | { valid: false };

export function createVGamesIdentityClient(options: {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}): VGamesIdentityClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");

  const request = async (
    path: string,
    body: unknown,
    init: { token?: string } = {},
  ): Promise<unknown> => {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const payload = await readJson(response);

    if (!response.ok) {
      throw new ApiError(
        "vgames_identity_failed",
        readVGamesError(payload, response.status),
        response.status,
      );
    }

    return payload;
  };

  return {
    async quick(input) {
      const payload = await request("/auth/quick", {
        deviceCredential: input.deviceCredential,
        displayName: input.displayName,
        game: "vwiki-race",
      });
      const auth = readAuthPayload(payload);
      return {
        accountId: auth.accountId,
        displayName: input.displayName,
        token: auth.token,
        status: "ghost",
      };
    },

    async secure(input) {
      await request(
        "/auth/set-credentials",
        {
          username: input.username,
          password: input.password,
        },
        { token: input.token },
      );

      return this.login({
        deviceCredential: input.deviceCredential,
        username: input.username,
        password: input.password,
      });
    },

    async login(input) {
      const payload = await request("/auth/login", {
        username: input.username,
        password: input.password,
        deviceCredential: input.deviceCredential,
      });
      const auth = readAuthPayload(payload);
      return {
        accountId: auth.accountId,
        displayName: input.username,
        token: auth.token,
        status: "claimed",
      };
    },

    async introspect(token) {
      const payload = await request("/auth/introspect", { token });
      return readIntrospectionPayload(payload);
    },
  };
}

function readIntrospectionPayload(payload: unknown): VGamesIntrospection {
  if (!payload || typeof payload !== "object" || !("valid" in payload)) {
    throw invalidIdentityResponse();
  }
  if (payload.valid === false) {
    return { valid: false };
  }
  if (
    payload.valid !== true ||
    !("accountId" in payload) ||
    typeof payload.accountId !== "string" ||
    payload.accountId.trim().length === 0 ||
    !("status" in payload) ||
    (payload.status !== "ghost" && payload.status !== "claimed") ||
    !("displayName" in payload) ||
    typeof payload.displayName !== "string" ||
    payload.displayName.trim().length === 0 ||
    !("aliases" in payload) ||
    !Array.isArray(payload.aliases) ||
    !payload.aliases.every(
      (alias) => typeof alias === "string" && alias.trim().length > 0,
    )
  ) {
    throw invalidIdentityResponse();
  }

  return {
    valid: true,
    accountId: payload.accountId,
    status: payload.status,
    displayName: payload.displayName,
    aliases: payload.aliases,
  };
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

function readAuthPayload(payload: unknown): { accountId: string; token: string } {
  if (
    payload &&
    typeof payload === "object" &&
    "accountId" in payload &&
    typeof payload.accountId === "string" &&
    payload.accountId.length > 0 &&
    "token" in payload &&
    typeof payload.token === "string" &&
    payload.token.length > 0
  ) {
    return {
      accountId: payload.accountId,
      token: payload.token,
    };
  }

  throw invalidIdentityResponse();
}

function invalidIdentityResponse(): ApiError {
  return new ApiError(
    "invalid_vgames_identity_response",
    "VGames identity response was invalid.",
    502,
  );
}

function readVGamesError(payload: unknown, status: number): string {
  if (
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    typeof payload.error === "string" &&
    payload.error.length > 0
  ) {
    return payload.error;
  }
  if (
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    payload.error &&
    typeof payload.error === "object" &&
    "message" in payload.error &&
    typeof payload.error.message === "string"
  ) {
    return payload.error.message;
  }

  return `VGames identity request failed with status ${status}`;
}
