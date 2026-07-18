import AdminDailies from "../components/AdminDailies";
import type { CreateChallengeInput } from "./challenges/Browse";
import type { AccountStats, Challenge, RankedLeaderboardRow, ServerPathStep } from "../domain/types";
import type { TargetPreviewState } from "../hooks/useTargetPreview";
import { isAdminDailiesRoute } from "../services/urlRouting";
import type { VGamesIdentitySession } from "../services/vgamesIdentity";
import type { VWikiRaceApiClient } from "../services/vwikiRaceApiClient";
import type { WikipediaGateway } from "../services/wikipediaGateway";
import Boards from "./Boards";
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
 * The bottom-nav mode shell (Increment 2): replaces App.tsx's old top
 * tabbar with the real Home/Boards/Challenges/You nav, and owns the
 * `/admin/dailies` bypass (migration note ii - the pathname-gated route
 * never becomes a fifth nav item; visiting it while authorized replaces
 * this entire shell, nav included, the same way the race takeover does).
 * App.tsx keeps `<RaceFlow>` rendered above/outside this component
 * entirely - see the `raceEngaged` branch there - so this file never needs
 * to know about the race flow at all.
 */
export default function AppShell({
  accountStats,
  apiClient,
  authBusy,
  bannerError,
  bannerNotice,
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
  onDisclosePath,
  onExitAdmin,
  onSelectChallenge,
  onSelectChallengeForBoards,
  onSelectMode,
  onStartChallenge,
  previewWikipediaGateway,
  runPaths,
  selectedChallenge,
  selectionLocked,
  targetPreview,
  todayCentral,
}: {
  accountStats: AccountStats | null;
  apiClient: VWikiRaceApiClient;
  authBusy: boolean;
  bannerError: string | null;
  bannerNotice: string | null;
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
  onDisclosePath: (runId: string) => void;
  onExitAdmin: () => void;
  onSelectChallenge: (challengeId: string) => void;
  onSelectChallengeForBoards: (challengeId: string) => void;
  onSelectMode: (mode: ModeKey) => void;
  onStartChallenge: () => void;
  previewWikipediaGateway: WikipediaGateway;
  runPaths: Record<string, ServerPathStep[]>;
  selectedChallenge: Challenge | null;
  selectionLocked: boolean;
  targetPreview: TargetPreviewState;
  todayCentral: string;
}) {
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

  return (
    <>
      <header className="shell-topbar">
        <div className="brand-lockup" aria-label="VWiki Race">
          <span className="viota-mark">VWiki</span>
          <h1>VWiki Race</h1>
        </div>
      </header>

      {bannerError ? <p className="error-banner" role="alert">{bannerError}</p> : null}
      {bannerNotice ? <p className="run-notice" role="status">{bannerNotice}</p> : null}
      {showAdminAccessNotice ? (
        <p aria-label="Authorization notice" className="run-notice" role="status">
          This page is not available.
        </p>
      ) : null}

      <section className="content-shell">
        {visibleMode === "home" ? (
          <Home
            canNominateForDaily={canNominateForDaily}
            challenges={challenges}
            onCreateChallenge={onCreateChallenge}
            onSelectChallenge={onSelectChallenge}
            onStartChallenge={onStartChallenge}
            selectedChallenge={selectedChallenge}
            selectionLocked={selectionLocked}
            startDisabled={!selectedChallenge || authBusy}
            targetPreview={targetPreview}
            todayCentral={todayCentral}
          />
        ) : null}

        {visibleMode === "boards" ? (
          <Boards
            challenges={challenges}
            leaderboard={leaderboard}
            onDisclosePath={onDisclosePath}
            onSelectChallenge={onSelectChallengeForBoards}
            runPaths={runPaths}
            selectedChallengeId={selectedChallenge?.id ?? null}
            selectionLocked={selectionLocked}
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
              onRaceThis={onStartChallenge}
              raceDisabled={!selectedChallenge || authBusy}
              runPaths={runPaths}
            />
          ) : (
            <ChallengeBrowser
              canNominateForDaily={canNominateForDaily}
              challenges={challenges}
              onCreateChallenge={onCreateChallenge}
              onSelectChallenge={onSelectChallenge}
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

      <nav className="bottom-nav" aria-label="VWiki Race views">
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
    </>
  );
}
