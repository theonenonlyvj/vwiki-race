import { useEffect, useMemo, useState, type FormEvent } from "react";
import StateChip from "../../components/StateChip";
import { formatChallengeCardMeta } from "../../domain/challengeCard";
import { dailyBadgeLabel, type HomeHeroSelection } from "../../domain/challengeSelection";
import { filterChallengesByQuery, resolveChallengeIdFromSearchInput } from "../../domain/challengeSearch";
import { RANDOM_CHALLENGE_LOADING_COPY } from "../../domain/playAnother";
import type { Challenge, ChallengeOutcomeEntry, ChallengeSummaryEntry } from "../../domain/types";
import type { VWikiRaceApiClient } from "../../services/vwikiRaceApiClient";

export interface CreateChallengeInput {
  startTitle: string;
  targetTitle: string;
  nominateForDaily: boolean;
}

/**
 * Challenges/Browse full card spec (Increment 5, UX redesign spec
 * §Challenges): each card grows a meta line ("N players · best 0:38 · 5
 * clk", from `GET /api/v2/challenges/summary` - fetched once per Browse
 * view, cached in state) and a right-aligned state chip (`GET
 * /api/v2/account/challenge-outcomes`, only when there's a session -
 * anonymous browsing gets no chips and makes no outcomes call at all). A
 * search field at the top filters cards live by title AND accepts a pasted
 * share link or bare challenge id, jumping straight to that Detail (same
 * route Browse's own cards use) - see `resolveChallengeIdFromSearchInput`.
 * "Create a random new one" sits beside the existing create-challenge form,
 * sharing App.tsx's single random-challenge busy/error state with Home's and
 * Results' Play-another card so the two surfaces can never double-fire
 * against each other.
 *
 * PKG-01: a pinned daily row sits above the catalog ("⭐ <daily badge> ·
 * pair", state chip), sourced from `heroSelection` - the SAME
 * `selectHomeHeroChallenge` pick AppShell hands to Home's hero and Boards'
 * Today segment, so Browse can never pin a different "today's daily" than
 * either of those. It routes to Home (`onGoHome`), not Challenge Detail
 * (spec: "The daily pinned at top but pointing to Home") - Home, not
 * Browse, owns the actual race/board UI for it. Mirrors the same honesty
 * rule as Boards/Home: the pin only ever shows for `today-daily`/
 * `yesterday-daily` kinds; the "default" kind (no daily anywhere in the
 * catalog) renders no pin at all rather than disguising an arbitrary
 * fallback challenge as the daily.
 */
export default function ChallengeBrowser({
  apiClient,
  canNominateForDaily,
  challenges,
  heroSelection,
  identityToken,
  onCreateChallenge,
  onCreateRandomChallenge,
  onGoHome,
  onOpenChallenge,
  randomChallengeBusy,
  randomChallengeError,
  selectionLocked = false,
  selectedChallengeId,
  todayCentral,
}: {
  apiClient: VWikiRaceApiClient;
  canNominateForDaily: boolean;
  challenges: Challenge[];
  // PKG-01: AppShell's `homeHero` - see this file's doc comment above.
  // `null` while the catalog is still loading (or is genuinely empty).
  heroSelection: HomeHeroSelection | null;
  // `null` for an anonymous/no-session visitor (spec: "Anonymous/no-session:
  // no chips (no outcomes call)") - browsing itself never requires identity
  // (invariant 4).
  identityToken: string | null;
  onCreateChallenge: (input: CreateChallengeInput) => Promise<void>;
  onCreateRandomChallenge: () => void;
  // The pinned daily row's route (spec: "pinned at top but pointing to
  // Home") - distinct from `onOpenChallenge`, which every other card uses.
  onGoHome: () => void;
  onOpenChallenge: (challengeId: string) => void;
  randomChallengeBusy: boolean;
  randomChallengeError: string | null;
  selectionLocked?: boolean;
  selectedChallengeId: string | null;
  todayCentral: string;
}) {
  const [startTitle, setStartTitle] = useState("");
  const [targetTitle, setTargetTitle] = useState("");
  const [nominateForDaily, setNominateForDaily] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const canCreate =
    startTitle.trim().length > 0 && targetTitle.trim().length > 0;

  useEffect(() => {
    if (!canNominateForDaily) setNominateForDaily(false);
  }, [canNominateForDaily]);

  // Fetched once per Browse view (this component's own state - a mode
  // switch away and back remounts Browse, which fetches fresh). Unlike the
  // outcomes call below, this is public/unauthenticated - "like the
  // catalog" - so it's fetched regardless of session.
  const [summaryByChallengeId, setSummaryByChallengeId] = useState<
    Map<string, ChallengeSummaryEntry> | null
  >(null);
  useEffect(() => {
    let cancelled = false;
    void apiClient.getChallengesSummary()
      .then((entries) => {
        if (cancelled) return;
        setSummaryByChallengeId(new Map(entries.map((entry) => [entry.challengeId, entry])));
      })
      .catch(() => {
        if (!cancelled) setSummaryByChallengeId(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [apiClient]);

  // `null` covers both "anonymous" (no fetch attempted - identityToken is
  // null) and "still loading" for a real session; both render no chip at all
  // rather than a premature/possibly-wrong "NEW". Only a resolved Map for an
  // actual session lets individual cards fall back to the default "NEW".
  const [outcomesByChallengeId, setOutcomesByChallengeId] = useState<
    Map<string, ChallengeOutcomeEntry> | null
  >(null);
  useEffect(() => {
    let cancelled = false;
    if (!identityToken) {
      setOutcomesByChallengeId(null);
      return;
    }
    setOutcomesByChallengeId(null);
    void apiClient.getAccountChallengeOutcomes(identityToken)
      .then((entries) => {
        if (cancelled) return;
        setOutcomesByChallengeId(new Map(entries.map((entry) => [entry.challengeId, entry])));
      })
      .catch(() => {
        // Degrade to "NEW" everywhere rather than crashing Browse over a
        // failed chip fetch - an empty (not null) map so `hasSession` below
        // still renders chips, just all-default ones.
        if (!cancelled) setOutcomesByChallengeId(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [apiClient, identityToken]);

  const hasSession = identityToken !== null;
  const visibleChallenges = useMemo(
    () => filterChallengesByQuery(challenges, searchQuery),
    [challenges, searchQuery],
  );
  // PKG-01: the pin only shows for a real daily (today's or yesterday's,
  // still-playable) - the "default" kind means no daily exists anywhere in
  // the catalog, and pinning its arbitrary fallback challenge would repeat
  // the exact "random challenge disguised as the daily" bug this package
  // fixes in Boards. Independent of `searchQuery` - it's standing chrome,
  // not a catalog row, so it doesn't filter away as the user types.
  const pinnedDaily = heroSelection && heroSelection.kind !== "default"
    ? heroSelection.challenge
    : null;

  function handleSearchChange(value: string) {
    setSearchQuery(value);
    if (selectionLocked) return;
    const resolvedId = resolveChallengeIdFromSearchInput(value, challenges);
    if (resolvedId) {
      onOpenChallenge(resolvedId);
    }
  }

  async function submitChallenge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selectionLocked || !canCreate) {
      return;
    }

    setIsCreating(true);
    try {
      await onCreateChallenge({
        startTitle: startTitle.trim(),
        targetTitle: targetTitle.trim(),
        nominateForDaily,
      });
      setStartTitle("");
      setTargetTitle("");
      setNominateForDaily(false);
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <section className="challenge-browser">
      <h2>Challenges</h2>

      {/*
       * dvh/svh input rule (Increment 5, council amendment): this container
       * must not size itself off `dvh` ("dynamic" viewport height, which
       * tracks the *visual* viewport and shrinks the instant an on-screen
       * keyboard starts dismissing - the exact mechanism that swallowed taps
       * on the identity dialog's bottom sheet, src/styles.css's
       * `.modal-backdrop:has(.identity-dialog)` fix). Browse's search field
       * is ordinary top-anchored page content, not a bottom sheet, and stays
       * that way deliberately - the `browse-search-svh-safe` class is a
       * standing marker (and CSS anchor) for that constraint so a future
       * "make it a sticky/full-bleed panel" change reaches for `svh`, not
       * `dvh`, rather than rediscovering the bug from scratch.
       */}
      <div className="browse-search-svh-safe">
        <label className="name-control">
          <span>Search challenges</span>
          <input
            aria-label="Search challenges"
            disabled={selectionLocked}
            onChange={(event) => handleSearchChange(event.target.value)}
            placeholder="Title, or paste a challenge link"
            type="search"
            value={searchQuery}
          />
        </label>
      </div>

      {pinnedDaily ? (
        // PKG-01/spec ("The daily pinned at top but pointing to Home"):
        // wrapped in its own `.challenge-list`-classed list (reusing that
        // class's existing card styling, incl. state-chip/daily-badge
        // colors) so it needs no bespoke CSS beyond the accent that marks
        // it "visually distinct from the catalog" below.
        <ol className="challenge-list browse-pinned-list" aria-label="Today's daily">
          <li>
            <button
              className="browse-card browse-pinned-card"
              disabled={selectionLocked}
              onClick={onGoHome}
              type="button"
            >
              <span className="challenge-meta">
                <span className="daily-badge">
                  {"⭐"} {dailyBadgeLabel(pinnedDaily, todayCentral) ?? "Daily"}
                </span>
              </span>
              <span className="browse-card-title-row">
                <strong>
                  {pinnedDaily.start.title} {"→"} {pinnedDaily.target.title}
                </strong>
                {hasSession ? (
                  <StateChip outcome={outcomesByChallengeId?.get(pinnedDaily.id)} />
                ) : null}
              </span>
            </button>
          </li>
        </ol>
      ) : null}

      {visibleChallenges.length ? (
        <>
          <p className="browse-catalog-heading muted">All challenges</p>
          <ol className="challenge-list">
            {visibleChallenges.map((challenge) => {
              const meta = formatChallengeCardMeta(summaryByChallengeId?.get(challenge.id));
              return (
                <li key={challenge.id}>
                  <button
                    aria-pressed={selectedChallengeId === challenge.id}
                    className="browse-card"
                    disabled={selectionLocked}
                    onClick={() => onOpenChallenge(challenge.id)}
                    type="button"
                  >
                    <span className="challenge-meta">
                      <span>{challenge.label ?? challenge.id}</span>
                      {dailyBadgeLabel(challenge, todayCentral) ? (
                        <span className="daily-badge">
                          {dailyBadgeLabel(challenge, todayCentral)}
                        </span>
                      ) : null}
                    </span>
                    <span className="browse-card-title-row">
                      <strong>
                        {challenge.start.title} {"→"} {challenge.target.title}
                      </strong>
                      {hasSession ? (
                        <StateChip outcome={outcomesByChallengeId?.get(challenge.id)} />
                      ) : null}
                    </span>
                    {meta ? <span className="browse-card-meta muted">{meta}</span> : null}
                    {challenge.createdBy ? (
                      <em>Created by {challenge.createdBy.displayName}</em>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ol>
        </>
      ) : (
        <p className="muted">
          {challenges.length ? "No challenges match your search." : "No challenges loaded."}
        </p>
      )}

      <form className="create-challenge-form" onSubmit={submitChallenge}>
        <label className="name-control">
          <span>Start article</span>
          <input
            aria-label="Start article"
            disabled={selectionLocked}
            maxLength={512}
            onChange={(event) => setStartTitle(event.target.value)}
            placeholder="Wikipedia title or URL"
            value={startTitle}
          />
        </label>
        <label className="name-control">
          <span>Target article</span>
          <input
            aria-label="Target article"
            disabled={selectionLocked}
            maxLength={512}
            onChange={(event) => setTargetTitle(event.target.value)}
            placeholder="Wikipedia title or URL"
            value={targetTitle}
          />
        </label>
        {canNominateForDaily ? (
          <label className="daily-nomination-control">
            <input
              checked={nominateForDaily}
              disabled={selectionLocked}
              onChange={(event) => setNominateForDaily(event.target.checked)}
              type="checkbox"
            />
            <span>Nominate for a future Daily</span>
          </label>
        ) : null}
        <button type="submit" disabled={selectionLocked || !canCreate || isCreating}>
          Create challenge
        </button>
      </form>

      <div className="browse-random-challenge">
        <button
          disabled={selectionLocked || randomChallengeBusy}
          type="button"
          onClick={onCreateRandomChallenge}
        >
          {randomChallengeBusy ? RANDOM_CHALLENGE_LOADING_COPY : "Create a random new one"}
        </button>
        {randomChallengeError ? (
          <p className="error-banner" role="alert">{randomChallengeError}</p>
        ) : null}
      </div>
    </section>
  );
}
