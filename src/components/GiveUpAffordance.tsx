import { useState } from "react";
import { apiErrorCode, type ErrorReporter } from "../services/errorReporting";
import type { VWikiRaceApiClient } from "../services/vwikiRaceApiClient";

/**
 * "I gave up" affordance (owner spec, 2026-08-02: "I don't want to be
 * encouraging people to give up" - no in-race button; this lives POST-RUN
 * only, next to "Try again"/the retry affordance on Challenge Detail and the
 * DNF Results screen). Callers gate rendering this at all on
 * `ChallengeOutcomeEntry.giveUpEligible && !peeked` (see that field's own
 * doc comment, domain/types.ts) - this component itself renders nothing
 * beyond the collapsed link-button until clicked, and nothing at all
 * without a real identity token (an anonymous browse-only viewer can't have
 * a DNF to give up on in the first place - invariant 3, "no run exists
 * until Start").
 *
 * Deliberately a plain inline expand-to-confirm widget, not the shared
 * `ModalDialog` (App.tsx's End Run/identity dialogs) - the confirm copy is
 * one short sentence with two buttons, not worth the focus-trap/portal
 * machinery a real modal carries, and keeping this fully self-contained
 * means Detail and Results can each mount it with zero App.tsx state
 * threading.
 */
export default function GiveUpAffordance({
  apiClient,
  challengeId,
  errorReporter,
  identityToken,
  onPeeked,
}: {
  apiClient: VWikiRaceApiClient;
  challengeId: string;
  errorReporter: Pick<ErrorReporter, "reportVisibleError">;
  identityToken: string | null;
  /** Fired once the server has durably recorded the peek. The caller (not
   *  this component) owns what happens next - re-fetching outcomes to
   *  swap this affordance for "The solution", navigating to Detail, etc. */
  onPeeked: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!identityToken) return null;
  // Narrowed to a plain `string` const for the closure below - TS doesn't
  // retain the `!identityToken` guard's narrowing inside a nested function
  // declaration invoked later from an event handler.
  const token = identityToken;

  if (!confirming) {
    return (
      <button
        type="button"
        className="link-button muted give-up-link"
        onClick={() => setConfirming(true)}
      >
        I give up — show me the solution
      </button>
    );
  }

  async function confirmGiveUp() {
    setBusy(true);
    setError(null);
    try {
      await apiClient.giveUpChallenge(challengeId, token);
      // Deliberately left `busy: true` on success - the caller is expected
      // to stop rendering this component (outcome flips to `peeked`) almost
      // immediately; resetting local state here would just risk a one-frame
      // flash of the confirm panel reverting before that happens.
      onPeeked();
    } catch (caught) {
      const message = errorMessage(caught, "Couldn't record that. Try again.");
      errorReporter.reportVisibleError("give-up", apiErrorCode(caught), message);
      setError(message);
      setBusy(false);
    }
  }

  return (
    <div className="give-up-confirm" role="group" aria-label="Give up confirmation">
      <p className="muted">
        See the solution? This challenge&apos;s boards close for you — future runs won&apos;t rank.
      </p>
      {error ? (
        <p className="error-banner" role="alert">{error}</p>
      ) : null}
      <div className="give-up-confirm-actions">
        <button type="button" disabled={busy} onClick={() => void confirmGiveUp()}>
          {busy ? "Giving up…" : "Yes, show me"}
        </button>
        <button
          type="button"
          className="link-button"
          disabled={busy}
          onClick={() => {
            setConfirming(false);
            setError(null);
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function errorMessage(caught: unknown, fallback: string): string {
  return caught instanceof Error ? caught.message : fallback;
}
