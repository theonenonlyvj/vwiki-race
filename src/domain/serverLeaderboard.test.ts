import { describe, expect, it } from "vitest";
import { rankLeaderboardRows } from "./serverLeaderboard";
import type { ServerLeaderboardRow } from "./types";

const row = (
  id: string,
  elapsedMs: number,
  clickCount: number,
  completedAt: string,
): ServerLeaderboardRow => ({
  runId: id,
  challengeId: "challenge-0001",
  accountId: `account-${id}`,
  displayName: id,
  elapsedMs,
  clickCount,
  completedAt,
  protocolVersion: 2,
});

describe("server leaderboard ranking", () => {
  it("sorts by speed, then clicks, then completed timestamp", () => {
    const ranked = rankLeaderboardRows([
      row("slow", 9000, 2, "2026-07-14T01:00:00Z"),
      row("fast-more-clicks", 5000, 9, "2026-07-14T01:00:00Z"),
      row("fast-fewer-clicks", 5000, 4, "2026-07-14T01:05:00Z"),
      row("fast-earlier", 5000, 4, "2026-07-14T00:59:00Z"),
    ]);

    expect(ranked.map((entry) => [entry.rank, entry.runId])).toEqual([
      [1, "fast-earlier"],
      [2, "fast-fewer-clicks"],
      [3, "fast-more-clicks"],
      [4, "slow"],
    ]);
  });

  it("keeps one best run per account and breaks final ties by run id", () => {
    const ranked = rankLeaderboardRows([
      { ...row("slower-repeat", 7000, 2, "2026-07-14T01:00:00Z"), accountId: "same" },
      { ...row("fastest", 4000, 4, "2026-07-14T01:00:00Z"), accountId: "same" },
      { ...row("same-time-more-clicks", 5000, 3, "2026-07-14T01:00:00Z"), accountId: "other" },
      { ...row("same-time-fewer-clicks", 5000, 2, "2026-07-14T01:00:00Z"), accountId: "third" },
      { ...row("z-last", 6000, 1, "2026-07-14T01:00:00Z"), accountId: "z" },
      { ...row("a-first", 6000, 1, "2026-07-14T01:00:00Z"), accountId: "a" },
    ]);

    expect(ranked.map((entry) => entry.runId)).toEqual([
      "fastest",
      "same-time-fewer-clicks",
      "same-time-more-clicks",
      "a-first",
      "z-last",
    ]);
    expect(ranked[0]).not.toHaveProperty("pathPreview");
  });
});
