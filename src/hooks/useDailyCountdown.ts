import { useEffect, useState } from "react";
import { formatCountdown, msUntilNextCentralDrop } from "../domain/dailyCountdown";

const TICK_MS = 1_000;
const defaultNow = () => new Date();

/**
 * Home pre-play's "time left today" readout (PKG-07, council 2026-07-19,
 * owner-proxy ruling (d): "live countdown to 5:00 AM Central on Home
 * pre-play... update every second while visible"). Purely the ticking/
 * re-render wiring - the DST-safe math it calls each tick
 * (`msUntilNextCentralDrop`/`formatCountdown`, src/domain/dailyCountdown.ts)
 * is its own tested pure module, matching this repo's convention of
 * keeping timezone/date logic in src/domain rather than inline in a
 * component (see that file's own doc comment).
 *
 * `active` gates the interval the same way `useElapsedDecisionTime`'s own
 * `options.active` does (this hooks/ directory's established pattern) -
 * Home passes `false` once the daily is finished (the countdown isn't
 * shown post-play) or the hero has no real daily to count down to, so no
 * interval survives into a screen that no longer renders the readout.
 * Returns `null` while inactive.
 */
export function useDailyCountdown(options: { active: boolean; now?: () => Date }): string | null {
  const now = options.now ?? defaultNow;

  const [text, setText] = useState<string | null>(() =>
    options.active ? formatCountdown(msUntilNextCentralDrop(now())) : null,
  );

  useEffect(() => {
    if (!options.active) {
      setText(null);
      return;
    }
    const tick = () => setText(formatCountdown(msUntilNextCentralDrop(now())));
    tick();
    const timer = window.setInterval(tick, TICK_MS);
    return () => window.clearInterval(timer);
  }, [options.active, now]);

  return text;
}
