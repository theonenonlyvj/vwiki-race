import type { RankedLeaderboardRow, ServerLeaderboardRow } from "./types";

export function rankLeaderboardRows(
  rows: ServerLeaderboardRow[],
): RankedLeaderboardRow[] {
  const bestByAccount = new Map<string, ServerLeaderboardRow>();
  for (const row of rows) {
    const current = bestByAccount.get(row.accountId);
    if (!current || compareLeaderboardRows(row, current) < 0) {
      bestByAccount.set(row.accountId, row);
    }
  }

  return [...bestByAccount.values()]
    .sort((a, b) => {
      return compareLeaderboardRows(a, b);
    })
    .slice(0, 100)
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

function compareLeaderboardRows(
  a: ServerLeaderboardRow,
  b: ServerLeaderboardRow,
): number {
  if (a.elapsedMs !== b.elapsedMs) return a.elapsedMs - b.elapsedMs;
  if (a.clickCount !== b.clickCount) return a.clickCount - b.clickCount;
  const completedAt = Date.parse(a.completedAt) - Date.parse(b.completedAt);
  return completedAt || a.runId.localeCompare(b.runId);
}
