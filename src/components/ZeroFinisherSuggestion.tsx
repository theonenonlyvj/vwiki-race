import type { PlayAnotherSuggestionState } from "../domain/playAnother";

/**
 * Zero-finisher escape hatch (owner ask, 2026-07-26): a day with genuine
 * attempts but zero finishers (`ZERO_FINISHER_LABEL`, domain/boardSnippet.ts
 * - the same 2026-07-26 owner incident that copy itself came from) shouldn't
 * just tell players nobody's cracked it yet - it should point them at
 * something they CAN finish. This is the one line appended under that label
 * on both sites that render it for TODAY's daily (Home's hero board card,
 * Boards' Today segment - callers gate "is this actually today's daily, not
 * yesterday's/a trend window" themselves before rendering this; it never
 * second-guesses that).
 *
 * Deliberately reuses Increment 5's EXISTING play-another suggestion
 * (`getPlayAnotherSuggestion` - most-popular-not-yet-played, already
 * viewer-aware) rather than any new server logic - same state shape
 * `PlayAnotherCard` already renders, so a caller with that state already in
 * hand (Home) spends zero extra network cost, and one with its own local
 * fetch (Boards, which doesn't otherwise need this endpoint) still hits the
 * exact same one.
 *
 * Three cases, matching `PlayAnotherCard`'s own "never fabricate, never
 * dead-end" discipline:
 *  - Anonymous viewer (no account): the suggestion endpoint is authenticated
 *    and viewer-specific - there's nothing honest to offer - so this links
 *    straight to Browse instead of pretending to suggest anything.
 *  - Signed in, suggestion "ready": "Try an easier one ›" opens THAT
 *    challenge's Detail (`onOpenChallenge` - same "Detail, not a straight-in
 *    race start" route Browse's own cards and PlayAnotherCard's suggestion
 *    button use - invariant 3, "no run exists until Start").
 *  - Signed in but "empty" (started every active non-daily challenge
 *    already) / "loading" / "error": the same graceful Browse-all fallback
 *    PlayAnotherCard's own non-"ready" branches already use - never shows a
 *    stale or broken suggestion as if it were real (F6 discipline).
 */
export default function ZeroFinisherSuggestion({
  identityAccountId,
  suggestion,
  onOpenChallenge,
  onBrowseChallenges,
}: {
  identityAccountId: string | null;
  suggestion: PlayAnotherSuggestionState;
  onOpenChallenge: (challengeId: string) => void;
  onBrowseChallenges: () => void;
}) {
  if (identityAccountId !== null && suggestion.status === "ready") {
    const challengeId = suggestion.challenge.id;
    return (
      <p className="muted zero-finisher-suggestion">
        <button className="link-button" onClick={() => onOpenChallenge(challengeId)} type="button">
          Try an easier one ›
        </button>
      </p>
    );
  }

  return (
    <p className="muted zero-finisher-suggestion">
      <button className="link-button" onClick={onBrowseChallenges} type="button">
        Browse all challenges ›
      </button>
    </p>
  );
}
