export class ApiRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export type ApiRequestOptions<T> = {
  method?: "GET" | "POST";
  body?: unknown;
  token?: string;
  timeoutMs: number;
  /** Shorter leash for the FIRST attempt only. When an automatic retry is
   *  armed, a first request that has produced no response by this deadline
   *  is almost certainly stalled (cold upstream, dead pooled connection) -
   *  failing over to the retry quickly beats burning the whole `timeoutMs`
   *  budget on it. Ignored when no retry is armed, so a lone attempt always
   *  keeps the full window. Ignored when `attemptTimeoutsMs` is set (the
   *  ladder's own per-attempt timeouts take over). */
  firstAttemptTimeoutMs?: number;
  /** LR-2: ordered per-attempt timeouts driving a full multi-attempt retry
   *  LADDER instead of the single-retry default above. The array's length
   *  sets the attempt count; index 0 is the first attempt's timeout, the
   *  last entry is the final attempt's. Only takes effect when a retry is
   *  armed (`retry` is "read-once", or "idempotent-once" with an
   *  `idempotencyKey`) - a lone attempt always uses `timeoutMs`. Takes
   *  precedence over `firstAttemptTimeoutMs`/the legacy 2-attempt default,
   *  so existing single-retry callers (e.g. MB-1's click leash) are a strict
   *  subset, unaffected unless they opt in. Ladder retries also use a
   *  jittered gap (see `jitteredLadderRetryDelayMs`) instead of the legacy
   *  fixed `DEFAULT_RETRY_DELAY_MS`, so a burst of clients hitting the same
   *  stall don't all retry in lockstep. */
  attemptTimeoutsMs?: number[];
  /** Notified just before each automatic retry starts, with `attempt` set
   *  to the 1-based ordinal of the retry about to fire (1 = the second
   *  attempt overall, 2 = the third, ...) - lets the caller stage honest
   *  progress copy per rung instead of a single undifferentiated "retrying"
   *  flag. Existing callers that only need a boolean can ignore the
   *  argument. */
  onRetry?: (attempt: number) => void;
  retry: "read-once" | "idempotent-once" | "never";
  idempotencyKey?: string;
  validate(value: unknown): value is T;
};

const DEFAULT_RETRY_DELAY_MS = 250;
const MAX_AUTOMATIC_RETRY_DELAY_MS = 2_000;
// LR-2 ladder retries: a wider, jittered gap than the legacy single-retry's
// fixed 250ms. A burst of clients that all stalled on the same recovering
// upstream at once (the owner's live "fails in bursts" evidence) would
// otherwise all retry at the exact same instant if the gap were fixed -
// jitter spreads that load out. Still comfortably under
// MAX_AUTOMATIC_RETRY_DELAY_MS.
const LADDER_RETRY_BASE_DELAY_MS = 500;
const LADDER_RETRY_JITTER_MS = 150;
export const ABSOLUTE_API_URL_MARKER = "VWIKI_ABSOLUTE_API_URL_REQUIRED";

export const defaultApiFetch: typeof fetch = (input, init) =>
  globalThis.fetch(input, init);

export async function requestJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  options: ApiRequestOptions<T>,
): Promise<T> {
  assertAbsoluteApiUrl(url);
  const retryArmed = shouldRetry(options);
  const ladder = retryArmed && options.attemptTimeoutsMs && options.attemptTimeoutsMs.length > 0
    ? options.attemptTimeoutsMs
    : undefined;
  const attempts = ladder ? ladder.length : retryArmed ? 2 : 1;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const attemptTimeoutMs = ladder
      ? ladder[attempt]
      : attempt === 0 && attempts > 1 && options.firstAttemptTimeoutMs !== undefined
        ? options.firstAttemptTimeoutMs
        : options.timeoutMs;
    try {
      return await requestOnce(fetchImpl, url, options, attemptTimeoutMs);
    } catch (caught) {
      const error = toApiRequestError(caught);
      if (attempt + 1 >= attempts || !isRetryable(error, options)) {
        throw error;
      }
      const retryDelayMs = error.retryAfterMs ??
        (ladder ? jitteredLadderRetryDelayMs() : DEFAULT_RETRY_DELAY_MS);
      if (retryDelayMs > MAX_AUTOMATIC_RETRY_DELAY_MS) {
        throw error;
      }
      options.onRetry?.(attempt + 1);
      await delay(retryDelayMs);
    }
  }

  throw new ApiRequestError("request_failed", "API request failed.", 503);
}

function jitteredLadderRetryDelayMs(): number {
  const spread = (Math.random() * 2 - 1) * LADDER_RETRY_JITTER_MS;
  return Math.round(LADDER_RETRY_BASE_DELAY_MS + spread);
}

function assertAbsoluteApiUrl(value: string): void {
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return;
    }
  } catch {
    // Fall through to the typed invariant error.
  }
  throw new ApiRequestError(
    "invalid_url",
    `${ABSOLUTE_API_URL_MARKER}: API requests require an absolute HTTP(S) URL.`,
    500,
  );
}

async function requestOnce<T>(
  fetchImpl: typeof fetch,
  url: string,
  options: ApiRequestOptions<T>,
  attemptTimeoutMs: number = options.timeoutMs,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), attemptTimeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: options.method ?? "GET",
      headers: createHeaders(options),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    const payload = await readResponsePayload(response, response.ok);

    if (!response.ok) {
      throw readApiError(payload, response.status, response.headers);
    }
    if (!options.validate(payload)) {
      throw new ApiRequestError(
        "invalid_response",
        "API response did not match the expected shape.",
        502,
      );
    }

    return payload;
  } catch (caught) {
    if (controller.signal.aborted) {
      throw new ApiRequestError("timeout", "API request timed out.", 504);
    }
    if (caught instanceof ApiRequestError) {
      throw caught;
    }
    throw new ApiRequestError("network_error", "API request could not be completed.", 503);
  } finally {
    clearTimeout(timeout);
  }
}

function createHeaders(options: ApiRequestOptions<unknown>): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }
  if (options.idempotencyKey) {
    headers["Idempotency-Key"] = options.idempotencyKey;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

async function readResponsePayload(response: Response, successful: boolean): Promise<unknown> {
  const contentType = response.headers.get("Content-Type") ?? "";
  if (successful && !contentType.toLowerCase().includes("application/json")) {
    throw new ApiRequestError(
      "invalid_response",
      "API response was not JSON.",
      502,
    );
  }

  const text = await response.text();
  if (!text) {
    if (successful) {
      throw new ApiRequestError(
        "invalid_response",
        "API response body was empty.",
        502,
      );
    }
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    if (successful) {
      throw new ApiRequestError(
        "invalid_response",
        "API response body was invalid JSON.",
        502,
      );
    }
    return null;
  }
}

function readApiError(
  payload: unknown,
  status: number,
  headers: Headers,
): ApiRequestError {
  const error = payload && typeof payload === "object" && "error" in payload
    ? payload.error
    : null;
  const code = error && typeof error === "object" && "code" in error &&
      typeof error.code === "string"
    ? error.code
    : status === 429
      ? "rate_limited"
      : "api_error";
  const message = error && typeof error === "object" && "message" in error &&
      typeof error.message === "string"
    ? error.message
    : `VWiki Race API request failed with status ${status}`;
  return new ApiRequestError(code, message, status, readRetryAfterMs(headers));
}

function readRetryAfterMs(headers: Headers): number | null {
  const retryAfter = headers.get("Retry-After");
  if (!retryAfter) {
    return null;
  }
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1_000);
  }
  const date = Date.parse(retryAfter);
  if (Number.isNaN(date)) {
    return null;
  }
  return Math.max(date - Date.now(), 0);
}

function shouldRetry(options: ApiRequestOptions<unknown>): boolean {
  return options.retry === "read-once" ||
    (options.retry === "idempotent-once" && Boolean(options.idempotencyKey));
}

function isRetryable(
  error: ApiRequestError,
  options: ApiRequestOptions<unknown>,
): boolean {
  if (options.retry === "read-once") {
    return ["network_error", "timeout"].includes(error.code) ||
      [502, 503, 504].includes(error.status);
  }
  return options.retry === "idempotent-once" && Boolean(options.idempotencyKey) &&
    (["network_error", "timeout"].includes(error.code) ||
      [502, 503, 504].includes(error.status));
}

function toApiRequestError(caught: unknown): ApiRequestError {
  return caught instanceof ApiRequestError
    ? caught
    : new ApiRequestError("network_error", "API request could not be completed.", 503);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
