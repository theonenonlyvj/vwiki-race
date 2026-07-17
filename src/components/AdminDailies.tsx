import { useEffect, useState } from "react";
import type {
  DailyFlavor,
  DailyNomination,
  DailyQueueEntry,
} from "../domain/dailyEditorial";
import type { VWikiRaceDailyAdminApiClient } from "../services/vwikiRaceApiClient";
import type { Challenge } from "../domain/types";

interface AdminDailiesProps {
  apiClient: VWikiRaceDailyAdminApiClient;
  challenges: Challenge[];
  token: string;
}

interface DailyAdminState {
  nominations: DailyNomination[];
  queueEntries: DailyQueueEntry[];
}

const DAILY_FLAVORS: DailyFlavor[] = ["recognizable", "weird", "hard"];

export default function AdminDailies({ apiClient, challenges, token }: AdminDailiesProps) {
  const [state, setState] = useState<DailyAdminState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadVersion, setLoadVersion] = useState(0);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [flavorOverrides, setFlavorOverrides] = useState<Record<string, DailyFlavor>>({});
  const [directChallengeId, setDirectChallengeId] = useState("");
  const [directFlavor, setDirectFlavor] = useState<DailyFlavor>("recognizable");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    void apiClient.getDailyAdminState(token)
      .then((nextState) => {
        if (cancelled) return;
        setState(nextState);
      })
      .catch((caught) => {
        if (cancelled) return;
        setError(errorMessage(caught, "Could not load daily moderation."));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [apiClient, loadVersion, token]);

  async function approveNomination(nomination: DailyNomination) {
    const flavor = flavorOverrides[nomination.id] ?? nomination.suggestedFlavor ?? "recognizable";
    const action = `approve:${nomination.id}`;
    setBusyAction(action);
    setError(null);
    try {
      const queueEntry = await apiClient.approveDailyNomination(
        nomination.id,
        { flavor },
        token,
      );
      setState((current) => current === null
        ? current
        : {
            nominations: current.nominations.filter((item) => item.id !== nomination.id),
            queueEntries: replaceQueueEntry(current.queueEntries, queueEntry),
          });
    } catch (caught) {
      setError(errorMessage(caught, "Could not approve that nomination."));
    } finally {
      setBusyAction(null);
    }
  }

  async function declineNomination(nominationId: string) {
    const action = `decline:${nominationId}`;
    setBusyAction(action);
    setError(null);
    try {
      await apiClient.declineDailyNomination(nominationId, token);
      setState((current) => current === null
        ? current
        : {
            ...current,
            nominations: current.nominations.filter((item) => item.id !== nominationId),
          });
    } catch (caught) {
      setError(errorMessage(caught, "Could not decline that nomination."));
    } finally {
      setBusyAction(null);
    }
  }

  async function removeQueueEntry(queueEntryId: string) {
    const action = `remove:${queueEntryId}`;
    setBusyAction(action);
    setError(null);
    try {
      await apiClient.removeDailyQueueEntry(queueEntryId, token);
      setState((current) => current === null
        ? current
        : {
            ...current,
            queueEntries: current.queueEntries.filter((item) => item.id !== queueEntryId),
          });
    } catch (caught) {
      setError(errorMessage(caught, "Could not remove that queue entry."));
    } finally {
      setBusyAction(null);
    }
  }

  async function queueDirectPromotion() {
    const challengeId = directChallengeId.trim();
    if (!challengeId) {
      setError("Enter a challenge ID to add it to the queue.");
      return;
    }

    setBusyAction("direct-promotion");
    setError(null);
    try {
      const queueEntry = await apiClient.queueDailyChallenge({ challengeId, flavor: directFlavor }, token);
      setState((current) => current === null
        ? current
        : {
            ...current,
            queueEntries: replaceQueueEntry(current.queueEntries, queueEntry),
          });
      setDirectChallengeId("");
    } catch (caught) {
      setError(errorMessage(caught, "Could not queue that challenge."));
    } finally {
      setBusyAction(null);
    }
  }

  const pendingNominations = state?.nominations.filter((item) => item.status === "pending") ?? [];
  const queuedEntries = state?.queueEntries.filter((item) => item.status === "queued") ?? [];
  const challengeById = new Map(challenges.map((challenge) => [challenge.id, challenge]));
  const queuedChallengeIds = new Set(queuedEntries.map((entry) => entry.challengeId));
  const nominatedChallengeIds = new Set(pendingNominations.map((nomination) => nomination.challengeId));
  const directPromotionChallenges = challenges.filter((challenge) =>
    challenge.isActive !== false &&
    challenge.origin !== "daily" &&
    !challenge.dailyFeature &&
    !queuedChallengeIds.has(challenge.id) &&
    !nominatedChallengeIds.has(challenge.id)
  );

  return (
    <section className="daily-admin-layout" data-testid="daily-admin-layout" aria-labelledby="daily-admin-title">
      <header className="daily-admin-heading">
        <span className="viota-mark">VWiki</span>
        <h2 id="daily-admin-title">Daily moderation</h2>
      </header>

      {loading ? <p className="loading-text daily-admin-status">Loading daily moderation...</p> : null}
      {error ? (
        <section className="daily-admin-error" role="alert">
          <p>{error}</p>
          <button disabled={loading || busyAction !== null} onClick={() => setLoadVersion((version) => version + 1)} type="button">
            Retry
          </button>
        </section>
      ) : null}

      {state ? (
        <div className="daily-admin-columns">
          <section className="daily-admin-view" aria-labelledby="pending-nominations-title">
            <div className="daily-admin-view-heading">
              <h3 id="pending-nominations-title">Pending nominations</h3>
              <span>{pendingNominations.length}</span>
            </div>
            {pendingNominations.length === 0 ? (
              <p className="daily-admin-empty">No pending nominations.</p>
            ) : (
              <ol className="daily-admin-list">
                {pendingNominations.map((nomination) => {
                  const selectedFlavor = flavorOverrides[nomination.id] ??
                    nomination.suggestedFlavor ?? "recognizable";
                  const challenge = challengeById.get(nomination.challengeId);
                  return (
                    <li key={nomination.id}>
                      <article aria-label={`Nomination ${nomination.id}`} className="daily-nomination-row">
                        <div className="daily-row-title">
                          <strong>{challenge?.label ?? nomination.challengeId}</strong>
                          <span>{challengeRoute(challenge, nomination.challengeId)}</span>
                        </div>
                        <p className="daily-classifier-note">Nominated by {nomination.nominatedByDisplayName}</p>
                        <dl className="daily-score-grid" aria-label={`Classifier scores for ${nomination.challengeId}`}>
                          <div>
                            <dt>Recognizable</dt>
                            <dd>{formatScore(nomination.recognizableScore)}</dd>
                          </div>
                          <div>
                            <dt>Weird</dt>
                            <dd>{formatScore(nomination.weirdScore)}</dd>
                          </div>
                          <div>
                            <dt>Hard</dt>
                            <dd>{formatScore(nomination.hardScore)}</dd>
                          </div>
                        </dl>
                        <p className="daily-classifier-note">
                          Suggested: {nomination.suggestedFlavor ?? "unclassified"}
                        </p>
                        <p className="daily-classifier-note">Confidence: {nomination.confidence}</p>
                        <FlavorSegmentedControl
                          label={`Flavor for ${nomination.id}`}
                          onChange={(flavor) => setFlavorOverrides((current) => ({
                            ...current,
                            [nomination.id]: flavor,
                          }))}
                          value={selectedFlavor}
                        />
                        <div className="daily-row-actions">
                          <button
                            disabled={busyAction !== null}
                            onClick={() => void approveNomination(nomination)}
                            type="button"
                          >
                            Approve
                          </button>
                          <button
                            className="secondary-button"
                            disabled={busyAction !== null}
                            onClick={() => void declineNomination(nomination.id)}
                            type="button"
                          >
                            Decline
                          </button>
                        </div>
                      </article>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>

          <section className="daily-admin-view" aria-labelledby="daily-queue-title">
            <div className="daily-admin-view-heading">
              <h3 id="daily-queue-title">Approved queues</h3>
              <span>{queuedEntries.length}</span>
            </div>
            <div className="daily-queue-groups">
              {DAILY_FLAVORS.map((flavor) => {
                const entries = queuedEntries.filter((entry) => entry.flavor === flavor);
                return (
                  <section aria-label={`${flavorLabel(flavor)} queue`} className="daily-queue-group" key={flavor} role="region">
                    <h4>{flavorLabel(flavor)}</h4>
                    {entries.length === 0 ? (
                      <p className="daily-admin-empty">No queued challenges.</p>
                    ) : (
                      <ol className="daily-admin-list">
                        {entries.map((entry) => (
                          <li key={entry.id}>
                            <article aria-label={`Queued challenge ${entry.id}`} className="daily-queue-row">
                              <div className="daily-row-title">
                                <strong>{challengeById.get(entry.challengeId)?.label ?? entry.challengeId}</strong>
                                <span>{challengeRoute(challengeById.get(entry.challengeId), entry.challengeId)}</span>
                                <span>{entry.source}</span>
                              </div>
                              <button
                                className="secondary-button"
                                disabled={busyAction !== null}
                                onClick={() => void removeQueueEntry(entry.id)}
                                type="button"
                              >
                                Remove
                              </button>
                            </article>
                          </li>
                        ))}
                      </ol>
                    )}
                  </section>
                );
              })}
            </div>
          </section>

          <section aria-label="Direct promotion" className="daily-admin-view daily-direct-promotion" role="region">
            <div className="daily-admin-view-heading">
              <h3>Direct promotion</h3>
            </div>
            <label className="name-control">
              <span>Challenge</span>
              <select
                aria-label="Challenge"
                disabled={busyAction !== null}
                onChange={(event) => setDirectChallengeId(event.target.value)}
                value={directChallengeId}
              >
                <option value="">Choose a challenge</option>
                {directPromotionChallenges.map((challenge) => (
                  <option key={challenge.id} value={challenge.id}>
                    {challenge.label ?? challenge.id}: {challenge.start.title} -&gt; {challenge.target.title}
                  </option>
                ))}
              </select>
            </label>
            <FlavorSegmentedControl
              label="Direct promotion flavor"
              onChange={setDirectFlavor}
              value={directFlavor}
            />
            <button
              disabled={busyAction !== null || !directChallengeId.trim()}
              onClick={() => void queueDirectPromotion()}
              type="button"
            >
              Queue challenge
            </button>
          </section>
        </div>
      ) : null}
    </section>
  );
}

function FlavorSegmentedControl({
  label,
  onChange,
  value,
}: {
  label: string;
  onChange: (flavor: DailyFlavor) => void;
  value: DailyFlavor;
}) {
  return (
    <div aria-label={label} className="daily-flavor-control" role="group">
      {DAILY_FLAVORS.map((flavor) => (
        <button
          aria-pressed={value === flavor}
          className={value === flavor ? "active" : undefined}
          key={flavor}
          onClick={() => onChange(flavor)}
          type="button"
        >
          {flavorLabel(flavor)}
        </button>
      ))}
    </div>
  );
}

function replaceQueueEntry(entries: DailyQueueEntry[], entry: DailyQueueEntry): DailyQueueEntry[] {
  return [...entries.filter((item) => item.id !== entry.id), entry];
}

function formatScore(value: number | null): string {
  return value === null ? "-" : String(value);
}

function flavorLabel(flavor: DailyFlavor): string {
  return `${flavor.slice(0, 1).toUpperCase()}${flavor.slice(1)}`;
}

function errorMessage(caught: unknown, fallback: string): string {
  return caught instanceof Error ? caught.message : fallback;
}

function challengeRoute(challenge: Challenge | undefined, fallback: string): string {
  return challenge ? `${challenge.start.title} -> ${challenge.target.title}` : fallback;
}
