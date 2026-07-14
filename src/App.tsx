import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type MouseEvent,
} from "react";
import { getSortedChallenges } from "./domain/challenges";
import {
  createGameSession,
  followResolvedLink,
  type GameSession,
} from "./domain/gameSession";
import { compressPathForStrip } from "./domain/pathCompression";
import type {
  Article,
  Challenge,
  RankedLeaderboardRow,
  ServerPathStep,
} from "./domain/types";
import {
  createVGamesIdentityClient,
  createVGamesIdentityRepository,
  type VGamesIdentityClient,
  type VGamesIdentityRepository,
  type VGamesIdentitySession,
} from "./services/vgamesIdentity";
import {
  createVWikiRaceApiClient,
  type VWikiRaceApiClient,
} from "./services/vwikiRaceApiClient";
import { createWikipediaGateway } from "./services/wikipediaGateway";
import type { RunRecordResponse } from "./server/trackingRepository";

interface AppProps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  storage?: Storage;
  apiClient?: VWikiRaceApiClient;
  identityClient?: VGamesIdentityClient;
  identityRepository?: VGamesIdentityRepository;
}

type ModeState = "idle" | "loading" | "playing" | "complete";
type TabKey = "play" | "leaderboard" | "challenges" | "stats";
type AuthMode = "guest" | "claim" | "login";
type AuthPromptIntent =
  | { type: "start"; challengeId: string }
  | {
      type: "create";
      input: {
        startTitle: string;
        targetTitle: string;
      };
    };

const defaultFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

export default function App({
  fetchImpl = defaultFetch,
  now = () => Date.now(),
  storage = globalThis.localStorage,
  apiClient: injectedApiClient,
  identityClient: injectedIdentityClient,
  identityRepository: injectedIdentityRepository,
}: AppProps) {
  const [modeState, setModeState] = useState<ModeState>("idle");
  const [activeTab, setActiveTab] = useState<TabKey>("play");
  const [authPrompt, setAuthPrompt] = useState<AuthPromptIntent | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode>("guest");
  const [authBusy, setAuthBusy] = useState(false);
  const [identitySession, setIdentitySession] =
    useState<VGamesIdentitySession | null>(null);
  const [displayNameDraft, setDisplayNameDraft] = useState("");
  const [usernameDraft, setUsernameDraft] = useState("");
  const [passwordDraft, setPasswordDraft] = useState("");
  const [challenges, setChallenges] = useState<Challenge[]>([]);
  const [selectedChallengeId, setSelectedChallengeId] = useState<string | null>(
    null,
  );
  const [serverRun, setServerRun] = useState<RunRecordResponse | null>(null);
  const [session, setSession] = useState<GameSession | null>(null);
  const [article, setArticle] = useState<Article | null>(null);
  const [pendingNavigationTitle, setPendingNavigationTitle] = useState<
    string | null
  >(null);
  const [leaderboard, setLeaderboard] = useState<RankedLeaderboardRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const apiClient = useMemo(
    () => injectedApiClient ?? createVWikiRaceApiClient(fetchImpl),
    [fetchImpl, injectedApiClient],
  );
  const identityClient = useMemo(
    () => injectedIdentityClient ?? createVGamesIdentityClient(fetchImpl),
    [fetchImpl, injectedIdentityClient],
  );
  const identityRepository = useMemo(
    () => injectedIdentityRepository ?? createVGamesIdentityRepository(storage),
    [injectedIdentityRepository, storage],
  );
  const wikipediaGateway = useMemo(
    () => createWikipediaGateway({ fetchImpl }),
    [fetchImpl],
  );

  const selectedChallenge =
    challenges.find((challenge) => challenge.id === selectedChallengeId) ??
    challenges[0] ??
    null;
  const displayNameIsReady =
    (identitySession?.displayName ?? displayNameDraft).trim().length > 0;
  const isBusy = modeState === "loading" || authBusy;
  const headerState =
    modeState === "complete"
      ? "result"
      : session && modeState !== "idle"
        ? "compact"
        : "expanded";

  useEffect(() => {
    const cachedSession = identityRepository.getSession();
    if (cachedSession) {
      setIdentitySession(cachedSession);
      setDisplayNameDraft(cachedSession.displayName);
      setUsernameDraft(cachedSession.displayName);
    }
  }, [identityRepository]);

  useEffect(() => {
    let cancelled = false;

    async function loadChallengeCatalog() {
      setError(null);
      try {
        const nextChallenges = await apiClient.listChallenges();
        if (cancelled) {
          return;
        }
        setChallenges(nextChallenges);
        const requestedChallengeId = readChallengeIdFromUrl();
        const firstChallenge = nextChallenges[0] ?? null;
        const requestedChallenge =
          nextChallenges.find(
            (challenge) => challenge.id === requestedChallengeId,
          ) ?? null;
        const nextChallenge = requestedChallenge ?? firstChallenge;
        setSelectedChallengeId(nextChallenge?.id ?? null);
        if (requestedChallenge) {
          syncChallengeUrl(requestedChallenge.id, "replace");
        }
        if (nextChallenge) {
          setLeaderboard(await apiClient.listLeaderboard(nextChallenge.id));
        }
      } catch (caught) {
        if (!cancelled) {
          setError(errorMessage(caught, "Could not load challenges."));
        }
      }
    }

    void loadChallengeCatalog();

    return () => {
      cancelled = true;
    };
  }, [apiClient]);

  async function refreshLeaderboard(challengeId: string) {
    setLeaderboard(await apiClient.listLeaderboard(challengeId));
  }

  async function selectChallenge(challengeId: string) {
    setSelectedChallengeId(challengeId);
    syncChallengeUrl(challengeId);
    setActiveTab("play");
    setError(null);
    try {
      await refreshLeaderboard(challengeId);
    } catch (caught) {
      setError(errorMessage(caught, "Could not load the leaderboard."));
    }
  }

  async function createChallenge(input: {
    startTitle: string;
    targetTitle: string;
  }) {
    if (!identitySession) {
      openAuthPrompt({ type: "create", input });
      return;
    }

    await createChallengeWithSession(input, identitySession);
  }

  async function createChallengeWithSession(
    input: {
      startTitle: string;
      targetTitle: string;
    },
    sessionForRequest: VGamesIdentitySession,
  ) {
    setError(null);
    try {
      const challenge = await apiClient.createChallenge(
        {
          ...input,
          creatorDisplayName: sessionForRequest.displayName,
        },
        sessionForRequest.token,
      );
      setChallenges((current) =>
        getSortedChallenges([
          ...current.filter((item) => item.id !== challenge.id),
          challenge,
        ]),
      );
      if (!session || session.status !== "active") {
        setSelectedChallengeId(challenge.id);
        syncChallengeUrl(challenge.id);
        setServerRun(null);
        setSession(null);
        setArticle(null);
        setLeaderboard([]);
        setActiveTab("play");
      }
    } catch (caught) {
      setError(errorMessage(caught, "Could not create that challenge."));
      throw caught;
    }
  }

  async function startSelectedChallenge() {
    if (!selectedChallenge) {
      return;
    }

    if (!identitySession || identitySession.status === "ghost") {
      openAuthPrompt({ type: "start", challengeId: selectedChallenge.id });
      return;
    }

    await startChallengeWithSession(selectedChallenge.id, identitySession);
  }

  async function startChallengeWithSession(
    challengeId: string,
    sessionForRun: VGamesIdentitySession,
  ) {
    const challenge =
      challenges.find((item) => item.id === challengeId) ?? selectedChallenge;
    if (!challenge) {
      setError("Choose a challenge before starting.");
      return;
    }

    setError(null);
    setModeState("loading");
    setPendingNavigationTitle(null);
    setLeaderboard([]);
    setSelectedChallengeId(challenge.id);
    syncChallengeUrl(challenge.id);

    try {
      const nextRun = await apiClient.startRun(
        {
          challengeId: challenge.id,
          publicName: sessionForRun.displayName,
        },
        sessionForRun.token,
      );
      const nextArticle = await wikipediaGateway.getArticle(
        challenge.start.title,
      );
      const startedAtMs = Date.parse(nextRun.startedAt);
      setServerRun(nextRun);
      setSession(
        createGameSession(
          challenge,
          Number.isNaN(startedAtMs) ? now() : startedAtMs,
        ),
      );
      setArticle(nextArticle);
      await refreshLeaderboard(challenge.id);
      setActiveTab("play");
      setModeState("playing");
    } catch (caught) {
      setModeState("idle");
      setError(errorMessage(caught, "Could not start that challenge."));
    }
  }

  function openAuthPrompt(intent: AuthPromptIntent) {
    setError(null);
    setAuthPrompt(intent);
    if (identitySession?.status === "ghost") {
      setAuthMode("claim");
      setUsernameDraft(identitySession.displayName);
    } else if (!identitySession) {
      setAuthMode("guest");
    }
  }

  async function continueAsGuest() {
    if (!authPrompt) {
      return;
    }

    const prompt = authPrompt;
    let nextIdentitySession = identitySession;
    if (!nextIdentitySession) {
      const displayName = displayNameDraft.trim();
      if (!displayName) {
        setError("Choose a display name before continuing as guest.");
        return;
      }

      setAuthBusy(true);
      try {
        nextIdentitySession = await identityClient.playAsGuest({
          deviceCredential: identityRepository.getDeviceCredential(),
          displayName,
        });
        persistIdentitySession(nextIdentitySession);
      } catch (caught) {
        setError(errorMessage(caught, "Could not start a guest session."));
        setAuthBusy(false);
        return;
      }
    }

    setAuthPrompt(null);
    try {
      await resumeAfterIdentity(prompt, nextIdentitySession);
    } finally {
      setAuthBusy(false);
    }
  }

  async function claimGuestName() {
    if (!authPrompt) {
      return;
    }

    const prompt = authPrompt;
    const username = usernameDraft.trim();
    const password = passwordDraft;
    if (!username || !password) {
      setError("Enter a username and password to save this name.");
      return;
    }

    const displayName = (identitySession?.displayName ?? displayNameDraft).trim();
    if (!identitySession && !displayName) {
      setError("Choose a display name before creating an account.");
      return;
    }

    setAuthBusy(true);
    try {
      let guestSession = identitySession;
      if (!guestSession) {
        guestSession = await identityClient.playAsGuest({
          deviceCredential: identityRepository.getDeviceCredential(),
          displayName,
        });
      }

      const claimedSession = await identityClient.secureGuest({
        deviceCredential: identityRepository.getDeviceCredential(),
        token: guestSession.token,
        username,
        password,
      });
      persistIdentitySession(claimedSession);
      setAuthPrompt(null);
      await resumeAfterIdentity(prompt, claimedSession);
    } catch (caught) {
      setError(errorMessage(caught, "Could not save that display name."));
    } finally {
      setAuthBusy(false);
    }
  }

  async function login() {
    if (!authPrompt) {
      return;
    }

    const prompt = authPrompt;
    const username = usernameDraft.trim();
    const password = passwordDraft;
    if (!username || !password) {
      setError("Enter your username and password.");
      return;
    }

    setAuthBusy(true);
    try {
      const loggedInSession = await identityClient.login({
        deviceCredential: identityRepository.getDeviceCredential(),
        username,
        password,
      });
      persistIdentitySession(loggedInSession);
      setAuthPrompt(null);
      await resumeAfterIdentity(prompt, loggedInSession);
    } catch (caught) {
      setError(errorMessage(caught, "Could not log in."));
    } finally {
      setAuthBusy(false);
    }
  }

  function persistIdentitySession(nextSession: VGamesIdentitySession) {
    identityRepository.saveSession(nextSession);
    setIdentitySession(nextSession);
    setDisplayNameDraft(nextSession.displayName);
    setUsernameDraft(nextSession.displayName);
  }

  async function resumeAfterIdentity(
    prompt: AuthPromptIntent,
    nextIdentitySession: VGamesIdentitySession,
  ) {
    if (prompt.type === "start") {
      await startChallengeWithSession(prompt.challengeId, nextIdentitySession);
      return;
    }

    await createChallengeWithSession(prompt.input, nextIdentitySession);
  }

  async function followArticleLink(title: string, anchorText: string) {
    if (
      !session ||
      !serverRun ||
      !identitySession ||
      session.status !== "active" ||
      pendingNavigationTitle
    ) {
      return;
    }

    setError(null);
    setPendingNavigationTitle(anchorText || title);
    setModeState("loading");

    try {
      const clickedAt = now();
      const nextArticle = await wikipediaGateway.getArticle(title);
      const nextSession = followResolvedLink(session, {
        clickedAnchorText: anchorText,
        requestedTitle: title,
        resolvedDestination: {
          canonicalTitle: nextArticle.canonicalTitle,
          pageId: nextArticle.pageId,
        },
        timestamp: clickedAt,
      });
      setArticle(nextArticle);
      setSession(nextSession);
      setServerRun({
        ...serverRun,
        clickCount: nextSession.clicks,
      });
      setPendingNavigationTitle(null);
      setModeState(
        nextSession.status === "completed" ? "complete" : "playing",
      );

      const clickResponse = await apiClient.recordClick(
        serverRun.id,
        {
          sourceTitle: session.currentPage.canonicalTitle,
          clickedAnchorText: anchorText,
          requestedTitle: title,
          destinationTitle: nextArticle.canonicalTitle,
          destinationPageId: nextArticle.pageId,
          clientTimestampMs: clickedAt,
        },
        identitySession.token,
      );

      const trackedSession = {
        ...nextSession,
        clicks: clickResponse.clickCount,
      };
      setSession(trackedSession);

      if (trackedSession.status === "completed") {
        const leaderboardRow = await apiClient.completeRun(
          serverRun.id,
          {
            finalTitle: nextArticle.canonicalTitle,
            clientTimestampMs: clickedAt,
          },
          identitySession.token,
        );
        setServerRun({
          ...serverRun,
          status: "completed",
          clickCount: trackedSession.clicks,
          completedAt: leaderboardRow.completedAt,
          elapsedMs: leaderboardRow.elapsedMs,
        });
        await refreshLeaderboard(trackedSession.challenge.id);
        setModeState("complete");
      } else {
        setServerRun({
          ...serverRun,
          clickCount: trackedSession.clicks,
        });
        setModeState("playing");
      }
    } catch (caught) {
      setPendingNavigationTitle(null);
      setModeState("playing");
      setError(errorMessage(caught, "Could not load that article."));
    }
  }

  function handleArticleClick(event: MouseEvent<HTMLElement>) {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    const link = target.closest<HTMLAnchorElement>("a[data-vwiki-race-title]");
    if (!link) {
      return;
    }

    event.preventDefault();
    const title = link.dataset.vwikiRaceTitle;
    if (title) {
      void followArticleLink(title, link.textContent?.trim() || title);
    }
  }

  const currentPathTitles = session
    ? [
        session.challenge.start.title,
        ...session.path.map(
          (entry) => entry.resolvedDestination.canonicalTitle,
        ),
      ]
    : [];
  const visiblePath = session
    ? compressPathForStrip(
        currentPathTitles,
        session.challenge.target.title,
      )
    : [];
  const elapsedMs =
    serverRun?.elapsedMs ??
    (session?.status === "completed" && session.completedAt
      ? session.completedAt - session.startedAt
      : 0);

  return (
    <main
      className={`app-shell header-${headerState}`}
      aria-busy={isBusy}
    >
      <header className="game-header">
        <div className="brand-lockup" aria-label="VWiki Race">
          <span className="viota-mark">VWiki</span>
          <h1>VWiki Race</h1>
        </div>

        <div className="challenge-route" aria-label="Current challenge">
          <span>{selectedChallenge?.label ?? "Challenge"}</span>
          <strong>
            {selectedChallenge
              ? `${selectedChallenge.start.title} -> ${selectedChallenge.target.title}`
              : "Loading"}
          </strong>
        </div>

        {session ? (
          <dl className="run-metrics" aria-label="Current run">
            <div>
              <dt>Clicks</dt>
              <dd>{session.clicks}</dd>
            </div>
            <div>
              <dt>Target</dt>
              <dd>{session.challenge.target.title}</dd>
            </div>
          </dl>
        ) : null}

        <div className="player-gate">
          <button
            type="button"
            disabled={!selectedChallenge || isBusy}
            onClick={() => void startSelectedChallenge()}
          >
            Start {selectedChallenge?.label ?? "Challenge"}
          </button>
        </div>

        <div className="account-chip" role="status" aria-label="Current player">
          {identitySession?.displayName ?? "Guest"}
        </div>
      </header>

      {session ? (
        <PathStrip titles={visiblePath} />
      ) : null}

      <nav className="tabbar" aria-label="VWiki Race views">
        {(["play", "leaderboard", "challenges", "stats"] as const).map(
          (tab) => (
            <button
              aria-pressed={activeTab === tab}
              className={activeTab === tab ? "active" : undefined}
              key={tab}
              onClick={() => setActiveTab(tab)}
              type="button"
            >
              {tab}
            </button>
          ),
        )}
      </nav>

      {error ? <p className="error-banner">{error}</p> : null}
      {modeState === "loading" && !pendingNavigationTitle ? (
        <p className="loading-text">Loading article...</p>
      ) : null}

      <section className="content-shell">
        {activeTab === "play" ? (
          <PlayPanel
            article={article}
            challenges={challenges}
            elapsedMs={elapsedMs}
            handleArticleClick={handleArticleClick}
            modeState={modeState}
            onCreateChallenge={createChallenge}
            onSelectChallenge={(challengeId) => void selectChallenge(challengeId)}
            pendingNavigationTitle={pendingNavigationTitle}
            selectedChallenge={selectedChallenge}
            session={session}
          />
        ) : null}

        {activeTab === "leaderboard" ? (
          <LeaderboardPanel leaderboard={leaderboard} />
        ) : null}

        {activeTab === "challenges" ? (
          <ChallengeBrowser
            challenges={challenges}
            onCreateChallenge={createChallenge}
            onSelectChallenge={(challengeId) => void selectChallenge(challengeId)}
            selectedChallengeId={selectedChallenge?.id ?? null}
          />
        ) : null}

        {activeTab === "stats" ? (
          <StatsPanel
            accountId={identitySession?.accountId ?? null}
            leaderboard={leaderboard}
            session={session}
          />
        ) : null}
      </section>

      {authPrompt ? (
        <IdentityPrompt
          authBusy={authBusy}
          authMode={authMode}
          displayNameDraft={displayNameDraft}
          displayNameIsReady={displayNameIsReady}
          identitySession={identitySession}
          onClaim={() => void claimGuestName()}
          onClose={() => {
            if (!authBusy) {
              setAuthPrompt(null);
            }
          }}
          onContinueAsGuest={() => void continueAsGuest()}
          onDisplayNameChange={setDisplayNameDraft}
          onLogin={() => void login()}
          onPasswordChange={setPasswordDraft}
          onSetAuthMode={setAuthMode}
          onUsernameChange={setUsernameDraft}
          passwordDraft={passwordDraft}
          usernameDraft={usernameDraft}
        />
      ) : null}
    </main>
  );
}

function IdentityPrompt({
  authBusy,
  authMode,
  displayNameDraft,
  displayNameIsReady,
  identitySession,
  onClaim,
  onClose,
  onContinueAsGuest,
  onDisplayNameChange,
  onLogin,
  onPasswordChange,
  onSetAuthMode,
  onUsernameChange,
  passwordDraft,
  usernameDraft,
}: {
  authBusy: boolean;
  authMode: AuthMode;
  displayNameDraft: string;
  displayNameIsReady: boolean;
  identitySession: VGamesIdentitySession | null;
  onClaim: () => void;
  onClose: () => void;
  onContinueAsGuest: () => void;
  onDisplayNameChange: (value: string) => void;
  onLogin: () => void;
  onPasswordChange: (value: string) => void;
  onSetAuthMode: (mode: AuthMode) => void;
  onUsernameChange: (value: string) => void;
  passwordDraft: string;
  usernameDraft: string;
}) {
  const isGhost = identitySession?.status === "ghost";

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        aria-labelledby="identity-prompt-title"
        aria-modal="true"
        className="identity-dialog"
        role="dialog"
      >
        <div className="identity-dialog-heading">
          <div>
            <span className="viota-mark">VWiki</span>
            <h2 id="identity-prompt-title">Save your stats</h2>
          </div>
          <button
            aria-label="Close identity prompt"
            className="icon-button"
            disabled={authBusy}
            onClick={onClose}
            type="button"
          >
            x
          </button>
        </div>

        {isGhost ? (
          <p className="identity-copy">
            Save this name to keep your runs across devices, or continue as
            guest for this challenge.
          </p>
        ) : (
          <p className="identity-copy">
            Pick a display name before the timer starts. You can claim it now or
            keep playing as a guest.
          </p>
        )}

        <div
          className="auth-mode-switch"
          role="tablist"
          aria-label="Identity options"
        >
          <button
            aria-pressed={authMode === "guest"}
            onClick={() => onSetAuthMode("guest")}
            type="button"
          >
            Guest
          </button>
          <button
            aria-pressed={authMode === "claim"}
            onClick={() => onSetAuthMode("claim")}
            type="button"
          >
            Claim
          </button>
          <button
            aria-pressed={authMode === "login"}
            onClick={() => onSetAuthMode("login")}
            type="button"
          >
            Log in
          </button>
        </div>

        {authMode === "guest" ? (
          <form
            className="identity-form"
            onSubmit={(event) => {
              event.preventDefault();
              onContinueAsGuest();
            }}
          >
            {!identitySession ? (
              <label className="name-control">
                <span>Display name</span>
                <input
                  aria-label="Display name"
                  autoComplete="nickname"
                  autoFocus
                  maxLength={24}
                  onChange={(event) => onDisplayNameChange(event.target.value)}
                  value={displayNameDraft}
                />
              </label>
            ) : (
              <div className="identity-current-name">
                <span>Playing as</span>
                <strong>{identitySession.displayName}</strong>
              </div>
            )}
            <button
              disabled={authBusy || (!identitySession && !displayNameIsReady)}
              type="submit"
            >
              Continue as guest
            </button>
          </form>
        ) : null}

        {authMode === "claim" ? (
          <form
            className="identity-form"
            onSubmit={(event) => {
              event.preventDefault();
              onClaim();
            }}
          >
            {!identitySession ? (
              <label className="name-control">
                <span>Display name</span>
                <input
                  aria-label="Display name"
                  autoComplete="nickname"
                  autoFocus
                  maxLength={24}
                  onChange={(event) => onDisplayNameChange(event.target.value)}
                  value={displayNameDraft}
                />
              </label>
            ) : null}
            <label className="name-control">
              <span>Username</span>
              <input
                aria-label="Username"
                autoComplete="username"
                maxLength={24}
                onChange={(event) => onUsernameChange(event.target.value)}
                value={usernameDraft}
              />
            </label>
            <label className="name-control">
              <span>Password</span>
              <input
                aria-label="Password"
                autoComplete="new-password"
                minLength={8}
                onChange={(event) => onPasswordChange(event.target.value)}
                type="password"
                value={passwordDraft}
              />
            </label>
            <button disabled={authBusy} type="submit">
              Claim this name
            </button>
            <button
              className="secondary-button"
              disabled={authBusy}
              onClick={onContinueAsGuest}
              type="button"
            >
              Continue as guest
            </button>
          </form>
        ) : null}

        {authMode === "login" ? (
          <form
            className="identity-form"
            onSubmit={(event) => {
              event.preventDefault();
              onLogin();
            }}
          >
            <label className="name-control">
              <span>Username</span>
              <input
                aria-label="Username"
                autoComplete="username"
                autoFocus
                maxLength={24}
                onChange={(event) => onUsernameChange(event.target.value)}
                value={usernameDraft}
              />
            </label>
            <label className="name-control">
              <span>Password</span>
              <input
                aria-label="Password"
                autoComplete="current-password"
                onChange={(event) => onPasswordChange(event.target.value)}
                type="password"
                value={passwordDraft}
              />
            </label>
            <button disabled={authBusy} type="submit">
              Log in
            </button>
            <button
              className="secondary-button"
              disabled={authBusy}
              onClick={onContinueAsGuest}
              type="button"
            >
              Continue as guest
            </button>
          </form>
        ) : null}
      </section>
    </div>
  );
}

function PlayPanel({
  article,
  challenges,
  elapsedMs,
  handleArticleClick,
  modeState,
  onCreateChallenge,
  onSelectChallenge,
  pendingNavigationTitle,
  selectedChallenge,
  session,
}: {
  article: Article | null;
  challenges: Challenge[];
  elapsedMs: number;
  handleArticleClick: (event: MouseEvent<HTMLElement>) => void;
  modeState: ModeState;
  onCreateChallenge: (input: {
    startTitle: string;
    targetTitle: string;
  }) => Promise<void>;
  onSelectChallenge: (challengeId: string) => void;
  pendingNavigationTitle: string | null;
  selectedChallenge: Challenge | null;
  session: GameSession | null;
}) {
  if (session && article) {
    return (
      <section className="game-layout">
        <article
          aria-busy={Boolean(pendingNavigationTitle)}
          className="article-panel"
          onClick={handleArticleClick}
        >
          {pendingNavigationTitle ? (
            <div className="article-navigation-pending" role="status">
              Opening {pendingNavigationTitle}...
            </div>
          ) : null}
          <div className="article-heading">
            <span>{session.challenge.label ?? session.challenge.mode}</span>
            <h2>{article.canonicalTitle}</h2>
          </div>
          <div
            className="article-content"
            dangerouslySetInnerHTML={{ __html: article.html }}
          />
          <p className="attribution">{article.attribution}</p>
        </article>

        {session.status === "completed" ? (
          <aside className="result-panel">
            <h2>Target reached</h2>
            <p>
              {session.clicks} {session.clicks === 1 ? "click" : "clicks"} in{" "}
              {formatElapsed(elapsedMs)}
            </p>
          </aside>
        ) : null}
      </section>
    );
  }

  return (
    <section className="home-layout">
      <section className="empty-state">
        <span>{selectedChallenge?.label ?? "Challenge"}</span>
        <h2>
          {selectedChallenge
            ? `${selectedChallenge.start.title} -> ${selectedChallenge.target.title}`
            : "Loading challenge catalog"}
        </h2>
        <p>{modeState === "loading" ? "Preparing run..." : "Pick a challenge."}</p>
      </section>

      <ChallengeBrowser
        challenges={challenges}
        onCreateChallenge={onCreateChallenge}
        onSelectChallenge={onSelectChallenge}
        selectedChallengeId={selectedChallenge?.id ?? null}
      />
    </section>
  );
}

function PathStrip({ titles }: { titles: string[] }) {
  return (
    <nav className="path-strip" aria-label="Run path">
      {titles.map((title, index) => (
        <span
          className={title === "..." ? "path-ellipsis" : undefined}
          key={`${title}-${index}`}
        >
          {title}
        </span>
      ))}
    </nav>
  );
}

function ChallengeBrowser({
  challenges,
  onCreateChallenge,
  onSelectChallenge,
  selectedChallengeId,
}: {
  challenges: Challenge[];
  onCreateChallenge: (input: {
    startTitle: string;
    targetTitle: string;
  }) => Promise<void>;
  onSelectChallenge: (challengeId: string) => void;
  selectedChallengeId: string | null;
}) {
  const [startTitle, setStartTitle] = useState("");
  const [targetTitle, setTargetTitle] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const canCreate =
    startTitle.trim().length > 0 && targetTitle.trim().length > 0;

  async function submitChallenge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canCreate) {
      return;
    }

    setIsCreating(true);
    try {
      await onCreateChallenge({
        startTitle: startTitle.trim(),
        targetTitle: targetTitle.trim(),
      });
      setStartTitle("");
      setTargetTitle("");
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <section className="challenge-browser">
      <h2>Challenges</h2>
      <form className="create-challenge-form" onSubmit={submitChallenge}>
        <label className="name-control">
          <span>Start article</span>
          <input
            aria-label="Start article"
            maxLength={80}
            onChange={(event) => setStartTitle(event.target.value)}
            value={startTitle}
          />
        </label>
        <label className="name-control">
          <span>Target article</span>
          <input
            aria-label="Target article"
            maxLength={80}
            onChange={(event) => setTargetTitle(event.target.value)}
            value={targetTitle}
          />
        </label>
        <button type="submit" disabled={!canCreate || isCreating}>
          Create Challenge
        </button>
      </form>
      {challenges.length ? (
        <ol className="challenge-list">
          {challenges.map((challenge) => (
            <li key={challenge.id}>
              <button
                aria-pressed={selectedChallengeId === challenge.id}
                onClick={() => onSelectChallenge(challenge.id)}
                type="button"
              >
                <span>{challenge.label ?? challenge.id}</span>
                <strong>
                  {challenge.start.title} {"->"} {challenge.target.title}
                </strong>
                {challenge.createdBy ? (
                  <em>Created by {challenge.createdBy.displayName}</em>
                ) : null}
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted">No challenges loaded.</p>
      )}
    </section>
  );
}

function LeaderboardPanel({
  leaderboard,
}: {
  leaderboard: RankedLeaderboardRow[];
}) {
  return (
    <section className="leaderboard-panel">
      <h2>Leaderboard</h2>
      {leaderboard.length ? (
        <ol className="leaderboard">
          {leaderboard.map((row) => (
            <li key={row.runId}>
              <span className="rank">#{row.rank}</span>
              <span>{row.displayName}</span>
              <span>{formatElapsed(row.elapsedMs)}</span>
              <span>
                {row.clickCount} {row.clickCount === 1 ? "click" : "clicks"}
              </span>
              <details>
                <summary>Path</summary>
                <RunPathPreview path={row.pathPreview} />
              </details>
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted">No completed runs yet.</p>
      )}
    </section>
  );
}

function RunPathPreview({ path }: { path: ServerPathStep[] }) {
  if (!path.length) {
    return <p className="muted">Path not loaded.</p>;
  }

  return (
    <ol className="path-preview">
      {path.map((step) => (
        <li key={step.stepNumber}>
          <span>{step.sourceTitle}</span>
          <strong>{step.clickedAnchorText}</strong>
          <span>{step.destinationTitle}</span>
        </li>
      ))}
    </ol>
  );
}

function StatsPanel({
  accountId,
  leaderboard,
  session,
}: {
  accountId: string | null;
  leaderboard: RankedLeaderboardRow[];
  session: GameSession | null;
}) {
  const personalRows = accountId
    ? leaderboard.filter((row) => row.accountId === accountId)
    : [];
  const visitedTitles = session
    ? [
        session.challenge.start.title,
        ...session.path.map(
          (entry) => entry.resolvedDestination.canonicalTitle,
        ),
      ]
    : [];
  const bestRow = personalRows.at(0) ?? null;

  return (
    <section className="stats-panel">
      <h2>Stats</h2>
      <dl className="stat-grid">
        <div>
          <dt>Runs ranked</dt>
          <dd>{personalRows.length}</dd>
        </div>
        <div>
          <dt>Best speed</dt>
          <dd>{bestRow ? formatElapsed(bestRow.elapsedMs) : "-"}</dd>
        </div>
        <div>
          <dt>Best clicks</dt>
          <dd>{bestRow ? bestRow.clickCount : "-"}</dd>
        </div>
        <div>
          <dt>Visited now</dt>
          <dd>{visitedTitles.length}</dd>
        </div>
      </dl>
      <StatsList
        title="Top starts"
        items={session ? [session.challenge.start.title] : []}
      />
      <StatsList
        title="Top targets"
        items={session ? [session.challenge.target.title] : []}
      />
      <StatsList title="Visited pages" items={visitedTitles} />
    </section>
  );
}

function StatsList({ title, items }: { title: string; items: string[] }) {
  return (
    <section>
      <h3>{title}</h3>
      {items.length ? (
        <ol className="compact-list">
          {items.slice(0, 5).map((item) => (
            <li key={item}>
              <span>{item}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted">No data yet.</p>
      )}
    </section>
  );
}

function readChallengeIdFromUrl(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  return new URLSearchParams(window.location.search).get("challenge");
}

function syncChallengeUrl(
  challengeId: string,
  historyMode: "push" | "replace" = "push",
) {
  if (typeof window === "undefined" || !challengeId) {
    return;
  }

  const url = new URL(window.location.href);
  url.searchParams.set("challenge", challengeId);
  const nextUrl = `${url.pathname}${url.search}${url.hash}`;
  const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (nextUrl === currentUrl) {
    return;
  }

  if (historyMode === "replace") {
    window.history.replaceState({}, "", nextUrl);
    return;
  }

  window.history.pushState({}, "", nextUrl);
}

function formatElapsed(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function errorMessage(caught: unknown, fallback: string): string {
  return caught instanceof Error ? caught.message : fallback;
}
