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

// LR-2: ONE internal retry for the vwikirace-api -> VGAMES_IDENTITY
// service-binding hop, on binding failure or a stall - the owner's live
// evidence showed this hop fails in BURSTS server-side, so a client that
// retries against a proxy that never retries itself just burns its own
// ladder attempts on the same still-recovering upstream. 40%/50% of the
// configured `requestTimeoutMs` (4s/5s of the default 10s) keeps the
// worst-case total under the existing single-shot cutoff with headroom,
// and scales correctly if `requestTimeoutMs` is ever reconfigured -
// including in tests, which inject much smaller values for determinism.
function proxyRetryAttemptTimeoutsMs(requestTimeoutMs: number): number[] {
  return [
    Math.max(1, Math.round(requestTimeoutMs * 0.4)),
    Math.max(1, Math.round(requestTimeoutMs * 0.5)),
  ];
}

export function createVGamesIdentityClient(options: {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}): VGamesIdentityClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;

  const requestOnce = async (
    path: string,
    body: unknown,
    init: { token?: string },
    timeoutMs: number,
  ): Promise<unknown> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
          ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const payload = await readJson(response);

      if (!response.ok) {
        const failure = readVGamesError(payload, response.status);
        throw new ApiError(
          failure.code,
          failure.message,
          response.status,
          readRetryAfterSeconds(response.headers),
        );
      }

      return payload;
    } catch (caught) {
      if (caught instanceof ApiError) {
        throw caught;
      }
      if (controller.signal.aborted) {
        throw new ApiError(
          "vgames_identity_timeout",
          "VGames identity timed out.",
          504,
        );
      }
      throw new ApiError(
        "vgames_identity_unavailable",
        "VGames identity is temporarily unavailable.",
        503,
      );
    } finally {
      clearTimeout(timeout);
    }
  };

  const request = async (
    path: string,
    body: unknown,
    init: { token?: string; retryable?: boolean } = {},
  ): Promise<unknown> => {
    const attemptTimeoutsMs = init.retryable
      ? proxyRetryAttemptTimeoutsMs(requestTimeoutMs)
      : [requestTimeoutMs];

    let lastFailure: unknown;
    for (let attempt = 0; attempt < attemptTimeoutsMs.length; attempt += 1) {
      const attemptStartedAt = Date.now();
      try {
        const result = await requestOnce(path, body, init, attemptTimeoutsMs[attempt]);
        logIdentityCall({
          route: path,
          attempt: attempt + 1,
          upstreamMs: Date.now() - attemptStartedAt,
          outcome: "ok",
        });
        return result;
      } catch (caught) {
        lastFailure = caught;
        logIdentityCall({
          route: path,
          attempt: attempt + 1,
          upstreamMs: Date.now() - attemptStartedAt,
          outcome: identityCallOutcome(caught),
        });
        const isLastAttempt = attempt === attemptTimeoutsMs.length - 1;
        if (isLastAttempt || !isProxyRetryable(caught)) {
          throw caught;
        }
      }
    }

    throw lastFailure;
  };

  return {
    async quick(input) {
      const payload = await request(
        "/auth/quick",
        {
          deviceCredential: input.deviceCredential,
          displayName: input.displayName,
          game: "vwiki-race",
        },
        // Naturally idempotent (get-or-create keyed by deviceCredential) -
        // safe for the proxy's own internal retry.
        { retryable: true },
      );
      const auth = readAuthPayload(payload);
      return {
        accountId: auth.accountId,
        displayName: input.displayName,
        token: auth.token,
        status: "ghost",
      };
    },

    // NOT retryable (LR-2 non-goal, verified): `/auth/set-credentials`
    // mutates a unique username/password claim - a retry on a stall can't
    // tell "never reached viota" from "succeeded but the response was
    // lost," and replaying it could surface a false failure for an
    // already-secured guest. The `login()` call just below IS retryable
    // (reused as-is), so secure()'s second step still benefits.
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
      const payload = await request(
        "/auth/login",
        {
          username: input.username,
          password: input.password,
          deviceCredential: input.deviceCredential,
        },
        { retryable: true },
      );
      const auth = readAuthPayload(payload);
      return {
        accountId: auth.accountId,
        displayName: input.username,
        token: auth.token,
        status: "claimed",
      };
    },

    async introspect(token) {
      const payload = await request("/auth/introspect", { token }, { retryable: true });
      return readIntrospectionPayload(payload);
    },
  };
}

/** LR-2: only binding failures/stalls are worth ONE proxy-side retry - a
 *  real upstream answer (bad credentials, a taken username, a malformed
 *  payload) is not, and retrying it would just waste the remaining ladder
 *  budget on a request that will fail the same way again. */
function isProxyRetryable(caught: unknown): boolean {
  return caught instanceof ApiError &&
    (caught.code === "vgames_identity_timeout" || caught.code === "vgames_identity_unavailable");
}

function identityCallOutcome(caught: unknown): string {
  return caught instanceof ApiError ? caught.code : "unknown_error";
}

/** LR-2 telemetry: a structured, greppable line per identity-service-binding
 *  attempt (route/attempt/upstreamMs/outcome) - cheap in Workers Logs, and
 *  the ONLY way a stall gets diagnosed without an owner screenshot next
 *  time the burst-failure pattern recurs. */
function logIdentityCall(fields: {
  route: string;
  attempt: number;
  upstreamMs: number;
  outcome: string;
}): void {
  console.info("vgames_identity_call", JSON.stringify(fields));
}

function readIntrospectionPayload(payload: unknown): VGamesIntrospection {
  if (!payload || typeof payload !== "object" || !("valid" in payload)) {
    throw invalidIdentityResponse();
  }
  if (payload.valid === false) {
    return { valid: false };
  }
  // Authorization keys off `valid` + a well-formed `accountId` + a recognized
  // `status` only. Keep that validation strict. `displayName`/`aliases` are
  // display/re-attribution metadata; tolerate their absence so this stays
  // compatible with viota workers that don't emit them yet (alias
  // re-attribution simply stays dormant until viota ships those fields).
  if (
    payload.valid !== true ||
    !("accountId" in payload) ||
    typeof payload.accountId !== "string" ||
    payload.accountId.trim().length === 0 ||
    !("status" in payload) ||
    (payload.status !== "ghost" && payload.status !== "claimed")
  ) {
    throw invalidIdentityResponse();
  }

  const accountId = payload.accountId;
  const rawDisplayName =
    "displayName" in payload ? payload.displayName : undefined;
  const displayName =
    typeof rawDisplayName === "string" && rawDisplayName.trim().length > 0
      ? rawDisplayName
      : accountId;

  // Invariant: `aliases` are opaque internal merge-graph account UUIDs — they
  // are server-to-server only and must NEVER be serialized into any
  // client-facing response.
  const rawAliases = "aliases" in payload ? payload.aliases : undefined;
  const aliases = Array.isArray(rawAliases)
    ? rawAliases.filter(
        (alias): alias is string =>
          typeof alias === "string" && alias.trim().length > 0,
      )
    : [];

  return {
    valid: true,
    accountId,
    status: payload.status,
    displayName,
    aliases,
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

function readVGamesError(
  payload: unknown,
  status: number,
): { code: string; message: string } {
  if (
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    typeof payload.error === "string" &&
    payload.error.length > 0
  ) {
    return { code: payload.error, message: payload.error };
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
    const code = "code" in payload.error && typeof payload.error.code === "string"
      ? payload.error.code
      : "vgames_identity_failed";
    return { code, message: payload.error.message };
  }

  return {
    code: "vgames_identity_failed",
    message: `VGames identity request failed with status ${status}`,
  };
}

function readRetryAfterSeconds(headers: Headers): number | null {
  const value = headers.get("Retry-After");
  if (!value) {
    return null;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds);
  }

  const retryAt = Date.parse(value);
  return Number.isNaN(retryAt)
    ? null
    : Math.max(Math.ceil((retryAt - Date.now()) / 1_000), 0);
}
