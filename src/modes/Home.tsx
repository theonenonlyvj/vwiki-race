import { dailyBadgeLabel } from "../domain/challengeSelection";
import type { Challenge } from "../domain/types";
import { type TargetPreviewState } from "../hooks/useTargetPreview";
import { ChallengeShareButton } from "../race/shared";
import ChallengeBrowser, { type CreateChallengeInput } from "./challenges/Browse";

/**
 * Home v1 (this task's placeholder scope - the follow-up task makes it the
 * stateful pre-play/DNF/post-play daily hub from the redesign spec). Moves
 * the old PlayPanel content over essentially as-is: the how-to-play line,
 * the current challenge's route + Start/Race button (previously stranded in
 * the app-wide header, now Home-owned per the spec's "Home owns 'play
 * today'"), the target preview card, and the embedded challenge
 * browser/create form (unchanged duplication with Browse - see that file's
 * comment).
 */
export default function Home({
  canNominateForDaily,
  challenges,
  onCreateChallenge,
  onSelectChallenge,
  onStartChallenge,
  selectedChallenge,
  selectionLocked,
  startDisabled,
  targetPreview,
  todayCentral,
}: {
  canNominateForDaily: boolean;
  challenges: Challenge[];
  onCreateChallenge: (input: CreateChallengeInput) => Promise<void>;
  onSelectChallenge: (challengeId: string) => void;
  onStartChallenge: () => void;
  selectedChallenge: Challenge | null;
  selectionLocked: boolean;
  startDisabled: boolean;
  targetPreview: TargetPreviewState;
  todayCentral: string;
}) {
  return (
    <section className="home-layout">
      <p className="how-to-play muted">
        Race from the start article to the target using only links inside the page. Fastest time wins.
      </p>

      {selectedChallenge ? (
        <div className="home-target">
          <div className="challenge-route" aria-label="Current challenge">
            <div className="challenge-meta">
              <span>{selectedChallenge.label ?? "Challenge"}</span>
              {dailyBadgeLabel(selectedChallenge, todayCentral) ? (
                <span className="daily-badge">
                  {dailyBadgeLabel(selectedChallenge, todayCentral)}
                </span>
              ) : null}
            </div>
            <strong>
              {selectedChallenge.start.title} {"->"} {selectedChallenge.target.title}
            </strong>
          </div>

          <div className="player-gate">
            <button
              type="button"
              disabled={startDisabled}
              onClick={onStartChallenge}
            >
              {`Start ${selectedChallenge.label ?? "Challenge"}`}
            </button>
          </div>

          <TargetPreviewPanel
            challenge={selectedChallenge}
            targetPreview={targetPreview}
          />
        </div>
      ) : (
        <section className="empty-state">
          <span>Challenge</span>
          <h2>Loading challenge catalog</h2>
          <p>Pick a challenge.</p>
        </section>
      )}

      <ChallengeBrowser
        canNominateForDaily={canNominateForDaily}
        challenges={challenges}
        onCreateChallenge={onCreateChallenge}
        onSelectChallenge={onSelectChallenge}
        selectedChallengeId={selectedChallenge?.id ?? null}
        selectionLocked={selectionLocked}
        todayCentral={todayCentral}
      />
    </section>
  );
}

function TargetPreviewPanel({
  challenge,
  targetPreview,
}: {
  challenge: Challenge;
  targetPreview: TargetPreviewState;
}) {
  const readyPreview =
    targetPreview.status === "ready" && targetPreview.challengeId === challenge.id
      ? targetPreview
      : null;
  const unavailable =
    targetPreview.status === "unavailable" && targetPreview.challengeId === challenge.id;
  const title = readyPreview?.canonicalTitle ?? challenge.target.title;

  return (
    <section
      aria-label="Target preview"
      className="target-preview-panel"
      role="region"
    >
      <div className="target-preview-copy">
        <span className="target-preview-kicker">Target preview</span>
        <h2 id="target-preview-title">{title}</h2>
        {readyPreview ? (
          <p className="target-preview-blurb">
            {readyPreview.preview.blurb ?? "Wikipedia does not provide a short lead for this target."}
          </p>
        ) : unavailable ? (
          <p className="target-preview-blurb muted">Preview unavailable. You can still start the challenge.</p>
        ) : (
          <p className="target-preview-blurb muted">Loading target preview...</p>
        )}
        {readyPreview ? (
          <p className="target-preview-attribution">
            <a href={readyPreview.attributionUrl} rel="noreferrer noopener" target="_blank">
              Source revision
            </a>{" "}
            ·{" "}
            <a
              href="https://creativecommons.org/licenses/by-sa/4.0/"
              rel="noreferrer noopener"
              target="_blank"
            >
              CC BY-SA 4.0
            </a>
          </p>
        ) : null}
        <ChallengeShareButton challengeId={challenge.id} />
      </div>
    </section>
  );
}
