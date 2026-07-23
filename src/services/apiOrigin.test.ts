import { describe, expect, it } from "vitest";
import { LEGACY_WORKER_API_ORIGIN, resolveApiOrigin } from "./apiOrigin";

describe("resolveApiOrigin resolution order", () => {
  it("prefers an explicit configured origin over same-origin resolution", () => {
    expect(
      resolveApiOrigin("https://vwikirace-api.example.workers.dev", {
        production: true,
        locationOrigin: "https://vwikirace.pages.dev",
      }),
    ).toBe("https://vwikirace-api.example.workers.dev");
  });

  it("resolves the app's own origin on the production Pages host", () => {
    expect(
      resolveApiOrigin(undefined, {
        production: true,
        locationOrigin: "https://vwikirace.pages.dev",
      }),
    ).toBe("https://vwikirace.pages.dev");
  });

  it("resolves the app's own origin on a *.pages.dev preview deployment", () => {
    expect(
      resolveApiOrigin("", {
        production: true,
        locationOrigin: "https://abc123.vwikirace.pages.dev",
      }),
    ).toBe("https://abc123.vwikirace.pages.dev");
  });

  it("keeps the same-origin result absolute so requestJson's invariant holds", () => {
    const origin = resolveApiOrigin("", {
      production: true,
      locationOrigin: "https://vwikirace.pages.dev",
    });
    expect(`${origin}/api/v2/challenges`).toBe(
      "https://vwikirace.pages.dev/api/v2/challenges",
    );
    expect(() => new URL(`${origin}/api/v2/challenges`)).not.toThrow();
  });

  it.each([
    "https://example.com",
    "https://pages.dev",
    "https://evilpages.dev",
    "https://vwikirace.pages.dev.attacker.example",
    "http://vwikirace.pages.dev",
    "not a url",
  ])("falls back to the legacy Worker origin off *.pages.dev: %s", (locationOrigin) => {
    expect(resolveApiOrigin("", { production: true, locationOrigin })).toBe(
      LEGACY_WORKER_API_ORIGIN,
    );
  });

  it("falls back to the legacy Worker origin with no location at all (Node build-time validation)", () => {
    expect(resolveApiOrigin("", { production: true, locationOrigin: null })).toBe(
      LEGACY_WORKER_API_ORIGIN,
    );
  });

  it("reads the live browser origin when no override is supplied", () => {
    // jsdom serves tests from a localhost origin - not a *.pages.dev host -
    // so the default-location path lands on the legacy Worker fallback.
    expect(resolveApiOrigin("", { production: true })).toBe(LEGACY_WORKER_API_ORIGIN);
  });

  it("keeps resolving to a relative origin during development with nothing configured", () => {
    expect(
      resolveApiOrigin(undefined, { locationOrigin: "https://vwikirace.pages.dev" }),
    ).toBe("");
  });

  it("still rejects a malformed explicit origin in production", () => {
    expect(() =>
      resolveApiOrigin("http://localhost:8787", {
        production: true,
        locationOrigin: "https://vwikirace.pages.dev",
      }),
    ).toThrow("VITE_VWIKI_RACE_API_URL");
  });
});
