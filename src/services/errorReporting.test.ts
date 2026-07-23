import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createErrorReporter } from "./errorReporting";

const apiOrigin = "https://vwikirace-api.example.workers.dev";

function fetchMock() {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(null, { status: 204 }));
}

function jsonBody(fetchImpl: ReturnType<typeof fetchMock>, callIndex = 0) {
  const call = fetchImpl.mock.calls[callIndex];
  const init = call?.[1];
  if (!init) {
    throw new Error("Expected a fetch call with a request init.");
  }
  return JSON.parse(init.body as string);
}

describe("createErrorReporter", () => {
  beforeEach(() => {
    window.history.pushState({}, "", "/race/challenge-1?foo=bar");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("report", () => {
    it("posts the payload shape to /api/client-error with keepalive and no auth header", async () => {
      const fetchImpl = fetchMock();
      const reporter = createErrorReporter({ apiOrigin, fetchImpl });

      reporter.report("manual", new Error("boom"));
      await Promise.resolve();

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0]!;
      if (!init) {
        throw new Error("Expected a fetch call with a request init.");
      }
      expect(url).toBe(`${apiOrigin}/api/client-error`);
      expect(init.method).toBe("POST");
      expect(init.keepalive).toBe(true);
      expect((init.headers as Record<string, string>).Authorization).toBeUndefined();

      const body = jsonBody(fetchImpl);
      expect(body).toMatchObject({
        source: "manual",
        name: "Error",
        message: "boom",
        url: "/race/challenge-1?foo=bar",
      });
      expect(typeof body.stack).toBe("string");
      expect(typeof body.userAgent).toBe("string");
      expect(typeof body.ts).toBe("string");
      expect(() => new Date(body.ts).toISOString()).not.toThrow();
    });

    it("builds a best-effort payload for a non-Error throwable", async () => {
      const fetchImpl = fetchMock();
      const reporter = createErrorReporter({ apiOrigin, fetchImpl });

      reporter.report("manual", "just a string");
      await Promise.resolve();

      const body = jsonBody(fetchImpl);
      expect(typeof body.name).toBe("string");
      expect(body.name.length).toBeGreaterThan(0);
      expect(body.message).toContain("just a string");
    });

    it("never sends an empty name or message even for empty throwables", async () => {
      const fetchImpl = fetchMock();
      const reporter = createErrorReporter({ apiOrigin, fetchImpl });

      reporter.report("manual", new Error(""));
      await Promise.resolve();

      const body = jsonBody(fetchImpl);
      expect(body.name.length).toBeGreaterThan(0);
      expect(body.message.length).toBeGreaterThan(0);
    });

    it("dedupes repeated reports of the same source+name+message", async () => {
      const fetchImpl = fetchMock();
      const reporter = createErrorReporter({ apiOrigin, fetchImpl });

      reporter.report("manual", new Error("boom"));
      reporter.report("manual", new Error("boom"));
      reporter.report("manual", new Error("boom"));
      await Promise.resolve();

      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("still reports errors with the same name+message from a different source", async () => {
      const fetchImpl = fetchMock();
      const reporter = createErrorReporter({ apiOrigin, fetchImpl });

      reporter.report("manual", new Error("boom"));
      reporter.report("window", new Error("boom"));
      await Promise.resolve();

      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("caps reports at 10 per page load", async () => {
      const fetchImpl = fetchMock();
      const reporter = createErrorReporter({ apiOrigin, fetchImpl });

      for (let i = 0; i < 15; i += 1) {
        reporter.report("manual", new Error(`boom-${i}`));
      }
      await Promise.resolve();

      expect(fetchImpl).toHaveBeenCalledTimes(10);
    });

    it("never throws when the fetch implementation rejects", async () => {
      const fetchImpl = vi.fn(async () => {
        throw new Error("network down");
      });
      const reporter = createErrorReporter({ apiOrigin, fetchImpl });

      expect(() => reporter.report("manual", new Error("boom"))).not.toThrow();
      await Promise.resolve();
      await Promise.resolve();
    });

    it("never throws when the fetch implementation itself throws synchronously", () => {
      const fetchImpl = vi.fn(() => {
        throw new Error("synchronous failure");
      });
      const reporter = createErrorReporter({ apiOrigin, fetchImpl: fetchImpl as unknown as typeof fetch });

      expect(() => reporter.report("manual", new Error("boom"))).not.toThrow();
    });

    it("does not throw or recurse when building the payload fails", () => {
      const fetchImpl = fetchMock();
      const reporter = createErrorReporter({ apiOrigin, fetchImpl });
      const hostile = {
        get name(): string {
          throw new Error("hostile getter");
        },
      };

      expect(() => reporter.report("manual", hostile)).not.toThrow();
    });
  });

  describe("payload truncation to server caps", () => {
    it("truncates a huge non-Error rejection reason's serialized message to 512 chars", async () => {
      const fetchImpl = fetchMock();
      const reporter = createErrorReporter({ apiOrigin, fetchImpl });

      // safeStringify(JSON.stringify) on a large plain object easily exceeds
      // the server's 512-char cap on `message`; the server would 413 the
      // whole request once the body crosses 8 KiB, silently dropping the beacon.
      const hugeRejectionReason = { data: "x".repeat(2000), nested: { more: "y".repeat(2000) } };
      reporter.report("unhandledrejection", hugeRejectionReason);
      await Promise.resolve();

      const body = jsonBody(fetchImpl);
      expect(body.message.length).toBeLessThanOrEqual(512);
    });

    it("truncates stack (including an appended component stack) to 4096 chars", async () => {
      const fetchImpl = fetchMock();
      const reporter = createErrorReporter({ apiOrigin, fetchImpl });

      const error = new Error("deep crash");
      error.stack = "at frame\n".repeat(500); // ~4500 chars on its own
      const componentStack = "\n    in Deeply (at App.tsx:1)".repeat(300); // ~8700 chars

      reporter.report("error-boundary", error, { componentStack });
      await Promise.resolve();

      const body = jsonBody(fetchImpl);
      expect(typeof body.stack).toBe("string");
      expect(body.stack.length).toBeLessThanOrEqual(4096);
    });

    it("LR-2: appends context.detail to the stack, alongside a component stack when both are present", async () => {
      const fetchImpl = fetchMock();
      const reporter = createErrorReporter({ apiOrigin, fetchImpl });

      const error = new Error("stalled login");
      error.stack = "at requestJson";
      reporter.report("manual", error, {
        detail: "identity-retry-ladder flow=login attempts=3 retryAtMs=[4010,12630] totalMs=27510",
      });
      await Promise.resolve();

      const body = jsonBody(fetchImpl);
      expect(body.stack).toContain("at requestJson");
      expect(body.stack).toContain("identity-retry-ladder flow=login attempts=3");

      const fetchImpl2 = fetchMock();
      const reporter2 = createErrorReporter({ apiOrigin, fetchImpl: fetchImpl2 });
      reporter2.report("error-boundary", new Error("boom"), {
        componentStack: "\n    in App",
        detail: "identity-retry-ladder flow=guest attempts=1 retryAtMs=[] totalMs=90",
      });
      await Promise.resolve();

      const body2 = jsonBody(fetchImpl2);
      expect(body2.stack).toContain("Component stack:");
      expect(body2.stack).toContain("identity-retry-ladder flow=guest");
    });

    it("truncates url and userAgent to 512 chars", async () => {
      const fetchImpl = fetchMock();
      const reporter = createErrorReporter({ apiOrigin, fetchImpl });

      window.history.pushState({}, "", `/race/${"a".repeat(1000)}`);
      const userAgentSpy = vi
        .spyOn(window.navigator, "userAgent", "get")
        .mockReturnValue("Mozilla/5.0 ".repeat(100));

      reporter.report("manual", new Error("boom"));
      await Promise.resolve();
      userAgentSpy.mockRestore();

      const body = jsonBody(fetchImpl);
      expect(body.url.length).toBeLessThanOrEqual(512);
      expect(body.userAgent.length).toBeLessThanOrEqual(512);
    });
  });

  describe("installGlobalHandlers", () => {
    it("attaches exactly one error and one unhandledrejection listener", () => {
      const fetchImpl = fetchMock();
      const reporter = createErrorReporter({ apiOrigin, fetchImpl });
      const target = new EventTarget() as unknown as Window;
      const addSpy = vi.spyOn(target, "addEventListener");

      reporter.installGlobalHandlers(target);

      expect(addSpy).toHaveBeenCalledTimes(2);
      expect(addSpy.mock.calls.map((call) => call[0]).sort()).toEqual([
        "error",
        "unhandledrejection",
      ]);
    });

    it("is idempotent: installing twice attaches listeners once", () => {
      const fetchImpl = fetchMock();
      const reporter = createErrorReporter({ apiOrigin, fetchImpl });
      const target = new EventTarget() as unknown as Window;
      const addSpy = vi.spyOn(target, "addEventListener");

      reporter.installGlobalHandlers(target);
      reporter.installGlobalHandlers(target);

      expect(addSpy).toHaveBeenCalledTimes(2);
    });

    it("forwards a window error event to report with source window", async () => {
      const fetchImpl = fetchMock();
      const reporter = createErrorReporter({ apiOrigin, fetchImpl });
      const target = new EventTarget() as unknown as Window;
      reporter.installGlobalHandlers(target);

      target.dispatchEvent(new ErrorEvent("error", { error: new Error("window boom") }));
      await Promise.resolve();

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const body = jsonBody(fetchImpl);
      expect(body.source).toBe("window");
      expect(body.message).toBe("window boom");
    });

    it("forwards an unhandledrejection event to report with source unhandledrejection", async () => {
      const fetchImpl = fetchMock();
      const reporter = createErrorReporter({ apiOrigin, fetchImpl });
      const target = new EventTarget() as unknown as Window;
      reporter.installGlobalHandlers(target);

      // jsdom/Node do not implement a real PromiseRejectionEvent constructor,
      // so a plain Event carrying a `reason` property stands in for it here.
      target.dispatchEvent(
        Object.assign(new Event("unhandledrejection"), {
          reason: new Error("rejection boom"),
        }),
      );
      await Promise.resolve();

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const body = jsonBody(fetchImpl);
      expect(body.source).toBe("unhandledrejection");
      expect(body.message).toBe("rejection boom");
    });
  });
});
