export type ErrorSource = "window" | "unhandledrejection" | "error-boundary" | "manual";

export interface ErrorReportContext {
  /** React's componentStack, when the error was caught by ErrorBoundary. */
  componentStack?: string;
  /** LR-2: extra structured detail appended to the reported stack - e.g.
   *  identity retry-ladder attempt timings - so a stall names itself in
   *  Workers Logs without widening the wire payload's schema. */
  detail?: string;
}

/**
 * Extra context for a HANDLED, user-visible error (see reportVisibleError
 * below) - deliberately thin: everything wire-bound still flows through the
 * exact same /api/client-error payload shape report() already builds, this
 * just names WHICH flow/account was live when the error rendered.
 */
export interface VisibleErrorContext {
  /** Which step of the surface's flow produced this error, e.g. "guest" /
   *  "create" / "login" for the identity sheet, or "start" / "click" /
   *  "article" / "recovery" / "end-run" for the race flow. Freeform -
   *  appended to the beacon's structured detail, never part of the dedupe
   *  key (that's surface+code only, so varying flow/message text on a
   *  repeat occurrence still dedupes). */
  flow?: string;
  /** The signed-in account id, when a session exists at the point of failure. */
  accountId?: string;
}

export interface ErrorReporter {
  report(source: ErrorSource, error: unknown, context?: ErrorReportContext): void;
  /**
   * Beacons a HANDLED error that was actually rendered to the player - the
   * gap the crash-only report() above never covered (identity-sheet lines,
   * runNotice failures, a "failed" catalog/leaderboard/board tri-state,
   * "I gave up"/graph fetch failures, ...). `surface` names the UI spot that
   * rendered the error (e.g. "identity-sheet", "catalog", "the-solution");
   * `code` is a short, stable machine code (an ApiRequestError's `.code`
   * where one exists - see apiErrorCode below - never the free-text
   * message, which can vary run to run); `message` is the copy actually
   * shown to the player.
   *
   * Never beacons a code the surface's own allowlist marks "expected" (a
   * validation-y user mistake, e.g. bad credentials, a taken username, a
   * rate-limit the UI already presents as normal) - see
   * EXPECTED_VISIBLE_ERROR_CODES. Every other code beacons, deduped per
   * session per (surface, code) so a tri-state stuck re-rendering the same
   * failure (or a retry that fails the same way again) can't itself blow
   * through the server's 20/min client-error rate limit.
   */
  reportVisibleError(
    surface: string,
    code: string,
    message: string,
    context?: VisibleErrorContext,
  ): void;
  installGlobalHandlers(target: Window): void;
}

export interface CreateErrorReporterOptions {
  apiOrigin: string;
  fetchImpl?: typeof fetch;
  /** Override for the bundle-version tag appended to a visible-error beacon's
   *  detail - tests inject a fixed value; production defaults to
   *  VITE_COMMIT_SHA (unset today, so "dev" - matches how apiOrigin.ts's own
   *  VITE_* fallbacks read when a build doesn't set them). */
  bundleVersion?: string;
}

const CLIENT_ERROR_PATH = "/api/client-error";
const MAX_REPORTS_PER_PAGE_LOAD = 10;
const FALLBACK_NAME = "Error";
const FALLBACK_MESSAGE = "Unknown error";

const DEFAULT_BUNDLE_VERSION =
  (import.meta.env.VITE_COMMIT_SHA as string | undefined) || "dev";

/**
 * Surfaces where a "handled" error can be an entirely expected user mistake
 * rather than a bug worth a beacon - e.g. a wrong password on the identity
 * sheet, or the random-challenge button's own rate limit, which the UI
 * already presents as normal "slow down" copy, not a failure. Anything NOT
 * listed here for a given surface (including a surface absent from this map
 * entirely) is treated as unexpected and beacons. Keyed on the same short
 * `.code` values the server/identity client already produce (ApiRequestError
 * codes, or isAccountAlreadySecuredFailure's "not_ghost") - never on message
 * text, which can reword without notice.
 */
const EXPECTED_VISIBLE_ERROR_CODES: Readonly<Record<string, ReadonlySet<string>>> = {
  "identity-sheet": new Set([
    "invalid_credentials",
    "username_taken",
    "name_reserved",
    "invalid_username",
    "invalid_password",
    // Already named in Workers Logs by the existing identity retry-ladder
    // exhaustion beacon (reportIdentityStall, App.tsx) - reporting it again
    // here would just double the same signal under a different code.
    "identity_connectivity",
  ]),
  "random-challenge": new Set([
    "random_challenge_rate_limited",
    "random_challenge_ip_rate_limited",
  ]),
};

function isExpectedVisibleError(surface: string, code: string): boolean {
  return EXPECTED_VISIBLE_ERROR_CODES[surface]?.has(code) ?? false;
}

/**
 * Best-effort, short machine code for a caught value, for reportVisibleError
 * call sites that don't already have a more specific one to hand (e.g. an
 * identity-flow-specific code) - `.code` when the caught value is an
 * ApiRequestError-shaped object (every apiClient/identityClient rejection is
 * one), else a coarse fallback. Never throws.
 */
export function apiErrorCode(caught: unknown): string {
  try {
    if (
      caught !== null &&
      typeof caught === "object" &&
      "code" in caught &&
      typeof (caught as { code: unknown }).code === "string" &&
      (caught as { code: string }).code
    ) {
      return (caught as { code: string }).code;
    }
    if (caught instanceof Error) {
      return `error:${caught.name || FALLBACK_NAME}`;
    }
  } catch {
    // Fall through to the generic code below.
  }
  return "unknown";
}

// Mirror the server's own caps (src/server/worker.ts: clientErrorInput) so an
// oversized payload is truncated here instead of being silently dropped by
// the server's 8 KiB body-size 413 — the beacon swallows all fetch failures,
// so exactly the largest crashes (huge non-Error rejection reasons, deep
// component stacks) would otherwise vanish without a trace.
const MAX_MESSAGE_LENGTH = 512;
const MAX_STACK_LENGTH = 4096;
const MAX_URL_LENGTH = 512;
const MAX_USER_AGENT_LENGTH = 512;

const defaultFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

export function createErrorReporter({
  apiOrigin,
  fetchImpl = defaultFetch,
  bundleVersion = DEFAULT_BUNDLE_VERSION,
}: CreateErrorReporterOptions): ErrorReporter {
  const reportedKeys = new Set<string>();
  const reportedVisibleErrorKeys = new Set<string>();
  let reportCount = 0;
  let handlersInstalled = false;

  function report(source: ErrorSource, error: unknown, context?: ErrorReportContext): void {
    try {
      const described = describeThrowable(error, context);
      const dedupeKey = JSON.stringify([source, described.name, described.message]);
      if (reportedKeys.has(dedupeKey) || reportCount >= MAX_REPORTS_PER_PAGE_LOAD) {
        return;
      }
      reportedKeys.add(dedupeKey);
      reportCount += 1;

      // Truncate every composed, wire-bound string to the server's caps here,
      // after all composition (safeStringify, appendComponentStack) is done,
      // so this single spot covers every source path (window/unhandledrejection/
      // error-boundary/manual).
      const payload = {
        source,
        name: described.name,
        message: described.message.slice(0, MAX_MESSAGE_LENGTH),
        stack: described.stack?.slice(0, MAX_STACK_LENGTH),
        url: readUrl()?.slice(0, MAX_URL_LENGTH),
        userAgent: readUserAgent()?.slice(0, MAX_USER_AGENT_LENGTH),
        ts: new Date().toISOString(),
      };

      fetchImpl(`${apiOrigin}${CLIENT_ERROR_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(() => {
        // Fire-and-forget: a failed beacon must never surface to the app.
      });
    } catch {
      // Reporting must never throw back into the caller, nor recurse.
    }
  }

  function reportVisibleError(
    surface: string,
    code: string,
    message: string,
    context?: VisibleErrorContext,
  ): void {
    try {
      if (isExpectedVisibleError(surface, code)) {
        return;
      }
      // Dedupe on (surface, code) ALONE - deliberately coarser than
      // report()'s own (source, name, message) key just below, so a tri-
      // state that re-renders the identical failure with a slightly
      // different server message (or a retry that fails the same way
      // again) still only ever beacons once per session, respecting the
      // server's 20/min client-error rate limit (namespace 51004).
      const dedupeKey = `${surface} ${code}`;
      if (reportedVisibleErrorKeys.has(dedupeKey)) {
        return;
      }
      reportedVisibleErrorKeys.add(dedupeKey);

      const detail = [
        `visible-error surface=${surface} code=${code}`,
        context?.flow ? `flow=${context.flow}` : null,
        context?.accountId ? `accountId=${context.accountId}` : null,
        `bundle=${bundleVersion}`,
      ].filter((part): part is string => part !== null).join(" ");

      const syntheticError = new Error(message || FALLBACK_MESSAGE);
      syntheticError.name = code || FALLBACK_NAME;
      report("manual", syntheticError, { detail });
    } catch {
      // Reporting must never throw back into the caller, nor recurse.
    }
  }

  function installGlobalHandlers(target: Window): void {
    if (handlersInstalled) {
      return;
    }
    handlersInstalled = true;

    target.addEventListener("error", (event) => {
      report("window", event.error ?? event.message);
    });
    target.addEventListener("unhandledrejection", (event) => {
      report("unhandledrejection", event.reason);
    });
  }

  return { report, reportVisibleError, installGlobalHandlers };
}

function describeThrowable(
  error: unknown,
  context: ErrorReportContext | undefined,
): { name: string; message: string; stack?: string } {
  const base = baseDescription(error);
  return { ...base, stack: appendContextDetails(base.stack, context) };
}

function baseDescription(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      name: error.name || FALLBACK_NAME,
      message: error.message || FALLBACK_MESSAGE,
      stack: typeof error.stack === "string" ? error.stack : undefined,
    };
  }
  if (typeof error === "string" && error) {
    return { name: FALLBACK_NAME, message: error };
  }
  return { name: FALLBACK_NAME, message: safeStringify(error) };
}

function safeStringify(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (serialized && serialized !== "{}" && serialized !== "null") {
      return serialized;
    }
  } catch {
    // Fall through to String() below.
  }
  const stringified = String(value);
  return stringified || FALLBACK_MESSAGE;
}

function appendContextDetails(
  stack: string | undefined,
  context: ErrorReportContext | undefined,
): string | undefined {
  const extras: string[] = [];
  if (context?.componentStack) {
    extras.push(`Component stack:${context.componentStack}`);
  }
  if (context?.detail) {
    extras.push(context.detail);
  }
  if (extras.length === 0) {
    return stack;
  }
  const joined = extras.join("\n\n");
  return stack ? `${stack}\n\n${joined}` : joined;
}

function readUrl(): string | undefined {
  try {
    return `${window.location.pathname}${window.location.search}`;
  } catch {
    return undefined;
  }
}

function readUserAgent(): string | undefined {
  try {
    return window.navigator.userAgent;
  } catch {
    return undefined;
  }
}
