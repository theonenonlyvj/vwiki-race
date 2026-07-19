import { formatElapsed } from "../race/shared";
import type { AccountStats } from "../domain/types";
import type { VGamesIdentitySession } from "../services/vgamesIdentity";

/**
 * You (profile/stats). Ports the old StatsPanel/StatsList unchanged, plus
 * the account chip that used to live in the always-visible app header (now
 * You-owned, per the redesign's "You (profile/stats)... For guests, this is
 * where the persistent claim/log-in affordance lives"). Unclaimed sessions
 * (no identity yet, or a guest ghost) get a standing "Claim your stats" CTA
 * here - distinct from Results' one-shot claim CTA (already shipped), this
 * one persists for as long as the account stays unclaimed.
 */
export default function You({
  identitySession,
  onClaimIdentity,
  stats,
}: {
  identitySession: VGamesIdentitySession | null;
  onClaimIdentity: () => void;
  stats: AccountStats | null;
}) {
  const isUnclaimed = !identitySession || identitySession.status === "ghost";

  return (
    <section className="you-panel">
      <div className="account-chip" role="status" aria-label="Current player">
        {identitySession?.displayName ?? "Guest"}
      </div>

      {isUnclaimed ? (
        <section className="claim-cta" aria-label="Claim your stats">
          <p>
            {identitySession
              ? `You're on the board as ${identitySession.displayName}. Claim it so it stays yours.`
              : "Playing as a guest. Claim your name so your stats stay yours."}
          </p>
          <button type="button" onClick={onClaimIdentity}>
            Claim your stats
          </button>
        </section>
      ) : null}

      <StatsPanel stats={stats} />
    </section>
  );
}

// PKG-11 (council 2026-07-19, Judge A amendment 3, option b): "No data yet."
// - StatsList's own established convention (below) - covers both
// "stats haven't resolved yet" (loading/errored/no session; `stats` itself
// is null - see App.tsx's accountStatsProjection, which conflates all three)
// AND a resolved account's own genuinely-empty numeric field (`bestClicks`/
// `bestElapsedMs` are legitimately `null` before a first completion, not a
// missing-data bug). A confirmed-zero total (0 attempts, 0 completions, a
// fresh account's 0-day streak) now renders as the real number "0", never a
// bare "-" that reads like a rendering glitch. Distinguishing "loading" from
// "errored" from "guest, nothing to fetch" would need new state threaded
// through App.tsx -> AppShell.tsx -> You.tsx (accountStatsProjection has no
// such signal today) - descoped to its own ticket per the council rescope;
// this package only fixes the copy/zero-rendering, not that plumbing gap.
const NO_DATA_YET = "No data yet.";

function StatsPanel({ stats }: { stats: AccountStats | null }) {
  const totals = stats?.totals;

  return (
    <section className="stats-panel">
      <h2>Stats</h2>
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
        <div>
          <dt>Best clicks</dt>
          <dd>{totals?.bestClicks === null || totals?.bestClicks === undefined ? NO_DATA_YET : totals.bestClicks}</dd>
        </div>
        <div>
          <dt>Completed clicks</dt>
          <dd>{totals ? totals.totalClicks : NO_DATA_YET}</dd>
        </div>
      </dl>
      <StatsList
        title="Top starts"
        items={stats?.topStarts.map((item) => item.title) ?? []}
      />
      <StatsList
        title="Top targets"
        items={stats?.topTargets.map((item) => item.title) ?? []}
      />
      <StatsList title="Visited pages" items={stats?.mostVisited.map((item) => item.title) ?? []} />
    </section>
  );
}

function StatsList({ title, items }: { title: string; items: string[] }) {
  return (
    <section>
      <h3>{title}</h3>
      {items.length ? (
        <ol className="compact-list">
          {items.slice(0, 5).map((item) => (
            <li key={item}>
              <span>{item}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted">{NO_DATA_YET}</p>
      )}
    </section>
  );
}
