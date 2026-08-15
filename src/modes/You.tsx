import {
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import StagedLoadingNotice from "../components/StagedLoadingNotice";
import { formatMinutesSeconds } from "../domain/formatting";
import { formatElapsed } from "../race/shared";
import type { AccountStats, PageStat } from "../domain/types";
import type { VGamesIdentitySession } from "../services/vgamesIdentity";

/** RC-06 ("one honest loading/error system", Judge A amendment 3 / Judge B
 * amendment 1): the plumbing gap this file's own PKG-11 comment (below)
 * explicitly descoped - threaded from App.tsx's `accountStatsStatus`, kept
 * SEPARATE from `stats` itself (never leaked into the ghost-loss guard's
 * shared `accountStats` derivation - see App.tsx's doc comment). */
export type AccountStatsStatus = "loading" | "error" | "ready";

/**
 * You (profile/stats). Ports the old StatsPanel/StatsList unchanged, plus
 * the account block that used to be a bare, always-hidden-behind-a-claim-CTA
 * chip - now the "Honest You" (Option B, hardened) three-state account
 * block (spec: acct-option-b.json), ALWAYS rendered as the first child of
 * `.you-panel`, in all three session states:
 *
 *  - State A - signed-out / never-played: `identitySession === null`.
 *  - State B - named guest (ghost): `identitySession.status === "ghost"`.
 *  - State C - logged in (claimed): `identitySession.status === "claimed"`.
 *
 * State C is the "missing state" the old chip never addressed - a static
 * (non-tappable, amendment 3) status readout with its own Log out/Switch
 * account actions and the cross-game transparency line, instead of nothing.
 */
export default function You({
  identitySession,
  onClaimIdentity,
  onGoHome,
  onLogOut,
  onPlayAsSomeoneElse,
  onRetryStats,
  onSwitchAccount,
  stats,
  statsStatus,
}: {
  identitySession: VGamesIdentitySession | null;
  // PKG-11 remainder fix (2026-07-19): widened from `() => void` to the same
  // `(mode) => void` shape RaceResults.tsx's `ClaimCta` already uses, so
  // both entry points can share the one unified "Create account"/"Log in"
  // pair (brief item 5/acceptance criterion 3) instead of You keeping its
  // own third account verb ("Claim your stats").
  onClaimIdentity: (mode: "create" | "login") => void;
  // QF-09 (owner-proxy ruling, 2026-07-19): CTA out of the never-played
  // empty state, back to Home - same one-line `onGoHome={() =>
  // onSelectMode("home")}` wiring pattern AppShell.tsx already uses for
  // Browse.
  onGoHome: () => void;
  // "Honest You" (State C): local, synchronous, no confirm dialog (2026-07-20
  // judge amendment cut the brief's confirm-dialog hardening - a fully
  // reversible, non-destructive action doesn't earn a modal interrupt; the
  // device-scope caveat lives in the post-logout run notice instead).
  onLogOut: () => void;
  // "Honest You" (State B's ghost exit): routed through the ghost-loss guard
  // in App.tsx when the ghost has real stakes.
  onPlayAsSomeoneElse: () => void;
  // RC-06: bumps App.tsx's statsRefreshVersion - the inline "Couldn't load
  // your stats — Retry" below only.
  onRetryStats: () => void;
  // "Honest You" (State C): opens the sheet on Log in, no pre-clear.
  onSwitchAccount: () => void;
  stats: AccountStats | null;
  statsStatus: AccountStatsStatus;
}) {
  // State A (spec §1): identitySession === null implies accountStats is
  // necessarily null too (the projection is token-gated on the session -
  // App.tsx ~380) - the old `isNeverPlayedGuest` predicate's `stats === null`
  // clause was redundant and is dropped here.
  const isNeverPlayedGuest = identitySession === null;

  return (
    <section className="you-panel">
      <AccountBlock
        identitySession={identitySession}
        onClaimIdentity={onClaimIdentity}
        onLogOut={onLogOut}
        onPlayAsSomeoneElse={onPlayAsSomeoneElse}
        onSwitchAccount={onSwitchAccount}
      />

      {isNeverPlayedGuest ? (
        // QF-09: one warm message instead of the 7-tile grid + 3 list
        // sections all repeating the same "No data yet." placeholder ten
        // times over for someone who has never raced at all. Reuses the
        // app's existing `.empty-state` panel chrome (Home.tsx's loading
        // state) rather than inventing new CSS.
        // RC-09 (owner-proxy ruling, Judge B "strongest-evidenced item"):
        // the empty-state/stats-panel swap on login/logout used to be a
        // literal instant hard-swap (journey6 trace: the identity modal at
        // one capture, the fully-mounted panel the very next, zero
        // cross-fade) - `surface-entrance` is the same shared fade+rise
        // QF-08 already ships elsewhere, applied to both sides of this
        // swap so whichever one mounts eases in instead of popping.
        <section className="empty-state you-empty-state surface-entrance">
          <p>Play your first race to start building stats.</p>
          <button onClick={onGoHome} type="button">
            Home
          </button>
        </section>
      ) : (
        <StatsPanel onRetry={onRetryStats} stats={stats} status={statsStatus} />
      )}
    </section>
  );
}

function AccountBlock({
  identitySession,
  onClaimIdentity,
  onLogOut,
  onPlayAsSomeoneElse,
  onSwitchAccount,
}: {
  identitySession: VGamesIdentitySession | null;
  onClaimIdentity: (mode: "create" | "login") => void;
  onLogOut: () => void;
  onPlayAsSomeoneElse: () => void;
  onSwitchAccount: () => void;
}) {
  if (!identitySession) {
    // State A - signed-out/never-played (NV-1, owner feedback: the old bare
    // "Guest" chip gave no visible way in - its tap-to-open-the-sheet
    // behavior was undiscoverable). Explicit status line + a primary "Log
    // in" CTA (opens the identity sheet straight on the Log In tab, same
    // onClaimIdentity("login") preferredMode call every other entry point
    // uses) + "Create account" as a secondary .link-button + one muted
    // reassurance line that an account isn't required to play.
    return (
      <div className="account-block">
        <p className="account-status-line">Not logged in.</p>
        <div className="account-actions">
          <button type="button" onClick={() => onClaimIdentity("login")}>
            Log in
          </button>
          <button className="link-button" type="button" onClick={() => onClaimIdentity("create")}>
            Create account
          </button>
        </div>
        <p className="muted">Or just play — no account needed.</p>
      </div>
    );
  }

  if (identitySession.status === "ghost") {
    const name = identitySession.displayName;
    return (
      <div className="account-block">
        <button
          aria-label={`${name}, guest - tap to manage`}
          className="account-chip"
          onClick={() => onClaimIdentity("create")}
          type="button"
        >
          {name} · Guest
        </button>

        {/* Claim CTA, copy and buttons unchanged from today (You.tsx:53-72) -
            plus the new "Play as someone else" tertiary exit underneath. */}
        <section className="claim-cta" aria-label="Claim your stats">
          <p>{`You're on the board as ${name}. Claim it so it stays yours.`}</p>
          <div className="claim-cta-actions">
            <button type="button" onClick={() => onClaimIdentity("create")}>
              Create account
            </button>
            <button className="link-button" type="button" onClick={() => onClaimIdentity("login")}>
              Log in
            </button>
          </div>
          {/* NEW tertiary action (spec §1 State B): routes through the
              ghost-loss guard in App.tsx when this ghost has real stakes.
              Never labeled "Log out" - a guest has no credentials to return
              with, the opposite risk profile from State C's Log out. */}
          <button className="link-button" type="button" onClick={onPlayAsSomeoneElse}>
            Play as someone else
          </button>
        </section>
      </div>
    );
  }

  // State C - logged in (the missing state). Chip is a static status
  // element, not a button (amendment 3, §9): its management actions render
  // directly beneath it, so a "tap to manage" button that opens nothing
  // would be a dead tap.
  const name = identitySession.displayName;
  return (
    <div className="account-block">
      <div aria-label={`${name}, logged in`} className="account-chip" role="status">
        {name}
      </div>
      <p className="account-status-line">Logged in on this device.</p>
      <div className="account-actions">
        {/* Standard solid button - NOT coral. Coral stays reserved for
            commit/destructive actions and the brand kicker; nothing is
            destroyed by logging out (it's local-only, reversible - see
            App.tsx's `logOut`). */}
        <button type="button" onClick={onLogOut}>
          Log out
        </button>
        <button className="link-button" type="button" onClick={onSwitchAccount}>
          Switch account
        </button>
      </div>
      {/* Cross-game transparency (spec §4): the identity sheet's already-
          shipped sentence, verbatim, reused rather than a second copy of it
          to keep in sync. */}
      <p className="account-cross-game muted">One account works across every VGames title.</p>
    </div>
  );
}

// PKG-11 (council 2026-07-19, Judge A amendment 3, option b): "No data yet."
// - StatsList's own established convention (below) - covers a resolved
// account's own genuinely-empty numeric field (`bestClicks`/`bestElapsedMs`
// are legitimately `null` before a first completion, not a missing-data
// bug). A confirmed-zero total (0 attempts, 0 completions, a fresh account's
// 0-day streak) now renders as the real number "0", never a bare "-" that
// reads like a rendering glitch.
//
// RC-06 ("one honest loading/error system", Judge A amendment 3 / Judge B
// amendment 1): "loading" and "errored" no longer collapse into this same
// copy - `status` (threaded from App.tsx's accountStatsStatus, the plumbing
// gap this comment used to descope) renders a distinct muted loading
// treatment and a distinct inline error + Retry instead. `NO_DATA_YET`
// itself is reachable ONLY via `status === "ready"` now - a genuine
// zero-attempts account, or one of `totals`' own always-legitimately-null
// fields - never a stand-in for "hasn't resolved yet".
const NO_DATA_YET = "No data yet.";

function StatsPanel({
  onRetry,
  stats,
  status,
}: {
  onRetry: () => void;
  stats: AccountStats | null;
  status: AccountStatsStatus;
}) {
  const totals = stats?.totals;

  // RC-09 (owner-proxy ruling, Judge B "strongest-evidenced item"): every
  // return below carries `surface-entrance` (see You()'s own comment on the
  // empty-state sibling for the trace evidence) - StatsPanel mounts fresh on
  // every login/logout swap regardless of which internal status it starts
  // in, so all three branches need the same fade+rise, not just the "ready"
  // one.
  if (status === "error") {
    return (
      <section className="stats-panel surface-entrance">
        <h2>Your stats</h2>
        <div className="board-error">
          <p className="error-banner" role="alert">Couldn&apos;t load your stats.</p>
          <button onClick={onRetry} type="button">
            Retry
          </button>
        </div>
      </section>
    );
  }

  if (status === "loading") {
    return (
      <section className="stats-panel surface-entrance">
        <h2>Your stats</h2>
        <StagedLoadingNotice
          active
          className="muted stats-panel-loading"
          onRetry={onRetry}
          pendingLabel="Loading your stats…"
        />
      </section>
    );
  }

  return (
    <section className="stats-panel surface-entrance">
      {/* QF-09: nav's "Stats" tab now literally points at Boards
          (PKG-14, AppShell.tsx) - keeping this heading as "Stats" too
          made a screen one tap away self-identify with the same name.
          "Your stats" disambiguates without touching Boards' own
          ratified "Stats" rename. */}
      <h2>Your stats</h2>
      <dl className="stat-grid">
        {/* PKG-07 (council 2026-07-19, owner-proxy ruling (a)): the ritual-
            identity streak, reusing `accountStats.dailyStreak` - Home
            already fetches this same field for its own streak/trend chip
            (StreakTrendRow in Home.tsx), so You never has to introduce a
            second source of truth for it. No "best streak" tile alongside
            it - `AccountStats` doesn't track a lifetime-best streak
            anywhere server-side, and this repo's data-fidelity convention
            is to never fabricate a number the server hasn't actually
            computed. */}
        <div>
          <dt>Streak</dt>
          <dd>
            {stats ? `${stats.dailyStreak} ${stats.dailyStreak === 1 ? "day" : "days"}` : NO_DATA_YET}
          </dd>
        </div>
        <div>
          <dt>Attempts</dt>
          <dd>{totals ? totals.attempts : NO_DATA_YET}</dd>
        </div>
        <div>
          <dt>Completed</dt>
          <dd>{totals ? totals.completed : NO_DATA_YET}</dd>
        </div>
        <div>
          <dt>DNFs</dt>
          <dd>{totals ? totals.abandoned : NO_DATA_YET}</dd>
        </div>
        <div>
          <dt>Best speed</dt>
          <dd>{totals?.bestElapsedMs === null || totals?.bestElapsedMs === undefined ? NO_DATA_YET : formatElapsed(totals.bestElapsedMs)}</dd>
        </div>
        {/* QF-09: averageElapsedMs/averageClicks are already server-computed,
            typed, and delivered on every AccountStats response - they were
            just never rendered. Same formatters as their "Best" siblings:
            formatElapsed for the ms field, and toFixed(1) for the
            fractional-clicks field, one decimal place - same precision
            server-side avgClicks fields use throughout this app (e.g.
            listDailyTrends' ranked rows). */}
        <div>
          <dt>Avg speed</dt>
          <dd>{totals ? formatElapsed(totals.averageElapsedMs) : NO_DATA_YET}</dd>
        </div>
        <div>
          <dt>Best clicks</dt>
          <dd>{totals?.bestClicks === null || totals?.bestClicks === undefined ? NO_DATA_YET : totals.bestClicks}</dd>
        </div>
        <div>
          <dt>Avg clicks</dt>
          <dd>{totals ? totals.averageClicks.toFixed(1) : NO_DATA_YET}</dd>
        </div>
        <div>
          <dt>Completed clicks</dt>
          <dd>{totals ? totals.totalClicks : NO_DATA_YET}</dd>
        </div>
      </dl>
      <PageLists stats={stats} />
    </section>
  );
}

const PAGE_VIEWS = ["visited", "time"] as const;
type PageView = (typeof PAGE_VIEWS)[number];

const PAGE_VIEW_LABEL: Record<PageView, string> = {
  visited: "Most visited",
  time: "Most time",
};

const YOU_PAGES_PANEL_ID = "you-pages-panel";
const pageTabId = (view: PageView) => `you-pages-tab-${view}`;

/** A page with no dwell sample - see `PageStat`. An em dash, never "0:00":
 * we don't know the time, which is not the same as knowing it was zero. */
const NO_TIME = "—";

/**
 * You's page lists (owner request, 2026-08-15: "toggle with total time
 * spent, but have both"). Both rankings carry both figures, so the toggle
 * re-sorts facts the player is already looking at rather than swapping in a
 * separate readout:
 *
 *  - Most visited: `×7 · 0:15 avg` - how often, then how long it holds you.
 *  - Most time:    `13:11 · ×7`    - total sunk, then how many visits made it.
 *
 * The two arrays are BOTH the server's own top-10s and are deliberately not
 * derived from each other here (see `AccountStats.mostTimeSpent`): the real
 * rankings barely overlap, so re-sorting one list client-side would drop
 * exactly the pages this toggle exists to reveal.
 *
 * Duplicates Boards' roving-tabindex segment control rather than sharing it
 * (`.board-segment-control` styling IS reused): Boards' version also owns
 * the 5-segment horizontal-scroll machinery - spacer, edge fade,
 * scrollIntoView - that a two-segment control has no use for, so the
 * shared surface would be thinner than the seam.
 */
function PageLists({ stats }: { stats: AccountStats | null }) {
  const [view, setView] = useState<PageView>("visited");
  const tabRefs = useRef<Partial<Record<PageView, HTMLButtonElement | null>>>({});
  const items = (view === "visited" ? stats?.mostVisited : stats?.mostTimeSpent) ?? [];

  // Same WAI-ARIA "automatic activation" model as Boards (PKG-10): arrow
  // keys move focus AND select, wrapping at both ends.
  function handleTabKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const delta = event.key === "ArrowRight" ? 1 : -1;
    const next = PAGE_VIEWS[(PAGE_VIEWS.indexOf(view) + delta + PAGE_VIEWS.length) % PAGE_VIEWS.length];
    setView(next);
    tabRefs.current[next]?.focus();
  }

  const rows = items.slice(0, 10);
  // Bars encode the metric the list is CURRENTLY sorted by, so they always
  // decrease down the list - the shape reads as the ranking itself rather
  // than as a second, competing signal. No minimum-width floor: the
  // smallest real value in either ranking is still a visible fraction of
  // its peak, and padding it out would overstate it.
  const peak = rows.reduce((most, row) => Math.max(most, pageMetric(row, view)), 0);

  return (
    <section className="you-pages">
      <div className="you-pages-head">
        <h3>Pages</h3>
        <div
          aria-label="Page ranking"
          className="you-pages-switch"
          onKeyDown={handleTabKeyDown}
          role="tablist"
        >
          {PAGE_VIEWS.map((key) => (
            <button
              aria-controls={YOU_PAGES_PANEL_ID}
              aria-selected={view === key}
              className={view === key ? "active" : undefined}
              id={pageTabId(key)}
              key={key}
              onClick={() => setView(key)}
              ref={(el) => {
                tabRefs.current[key] = el;
              }}
              role="tab"
              tabIndex={view === key ? 0 : -1}
              type="button"
            >
              {PAGE_VIEW_LABEL[key]}
            </button>
          ))}
        </div>
      </div>
      <div aria-labelledby={pageTabId(view)} id={YOU_PAGES_PANEL_ID} role="tabpanel">
        {rows.length ? (
          <ol className="you-pages-list">
            {rows.map((item, index) => (
              <li
                key={item.title}
                style={{ "--fill": barWidth(item, view, peak) } as CSSProperties}
                title={pageTooltip(item)}
              >
                <span className="you-pages-rank">{index + 1}</span>
                <span className="you-pages-title">{item.title}</span>
                <span className="you-pages-figure">{pageFigures(item, view)}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">{NO_DATA_YET}</p>
        )}
      </div>
    </section>
  );
}

/** Whichever number the active ranking is sorted by - the one the bar
 * length has to encode for the list to read as its own ordering. */
function pageMetric(stat: PageStat, view: PageView): number {
  return view === "time" ? stat.totalMs ?? 0 : stat.count;
}

function barWidth(stat: PageStat, view: PageView, peak: number): string {
  return peak > 0 ? `${Math.round((pageMetric(stat, view) / peak) * 100)}%` : "0%";
}

/** Says out loud what the terse `10:00 · ×5` row figure means. Carries
 * BOTH numbers regardless of the active view, so hovering never requires
 * toggling to see the other one. */
function pageTooltip(stat: PageStat): string {
  const visits = `${stat.count} ${stat.count === 1 ? "visit" : "visits"}`;
  return stat.totalMs === null
    ? `${stat.title} — ${visits}, no timed visit`
    : `${stat.title} — ${visits}, ${formatMinutesSeconds(stat.totalMs)} total`;
}

/** Reuses `formatMinutesSeconds` - the app's one duration format (Global
 * invariant #1) - rather than introducing a second one for dwell. */
function pageFigures(stat: PageStat, view: PageView): string {
  const count = `×${stat.count}`;
  if (view === "time") {
    return `${stat.totalMs === null ? NO_TIME : formatMinutesSeconds(stat.totalMs)} · ${count}`;
  }
  return `${count} · ${stat.avgMs === null ? NO_TIME : `${formatMinutesSeconds(stat.avgMs)} avg`}`;
}
