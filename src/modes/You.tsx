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

function StatsPanel({ stats }: { stats: AccountStats | null }) {
  const totals = stats?.totals;

  return (
    <section className="stats-panel">
      <h2>Stats</h2>
      <dl className="stat-grid">
        <div>
          <dt>Attempts</dt>
          <dd>{totals?.attempts ?? "-"}</dd>
        </div>
        <div>
          <dt>Completed</dt>
          <dd>{totals?.completed ?? "-"}</dd>
        </div>
        <div>
          <dt>DNFs</dt>
          <dd>{totals?.abandoned ?? "-"}</dd>
        </div>
        <div>
          <dt>Best speed</dt>
          <dd>{totals?.bestElapsedMs === null || totals?.bestElapsedMs === undefined ? "-" : formatElapsed(totals.bestElapsedMs)}</dd>
        </div>
        <div>
          <dt>Best clicks</dt>
          <dd>{totals?.bestClicks ?? "-"}</dd>
        </div>
        <div>
          <dt>Completed clicks</dt>
          <dd>{totals?.totalClicks ?? "-"}</dd>
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
        <p className="muted">No data yet.</p>
      )}
    </section>
  );
}
