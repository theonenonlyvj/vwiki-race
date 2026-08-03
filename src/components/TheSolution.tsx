import { useEffect, useState } from "react";
import StagedLoadingNotice from "./StagedLoadingNotice";
import WinningPathChain from "./WinningPathChain";
import type { ChallengePathsResponse } from "../server/contracts";
import type { VWikiRaceApiClient } from "../services/vwikiRaceApiClient";

function emptyResult(): ChallengePathsResponse {
  return { runs: [], totalRuns: 0 };
}

/**
 * "I gave up" solution view (owner spec, 2026-08-02). Mounted by Challenge
 * Detail ONLY for a peeked viewer (`ChallengeOutcomeEntry.peeked`) - reuses
 * the existing `GET /challenges/{id}/paths` endpoint, whose disclosure guard
 * was extended (server-side) to admit a peeked-but-never-finished viewer,
 * not just a finisher. Self-fetches with the same reset-then-refetch-then-
 * cancel-guard shape ChallengeDetail's own Leaderboard panel and RaceResults
 * already use for their own board fetches, so switching between two peeked
 * challenges (a back/forward step) can't leak a stale solution across the
 * switch.
 *
 * Three cases, per the guaranteed server contract (`getChallengePaths`
 * always empties `runs` unless its first entry is a real completion -
 * "finishers-fastest-first" ordering plus the disclosure fix mean a
 * non-empty `runs[0]` is always case (a)):
 *  (a) `runs.length > 0` - the best (fastest) finisher's real path.
 *  (b) `runs` empty but `referencePath` present - the stored best-effort
 *      route computed at daily-drop time (dailies only).
 *  (c) neither - the honest "nobody's cracked it" copy.
 */
export default function TheSolution({
  apiClient,
  challengeId,
  identityToken,
}: {
  apiClient: VWikiRaceApiClient;
  challengeId: string;
  identityToken: string;
}) {
  const [result, setResult] = useState<ChallengePathsResponse>(emptyResult);
  const [status, setStatus] = useState<"loading" | "error" | "ready">("loading");
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setResult(emptyResult());
    setStatus("loading");
    void apiClient.getChallengePaths(challengeId, identityToken)
      .then((response) => {
        if (!cancelled) {
          setResult(response);
          setStatus("ready");
        }
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [apiClient, challengeId, identityToken, retryToken]);

  const finisher = result.runs[0];

  return (
    <section className="leaderboard-panel the-solution" aria-label="The solution">
      <h3>The solution</h3>
      {status === "error" ? (
        <div className="board-error">
          <p className="error-banner" role="alert">Couldn&apos;t load the solution.</p>
          <button onClick={() => setRetryToken((value) => value + 1)} type="button">
            Retry
          </button>
        </div>
      ) : status === "loading" ? (
        <StagedLoadingNotice
          active
          onRetry={() => setRetryToken((value) => value + 1)}
          pendingLabel="Loading the solution…"
        />
      ) : finisher ? (
        <WinningPathChain titles={pathToChain(finisher.steps)} />
      ) : result.referencePath ? (
        <>
          <p className="muted">Reference route</p>
          <WinningPathChain titles={result.referencePath} />
        </>
      ) : (
        <p className="muted">No one — human or machine — has cracked this one yet.</p>
      )}
    </section>
  );
}

function pathToChain(steps: ChallengePathsResponse["runs"][number]["steps"]): string[] {
  if (steps.length === 0) return [];
  return [steps[0]!.from, ...steps.map((step) => step.to)];
}
