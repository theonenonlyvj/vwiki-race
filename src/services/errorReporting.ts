export type ErrorSource = "window" | "unhandledrejection" | "error-boundary" | "manual";

export interface ErrorReportContext {
  /** React's componentStack, when the error was caught by ErrorBoundary. */
  componentStack?: string;
  /** LR-2: extra structured detail appended to the reported stack - e.g.
   *  identity retry-ladder attempt timings - so a stall names itself in
   *  Workers Logs without widening the wire payload's schema. */
  detail?: string;
}

export interface ErrorReporter {
  report(source: ErrorSource, error: unknown, context?: ErrorReportContext): void;
  installGlobalHandlers(target: Window): void;
}

export interface CreateErrorReporterOptions {
  apiOrigin: string;
  fetchImpl?: typeof fetch;
}

const CLIENT_ERROR_PATH = "/api/client-error";
const MAX_REPORTS_PER_PAGE_LOAD = 10;
const FALLBACK_NAME = "Error";
const FALLBACK_MESSAGE = "Unknown error";

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
}: CreateErrorReporterOptions): ErrorReporter {
  const reportedKeys = new Set<string>();
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

  return { report, installGlobalHandlers };
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
