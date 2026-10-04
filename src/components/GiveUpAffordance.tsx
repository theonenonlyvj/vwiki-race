import { useEffect, useId, useRef, useState } from "react";
import { apiErrorCode, type ErrorReporter } from "../services/errorReporting";
import ModalDialog from "./ModalDialog";
import type { VWikiRaceApiClient } from "../services/vwikiRaceApiClient";

/** Post-run answer reveal or an explanation of unmet requirements.
 * the server records the ranking forfeiture only after explicit confirmation. */
export default function GiveUpAffordance({
  apiClient,
  challengeId,
  errorReporter,
  eligible,
  ineligibleReason = "more-progress",
  attemptClickCount,
  onRace,
  raceDisabled = false,
  identityToken,
  onPeeked,
}: {
  apiClient: VWikiRaceApiClient;
  challengeId: string;
  errorReporter: Pick<ErrorReporter, "reportVisibleError">;
  identityToken: string | null;
  eligible: boolean;
  ineligibleReason?: "minimum-clicks" | "more-progress";
  attemptClickCount?: number;
  onRace: () => void;
  raceDisabled?: boolean;
  /** Fired once the server has durably recorded the peek. The caller (not
   *  this component) owns what happens next - re-fetching outcomes to
   *  swap this affordance for "The solution", navigating to Detail, etc. */
  onPeeked: () => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestGeneration = useRef(0);
  useEffect(() => {
    requestGeneration.current += 1;
    setConfirming(false);
    setBusy(false);
    setError(null);
    return () => { requestGeneration.current += 1; };
  }, [identityToken, challengeId]);

  if (!identityToken) return null;
  // Narrowed to a plain `string` const for the closure below - TS doesn't
  // retain the `!identityToken` guard's narrowing inside a nested function
  // declaration invoked later from an event handler.
  const token = identityToken;
  const knownClicks = typeof attemptClickCount === "number" && Number.isInteger(attemptClickCount) && attemptClickCount >= 0
    ? attemptClickCount : null;
  const explanation = ineligibleReason === "minimum-clicks"
    ? knownClicks !== null && knownClicks < 2
      ? `This attempt recorded ${knownClicks} accepted ${knownClicks === 1 ? "click" : "clicks"}. At least 2 are required before answers can unlock.`
      : "No qualifying attempt is recorded for this challenge yet."
    : knownClicks !== null && knownClicks >= 2 && knownClicks < 5
      ? `This attempt recorded ${knownClicks} accepted clicks, below the 5-click requirement, and didn't qualify for the 3-minute alternative.`
      : "None of your attempts with at least 2 clicks has met the 5-click or 3-minute requirement.";

  function close() {
    if (busy) return;
    setConfirming(false);
    setError(null);
  }

  async function confirmGiveUp() {
    if (!eligible || busy) return;
    const generation = requestGeneration.current;
    setBusy(true);
    setError(null);
    try {
      await apiClient.giveUpChallenge(challengeId, token);
      // Deliberately left `busy: true` on success - the caller is expected
      // to stop rendering this component (outcome flips to `peeked`) almost
      // immediately; resetting local state here would just risk a one-frame
      // flash of the confirm panel reverting before that happens.
      if (requestGeneration.current === generation) onPeeked();
    } catch (caught) {
      if (requestGeneration.current !== generation) return;
      const message = errorMessage(caught, "Couldn't record that. Try again.");
      errorReporter.reportVisibleError("give-up", apiErrorCode(caught), message);
      setError(message);
      if (requestGeneration.current === generation) setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="link-button muted give-up-link"
        ref={triggerRef}
        onClick={() => setConfirming(true)}
      >
        Show me the answers
      </button>
      {confirming ? (
        <ModalDialog
          className="identity-dialog give-up-dialog"
          titleId={titleId}
          returnFocusRef={triggerRef}
          onClose={close}
          busy={busy}
          portal
        >
          <h2 id={titleId}>{eligible ? "Show me the answers?" : "Answers are still locked"}</h2>
          {eligible ? (
            <p className="identity-copy">
              Future attempts on this challenge won&apos;t rank. You can still play for practice.
            </p>
          ) : (
            <>
              <p className="identity-copy">
                {explanation}
              </p>
              <p className="identity-copy">
                Race again: make at least 2 clicks, and reach either 5 clicks or 3 minutes
                before ending the run.
              </p>
            </>
          )}
          {error ? <p className="error-banner" role="alert">{error}</p> : null}
          <div className="give-up-confirm-actions">
            <button type="button" className="link-button" disabled={busy} onClick={close}>
              Cancel
            </button>
            {eligible ? (
              <button type="button" disabled={busy} onClick={() => void confirmGiveUp()}>
                {busy ? "Revealing…" : "Yes, show me"}
              </button>
            ) : (
              <button type="button" disabled={raceDisabled} onClick={() => { close(); onRace(); }}>
                ▶ Race
              </button>
            )}
          </div>
        </ModalDialog>
      ) : null}
    </>
  );
}

function errorMessage(caught: unknown, fallback: string): string {
  return caught instanceof Error ? caught.message : fallback;
}
