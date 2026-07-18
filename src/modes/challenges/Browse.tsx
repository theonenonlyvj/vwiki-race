import { useEffect, useState, type FormEvent } from "react";
import { dailyBadgeLabel } from "../../domain/challengeSelection";
import type { Challenge } from "../../domain/types";

export interface CreateChallengeInput {
  startTitle: string;
  targetTitle: string;
  nominateForDaily: boolean;
}

/**
 * Challenges/Browse v1 (plan Task 2.3): a verbatim port of App.tsx's old
 * ChallengeBrowser - cards list + create-challenge form - unchanged in
 * behavior. Mounted both as the Challenges mode's own screen (AppShell) and
 * inside Home (the pre-redesign Play/Challenges duplication this increment
 * deliberately preserves; a later increment gives Home its own stateful
 * design and lets this widget become the sole "library" owner). Selecting a
 * card always resolves to the shared `onSelectChallenge` callback the
 * bootstrap wires per-mount - Home's mount keeps you on Home, Browse's mount
 * does the same (both call the same "select and go to Home" handler,
 * matching today's shipped behavior 1:1). Increment 5 gives Browse its own
 * aggregate/state-chip data and a proper detail hand-off.
 */
export default function ChallengeBrowser({
  canNominateForDaily,
  challenges,
  onCreateChallenge,
  onSelectChallenge,
  selectionLocked = false,
  selectedChallengeId,
  todayCentral,
}: {
  canNominateForDaily: boolean;
  challenges: Challenge[];
  onCreateChallenge: (input: CreateChallengeInput) => Promise<void>;
  onSelectChallenge: (challengeId: string) => void;
  selectionLocked?: boolean;
  selectedChallengeId: string | null;
  todayCentral: string;
}) {
  const [startTitle, setStartTitle] = useState("");
  const [targetTitle, setTargetTitle] = useState("");
  const [nominateForDaily, setNominateForDaily] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const canCreate =
    startTitle.trim().length > 0 && targetTitle.trim().length > 0;

  useEffect(() => {
    if (!canNominateForDaily) setNominateForDaily(false);
  }, [canNominateForDaily]);

  async function submitChallenge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selectionLocked || !canCreate) {
      return;
    }

    setIsCreating(true);
    try {
      await onCreateChallenge({
        startTitle: startTitle.trim(),
        targetTitle: targetTitle.trim(),
        nominateForDaily,
      });
      setStartTitle("");
      setTargetTitle("");
      setNominateForDaily(false);
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <section className="challenge-browser">
      <h2>Challenges</h2>
      <form className="create-challenge-form" onSubmit={submitChallenge}>
        <label className="name-control">
          <span>Start article</span>
          <input
            aria-label="Start article"
            disabled={selectionLocked}
            maxLength={512}
            onChange={(event) => setStartTitle(event.target.value)}
            placeholder="Wikipedia title or URL"
            value={startTitle}
          />
        </label>
        <label className="name-control">
          <span>Target article</span>
          <input
            aria-label="Target article"
            disabled={selectionLocked}
            maxLength={512}
            onChange={(event) => setTargetTitle(event.target.value)}
            placeholder="Wikipedia title or URL"
            value={targetTitle}
          />
        </label>
        {canNominateForDaily ? (
          <label className="daily-nomination-control">
            <input
              checked={nominateForDaily}
              disabled={selectionLocked}
              onChange={(event) => setNominateForDaily(event.target.checked)}
              type="checkbox"
            />
            <span>Nominate for a future Daily</span>
          </label>
        ) : null}
        <button type="submit" disabled={selectionLocked || !canCreate || isCreating}>
          Create Challenge
        </button>
      </form>
      {challenges.length ? (
        <ol className="challenge-list">
          {challenges.map((challenge) => (
            <li key={challenge.id}>
              <button
                aria-pressed={selectedChallengeId === challenge.id}
                disabled={selectionLocked}
                onClick={() => onSelectChallenge(challenge.id)}
                type="button"
              >
                <span className="challenge-meta">
                  <span>{challenge.label ?? challenge.id}</span>
                  {dailyBadgeLabel(challenge, todayCentral) ? (
                    <span className="daily-badge">
                      {dailyBadgeLabel(challenge, todayCentral)}
                    </span>
                  ) : null}
                </span>
                <strong>
                  {challenge.start.title} {"->"} {challenge.target.title}
                </strong>
                {challenge.createdBy ? (
                  <em>Created by {challenge.createdBy.displayName}</em>
                ) : null}
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted">No challenges loaded.</p>
      )}
    </section>
  );
}
