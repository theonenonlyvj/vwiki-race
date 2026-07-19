import { formatSuggestionTitle, RANDOM_CHALLENGE_LOADING_COPY } from "../domain/playAnother";
import type { PlayAnotherSuggestionState } from "../domain/playAnother";

/**
 * Home's post-play "Got a few more minutes?" card and Results' Play-another
 * slot (Increment 5, UX redesign spec §Home + §Race flow beat 3) share this
 * one component so the two screens can never drift: "ONE suggested challenge
 * ('🏁 <start> → <target> · <N> players')... + 'Browse all challenges ›' -
 * never a menu." Tapping the suggestion opens Challenge Detail (the same
 * route Browse's own cards use), not a direct race start - invariant 3
 * ("no run exists until Start") holds here exactly as it does in Browse.
 *
 * `suggestion.status === "empty"` (spec: "Suggestion null (started
 * everything) → show 'Create a random new one' in the same slot") swaps in
 * the on-demand random-challenge action instead of a specific suggestion -
 * disabled and showing the bounded "Rolling the dice..." copy while
 * in-flight (the caller owns the single busy flag shared with Browse's own
 * bottom action, so the two can never double-fire against each other).
 * `"loading"`/`"error"` degrade to just the Browse-all link, matching
 * Boards' F6 discipline: never silently show the wrong state as if it were
 * real data.
 *
 * PKG-05 (council 2026-07-19): the suggestion/random-challenge button uses
 * the existing `.secondary-button` treatment (mockup-race-flow-v3 panel 3's
 * smaller bordered card) rather than the default solid-cyan button weight -
 * this is a shared component, so the demotion is a twofer: it fixes both
 * Results' Play-another slot AND Home's "Got a few more minutes?" card in
 * one change, intentionally (not a side effect discovered mid-implementation).
 */
export default function PlayAnotherCard({
  suggestion,
  onOpenChallenge,
  onBrowseChallenges,
  randomChallengeBusy,
  randomChallengeError,
  onCreateRandomChallenge,
}: {
  suggestion: PlayAnotherSuggestionState;
  onOpenChallenge: (challengeId: string) => void;
  onBrowseChallenges: () => void;
  randomChallengeBusy: boolean;
  randomChallengeError: string | null;
  onCreateRandomChallenge: () => void;
}) {
  return (
    <section aria-label="Play another challenge" className="play-another-card">
      <h3>Got a few more minutes?</h3>

      {suggestion.status === "ready" ? (
        <button
          className="secondary-button"
          type="button"
          onClick={() => onOpenChallenge(suggestion.challenge.id)}
        >
          {formatSuggestionTitle(suggestion.challenge, suggestion.playerCount)}
        </button>
      ) : suggestion.status === "empty" ? (
        <>
          <button
            className="secondary-button"
            disabled={randomChallengeBusy}
            type="button"
            onClick={onCreateRandomChallenge}
          >
            {randomChallengeBusy ? RANDOM_CHALLENGE_LOADING_COPY : "Create a random new one"}
          </button>
          {randomChallengeError ? (
            <p className="error-banner" role="alert">{randomChallengeError}</p>
          ) : null}
        </>
      ) : null}

      <button className="link-button" type="button" onClick={onBrowseChallenges}>
        Browse all challenges ›
      </button>
    </section>
  );
}
