import { describe, expect, it } from "vitest";

import {
  buildProductHealthReport,
  renderProductHealthMarkdown,
} from "./product-health-report.mjs";

const AS_OF = "2026-09-20T12:00:00.000Z";

function source(overrides = {}) {
  return {
    profiles: [],
    aliases: [],
    runs: [],
    dailyFeatures: [],
    ...overrides,
  };
}

function profile(accountId, publicName, updatedAt = "2026-09-01T00:00:00.000Z") {
  return {
    account_id: accountId,
    public_name: publicName,
    identity_status: "claimed",
    updated_at: updatedAt,
  };
}

function run(accountId, challengeId, overrides = {}) {
  const startedAt = overrides.started_at ?? "2026-09-14T15:00:00.000Z";
  const status = overrides.status ?? "abandoned";
  return {
    challenge_id: challengeId,
    account_id: accountId,
    canonical_account_id: accountId,
    status,
    started_at: startedAt,
    completed_at: status === "completed"
      ? new Date(Date.parse(startedAt) + 3 * 60_000).toISOString()
      : null,
    abandoned_at: status === "abandoned"
      ? new Date(Date.parse(startedAt) + 5 * 60_000).toISOString()
      : null,
    expires_at: new Date(Date.parse(startedAt) + 24 * 60 * 60_000).toISOString(),
    elapsed_ms: 300_000,
    click_count: 2,
    ranked_eligible: 0,
    protocol_version: 2,
    board_excluded: 0,
    ...overrides,
  };
}

function complete(accountId, challengeId, overrides = {}) {
  return run(accountId, challengeId, {
    status: "completed",
    elapsed_ms: 180_000,
    click_count: 3,
    ranked_eligible: 1,
    ...overrides,
  });
}

function daily(dailyDate, challengeId, flavor = "recognizable") {
  return {
    daily_date: dailyDate,
    challenge_id: challengeId,
    flavor,
  };
}

describe("product health report", () => {
  it("resolves alias chains and gives one canonical player completion precedence", () => {
    const { report } = buildProductHealthReport(source({
      profiles: [profile("a", "Player"), profile("b", "Player"), profile("c", "Player")],
      aliases: [
        { alias_account_id: "a", canonical_account_id: "b" },
        { alias_account_id: "b", canonical_account_id: "c" },
      ],
      dailyFeatures: [daily("2026-09-14", "daily-1")],
      runs: [
        run("a", "daily-1", { canonical_account_id: "a" }),
        complete("b", "daily-1", { canonical_account_id: "b" }),
        complete("c", "daily-1", { started_at: "2026-09-15T15:00:00.000Z" }),
      ],
    }), { asOf: AS_OF, days: 7 });

    expect(report.dailyCohorts).toEqual([
      expect.objectContaining({
        dailyDate: "2026-09-14",
        weekday: "Monday",
        startedPlayers: 1,
        finishedPlayers: 1,
        countedDnfs: 0,
        matureStartedCompletion: { numerator: 1, denominator: 1, value: 1 },
      }),
    ]);
    expect(report.completionByWeekday.find((row) => row.weekday === "Monday"))
      .toEqual(expect.objectContaining({ startedPlayers: 1, finishedPlayers: 1 }));
  });

  it("separates counted failures, early bails, expired active runs, and pending starts", () => {
    const challengeId = "daily-1";
    const profiles = ["finish", "dnf", "bail", "expired", "pending"]
      .map((id) => profile(id, id));
    const { report } = buildProductHealthReport(source({
      profiles,
      dailyFeatures: [daily("2026-09-14", challengeId)],
      runs: [
        complete("finish", challengeId),
        run("dnf", challengeId),
        run("bail", challengeId, { click_count: 1 }),
        run("expired", challengeId, {
          status: "active",
          abandoned_at: null,
          expires_at: "2026-09-15T00:00:00.000Z",
          elapsed_ms: null,
        }),
        run("pending", challengeId, {
          status: "active",
          abandoned_at: null,
          expires_at: "2026-09-21T00:00:00.000Z",
          elapsed_ms: null,
        }),
      ],
    }), { asOf: AS_OF, days: 7 });

    expect(report.dailyCohorts[0]).toEqual(expect.objectContaining({
      startedPlayers: 5,
      matureStartedPlayers: 4,
      finishedPlayers: 1,
      countedDnfs: 1,
      expiredActiveEngaged: 1,
      earlyBails: 1,
      pendingPlayers: 1,
      matureStartedCompletion: { numerator: 1, denominator: 4, value: 0.25 },
      engagedFinishRate: { numerator: 1, denominator: 3, value: 1 / 3 },
    }));
    const markdown = renderProductHealthMarkdown(report);
    expect(markdown).toContain("Counted DNFs | Expired active | Uncounted terminal");
    expect(markdown).toContain("| Monday | 5 | 1 | 1 | 1 | 1 | 0 | 1 | 25.0% (1/4) | 33.3% (1/3) |");
  });

  it("uses null rather than zero percent when a denominator is unavailable", () => {
    const { report } = buildProductHealthReport(source({
      dailyFeatures: [daily("2026-09-14", "daily-1")],
    }), { asOf: AS_OF, days: 7 });

    expect(report.dailyCohorts[0].matureStartedCompletion).toEqual({
      numerator: 0,
      denominator: 0,
      value: null,
    });
    expect(report.dailyCohorts[0].engagedFinishRate.value).toBeNull();
    expect(report.returningPlayers.returnRate.value).toBeNull();
    expect(report.sevenDayRepeat.repeatRate.value).toBeNull();
    expect(renderProductHealthMarkdown(report)).toContain("unavailable (0/0)");
  });

  it("excludes the partial Central day from complete windows", () => {
    const asOf = "2026-09-20T04:30:00.000Z"; // 2026-09-19 23:30 Central.
    const { report } = buildProductHealthReport(source({
      profiles: [profile("p", "Player")],
      dailyFeatures: [
        daily("2026-09-18", "complete-day"),
        daily("2026-09-19", "partial-day"),
      ],
      runs: [complete("p", "complete-day"), complete("p", "partial-day")],
    }), { asOf, days: 2 });

    expect(report.window).toEqual({
      days: 2,
      startCentralDate: "2026-09-17",
      endCentralDate: "2026-09-18",
      currentPartialCentralDate: "2026-09-19",
    });
    expect(report.dailyCohorts.map((row) => row.dailyDate)).toEqual(["2026-09-18"]);
  });

  it("attributes later replay outcomes to the daily's assigned Central weekday", () => {
    const { report } = buildProductHealthReport(source({
      profiles: [profile("p", "Player")],
      dailyFeatures: [daily("2026-09-14", "monday-daily")],
      runs: [complete("p", "monday-daily", { started_at: "2026-09-17T15:00:00.000Z" })],
    }), { asOf: AS_OF, days: 7 });

    expect(report.dailyCohorts[0]).toEqual(expect.objectContaining({
      dailyDate: "2026-09-14",
      weekday: "Monday",
      finishedPlayers: 1,
    }));
  });

  it("does not count terminal events accepted after the fixed as-of", () => {
    const { report } = buildProductHealthReport(source({
      profiles: [profile("p", "Player")],
      dailyFeatures: [daily("2026-09-14", "daily-1")],
      runs: [complete("p", "daily-1", {
        started_at: "2026-09-19T10:00:00.000Z",
        completed_at: "2026-09-21T10:00:00.000Z",
        expires_at: "2026-09-21T12:00:00.000Z",
      })],
    }), { asOf: AS_OF, days: 7 });

    expect(report.dailyCohorts[0]).toEqual(expect.objectContaining({
      finishedPlayers: 0,
      pendingPlayers: 1,
      matureStartedPlayers: 0,
    }));
  });

  it("reconstructs a post-as-of terminal row as expired active when expiry had passed", () => {
    const { report } = buildProductHealthReport(source({
      profiles: [profile("p", "Player")],
      dailyFeatures: [daily("2026-09-14", "daily-1")],
      runs: [complete("p", "daily-1", {
        started_at: "2026-09-18T10:00:00.000Z",
        completed_at: "2026-09-21T10:00:00.000Z",
        expires_at: "2026-09-19T10:00:00.000Z",
      })],
    }), { asOf: AS_OF, days: 7 });

    expect(report.dailyCohorts[0]).toEqual(expect.objectContaining({
      finishedPlayers: 0,
      expiredActiveEngaged: 1,
      pendingPlayers: 0,
    }));
  });

  it("excludes starts after as-of, moderated rows, and case-insensitive zz identities", () => {
    const challengeId = "daily-1";
    const { report } = buildProductHealthReport(source({
      profiles: [
        profile("v1", "Legacy"),
        profile("v2", "Modern"),
        profile("test", "ZzSmoke"),
        profile("excluded", "Excluded"),
        profile("future", "Future"),
      ],
      dailyFeatures: [daily("2026-09-14", challengeId)],
      runs: [
        complete("v1", challengeId, { protocol_version: 1, ranked_eligible: 0 }),
        complete("v2", challengeId, { protocol_version: 2, ranked_eligible: 0 }),
        complete("test", challengeId),
        complete("excluded", challengeId, { board_excluded: 1 }),
        complete("future", challengeId, { started_at: "2026-09-21T10:00:00.000Z" }),
      ],
    }), { asOf: AS_OF, days: 7 });

    expect(report.dailyCohorts[0]).toEqual(expect.objectContaining({
      startedPlayers: 2,
      finishedPlayers: 1,
      uncountedMatureStarts: 1,
    }));
    expect(report.dataQuality).toEqual(expect.objectContaining({
      excludedBoardRuns: 1,
      excludedSyntheticRuns: 1,
      excludedFutureStarts: 1,
    }));
  });

  it("measures returning players and +1 through +7 day repeats from counted play", () => {
    const ids = ["returning", "new-current", "repeat", "no-repeat"];
    const { report } = buildProductHealthReport(source({
      profiles: ids.map((id) => profile(id, id)),
      runs: [
        complete("returning", "manual-old", { started_at: "2026-09-05T15:00:00.000Z" }),
        run("returning", "manual-current", { started_at: "2026-09-15T15:00:00.000Z" }),
        complete("new-current", "manual-current", { started_at: "2026-09-14T15:00:00.000Z" }),
        complete("repeat", "first", { started_at: "2026-09-07T15:00:00.000Z" }),
        run("repeat", "again", { started_at: "2026-09-10T15:00:00.000Z" }),
        complete("no-repeat", "first", { started_at: "2026-09-08T15:00:00.000Z" }),
      ],
    }), { asOf: AS_OF, days: 14 });

    expect(report.returningPlayers).toEqual({
      activePlayers: 4,
      returningPlayers: 1,
      firstObservedInWindow: 3,
      returnRate: { numerator: 1, denominator: 4, value: 0.25 },
    });
    expect(report.sevenDayRepeat).toEqual(expect.objectContaining({
      eligibleCohortDates: 2,
      newPlayers: 2,
      repeatPlayers: 1,
      repeatRate: { numerator: 1, denominator: 2, value: 0.5 },
    }));
  });

  it("compares duplicate-name candidates through private hashed snapshots", () => {
    const baseline = buildProductHealthReport(source({
      profiles: [profile("a", "Alex"), profile("old-a", "Alex"), profile("b", "Beta")],
      aliases: [{ alias_account_id: "old-a", canonical_account_id: "a" }],
      runs: [complete("a", "one"), complete("b", "two")],
    }), { asOf: "2026-09-10T12:00:00.000Z", days: 7 });

    const current = buildProductHealthReport(source({
      profiles: [
        profile("a", "Alex"),
        profile("old-a", "Alex"),
        profile("c", "  ALEX  "),
        profile("d", "Normal"),
        profile("old-d", "zzSmoke"),
      ],
      aliases: [
        { alias_account_id: "old-a", canonical_account_id: "a" },
        { alias_account_id: "old-d", canonical_account_id: "d" },
      ],
      runs: [complete("a", "one"), complete("c", "two"), complete("d", "three")],
    }), { asOf: AS_OF, days: 7, previousSnapshot: baseline.snapshot });

    expect(current.report.duplicateCandidates).toEqual({
      comparedWithPreviousSnapshot: true,
      currentGroups: 1,
      currentCandidateAccounts: 2,
      newGroups: 1,
      grownGroups: 0,
      newCandidateAccounts: 1,
      resolvedGroups: 0,
    });
    const serialized = JSON.stringify({ report: current.report, snapshot: current.snapshot });
    expect(serialized).not.toContain("Alex");
    expect(serialized).not.toContain("old-a");
    expect(serialized).not.toContain("zzSmoke");
    expect(current.snapshot.nameGroups).toHaveLength(1);
  });

  it("detects an existing name group growing through an already known account", () => {
    const baseline = buildProductHealthReport(source({ profiles: [profile("a", "Alex"), profile("b", "Alex"), profile("c", "Chris")] }), { asOf: AS_OF });
    const current = buildProductHealthReport(source({ profiles: [profile("a", "Alex"), profile("b", "Alex"), profile("c", "Alex")] }), { asOf: AS_OF, previousSnapshot: baseline.snapshot });
    expect(current.report.duplicateCandidates).toEqual(expect.objectContaining({ grownGroups: 1, newGroups: 0, newCandidateAccounts: 0 }));
  });

  it("rejects alias cycles and malformed source rows", () => {
    expect(() => buildProductHealthReport(source({
      aliases: [
        { alias_account_id: "a", canonical_account_id: "b" },
        { alias_account_id: "b", canonical_account_id: "a" },
      ],
    }), { asOf: AS_OF, days: 7 })).toThrow(/alias cycle/i);

    expect(() => buildProductHealthReport(source({
      profiles: [profile("p", "Player")],
      runs: [run("p", "one", { status: "mystery" })],
    }), { asOf: AS_OF, days: 7 })).toThrow(/runs\[0\]\.status/);
  });
});
