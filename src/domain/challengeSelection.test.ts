import { describe, expect, it } from "vitest";
import { dailyFlavorForCentralDate } from "./dailyEditorial";
import type { Challenge } from "./types";
import {
  centralDateDaysBefore,
  centralDateKey,
  dailyBadgeLabel,
  previousCentralDate,
  selectDefaultChallenge,
} from "./challengeSelection";

describe("editorial Daily flavors", () => {
  it("maps Central calendar weekdays to the approved editorial rhythm", () => {
    expect(dailyFlavorForCentralDate("2026-07-19")).toBe("hard");
    expect(dailyFlavorForCentralDate("2026-07-20")).toBe("recognizable");
    expect(dailyFlavorForCentralDate("2026-07-21")).toBe("recognizable");
    expect(dailyFlavorForCentralDate("2026-07-22")).toBe("recognizable");
    expect(dailyFlavorForCentralDate("2026-07-23")).toBe("weird");
    expect(dailyFlavorForCentralDate("2026-07-24")).toBe("weird");
    expect(dailyFlavorForCentralDate("2026-07-25")).toBe("hard");
  });
});

const challenges = [
  challenge("challenge-0001"),
  challenge("challenge-0002"),
  challenge("challenge-0003", { origin: "daily", dailyDate: "2026-07-15" }),
];

describe("default challenge selection", () => {
  it("uses the Central calendar date across UTC midnight", () => {
    expect(centralDateKey(new Date("2026-07-16T00:30:00.000Z"))).toBe("2026-07-15");
    expect(centralDateKey(new Date("2026-01-16T05:30:00.000Z"))).toBe("2026-01-15");
  });

  it("distinguishes today's daily from historical daily challenges", () => {
    expect(dailyBadgeLabel(challenges[2]!, "2026-07-15")).toBe("Today");
    expect(dailyBadgeLabel(challenges[2]!, "2026-07-16")).toBe("Daily 7/15");
    expect(dailyBadgeLabel(challenges[0]!, "2026-07-15")).toBeNull();
  });

  it("uses authoritative Daily feature metadata before legacy provenance", () => {
    const featured = challenge("challenge-featured", {
      origin: "manual",
      dailyDate: null,
      dailyFeature: {
        dailyDate: "2026-07-15",
        flavor: "weird",
        selectionSource: "community",
      },
    });

    expect(dailyBadgeLabel(featured, "2026-07-15")).toBe("Today");
    expect(dailyBadgeLabel(featured, "2026-07-16")).toBe("Daily 7/15");
    expect(selectDefaultChallenge([
      challenge("challenge-manual"),
      featured,
    ], { todayUtc: "2026-07-15" })?.id).toBe("challenge-featured");
  });

  it("keeps legacy Daily provenance as a fallback when feature metadata is absent", () => {
    const legacyDaily = challenge("challenge-legacy", {
      origin: "daily",
      dailyDate: "2026-07-15",
    });

    expect(dailyBadgeLabel(legacyDaily, "2026-07-15")).toBe("Today");
    expect(selectDefaultChallenge([
      challenge("challenge-manual"),
      legacyDaily,
    ], { todayUtc: "2026-07-15" })?.id).toBe("challenge-legacy");
  });

  it("prioritizes a resumable active run over a direct URL and today's daily", () => {
    expect(selectDefaultChallenge(challenges, {
      activeChallengeId: "challenge-0002",
      requestedChallengeId: "challenge-0001",
      todayUtc: "2026-07-15",
    })?.id).toBe("challenge-0002");
  });

  it("prioritizes a valid direct URL over today's daily", () => {
    expect(selectDefaultChallenge(challenges, {
      requestedChallengeId: "challenge-0002",
      todayUtc: "2026-07-15",
    })?.id).toBe("challenge-0002");
  });

  it("selects today's daily when there is no active run or valid direct URL", () => {
    expect(selectDefaultChallenge(challenges, {
      requestedChallengeId: "challenge-missing",
      todayUtc: "2026-07-15",
    })?.id).toBe("challenge-0003");
  });

  it("falls back to the first active challenge", () => {
    expect(selectDefaultChallenge(challenges, {
      todayUtc: "2026-07-16",
    })?.id).toBe("challenge-0001");
  });

  it("never selects inactive challenges", () => {
    const rows = [challenge("challenge-0001", { isActive: false }), challenge("challenge-0002")];
    expect(selectDefaultChallenge(rows, {
      activeChallengeId: "challenge-0001",
      requestedChallengeId: "challenge-0001",
      todayUtc: "2026-07-15",
    })?.id).toBe("challenge-0002");
  });
});

describe("previousCentralDate", () => {
  it("walks the calendar back one day", () => {
    expect(previousCentralDate("2026-07-15")).toBe("2026-07-14");
  });

  it("carries across a month boundary", () => {
    expect(previousCentralDate("2026-08-01")).toBe("2026-07-31");
  });

  it("carries across a year boundary", () => {
    expect(previousCentralDate("2026-01-01")).toBe("2025-12-31");
  });
});

describe("centralDateDaysBefore", () => {
  it("returns the same date for a 0-day offset", () => {
    expect(centralDateDaysBefore("2026-07-15", 0)).toBe("2026-07-15");
  });

  it("matches previousCentralDate at a 1-day offset", () => {
    expect(centralDateDaysBefore("2026-07-15", 1)).toBe(previousCentralDate("2026-07-15"));
  });

  it("computes a 7-day window's inclusive start (6 days before)", () => {
    // A 7-day window ending at 2026-07-18 inclusive covers 07-12..07-18.
    expect(centralDateDaysBefore("2026-07-18", 6)).toBe("2026-07-12");
  });

  it("computes a 30-day window's inclusive start (29 days before)", () => {
    expect(centralDateDaysBefore("2026-07-18", 29)).toBe("2026-06-19");
  });

  it("carries across a month boundary", () => {
    expect(centralDateDaysBefore("2026-08-03", 6)).toBe("2026-07-28");
  });

  it("carries across a year boundary", () => {
    expect(centralDateDaysBefore("2026-01-03", 6)).toBe("2025-12-28");
  });
});

function challenge(id: string, overrides: Partial<Challenge> = {}): Challenge {
  return {
    id,
    label: `Challenge #${Number(id.slice(-4))}`,
    mode: "daily",
    start: { title: `${id} start` },
    target: { title: `${id} target` },
    ruleset: "ranked_classic",
    source: "curated",
    origin: "manual",
    isActive: true,
    ...overrides,
  };
}
