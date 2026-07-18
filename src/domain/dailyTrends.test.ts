import { describe, expect, it } from "vitest";
import { dailyTrendGuard, dailyTrendWindowStart } from "./dailyTrends";

describe("dailyTrendGuard", () => {
  it("requires exactly 3 for the 7-day window", () => {
    expect(dailyTrendGuard(7)).toBe(3);
  });

  it("requires exactly 10 for the 30-day window", () => {
    expect(dailyTrendGuard(30)).toBe(10);
  });

  it("requires exactly 10 for lifetime (null window)", () => {
    expect(dailyTrendGuard(null)).toBe(10);
  });
});

describe("dailyTrendWindowStart", () => {
  it("computes the 7-day window's inclusive start (6 days before today)", () => {
    expect(dailyTrendWindowStart("2026-07-18", 7)).toBe("2026-07-12");
  });

  it("computes the 30-day window's inclusive start (29 days before today)", () => {
    expect(dailyTrendWindowStart("2026-07-18", 30)).toBe("2026-06-19");
  });

  it("carries a 7-day window across a month/year boundary", () => {
    expect(dailyTrendWindowStart("2026-01-03", 7)).toBe("2025-12-28");
  });
});
