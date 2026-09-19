import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import StateChip from "../../components/StateChip";
import { formatChallengeCardMeta } from "../../domain/challengeCard";
import {
  dailyBadgeLabel,
  dailyDateForChallenge,
  type HomeHeroSelection,
} from "../../domain/challengeSelection";
import { filterChallengesByQuery, resolveChallengeIdFromSearchInput } from "../../domain/challengeSearch";
import { dailyFlavorBadgeText } from "../../domain/dailyEditorial";
import { formatTimeAndClicks } from "../../domain/formatting";
import { RANDOM_CHALLENGE_LOADING_COPY } from "../../domain/playAnother";
import type { Challenge, ChallengeOutcomeEntry, ChallengeSummaryEntry } from "../../domain/types";
import type { VWikiRaceApiClient } from "../../services/vwikiRaceApiClient";
import "./Browse.css";

export interface CreateChallengeInput {
  startTitle: string;
  targetTitle: string;
  nominateForDaily: boolean;
}

type BrowseView = "all" | "past-dailies";

type OutcomesLoadState =
  | { token: string; status: "loading" }
  | { entries: Map<string, ChallengeOutcomeEntry>; token: string; status: "ready" }
  | { token: string; status: "unavailable" };

function formatArchiveDate(date: string): string {
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
    year: "numeric",
  }).format(new Date(`${date}T00:00:00Z`));
}

function summaryVisibleToViewer(
  summary: ChallengeSummaryEntry | undefined,
  outcome: ChallengeOutcomeEntry | undefined,
): ChallengeSummaryEntry | undefined {
  if (!summary || outcome?.outcome === "completed" || outcome?.peeked) return summary;
  return { ...summary, best: null };
}

function ArchiveState({ outcome }: { outcome: ChallengeOutcomeEntry | undefined }) {
  if (outcome?.outcome === "completed") {
    return (
      <span className="browse-archive-state browse-archive-state-completed">
        {outcome.best
          ? `Completed · ${formatTimeAndClicks(outcome.best.elapsedMs, outcome.best.clickCount)}`
          : "Completed"}
      </span>
    );
  }
  if (outcome?.outcome === "dnf") {
    return <span className="browse-archive-state">Unfinished</span>;
  }
  return <span className="browse-archive-state">Not played</span>;
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
  const [createPanelOpen, setCreatePanelOpen] = useState(false);
  const [browseView, setBrowseView] = useState<BrowseView>("all");
  const [pastDailyDate, setPastDailyDate] = useState("all");
  // QF-07: `isCreating` alone (an async state setter) has a real window
  // before re-render where a second tap/Enter fires a second create
  // request - same synchronous-ref guard App.tsx's `login`/
  // `continueAsGuest`/`createVGamesAccount` use. Not the same lock as
  // App.tsx's `challengeLockRef` (that one gates "is a run currently
  // active," not a same-tick double-click).
  const submitChallengeLock = useRef(false);
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

  // The token travels with its outcome state. On an account switch React
  // renders with the new prop before this effect resets/fetches; without the
  // token key that render can expose the previous account's chip and unlock
  // aggregate best metrics. A matching `ready` state is the only state that
  // may render account outcomes. Loading, anonymous, and unavailable states
  // all keep chips and gated metrics hidden.
  const [outcomesLoad, setOutcomesLoad] = useState<OutcomesLoadState | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!identityToken) {
      setOutcomesLoad(null);
      return;
    }
    const token = identityToken;
    setOutcomesLoad({ status: "loading", token });
    void apiClient.getAccountChallengeOutcomes(identityToken)
      .then((entries) => {
        if (cancelled) return;
        setOutcomesLoad({
          entries: new Map(entries.map((entry) => [entry.challengeId, entry])),
          status: "ready",
          token,
        });
      })
      .catch(() => {
        if (!cancelled) setOutcomesLoad({ status: "unavailable", token });
      });
    return () => {
      cancelled = true;
    };
  }, [apiClient, identityToken]);

  const currentOutcomes = outcomesLoad?.token === identityToken ? outcomesLoad : null;
  const outcomesByChallengeId = currentOutcomes?.status === "ready"
    ? currentOutcomes.entries
    : null;
  const hasSession = outcomesByChallengeId !== null;
  const historyUnavailable = currentOutcomes?.status === "unavailable";
  // PKG-01: the pin only shows for a real daily (today's or yesterday's,
  // still-playable) - the "default" kind means no daily exists anywhere in
  // the catalog, and pinning its arbitrary fallback challenge would repeat
  // the exact "random challenge disguised as the daily" bug this package
  // fixes in Boards. Independent of `searchQuery` - it's standing chrome,
  // not a catalog row, so it doesn't filter away as the user types.
  const pinnedDaily = heroSelection && heroSelection.kind !== "default"
    ? heroSelection.challenge
    : null;
  const pastDailies = useMemo(
    () => challenges
      .filter((challenge) => {
        const dailyDate = dailyDateForChallenge(challenge);
        return Boolean(dailyDate && dailyDate < todayCentral);
      })
      .sort((left, right) => {
        const dateOrder = (dailyDateForChallenge(right) ?? "").localeCompare(
          dailyDateForChallenge(left) ?? "",
        );
        return dateOrder || left.id.localeCompare(right.id);
      }),
    [challenges, todayCentral],
  );
  const pastDailyDates = useMemo(
    () => [...new Set(pastDailies.map((challenge) => dailyDateForChallenge(challenge) as string))],
    [pastDailies],
  );
  // QF-03: exclude the pinned daily from the catalog below it - it's
  // already pinned as standing chrome above, so leaving it in
  // `visibleChallenges` too duplicated it onto the screen twice.
  const visibleChallenges = useMemo(
    () => {
      const candidates = browseView === "past-dailies"
        ? pastDailies.filter((challenge) =>
            pastDailyDate === "all" || dailyDateForChallenge(challenge) === pastDailyDate)
        : challenges;
      return filterChallengesByQuery(candidates, searchQuery).filter(
        (challenge) => challenge.id !== pinnedDaily?.id,
      );
    },
    [browseView, challenges, pastDailies, pastDailyDate, searchQuery, pinnedDaily],
  );

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
    if (selectionLocked || !canCreate || submitChallengeLock.current) {
      return;
    }

    submitChallengeLock.current = true;
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
      submitChallengeLock.current = false;
      setIsCreating(false);
    }
  }

  return (
    <section className="challenge-browser">
      <header className="browse-toolbar">
        <h2>Challenges</h2>
        <button
          aria-controls="browse-create-panel"
          aria-expanded={createPanelOpen}
          className="browse-secondary-action"
          disabled={selectionLocked}
          onClick={() => setCreatePanelOpen((open) => !open)}
          type="button"
        >
          {createPanelOpen ? "Close creator" : "Create a challenge"}
        </button>
      </header>

      {createPanelOpen ? (
        <div className="browse-create-panel" id="browse-create-panel">
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
            <span className="muted">Or let Wikipedia choose both articles.</span>
            <button
              disabled={selectionLocked || randomChallengeBusy}
              type="button"
              onClick={onCreateRandomChallenge}
            >
              {randomChallengeBusy ? RANDOM_CHALLENGE_LOADING_COPY : "Create a random new one"}
            </button>
          </div>
        </div>
      ) : null}
      {randomChallengeError ? (
        <p className="error-banner" role="alert">{randomChallengeError}</p>
      ) : null}

      <nav className="browse-filter-control" aria-label="Challenge filters">
        <button
          aria-pressed={browseView === "all"}
          onClick={() => setBrowseView("all")}
          type="button"
        >
          All challenges
        </button>
        <button
          aria-pressed={browseView === "past-dailies"}
          onClick={() => setBrowseView("past-dailies")}
          type="button"
        >
          Past dailies
        </button>
      </nav>

      {historyUnavailable ? (
        <p className="browse-history-status muted" role="status">
          Your challenge history is unavailable right now. Challenge details are still available.
        </p>
      ) : null}

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
                  {"⭐"}{" "}
                  {pinnedDaily.dailyFeature
                    ? dailyFlavorBadgeText(
                        pinnedDaily.dailyFeature,
                        heroSelection?.kind === "yesterday-daily" ? "yesterday" : "today",
                      )
                    : dailyBadgeLabel(pinnedDaily, todayCentral) ?? "Daily"}
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

      {browseView === "past-dailies" ? (
        <section className="browse-archive" aria-label="Past daily archive">
          <div className="browse-archive-controls">
            <div>
              <h3>Past dailies</h3>
              <p className="muted">Pick a date, then open the ordinary challenge page to race or revisit it.</p>
            </div>
            <label className="name-control browse-date-control">
              <span>Past daily date</span>
              <select
                aria-label="Past daily date"
                onChange={(event) => setPastDailyDate(event.target.value)}
                value={pastDailyDate}
              >
                <option value="all">All dates</option>
                {pastDailyDates.map((date) => (
                  <option key={date} value={date}>{formatArchiveDate(date)}</option>
                ))}
              </select>
            </label>
          </div>
          {visibleChallenges.length ? (
            <ol className="challenge-list browse-archive-list">
              {visibleChallenges.map((challenge) => {
                const outcome = outcomesByChallengeId?.get(challenge.id);
                const summary = summaryVisibleToViewer(
                  summaryByChallengeId?.get(challenge.id),
                  outcome,
                );
                const meta = formatChallengeCardMeta(summary);
                const dailyDate = dailyDateForChallenge(challenge) as string;
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
                        <time dateTime={dailyDate}>{formatArchiveDate(dailyDate)}</time>
                      </span>
                      <span className="browse-card-title-row">
                        <strong>{challenge.start.title} {"→"} {challenge.target.title}</strong>
                        {hasSession ? <ArchiveState outcome={outcome} /> : null}
                      </span>
                      {meta ? <span className="browse-card-meta muted">{meta}</span> : null}
                    </button>
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="muted">
              {pastDailies.length ? "No past dailies match your search." : "No past dailies available yet."}
            </p>
          )}
        </section>
      ) : visibleChallenges.length ? (
        <>
          <p className="browse-catalog-heading muted">All challenges</p>
          <ol className="challenge-list">
            {visibleChallenges.map((challenge) => {
              const outcome = outcomesByChallengeId?.get(challenge.id);
              const meta = formatChallengeCardMeta(summaryVisibleToViewer(
                summaryByChallengeId?.get(challenge.id),
                outcome,
              ));
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
                        <StateChip outcome={outcome} />
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

    </section>
  );
}
