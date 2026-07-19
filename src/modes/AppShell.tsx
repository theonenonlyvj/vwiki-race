import { useMemo } from "react";
import AdminDailies from "../components/AdminDailies";
import TeachingGate from "../components/TeachingGate";
import { selectDefaultChallenge, selectHomeHeroChallenge } from "../domain/challengeSelection";
import type { PlayAnotherSuggestionState } from "../domain/playAnother";
import { shouldShowTeachingGate } from "../domain/teachingGate";
import type { CreateChallengeInput } from "./challenges/Browse";
import type { AccountStats, Challenge, RankedLeaderboardRow, ServerPathStep } from "../domain/types";
import { isAdminDailiesRoute } from "../services/urlRouting";
import type { VGamesIdentitySession } from "../services/vgamesIdentity";
import type { VWikiRaceApiClient } from "../services/vwikiRaceApiClient";
import type { WikipediaGateway } from "../services/wikipediaGateway";
import Boards, { type BoardsSegment } from "./Boards";
import ChallengeBrowser from "./challenges/Browse";
import ChallengeDetail from "./challenges/ChallengeDetail";
import Home from "./Home";
import You from "./You";

export type ModeKey = "home" | "boards" | "challenges" | "you";
export type ChallengesView = "browse" | "detail";

const MODE_ITEMS: { key: ModeKey; label: string }[] = [
  { key: "home", label: "Home" },
  { key: "boards", label: "Boards" },
  { key: "challenges", label: "Challenges" },
  { key: "you", label: "You" },
];

/**
 * The mode shell (Increment 2): replaces App.tsx's old top tabbar with the
 * real Home/Boards/Challenges/You nav - ONE `.mode-nav` element that CSS
 * pins to the viewport bottom below 880px and docks inline top-right (next
 * to the logo) at desktop widths (desktop pass, FIX 2) - and owns the
 * `/admin/dailies` bypass (migration note ii - the pathname-gated route
 * never becomes a fifth nav item; visiting it while authorized replaces
 * this entire shell, nav included, the same way the race takeover does).
 * App.tsx keeps `<RaceFlow>` rendered above/outside this component
 * entirely - see the `raceEngaged` branch there - so this file never needs
 * to know about the race flow at all.
 *
 * Also owns the first-visit teaching gate (spec: "app-shell level, not
 * Home-specific... must fire on Challenge Detail too") and the single
 * "today's playable challenge" derivation shared by Home's hero and the
 * gate's popup example, so the two can never show a different pair.
 */
export default function AppShell({
  accountStats,
  apiClient,
  authBusy,
  bannerError,
  bannerNotice,
  boardsInitialSegment,
  canManageDailies,
  canNominateForDaily,
  challenges,
  challengesView,
  identitySession,
  leaderboard,
  mode,
  onClaimIdentity,
  onCloseChallengeDetail,
  onCreateChallenge,
  onCreateRandomChallenge,
  onDisclosePath,
  onExitAdmin,
  onGoToBoardsFor,
  onOpenChallengeDetail,
  onRaceChallenge,
  onSelectMode,
  playAnotherSuggestion,
  previewWikipediaGateway,
  randomChallengeBusy,
  randomChallengeError,
  runPaths,
  selectedChallenge,
  selectionLocked,
  sessionDnfChallengeIds,
  todayCentral,
}: {
  accountStats: AccountStats | null;
  apiClient: VWikiRaceApiClient;
  authBusy: boolean;
  bannerError: string | null;
  bannerNotice: string | null;
  boardsInitialSegment: BoardsSegment;
  canManageDailies: boolean | null;
  canNominateForDaily: boolean;
  challenges: Challenge[];
  challengesView: ChallengesView;
  identitySession: VGamesIdentitySession | null;
  leaderboard: RankedLeaderboardRow[];
  mode: ModeKey;
  onClaimIdentity: () => void;
  onCloseChallengeDetail: () => void;
  onCreateChallenge: (input: CreateChallengeInput) => Promise<void>;
  onCreateRandomChallenge: () => void;
  onDisclosePath: (runId: string) => void;
  onExitAdmin: () => void;
  onGoToBoardsFor: () => void;
  onOpenChallengeDetail: (challengeId: string) => void;
  onRaceChallenge: (challengeId: string) => void;
  onSelectMode: (mode: ModeKey) => void;
  // Increment 5: centrally fetched/owned in App.tsx - see Home.tsx's doc
  // comment on the identically-named prop.
  playAnotherSuggestion: PlayAnotherSuggestionState;
  previewWikipediaGateway: WikipediaGateway;
  randomChallengeBusy: boolean;
  randomChallengeError: string | null;
  runPaths: Record<string, ServerPathStep[]>;
  selectedChallenge: Challenge | null;
  selectionLocked: boolean;
  sessionDnfChallengeIds: ReadonlySet<string>;
  todayCentral: string;
}) {
  // Boards' Today segment keeps the pre-redesign selectDefaultChallenge
  // derivation (desktop-pass FIX 4 deliberately leaves non-Home consumers
  // untouched).
  const todaysHeroChallenge = useMemo(
    () => selectDefaultChallenge(challenges, { todayUtc: todayCentral }),
    [challenges, todayCentral],
  );
  // The one challenge Home's hero races and the teaching-gate popup uses as
  // its worked example, so the two can never show a different pair. FIX 4:
  // today's real daily post-drop; yesterday's still-playable daily pre-drop
  // (Home badges it as such); the default fallback only when the catalog
  // has no daily at all.
  const homeHero = useMemo(
    () => selectHomeHeroChallenge(challenges, todayCentral),
    [challenges, todayCentral],
  );

  const adminRoute = isAdminDailiesRoute();

  if (adminRoute && canManageDailies === true && identitySession) {
    return (
      <div className="admin-bypass">
        <button type="button" className="back-link" onClick={onExitAdmin}>
          ← Back to VWiki Race
        </button>
        <AdminDailies
          apiClient={apiClient}
          challenges={challenges}
          previewGateway={previewWikipediaGateway}
          token={identitySession.token}
        />
      </div>
    );
  }

  // An unauthorized/still-resolving admin visit degrades into the ordinary
  // shell (Home + a notice) rather than a special dead end - matches the
  // pre-redesign fallback, just with no "Admin" nav item to have to hide.
  const visibleMode: ModeKey = adminRoute && canManageDailies !== true ? "home" : mode;
  const showAdminAccessNotice = adminRoute && canManageDailies === false;
  // First-visit teaching gate (spec: "until an account's first finished
  // race, whichever screen it first lands on - Home or Challenge Detail -
  // shows the rules strip"). Fires on both, for as long as the account has
  // zero completed races - migration note (iii): derived from
  // accountStats.totals.completed, never device-local storage. M1 fix:
  // shouldShowTeachingGate also needs to know whether there's an identified
  // session at all, so a still-pending or errored stats fetch (both read as
  // accountStats: null) hides the gate for a returning account instead of
  // flashing it (or getting stuck showing it) - see teachingGate.ts.
  const showTeachingGate = shouldShowTeachingGate({
    hasIdentifiedSession: identitySession !== null,
    stats: accountStats,
  }) &&
    (visibleMode === "home" || (visibleMode === "challenges" && challengesView === "detail"));

  return (
    <>
      <header className="shell-topbar">
        {/* PKG-04: dropped the mini "VWiki" kicker that used to stack above
            this h1 - every mockup shows a single wordmark, and repeating
            the brand name here (unlike the identity dialog's "VWiki" kicker
            over a *different* heading, "Save your stats") just duplicated
            it. */}
        <div className="brand-lockup" aria-label="VWiki Race">
          <h1>VWiki Race</h1>
        </div>

        {/* Desktop pass (FIX 2): ONE nav element for both breakpoints.
            Below 880px CSS pins it fixed to the viewport bottom (the
            classic mobile pattern - position:fixed ignores this header
            parent); at >=880px it lays out inline here, docked top-right
            beside the logo. No floating mid-air strip on either. */}
        <nav className="mode-nav" aria-label="VWiki Race views">
          {MODE_ITEMS.map(({ key, label }) => (
            <button
              aria-pressed={visibleMode === key}
              className={visibleMode === key ? "active" : undefined}
              key={key}
              onClick={() => onSelectMode(key)}
              type="button"
            >
              {label}
            </button>
          ))}
        </nav>
      </header>

      {bannerError ? <p className="error-banner" role="alert">{bannerError}</p> : null}
      {bannerNotice ? <p className="run-notice" role="status">{bannerNotice}</p> : null}
      {showAdminAccessNotice ? (
        <p aria-label="Authorization notice" className="run-notice" role="status">
          This page is not available.
        </p>
      ) : null}
      {showTeachingGate ? <TeachingGate pairChallenge={homeHero?.challenge ?? null} /> : null}

      <section className="content-shell">
        {visibleMode === "home" ? (
          <Home
            accountStats={accountStats}
            apiClient={apiClient}
            challenges={challenges}
            hero={homeHero}
            identityAccountId={identitySession?.accountId ?? null}
            onCreateRandomChallenge={onCreateRandomChallenge}
            onGoToBoards={onGoToBoardsFor}
            onOpenChallenge={onOpenChallengeDetail}
            onRaceChallenge={onRaceChallenge}
            onShowChallenges={() => onSelectMode("challenges")}
            playAnotherSuggestion={playAnotherSuggestion}
            raceBusy={authBusy}
            randomChallengeBusy={randomChallengeBusy}
            randomChallengeError={randomChallengeError}
            sessionDnfChallengeIds={sessionDnfChallengeIds}
            todayCentral={todayCentral}
          />
        ) : null}

        {visibleMode === "boards" ? (
          <Boards
            apiClient={apiClient}
            challenges={challenges}
            identityAccountId={identitySession?.accountId ?? null}
            initialSegment={boardsInitialSegment}
            onRaceChallenge={onRaceChallenge}
            raceBusy={authBusy}
            todaysHeroChallenge={todaysHeroChallenge}
            todayCentral={todayCentral}
          />
        ) : null}

        {visibleMode === "challenges" ? (
          challengesView === "detail" && selectedChallenge ? (
            <ChallengeDetail
              challenge={selectedChallenge}
              identityAccountId={identitySession?.accountId ?? null}
              leaderboard={leaderboard}
              onBack={onCloseChallengeDetail}
              onDisclosePath={onDisclosePath}
              onRaceThis={() => onRaceChallenge(selectedChallenge.id)}
              raceDisabled={!selectedChallenge || authBusy}
              runPaths={runPaths}
              todayCentral={todayCentral}
            />
          ) : (
            <ChallengeBrowser
              apiClient={apiClient}
              canNominateForDaily={canNominateForDaily}
              challenges={challenges}
              identityToken={identitySession?.token ?? null}
              onCreateChallenge={onCreateChallenge}
              onCreateRandomChallenge={onCreateRandomChallenge}
              onOpenChallenge={onOpenChallengeDetail}
              randomChallengeBusy={randomChallengeBusy}
              randomChallengeError={randomChallengeError}
              selectedChallengeId={selectedChallenge?.id ?? null}
              selectionLocked={selectionLocked}
              todayCentral={todayCentral}
            />
          )
        ) : null}

        {visibleMode === "you" ? (
          <You
            identitySession={identitySession}
            onClaimIdentity={onClaimIdentity}
            stats={accountStats}
          />
        ) : null}
      </section>

      <footer className="site-footer">
        <p>
          Have{" "}
          <a
            href="https://theonenonlyvj.github.io/personal-site/contact"
            rel="noopener noreferrer"
            target="_blank"
          >
            Feedback
          </a>
          ? Want to see my other projects?{" "}
          <a
            href="https://theonenonlyvj.github.io/personal-site"
            rel="noopener noreferrer"
            target="_blank"
          >
            Click here
          </a>.
        </p>
      </footer>

    </>
  );
}
