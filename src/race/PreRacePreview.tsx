import type { Challenge } from "../domain/types";
import type { TargetPreviewState } from "../hooks/useTargetPreview";

/**
 * Beat 1 of the race flow: a full-screen review of the target before the
 * timer starts. Never blocks Start on preview loading/failure (invariant:
 * preview failure never blocks play). No run exists until "Start race" is
 * pressed (invariant 3) - Back and "See other challenges" are free exits.
 */
export default function PreRacePreview({
  challenge,
  targetPreview,
  startDisabled,
  onBack,
  onSeeOtherChallenges,
  onStart,
}: {
  challenge: Challenge;
  targetPreview: TargetPreviewState;
  startDisabled: boolean;
  onBack: () => void;
  onSeeOtherChallenges: () => void;
  onStart: () => void;
}) {
  const readyPreview =
    targetPreview.status === "ready" && targetPreview.challengeId === challenge.id
      ? targetPreview
      : null;
  const unavailable =
    targetPreview.status === "unavailable" && targetPreview.challengeId === challenge.id;
  const title = readyPreview?.canonicalTitle ?? challenge.target.title;

  return (
    <section className="pre-race-preview" aria-label="Pre-race preview">
      <button
        aria-label="Back"
        className="icon-button pre-race-back"
        onClick={onBack}
        type="button"
      >
        ←
      </button>

      <div className="pre-race-copy">
        <span className="target-preview-kicker">Your target</span>
        <h2>{title}</h2>
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

        <p className="pre-race-start-article">Start: {challenge.start.title}</p>

        <button
          className="start-race-button"
          disabled={startDisabled}
          onClick={onStart}
          type="button"
        >
          Start race ▶
        </button>

        <button
          className="link-button pre-race-see-other"
          onClick={onSeeOtherChallenges}
          type="button"
        >
          Not feeling it? See other challenges ›
        </button>
      </div>
    </section>
  );
}
