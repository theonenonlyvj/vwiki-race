/**
 * Invariant 1 formatter ("Time AND clicks, always... `0:38 · 5 clk`", UX
 * redesign spec, Global invariants #1). This is the one source of truth for
 * that string wherever a run's outcome is summarized - Results today, and
 * Boards/Home/Challenges as they land in later increments.
 */
export function formatMinutesSeconds(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function formatTimeAndClicks(elapsedMs: number, clicks: number): string {
  return `${formatMinutesSeconds(elapsedMs)} · ${clicks} clk`;
}

/**
 * You's stat figures (owner request, 2026-08-15) span three orders of
 * magnitude — a best race of 8.1 seconds, an average of 4:41, a lifetime
 * total of 2h 48m — and `formatMinutesSeconds` above holds only the middle
 * one honestly. It renders a lifetime total as "379:09", and it throws away
 * the tenth of a second that is the entire interest of a sub-minute best
 * (the profile shipped "280.7s" for an average speed precisely because the
 * other formatter in the app, `formatElapsed`, has the opposite problem).
 *
 * Rather than add a second and third named format beside this file's
 * self-declared one-source-of-truth, this is ONE function that picks the
 * unit the magnitude deserves. `formatMinutesSeconds` stays the format for
 * a RUN OUTCOME (Global invariant #1, "0:38 · 5 clk") — unchanged and still
 * the only thing leaderboards and results use. This one is for aggregate
 * stat figures, where the range is unbounded in both directions.
 */
export function formatStatDuration(ms: number): string {
  const safeMs = Math.max(0, ms);
  if (safeMs < 60_000) return `${(safeMs / 1000).toFixed(1)}s`;
  if (safeMs < 3_600_000) return formatMinutesSeconds(safeMs);
  const totalMinutes = Math.floor(safeMs / 60_000);
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
}

/**
 * RC-1: the race HUD's target chip sits side by side with the Run chip in
 * one flex row that must never wrap to a second line (the sticky race-hud's
 * rendered height feeds fixed scroll-margin-top values elsewhere - see the
 * ghost-HUD regression guard raceHudScrollMargin.test.ts documents). CSS
 * text-overflow: ellipsis on the chip's title element is a second line of
 * defense, but the display string itself is hard-capped here first so the
 * chip's natural (un-ellipsized) width stays predictable at every viewport.
 */
export function truncateTitle(title: string, maxLength = 16): string {
  return title.length > maxLength ? `${title.slice(0, maxLength)}…` : title;
}
