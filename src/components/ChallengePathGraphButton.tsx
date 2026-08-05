import { useEffect, useRef, useState, type RefObject } from "react";
import ChallengePathGraph from "./ChallengePathGraph";
import ModalDialog from "./ModalDialog";
import type { ChallengePathRunEntry } from "../domain/types";
import { apiErrorCode, type ErrorReporter } from "../services/errorReporting";
import type { VWikiRaceApiClient } from "../services/vwikiRaceApiClient";

type LoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "loaded"; runs: ChallengePathRunEntry[] };

/**
 * GR-1 ("View graph"): the one shared trigger + modal every board surface
 * (Challenge Detail's Leaderboard panel, Stats' Today/Yesterday segments,
 * Results' board snippet, and - best-effort - Home's yesterday recap) reuses,
 * so the fetch/loading/error handling and the "could this viewer even see
 * paths" gating can't drift per call site. Owner brief (verbatim): "a subtle
 * 'view graph' button that pops up this modal any time stats are shown for a
 * challenge."
 *
 * Renders nothing at all when `unlocked` is false - never a disabled/locked
 * button. A locked graph button would taunt a non-finisher with "there's
 * more here you can't see yet"; the existing per-row path disclosure already
 * settled this exact question the same way ("Paths hidden until you've
 * played" - the affordance itself disappears, it doesn't grey out).
 */
export default function ChallengePathGraphButton({
  apiClient,
  challengeId,
  errorReporter,
  identityToken,
  unlocked,
}: {
  apiClient: VWikiRaceApiClient;
  challengeId: string;
  errorReporter: Pick<ErrorReporter, "reportVisibleError">;
  // The bearer token backing the SAME client-side "has this viewer played"
  // knowledge that `unlocked` already encodes (ChallengeDetail's
  // `pathsUnlocked`, Boards' `Boolean(ownPlacement)`, Results'
  // `outcome.status === "completed"`) - the server enforces the real FB-4
  // guard regardless, this is just what the fetch call needs to carry.
  identityToken: string | null;
  unlocked: boolean;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  if (!unlocked) return null;

  return (
    <>
      <button
        className="link-button graph-trigger"
        onClick={(event) => {
          triggerRef.current = event.currentTarget;
          setOpen(true);
        }}
        type="button"
      >
        View graph
      </button>
      {open ? (
        <ChallengePathGraphDialog
          apiClient={apiClient}
          challengeId={challengeId}
          errorReporter={errorReporter}
          identityToken={identityToken}
          onClose={() => setOpen(false)}
          returnFocusRef={triggerRef}
        />
      ) : null}
    </>
  );
}

function ChallengePathGraphDialog({
  apiClient,
  challengeId,
  errorReporter,
  identityToken,
  onClose,
  returnFocusRef,
}: {
  apiClient: VWikiRaceApiClient;
  challengeId: string;
  errorReporter: Pick<ErrorReporter, "reportVisibleError">;
  identityToken: string | null;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    if (!identityToken) {
      // Shouldn't be reachable - `unlocked` implies a completed run, which
      // implies a session - but fails closed (an error state, not a silent
      // fetch of nothing) rather than assuming.
      errorReporter.reportVisibleError("path-graph", "missing_identity_token", "Couldn't load the graph.");
      setState({ status: "error" });
      return;
    }
    void apiClient.getChallengePaths(challengeId, identityToken)
      .then((response) => {
        if (!cancelled) setState({ status: "loaded", runs: response.runs });
      })
      .catch((caught) => {
        if (cancelled) return;
        errorReporter.reportVisibleError("path-graph", apiErrorCode(caught), "Couldn't load the graph.");
        setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [apiClient, challengeId, errorReporter, identityToken, retryToken]);

  return (
    <ModalDialog
      className="graph-modal"
      onClose={onClose}
      // GX-1: every board surface mounts this button inside a clip-path'd
      // panel (`.leaderboard-panel`/`.board-snippet`'s panel ancestors) -
      // clip-path creates a stacking context, which traps an inline
      // `.modal-backdrop`'s z-index inside that panel instead of the whole
      // page (see ModalDialog's own doc comment for the full mechanism).
      // Portaling to <body> is what actually makes this modal render as a
      // full-viewport overlay instead of losing the paint order battle to
      // whatever comes after the panel in the DOM.
      portal
      returnFocusRef={returnFocusRef}
      titleId="challenge-graph-title"
    >
      <div className="identity-dialog-heading">
        <h2 id="challenge-graph-title">Everyone&apos;s path</h2>
        <button aria-label="Close graph" className="icon-button" onClick={onClose} type="button">
          x
        </button>
      </div>

      {state.status === "loading" ? (
        <p className="muted">Loading graph…</p>
      ) : state.status === "error" ? (
        // Spec: "error state = quiet retry line" - not the louder
        // `.error-banner` treatment Boards' trend fetch uses; this is
        // optional bonus content on top of a screen that already rendered
        // fine, not a blocking failure.
        <p className="muted graph-modal-error">
          Couldn&apos;t load the graph.{" "}
          <button
            className="link-button"
            onClick={() => setRetryToken((value) => value + 1)}
            type="button"
          >
            Try again
          </button>
        </p>
      ) : state.runs.length ? (
        <ChallengePathGraph runs={state.runs} />
      ) : (
        <p className="muted">No paths to show yet.</p>
      )}
    </ModalDialog>
  );
}
