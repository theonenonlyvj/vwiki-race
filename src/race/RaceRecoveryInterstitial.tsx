import type { MouseEvent } from "react";
import type { RacePhase } from "../hooks/useRaceController";
import type { ActiveRunRecord } from "../server/trackingRepository";

/**
 * Full-screen gate for the "recovery-required" outcome of recoverActiveRun
 * (a legacy protocol-1 run, or a run whose challenge no longer exists).
 * Reuses the existing End-Old-Run/Retry-Resume UI and App.tsx-owned
 * handlers verbatim - no new recovery logic lives here or in
 * useRaceController. Race flow spec: "control is not released to
 * Home/bottom-nav until it resolves" - an explicit exception to invariants
 * 3 (no run exists until Start) and 4 (identity asked only at Start/Create),
 * since a recovering account already has both.
 */
export default function RaceRecoveryInterstitial({
  recoveryRun,
  phase,
  endRunDisabled,
  onRetryResume,
  onRequestEndRun,
}: {
  recoveryRun: ActiveRunRecord;
  phase: RacePhase;
  endRunDisabled: boolean;
  onRetryResume: () => void;
  onRequestEndRun: (event: MouseEvent<HTMLElement>) => void;
}) {
  return (
    <section aria-label="Resume previous run" className="recovery-notice">
      <h2>Resume your previous run</h2>
      {recoveryRun.protocolVersion === 2 ? (
        <button disabled={phase !== "idle"} type="button" onClick={onRetryResume}>
          Retry Resume
        </button>
      ) : null}
      <button
        className="end-run-button"
        disabled={endRunDisabled}
        type="button"
        onClick={onRequestEndRun}
      >
        End Old Run
      </button>
    </section>
  );
}
