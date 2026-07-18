import LeaderboardList from "../components/LeaderboardList";
import type { Challenge, RankedLeaderboardRow, ServerPathStep } from "../domain/types";

/**
 * Boards v0 (this task's scope - Increment 3 rebuilds this into the real
 * Today/Yesterday board design). A straight port of the old LeaderboardPanel
 * (challenge-scoped board), plus the selector it never needed while it lived
 * inside a shared tab: Boards is now a standalone mode, so it needs its own
 * way to change which challenge's board is showing without detouring
 * through Home. The full browse/create widget doesn't belong here (this is
 * a board, not the library), so this is a minimal native <select>, not a
 * second ChallengeBrowser mount.
 */
export default function Boards({
  challenges,
  leaderboard,
  onDisclosePath,
  onSelectChallenge,
  runPaths,
  selectedChallengeId,
  selectionLocked,
}: {
  challenges: Challenge[];
  leaderboard: RankedLeaderboardRow[];
  onDisclosePath: (runId: string) => void;
  onSelectChallenge: (challengeId: string) => void;
  runPaths: Record<string, ServerPathStep[]>;
  selectedChallengeId: string | null;
  selectionLocked: boolean;
}) {
  return (
    <section className="leaderboard-panel">
      <h2>Leaderboard</h2>
      <label className="name-control boards-selector">
        <span>Choose a challenge to view</span>
        <select
          aria-label="Choose a challenge to view"
          disabled={selectionLocked || challenges.length === 0}
          onChange={(event) => onSelectChallenge(event.target.value)}
          value={selectedChallengeId ?? ""}
        >
          {challenges.length === 0 ? <option value="">No challenges loaded</option> : null}
          {challenges.map((challenge) => (
            <option key={challenge.id} value={challenge.id}>
              {challenge.label ?? challenge.id}
            </option>
          ))}
        </select>
      </label>
      <LeaderboardList
        leaderboard={leaderboard}
        onDisclosePath={onDisclosePath}
        runPaths={runPaths}
      />
    </section>
  );
}
