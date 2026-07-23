export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type VGamesIdentityStatus = "ghost" | "claimed";

export interface VGamesIdentitySession {
  accountId: string;
  displayName: string;
  token: string;
  status: VGamesIdentityStatus;
}

export interface VGamesIdentityRepository {
  getDeviceCredential(): string;
  getSession(): VGamesIdentitySession | null;
  saveSession(session: VGamesIdentitySession): void;
  clearSession(): void;
}

export interface GuestIdentityInput {
  deviceCredential: string;
  displayName: string;
}

export interface SecureGuestInput {
  deviceCredential: string;
  token: string;
  username: string;
  password: string;
}

export interface LoginInput {
  deviceCredential: string;
  username: string;
  password: string;
}

export interface IdentityRetryHooks {
  /** Fired just before each rung of the automatic retry ladder fires, with
   *  `attempt` set to the 1-based ordinal of the retry about to start (1 =
   *  second attempt overall, 2 = third) - lets the UI stage honest progress
   *  copy per rung instead of a single undifferentiated "retrying" flag. */
  onRetry?: (attempt: number) => void;
}

export interface VGamesIdentityClient {
  playAsGuest(input: GuestIdentityInput, hooks?: IdentityRetryHooks): Promise<VGamesIdentitySession>;
  secureGuest(input: SecureGuestInput): Promise<VGamesIdentitySession>;
  login(input: LoginInput, hooks?: IdentityRetryHooks): Promise<VGamesIdentitySession>;
}

export interface VGamesIdentityClientOptions {
  apiOrigin?: string;
}

// LR-2: codes that mean "we never got a real answer" - a client-side
// timeout/network error, or the proxy's own upstream-timeout/-unavailable
// mapping (src/server/vgamesIdentityClient.ts) - as opposed to a genuine
// response from the identity service (bad credentials, a taken username, a
// malformed payload). These previously fell through to the raw
// pass-through below and surfaced strings like "VGames identity timed
// out." verbatim, which read as a developer error in the field (owner
// screenshots, live burst-failure incident). One honest message instead.
const CONNECTIVITY_FAILURE_CODES = new Set([
  "timeout",
  "network_error",
  "vgames_identity_timeout",
  "vgames_identity_unavailable",
]);

export function isIdentityConnectivityFailure(caught: unknown): boolean {
  const code = caught !== null && typeof caught === "object" && "code" in caught &&
      typeof caught.code === "string"
    ? caught.code
    : null;
  return code !== null && CONNECTIVITY_FAILURE_CODES.has(code);
}

export const IDENTITY_CONNECTIVITY_FAILURE_MESSAGE =
  "VGames identity is having a moment — try once more.";

export function vgamesIdentityErrorMessage(caught: unknown, fallback: string): string {
  if (isIdentityConnectivityFailure(caught)) {
    return IDENTITY_CONNECTIVITY_FAILURE_MESSAGE;
  }

  const code = caught !== null && typeof caught === "object" && "code" in caught &&
      typeof caught.code === "string"
    ? caught.code
    : null;
  const rawMessage = caught instanceof Error ? caught.message : null;
  const identityCode = code === "vgames_identity_failed" ? rawMessage : code;

  switch (identityCode) {
    case "username_taken":
      return "That VGames username is already taken.";
    case "name_reserved":
      return "That name belongs to an existing VGames account. Choose another guest name or log in.";
    case "invalid_credentials":
      return "That VGames username or password is incorrect.";
    case "invalid_username":
      return "Use 3-20 lowercase letters, numbers, or underscores for your VGames username.";
    case "invalid_password":
      return "Use a password between 6 and 128 characters.";
    default:
      return rawMessage && rawMessage !== "vgames_identity_failed"
        ? rawMessage
        : fallback;
  }
}

const CREDENTIAL_STORAGE_KEY = "vwiki-race:vgames-device-credential";
const SESSION_STORAGE_KEY = "vwiki-race:vgames-session";
const LEGACY_APP_KEY = ["viki", "pedia"].join("");
const LEGACY_CREDENTIAL_STORAGE_KEY = `${LEGACY_APP_KEY}:vgames-device-credential`;
const LEGACY_SESSION_STORAGE_KEY = `${LEGACY_APP_KEY}:vgames-session`;

type CryptoLike = Pick<Crypto, "getRandomValues">;

export function createVGamesIdentityRepository(
  storage: StorageLike,
  cryptoLike: CryptoLike = crypto,
): VGamesIdentityRepository {
  let memoryCredential: string | null = null;
  let memorySession: VGamesIdentitySession | null | undefined;
  const safeStorage: StorageLike = {
    getItem(key) {
      try {
        return storage.getItem(key);
      } catch {
        return null;
      }
    },
    setItem(key, value) {
      try {
        storage.setItem(key, value);
      } catch {
        // The in-memory values below keep identity usable for this tab.
      }
    },
    removeItem(key) {
      try {
        storage.removeItem(key);
      } catch {
        // A blocked storage backend cannot retain data written by this session.
      }
    },
  };

  return {
    getDeviceCredential() {
      if (memoryCredential) {
        return memoryCredential;
      }

      const existing = safeStorage.getItem(CREDENTIAL_STORAGE_KEY);
      if (existing) {
        memoryCredential = existing;
        return memoryCredential;
      }

      const legacy = safeStorage.getItem(LEGACY_CREDENTIAL_STORAGE_KEY);
      if (legacy) {
        memoryCredential = legacy;
        safeStorage.setItem(CREDENTIAL_STORAGE_KEY, legacy);
        safeStorage.removeItem(LEGACY_CREDENTIAL_STORAGE_KEY);
        return memoryCredential;
      }

      const bytes = cryptoLike.getRandomValues(new Uint8Array(32));
      memoryCredential = toHex(bytes);
      safeStorage.setItem(CREDENTIAL_STORAGE_KEY, memoryCredential);
      return memoryCredential;
    },

    getSession() {
      if (memorySession !== undefined) {
        return memorySession;
      }

      const session = readSession(safeStorage, SESSION_STORAGE_KEY);
      if (session) {
        memorySession = session;
        return memorySession;
      }

      const legacySession = readSession(safeStorage, LEGACY_SESSION_STORAGE_KEY);
      if (legacySession) {
        safeStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(legacySession));
        safeStorage.removeItem(LEGACY_SESSION_STORAGE_KEY);
      }
      memorySession = legacySession;
      return memorySession;
    },

    saveSession(session) {
      memorySession = session;
      safeStorage.setItem(
        SESSION_STORAGE_KEY,
        JSON.stringify({
          accountId: session.accountId,
          displayName: session.displayName,
          token: session.token,
          status: session.status,
        }),
      );
      safeStorage.removeItem(LEGACY_SESSION_STORAGE_KEY);
    },

    clearSession() {
      memorySession = null;
      safeStorage.removeItem(SESSION_STORAGE_KEY);
      safeStorage.removeItem(LEGACY_SESSION_STORAGE_KEY);
    },
  };
}

import { resolveApiOrigin } from "./apiOrigin";
import { defaultApiFetch, requestJson } from "./apiRequest";

const DEFAULT_API_ORIGIN = resolveApiOrigin(import.meta.env.VITE_VWIKI_RACE_API_URL, {
  production: import.meta.env.PROD,
});

// LR-2: live evidence 2026-07-22 (owner hit the hang LIVE, 4 screenshots,
// worked on the 5th manual attempt) showed the identity hop fails in
// BURSTS spanning more than one stalled request - a single retry (6d54452)
// wasn't always enough. Three widening attempts instead: 4s (same stalled-
// cold-connection leash as 6d54452) -> 8s -> 15s (the original full
// budget, kept last so a genuinely slow-but-alive upstream still gets its
// full window before the ladder gives up). Worst-case time-to-error is
// ~27s (4+8+15, plus two ~500ms jittered gaps) vs. the single-retry's
// ~19s (4+15) - a small worst-case cost for covering a burst that spans
// two stalls, which the live incident showed actually happens.
export const IDENTITY_ATTEMPT_TIMEOUTS_MS = [4_000, 8_000, 15_000];

export function createVGamesIdentityClient(
  fetchImpl: typeof fetch = defaultApiFetch,
  options: VGamesIdentityClientOptions = {},
): VGamesIdentityClient {
  const apiOrigin = options.apiOrigin ?? DEFAULT_API_ORIGIN;
  return {
    playAsGuest(input, hooks) {
      return identityRequest(fetchImpl, `${apiOrigin}/api/v2/identity/guest`, input, {
        idempotencyKey: crypto.randomUUID(),
        retry: "idempotent-once",
        // Naturally idempotent regardless of the Idempotency-Key header:
        // guest creation is a get-or-create keyed by `deviceCredential`
        // server-side ("device_credentials maps the device credential hash
        // to the ghost account", docs/superpowers/specs/
        // 2026-07-14-vgames-identity-v0-design.md) - retrying the SAME
        // deviceCredential+displayName can only ever return the SAME
        // ghost, never mint a second one. Safe to ladder in full (LR-2).
        attemptTimeoutsMs: IDENTITY_ATTEMPT_TIMEOUTS_MS,
        onRetry: hooks?.onRetry,
      });
    },
    // NOT laddered (LR-2 non-goal, verified): this single client call fans
    // out to TWO viota mutations server-side (server/vgamesIdentityClient.ts
    // `secure()`: `/auth/set-credentials` THEN `/auth/login`). A client-
    // observed timeout can't distinguish "never reached the server" from
    // "set-credentials already succeeded but the response was lost" - a
    // retry in the latter case would replay `/auth/set-credentials` for an
    // ALREADY-secured guest, which could surface a false failure (or worse,
    // a misleading "username taken") even though the account was created
    // fine the first time. Unlike `playAsGuest`/`login`, there is no stable
    // natural key here that makes a replay a safe no-op, so this call keeps
    // its original single, full-budget attempt. The create-account flow's
    // OTHER timeout-safe part - bootstrapping an anonymous guest via
    // `playAsGuest` above, when the caller has no session yet - already
    // gets the full ladder.
    secureGuest(input) {
      return identityRequest(fetchImpl, `${apiOrigin}/api/v2/identity/secure`, input);
    },
    login(input, hooks) {
      return identityRequest(
        fetchImpl,
        `${apiOrigin}/api/v2/identity/login`,
        input,
        {
          idempotencyKey: crypto.randomUUID(),
          retry: "idempotent-once",
          // LR-2: full 3-attempt ladder replaces 6d54452's single 4s-leash
          // retry - same Idempotency-Key on every attempt, one login
          // however many attempts it takes.
          attemptTimeoutsMs: IDENTITY_ATTEMPT_TIMEOUTS_MS,
          onRetry: hooks?.onRetry,
        },
      );
    },
  };
}

async function identityRequest(
  fetchImpl: typeof fetch,
  path: string,
  body: unknown,
  options: {
    idempotencyKey?: string;
    retry?: "idempotent-once" | "never";
    firstAttemptTimeoutMs?: number;
    attemptTimeoutsMs?: number[];
    onRetry?: (attempt: number) => void;
  } = {},
): Promise<VGamesIdentitySession> {
  return requestJson(fetchImpl, path, {
    method: "POST",
    body,
    timeoutMs: 15_000,
    firstAttemptTimeoutMs: options.firstAttemptTimeoutMs,
    attemptTimeoutsMs: options.attemptTimeoutsMs,
    onRetry: options.onRetry,
    retry: options.retry ?? "never",
    idempotencyKey: options.idempotencyKey,
    validate: isSession,
  });
}

function isSession(value: unknown): value is VGamesIdentitySession {
  return (
    value !== null &&
    typeof value === "object" &&
    "accountId" in value &&
    typeof value.accountId === "string" &&
    value.accountId.trim().length > 0 &&
    "displayName" in value &&
    typeof value.displayName === "string" &&
    value.displayName.trim().length > 0 &&
    "token" in value &&
    typeof value.token === "string" &&
    value.token.length > 0 &&
    "status" in value &&
    (value.status === "ghost" || value.status === "claimed")
  );
}

function readSession(
  storage: StorageLike,
  storageKey: string,
): VGamesIdentitySession | null {
  const raw = storage.getItem(storageKey);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<VGamesIdentitySession>;
    if (!isSession(parsed)) {
      storage.removeItem(storageKey);
      return null;
    }

    return {
      accountId: parsed.accountId.trim(),
      displayName: parsed.displayName.trim(),
      token: parsed.token,
      status: parsed.status,
    };
  } catch {
    storage.removeItem(storageKey);
    return null;
  }
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
