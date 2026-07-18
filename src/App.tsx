import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
} from "react";
import { getSortedChallenges } from "./domain/challenges";
import {
  centralDateKey,
  dailyBadgeLabel,
  selectDefaultChallenge,
} from "./domain/challengeSelection";
import type { CreateChallengeOutcome } from "./domain/dailyEditorial";
import type {
  AccountStats,
  Challenge,
  RankedLeaderboardRow,
  ServerPathStep,
} from "./domain/types";
import {
  createVGamesIdentityClient,
  createVGamesIdentityRepository,
  vgamesIdentityErrorMessage,
  type VGamesIdentityClient,
  type VGamesIdentityRepository,
  type VGamesIdentitySession,
  type StorageLike,
} from "./services/vgamesIdentity";
import {
  createVWikiRaceApiClient,
  type VWikiRaceApiClient,
} from "./services/vwikiRaceApiClient";
import { createWikipediaGateway } from "./services/wikipediaGateway";
import { useRaceController } from "./hooks/useRaceController";
import AdminDailies from "./components/AdminDailies";
import {
  type TargetPreviewState,
  useTargetPreview,
} from "./hooks/useTargetPreview";
import RaceFlow, { type DnfResultSnapshot } from "./race/RaceFlow";
import { ChallengeShareButton, formatElapsed } from "./race/shared";

interface AppProps {
  apiOrigin?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  todayUtc?: () => string;
  storage?: StorageLike;
  apiClient?: VWikiRaceApiClient;
  identityClient?: VGamesIdentityClient;
  identityRepository?: VGamesIdentityRepository;
}

type TabKey = "play" | "leaderboard" | "challenges" | "stats" | "admin";
type AuthMode = "guest" | "create" | "login";
interface LoginFormInput {
  username: string;
  password: string;
}
interface LeaderboardProjection {
  challengeId: string;
  rows: RankedLeaderboardRow[];
}
interface AccountStatsProjection {
  token: string;
  stats: AccountStats | null;
}
interface CreateChallengeInput {
  startTitle: string;
  targetTitle: string;
  nominateForDaily: boolean;
}
type AuthPromptIntent =
  | { type: "start"; challengeId: string }
  | { type: "retry-click" }
  | { type: "end-run" }
  | { type: "claim" }
  | {
      type: "create";
      input: CreateChallengeInput;
    };

const defaultFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);
const defaultNow = () => performance.now();
const defaultTodayUtc = () => centralDateKey(new Date());
const unavailableBrowserStorage: StorageLike = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
};

function readBrowserStorage(): StorageLike {
  try {
    return globalThis.localStorage ?? unavailableBrowserStorage;
  } catch {
    return unavailableBrowserStorage;
  }
}

/**
 * Reads a cached identity session synchronously at mount (see the
 * identitySession/displayNameDraft/usernameDraft lazy useState initializers
 * below), rather than through an effect that only sets state a render
 * after mount. Recovery-first routing (spec: "Race flow" lead paragraph)
 * needs to know from the very first render whether there's a session that
 * might have an active run to recover - a post-mount effect would leave a
 * one-render window where the shell could flash before recovery is even
 * checked. Builds a throwaway repository instance purely to read cached
 * state; the memoized `identityRepository` used everywhere else in the
 * component reads/writes the same underlying storage, so this is safe.
 */
function readCachedIdentitySession(
  storage: StorageLike | undefined,
  injectedIdentityRepository: VGamesIdentityRepository | undefined,
): VGamesIdentitySession | null {
  const resolvedStorage = storage ?? readBrowserStorage();
  const repository = injectedIdentityRepository ?? createVGamesIdentityRepository(resolvedStorage);
  return repository.getSession();
}

export default function App({
  apiOrigin,
  fetchImpl = defaultFetch,
  now = defaultNow,
  todayUtc = defaultTodayUtc,
  storage,
  apiClient: injectedApiClient,
  identityClient: injectedIdentityClient,
  identityRepository: injectedIdentityRepository,
}: AppProps) {
  const [activeTab, setActiveTab] = useState<TabKey>(() =>
    isAdminDailiesRoute() ? "admin" : "play",
  );
  const [raceStage, setRaceStage] = useState<"preview" | null>(null);
  const [canManageDailies, setCanManageDailies] = useState<boolean | null>(null);
  const [authPrompt, setAuthPrompt] = useState<AuthPromptIntent | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode>("create");
  const [authBusy, setAuthBusy] = useState(false);
  const [identitySession, setIdentitySession] =
    useState<VGamesIdentitySession | null>(
      () => readCachedIdentitySession(storage, injectedIdentityRepository),
    );
  const [displayNameDraft, setDisplayNameDraft] = useState(
    () => readCachedIdentitySession(storage, injectedIdentityRepository)?.displayName ?? "",
  );
  const [usernameDraft, setUsernameDraft] = useState(() => {
    const cached = readCachedIdentitySession(storage, injectedIdentityRepository);
    return cached ? suggestUsername(cached.displayName) : "";
  });
  const [passwordDraft, setPasswordDraft] = useState("");
  const [confirmPasswordDraft, setConfirmPasswordDraft] = useState("");
  const [challenges, setChallenges] = useState<Challenge[]>([]);
  const [catalogRefreshVersion, setCatalogRefreshVersion] = useState(0);
  const [selectedChallengeId, setSelectedChallengeId] = useState<string | null>(
    null,
  );
  const [leaderboardProjection, setLeaderboardProjection] =
    useState<LeaderboardProjection | null>(null);
  const [accountStatsProjection, setAccountStatsProjection] =
    useState<AccountStatsProjection | null>(null);
  const [runPaths, setRunPaths] = useState<Record<string, ServerPathStep[]>>({});
  const [endConfirmationOpen, setEndConfirmationOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runNotice, setRunNotice] = useState<string | null>(null);
  const [dnfResult, setDnfResult] = useState<DnfResultSnapshot | null>(null);
  const [catalogLoadFailed, setCatalogLoadFailed] = useState(false);
  const identityTrigger = useRef<HTMLElement | null>(null);
  const endRunTrigger = useRef<HTMLElement | null>(null);
  const requestedPaths = useRef(new Set<string>());
  const catalogRequest = useRef(0);
  const catalogRefreshQueued = useRef(false);
  const leaderboardRequest = useRef(0);
  const statsRequest = useRef(0);
  const recoveredToken = useRef<string | null>(null);
  const challengeLockRef = useRef(false);
  const startLockRef = useRef(false);
  const loginRequestLock = useRef(false);

  const apiClient = useMemo(
    () => injectedApiClient ?? createVWikiRaceApiClient(fetchImpl, { apiOrigin }),
    [apiOrigin, fetchImpl, injectedApiClient],
  );
  const identityClient = useMemo(
    () => injectedIdentityClient ?? createVGamesIdentityClient(fetchImpl, { apiOrigin }),
    [apiOrigin, fetchImpl, injectedIdentityClient],
  );
  const identityStorage = useMemo(
    () => storage ?? readBrowserStorage(),
    [storage],
  );
  const identityRepository = useMemo(
    () => injectedIdentityRepository ?? createVGamesIdentityRepository(identityStorage),
    [identityStorage, injectedIdentityRepository],
  );
  const wikipediaGateway = useMemo(
    () => createWikipediaGateway({ fetchImpl }),
    [fetchImpl],
  );
  const previewWikipediaGateway = useMemo(
    () => createWikipediaGateway({ fetchImpl }),
    [fetchImpl],
  );
  const race = useRaceController({ apiClient, gateway: wikipediaGateway, now });
  const modeState = race.phase;
  const session = race.session;
  const article = race.article;
  const pendingNavigationTitle = race.pendingNavigationTitle;
  const challengeIsLocked =
    ["preparing", "active", "syncing", "abandoning"].includes(race.phase) ||
    Boolean(race.recoveryRun);
  const startIsLocked =
    !["idle", "completed"].includes(race.phase) || Boolean(race.recoveryRun);
  challengeLockRef.current = challengeIsLocked;
  startLockRef.current = startIsLocked;
  // Recovery-first routing (spec: "Race flow" lead paragraph - "On load,
  // recovery takes priority over everything else"). True from the very
  // first render whenever a cached identity might still have an active run
  // to recover, until recoverActiveRun has actually been invoked for that
  // session's token (recoveredToken.current is set synchronously the
  // instant the recovery effect below calls it, in the same tick that
  // race.phase flips to "preparing" - so this and the phase check below
  // hand off without a gap). Guests with no cached session have nothing to
  // recover and skip this gate entirely. The recovery effect needs
  // challenges.length > 0 before it can even attempt recoverActiveRun, so a
  // failed catalog load (catalogLoadFailed) would otherwise leave an
  // identified user stuck here forever with no article to look at - release
  // the gate in that case and fall back to the shell, where the existing
  // error banner + focus-refetch affordances live.
  const recoveryGatePending = identitySession !== null &&
    recoveredToken.current !== identitySession.token &&
    !catalogLoadFailed;
  // Full-screen, zero-chrome race-flow takeover (spec: "Race flow" section).
  // Engaged whenever the preview beat is open, the run is mid-flight in any
  // sense (including transient preparing/syncing/abandoning and the
  // completed results beat), an active-run recovery gate is pending or
  // resolved-but-unaddressed, or a just-ended run is showing its DNF
  // Results variant.
  const raceEngaged = raceStage !== null ||
    ["preparing", "active", "syncing", "completed", "abandoning"].includes(race.phase) ||
    Boolean(race.recoveryRun) ||
    Boolean(dnfResult) ||
    recoveryGatePending;

  const selectedChallenge =
    challenges.find((challenge) => challenge.id === selectedChallengeId) ??
    challenges[0] ??
    null;
  const currentCentralDate = todayUtc();
  const targetPreview = useTargetPreview({
    challenge: selectedChallenge,
    enabled: modeState === "idle" && !race.recoveryRun,
    gateway: previewWikipediaGateway,
  });
  const leaderboard = !challengeIsLocked && selectedChallenge &&
      leaderboardProjection?.challengeId === selectedChallenge.id
    ? leaderboardProjection.rows
    : [];
  const accountStats = identitySession &&
      accountStatsProjection?.token === identitySession.token
    ? accountStatsProjection.stats
    : null;
  const displayNameIsReady =
    (identitySession?.displayName ?? displayNameDraft).trim().length > 0;
  const isBusy = ["preparing", "syncing", "abandoning"].includes(modeState) || authBusy;

  // Re-syncs identitySession when the *memoized* identityRepository instance
  // itself changes after mount (e.g. a different `identityRepository`/
  // `storage` prop, simulating a device/account swap in tests) - the lazy
  // useState initializers above only run once, at mount, so they can't see
  // this. Harmless no-op on the initial mount itself (same cached value).
  useEffect(() => {
    const cachedSession = identityRepository.getSession();
    if (cachedSession) {
      setIdentitySession(cachedSession);
      setDisplayNameDraft(cachedSession.displayName);
      setUsernameDraft(suggestUsername(cachedSession.displayName));
    }
  }, [identityRepository]);

  useEffect(() => {
    let cancelled = false;
    if (!identitySession) {
      setCanManageDailies(false);
      return;
    }

    setCanManageDailies(null);
    void apiClient.getCapabilities(identitySession.token)
      .then((capabilities) => {
        if (!cancelled) setCanManageDailies(capabilities.canManageDailies);
      })
      .catch(() => {
        if (!cancelled) setCanManageDailies(false);
      });

    return () => {
      cancelled = true;
    };
  }, [apiClient, identitySession]);

  useEffect(() => {
    if (modeState !== "active" && modeState !== "syncing") return;
    const blockBrowserFind = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", blockBrowserFind, { capture: true });
    return () => window.removeEventListener("keydown", blockBrowserFind, { capture: true });
  }, [modeState]);

  useEffect(() => {
    const queueCatalogRefresh = () => {
      if (catalogRefreshQueued.current) return;
      catalogRefreshQueued.current = true;
      queueMicrotask(() => {
        catalogRefreshQueued.current = false;
        setCatalogRefreshVersion((version) => version + 1);
      });
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") queueCatalogRefresh();
    };
    window.addEventListener("focus", queueCatalogRefresh);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("focus", queueCatalogRefresh);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const request = ++catalogRequest.current;

    async function loadChallengeCatalog() {
      setError(null);
      let challengesLoaded = false;
      try {
        const nextChallenges = await apiClient.listChallenges();
        if (cancelled || request !== catalogRequest.current) {
          return;
        }
        setChallenges(nextChallenges);
        challengesLoaded = true;
        setCatalogLoadFailed(false);
        const requestedChallengeId = readChallengeIdFromUrl();
        const nextChallenge = selectDefaultChallenge(nextChallenges, {
          requestedChallengeId,
          todayUtc: currentCentralDate,
        });
        setSelectedChallengeId(nextChallenge?.id ?? null);
        setLeaderboardProjection(nextChallenge
          ? { challengeId: nextChallenge.id, rows: [] }
          : null);
        if (
          nextChallenge &&
          race.phase === "idle" &&
          (requestedChallengeId === nextChallenge.id || nextChallenge.origin === "daily")
        ) {
          syncChallengeUrl(nextChallenge.id, "replace");
        }
        if (nextChallenge) {
          const leaderboardGeneration = ++leaderboardRequest.current;
          const nextLeaderboard = await apiClient.listLeaderboard(nextChallenge.id);
          if (
            !cancelled &&
            request === catalogRequest.current &&
            leaderboardGeneration === leaderboardRequest.current
          ) {
            setLeaderboardProjection({
              challengeId: nextChallenge.id,
              rows: nextLeaderboard,
            });
          }
        }
      } catch (caught) {
        if (!cancelled && request === catalogRequest.current) {
          setError(errorMessage(caught, "Could not load challenges."));
          // Only the initial challenges fetch itself failing should release
          // the recovery gate - a later failure in this same pass (e.g. the
          // leaderboard fetch) doesn't leave recovery stuck, since
          // challenges.length > 0 already let it proceed.
          if (!challengesLoaded) setCatalogLoadFailed(true);
        }
      }
    }

    void loadChallengeCatalog();

    return () => {
      cancelled = true;
    };
  }, [apiClient, catalogRefreshVersion, currentCentralDate]);

  useEffect(() => {
    if (!identitySession || challenges.length === 0 || recoveredToken.current === identitySession.token) {
      return;
    }
    recoveredToken.current = identitySession.token;
    void race.recoverActiveRun(challenges, identitySession.token).then((outcome) => {
      if (outcome.status === "unauthorized") clearStaleIdentity();
    });
  }, [challenges, identitySession, race.recoverActiveRun]);

  useEffect(() => {
    // Once a run actually starts (or recovery finds one), the race.phase
    // condition alone keeps the takeover engaged - drop the preview stage
    // marker so a later return to "idle" (e.g. after End Run) correctly
    // exits back to the normal shell instead of re-showing the preview.
    if (race.phase !== "idle" && raceStage !== null) {
      setRaceStage(null);
    }
  }, [race.phase, raceStage]);

  useEffect(() => {
    const lockedChallenge = race.challenge ??
      challenges.find((challenge) => challenge.id === race.recoveryRun?.challengeId) ??
      null;
    if (!lockedChallenge || !challengeIsLocked) return;
    setSelectedChallengeId(lockedChallenge.id);
    syncChallengeUrl(lockedChallenge.id, "replace");
  }, [challengeIsLocked, challenges, race.challenge, race.recoveryRun]);

  useEffect(() => {
    const onPopState = () => {
      const lockedChallengeId = race.challenge?.id ?? race.recoveryRun?.challengeId ?? selectedChallengeId;
      if (challengeIsLocked) {
        if (lockedChallengeId) syncChallengeUrl(lockedChallengeId, "replace");
        return;
      }
      if (isAdminDailiesRoute()) {
        setActiveTab("admin");
        setError(null);
        return;
      }
      const requestedId = readChallengeIdFromUrl();
      const requested = challenges.find((challenge) => challenge.id === requestedId);
      if (!requested) return;
      race.resetCompleted();
      setSelectedChallengeId(requested.id);
      setActiveTab("play");
      setError(null);
      void refreshLeaderboard(requested.id).catch((caught) => {
        setError(errorMessage(caught, "Could not load the leaderboard."));
      });
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [challengeIsLocked, challenges, race.challenge, race.recoveryRun, selectedChallengeId]);

  useEffect(() => {
    if (activeTab !== "stats" || !identitySession) return;
    const token = identitySession.token;
    const request = ++statsRequest.current;
    setAccountStatsProjection({ token, stats: null });
    void apiClient.getAccountStats(identitySession.token)
      .then((stats) => {
        if (request === statsRequest.current) {
          setAccountStatsProjection({ token, stats });
        }
      })
      .catch((caught) => {
        if (request !== statsRequest.current) return;
        setAccountStatsProjection(null);
        if (isUnauthorizedError(caught)) {
          clearStaleIdentity();
        }
        setError(errorMessage(caught, "Could not load account stats."));
      });
    return () => {
      if (request === statsRequest.current) statsRequest.current += 1;
    };
  }, [activeTab, apiClient, identitySession]);

  async function refreshLeaderboard(challengeId: string) {
    const request = ++leaderboardRequest.current;
    setLeaderboardProjection({ challengeId, rows: [] });
    try {
      const nextLeaderboard = await apiClient.listLeaderboard(challengeId);
      if (request === leaderboardRequest.current) {
        setLeaderboardProjection({ challengeId, rows: nextLeaderboard });
      }
    } catch (caught) {
      if (request === leaderboardRequest.current) {
        setLeaderboardProjection({ challengeId, rows: [] });
      }
      throw caught;
    }
  }

  async function selectChallenge(challengeId: string) {
    if (challengeLockRef.current) return;
    race.resetCompleted();
    setSelectedChallengeId(challengeId);
    syncChallengeUrl(challengeId);
    setActiveTab("play");
    setError(null);
    setRunNotice(null);
    try {
      await refreshLeaderboard(challengeId);
    } catch (caught) {
      setError(errorMessage(caught, "Could not load the leaderboard."));
    }
  }

  function selectView(tab: TabKey) {
    if (tab === "admin") {
      if (!canManageDailies) return;
      syncAdminDailiesUrl();
      setActiveTab("admin");
      return;
    }

    if (isAdminDailiesRoute()) {
      const url = new URL(window.location.href);
      url.pathname = "/";
      window.history.pushState({}, "", `${url.pathname}${url.search}${url.hash}`);
    }
    setActiveTab(tab);
  }

  async function createChallenge(input: CreateChallengeInput) {
    if (challengeLockRef.current) return;
    if (!identitySession || (input.nominateForDaily && identitySession.status !== "claimed")) {
      openAuthPrompt({ type: "create", input }, input.nominateForDaily ? "create" : undefined);
      return;
    }

    await createChallengeWithSession(input, identitySession);
  }

  async function createChallengeWithSession(
    input: CreateChallengeInput,
    sessionForRequest: VGamesIdentitySession,
  ) {
    if (challengeLockRef.current) return;
    if (input.nominateForDaily && sessionForRequest.status !== "claimed") {
      setError("Claim or log in to nominate for a future Daily.");
      openAuthPrompt({ type: "create", input }, "create");
      return;
    }
    setError(null);
    try {
      const outcome = await apiClient.createChallenge(
        input,
        sessionForRequest.token,
      );
      const { challenge } = outcome;
      catalogRequest.current += 1;
      setChallenges((current) => {
        const mergedChallenge = mergeCreatedChallenge(current, challenge);
        return getSortedChallenges([
          ...current.filter((item) => item.id !== challenge.id),
          mergedChallenge,
        ]);
      });
      if (!challengeLockRef.current) {
        race.resetCompleted();
        setSelectedChallengeId(challenge.id);
        syncChallengeUrl(challenge.id);
        setLeaderboardProjection({ challengeId: challenge.id, rows: [] });
        setActiveTab("play");
      }
      setRunNotice(createChallengeNotice(outcome));
      if (!challengeLockRef.current) {
        try {
          await refreshLeaderboard(challenge.id);
        } catch (caught) {
          setError(errorMessage(caught, "Could not load the leaderboard."));
        }
      }
    } catch (caught) {
      if (isUnauthorizedError(caught)) {
        clearStaleIdentity({ type: "create", input });
        return;
      }
      setError(errorMessage(caught, "Could not create that challenge."));
      throw caught;
    }
  }

  function openRacePreview() {
    if (!selectedChallenge) return;
    setRaceStage("preview");
  }

  function exitRaceFlow(tab: TabKey) {
    setRaceStage(null);
    setActiveTab(tab);
  }

  function exitCompletedRaceTo(tab: TabKey) {
    race.resetCompleted();
    setDnfResult(null);
    setRaceStage(null);
    setActiveTab(tab);
  }

  function requestEndRun(event: MouseEvent<HTMLElement>) {
    endRunTrigger.current = event.currentTarget;
    setEndConfirmationOpen(true);
  }

  async function startSelectedChallenge() {
    if (!selectedChallenge || startLockRef.current) {
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
    if (startLockRef.current) return;
    const challenge =
      challenges.find((item) => item.id === challengeId) ?? selectedChallenge;
    if (!challenge) {
      setError("Choose a challenge before starting.");
      return;
    }

    setError(null);
    setRunNotice(null);
    setDnfResult(null);
    setActiveTab("play");
    setLeaderboardProjection({ challengeId: challenge.id, rows: [] });
    setSelectedChallengeId(challenge.id);
    syncChallengeUrl(challenge.id);
    const outcome = await race.start(challenge, sessionForRun.token);
    if (outcome.status === "unauthorized") {
      clearStaleIdentity({ type: "start", challengeId: challenge.id });
      return;
    }
  }

  function openAuthPrompt(intent: AuthPromptIntent, preferredMode?: AuthMode) {
    identityTrigger.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setError(null);
    setAuthPrompt(intent);
    setPasswordDraft("");
    setConfirmPasswordDraft("");
    if (preferredMode) {
      setAuthMode(preferredMode);
    } else {
      setAuthMode("create");
      setUsernameDraft(
        identitySession?.status === "ghost"
          ? suggestUsername(identitySession.displayName)
          : "",
      );
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
        setError(vgamesIdentityErrorMessage(caught, "Could not start a guest session."));
        setAuthBusy(false);
        return;
      }
    }

    if (prompt.type === "create" && prompt.input.nominateForDaily && nextIdentitySession.status !== "claimed") {
      setAuthMode("create");
      setError("Claim or log in to nominate for a future Daily.");
      setAuthBusy(false);
      return;
    }

    setAuthPrompt(null);
    try {
      await resumeAfterIdentity(prompt, nextIdentitySession);
    } finally {
      setAuthBusy(false);
    }
  }

  async function createVGamesAccount() {
    if (!authPrompt) {
      return;
    }

    const prompt = authPrompt;
    const username = usernameDraft.trim().toLowerCase();
    const password = passwordDraft;
    if (!/^[a-z0-9_]{3,20}$/.test(username)) {
      setError("Use 3-20 lowercase letters, numbers, or underscores for your VGames username.");
      return;
    }
    if (password.length < 6 || password.length > 128) {
      setError("Use a password between 6 and 128 characters.");
      return;
    }
    if (password !== confirmPasswordDraft) {
      setError("Passwords do not match.");
      return;
    }

    setAuthBusy(true);
    try {
      let guestSession = identitySession;
      if (!guestSession) {
        guestSession = await identityClient.playAsGuest({
          deviceCredential: identityRepository.getDeviceCredential(),
          displayName: username,
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
      setError(vgamesIdentityErrorMessage(caught, "Could not create that VGames account."));
    } finally {
      setAuthBusy(false);
    }
  }

  async function login(input: LoginFormInput) {
    if (!authPrompt || loginRequestLock.current) {
      return;
    }

    const prompt = authPrompt;
    const username = input.username.trim().toLowerCase();
    const password = input.password;
    if (!username || !password) {
      setError("Enter your username and password.");
      return;
    }

    loginRequestLock.current = true;
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
      setError(vgamesIdentityErrorMessage(caught, "Could not log in."));
    } finally {
      loginRequestLock.current = false;
      setAuthBusy(false);
    }
  }

  function persistIdentitySession(nextSession: VGamesIdentitySession) {
    try {
      identityRepository.saveSession(nextSession);
    } catch {
      // A successful login remains usable for this tab even when browser
      // privacy settings block durable storage.
    }
    recoveredToken.current = nextSession.token;
    statsRequest.current += 1;
    setAccountStatsProjection(null);
    setIdentitySession(nextSession);
    setDisplayNameDraft(nextSession.displayName);
    setUsernameDraft(suggestUsername(nextSession.displayName));
  }

  function clearStaleIdentity(intent?: AuthPromptIntent) {
    identityRepository.clearSession();
    recoveredToken.current = null;
    statsRequest.current += 1;
    setAccountStatsProjection(null);
    setIdentitySession(null);
    setDisplayNameDraft("");
    setUsernameDraft("");
    setPasswordDraft("");
    setConfirmPasswordDraft("");
    if (intent) {
      openAuthPrompt(intent, "login");
    }
  }

  async function resumeAfterIdentity(
    prompt: AuthPromptIntent,
    nextIdentitySession: VGamesIdentitySession,
  ) {
    if (prompt.type === "start") {
      await startChallengeWithSession(prompt.challengeId, nextIdentitySession);
      return;
    }

    if (prompt.type === "retry-click") {
      await retryPendingClick(nextIdentitySession);
      return;
    }

    if (prompt.type === "end-run") {
      await confirmEndRun(nextIdentitySession);
      return;
    }

    if (prompt.type === "claim") {
      // Results' guest claim CTA (spec beat 3): there is no pending action
      // to resume - continueAsGuest/createVGamesAccount/login already
      // upgraded the identity and persisted it. Nothing further to do.
      return;
    }

    await createChallengeWithSession(prompt.input, nextIdentitySession);
  }

  async function followArticleLink(title: string, anchorText: string) {
    if (!identitySession) return;
    const outcome = await race.followLink(title, anchorText, identitySession.token);
    if (outcome.status === "unauthorized") {
      clearStaleIdentity({ type: "retry-click" });
      return;
    }
    if (outcome.status === "completed") await refreshLeaderboard(outcome.challengeId);
  }

  async function retryPendingClick(
    sessionForRetry: VGamesIdentitySession | null = identitySession,
  ) {
    if (!sessionForRetry) {
      openAuthPrompt({ type: "retry-click" }, "login");
      return;
    }
    const outcome = await race.retryPendingClick(sessionForRetry.token);
    if (outcome.status === "unauthorized") {
      clearStaleIdentity({ type: "retry-click" });
      return;
    }
    if (outcome.status === "completed") await refreshLeaderboard(outcome.challengeId);
  }

  async function retryRecovery() {
    if (!identitySession) return;
    const outcome = await race.recoverActiveRun(challenges, identitySession.token);
    if (outcome.status === "unauthorized") {
      clearStaleIdentity();
    }
  }

  async function loadRunPath(runId: string) {
    if (requestedPaths.current.has(runId)) return;
    requestedPaths.current.add(runId);
    try {
      const path = await apiClient.getRunPath(runId);
      setRunPaths((current) => ({ ...current, [runId]: path }));
    } catch (caught) {
      requestedPaths.current.delete(runId);
      setError(errorMessage(caught, "Could not load that winning path."));
    }
  }

  async function confirmEndRun(
    sessionForEnd: VGamesIdentitySession | null = identitySession,
  ) {
    if (!sessionForEnd) return;
    // Recovery's "End Old Run" (a stale/legacy run from this or another
    // device) has no live session/path to show - it resolves straight back
    // to the shell, same as always. Only ending an in-flight run from
    // RaceMode's "End Run" gets the DNF Results variant (spec: Race flow
    // beat 3). useRaceController.endRun wipes session/run on abandon, so
    // the data Results needs is snapshotted here, before that call.
    const isRecoveryEnd = Boolean(race.recoveryRun);
    const endedChallengeId = race.recoveryRun?.challengeId ?? race.challenge?.id ?? null;
    const acceptedClickCount = race.recoveryRun?.clickCount ?? race.session?.clicks ?? 0;
    const dnfSnapshot: DnfResultSnapshot | null = !isRecoveryEnd && race.challenge
      ? {
          challenge: race.challenge,
          clicks: acceptedClickCount,
          elapsedMs: race.elapsedMs,
          runId: race.run?.id ?? null,
        }
      : null;
    const outcome = await race.endRun(
      sessionForEnd.token,
      race.recoveryRun?.protocolVersion === 1 ? 1 : undefined,
    );
    if (outcome.status === "abandoned") {
      setEndConfirmationOpen(false);
      if (dnfSnapshot && dnfSnapshot.clicks > 0) {
        setDnfResult(dnfSnapshot);
        setRunNotice(null);
      } else {
        setDnfResult(null);
        setRunNotice(acceptedClickCount > 0
          ? "Run ended. Your DNF and path were saved."
          : "Run ended. The attempt was saved to your stats.");
      }
      if (endedChallengeId) {
        await refreshLeaderboard(endedChallengeId);
      }
    } else if (outcome.status === "completed") {
      setEndConfirmationOpen(false);
      setDnfResult(null);
      setRunNotice(null);
      if (endedChallengeId) {
        await refreshLeaderboard(endedChallengeId);
      }
    } else if (outcome.status === "unauthorized") {
      clearStaleIdentity({ type: "end-run" });
      setEndConfirmationOpen(false);
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

  function handleArticlePrewarm(target: EventTarget | null) {
    if (!(target instanceof Element)) return;
    const link = target.closest<HTMLAnchorElement>("a[data-vwiki-race-title]");
    const title = link?.dataset.vwikiRaceTitle;
    if (title) race.prewarmLink(title);
  }

  const elapsedMs = race.elapsedMs;
  const visibleError = error ?? race.error;
  const endRunIsBlocked = modeState === "syncing" || Boolean(race.pendingRetry);
  const endRunClickCount = race.recoveryRun?.clickCount ?? race.session?.clicks ?? 0;
  const endRunConfirmCopy = endRunClickCount >= 1
    ? `It'll count as a DNF with ${endRunClickCount} ${endRunClickCount === 1 ? "click" : "clicks"}.`
    : "This cannot be resumed after the server accepts it.";
  const showBanners = !authPrompt && !endConfirmationOpen;
  const bannerError = showBanners ? visibleError : null;
  const bannerNotice = showBanners ? runNotice : null;
  const visibleTab: TabKey = activeTab === "admin" && canManageDailies !== true
    ? "play"
    : activeTab;
  const showAdminAccessNotice = activeTab === "admin" && canManageDailies === false;
  const availableTabs: TabKey[] = canManageDailies
    ? ["play", "leaderboard", "challenges", "stats", "admin"]
    : ["play", "leaderboard", "challenges", "stats"];

  return (
    <main
      className="app-shell header-expanded"
      aria-busy={isBusy}
    >
      {raceEngaged ? (
        <RaceFlow
          phase={race.phase}
          raceChallenge={race.challenge}
          recoveryRun={race.recoveryRun}
          recoveryPending={recoveryGatePending}
          showPreview={raceStage === "preview"}
          previewChallenge={selectedChallenge}
          targetPreview={targetPreview}
          session={session}
          article={article}
          elapsedMs={elapsedMs}
          pendingNavigationTitle={pendingNavigationTitle}
          pendingRetry={race.pendingRetry}
          leaderboardContext={race.leaderboardContext}
          leaderboard={leaderboard}
          runId={race.run?.id ?? null}
          dnfResult={dnfResult}
          todayCentral={currentCentralDate}
          identityStatus={identitySession?.status ?? null}
          identityDisplayName={identitySession?.displayName ?? ""}
          error={bannerError}
          authBusy={authBusy}
          endRunIsBlocked={endRunIsBlocked}
          onRetryPending={() => void retryPendingClick()}
          onRetryRecovery={() => void retryRecovery()}
          onRetryCatalog={() => setCatalogRefreshVersion((version) => version + 1)}
          onRequestEndRun={requestEndRun}
          onBackFromPreview={() => exitRaceFlow("play")}
          onSeeOtherChallengesFromPreview={() => exitRaceFlow("challenges")}
          onStartFromPreview={() => void startSelectedChallenge()}
          onPlayAgain={() => void startSelectedChallenge()}
          onShowLeaderboard={() => exitCompletedRaceTo("leaderboard")}
          onShowChallenges={() => exitCompletedRaceTo("challenges")}
          onClaimIdentity={(mode) => openAuthPrompt({ type: "claim" }, mode)}
          handleArticleClick={handleArticleClick}
          handleArticlePrewarm={handleArticlePrewarm}
        />
      ) : (
        <>
          <header className="game-header">
            <div className="brand-lockup" aria-label="VWiki Race">
              <span className="viota-mark">VWiki</span>
              <h1>VWiki Race</h1>
            </div>

            <div className="challenge-route" aria-label="Current challenge">
              <div className="challenge-meta">
                <span>{selectedChallenge?.label ?? "Challenge"}</span>
                {selectedChallenge && dailyBadgeLabel(selectedChallenge, currentCentralDate) ? (
                  <span className="daily-badge">
                    {dailyBadgeLabel(selectedChallenge, currentCentralDate)}
                  </span>
                ) : null}
              </div>
              <strong>
                {selectedChallenge
                  ? `${selectedChallenge.start.title} -> ${selectedChallenge.target.title}`
                  : "Loading"}
              </strong>
            </div>

            <div className="player-gate">
              <button
                type="button"
                disabled={!selectedChallenge || authBusy}
                onClick={openRacePreview}
              >
                {`Start ${selectedChallenge?.label ?? "Challenge"}`}
              </button>
            </div>

            <div className="account-chip" role="status" aria-label="Current player">
              {identitySession?.displayName ?? "Guest"}
            </div>
          </header>

          <nav className={`tabbar${canManageDailies ? " has-admin" : ""}`} aria-label="VWiki Race views">
            {availableTabs.map(
              (tab) => (
                <button
                  aria-pressed={visibleTab === tab}
                  className={visibleTab === tab ? "active" : undefined}
                  disabled={tab !== "play" && challengeIsLocked}
                  key={tab}
                  onClick={() => selectView(tab)}
                  type="button"
                >
                  {tab === "admin" ? "Admin" : tab}
                </button>
              ),
            )}
          </nav>

          {bannerError ? (
            <p className="error-banner" role="alert">{bannerError}</p>
          ) : null}
          {bannerNotice ? (
            <p className="run-notice" role="status">{bannerNotice}</p>
          ) : null}
          {showAdminAccessNotice ? (
            <p aria-label="Authorization notice" className="run-notice" role="status">
              This page is not available.
            </p>
          ) : null}

          <section className="content-shell">
            {visibleTab === "play" ? (
              <PlayPanel
                challenges={challenges}
                onCreateChallenge={createChallenge}
                onSelectChallenge={(challengeId) => void selectChallenge(challengeId)}
                selectedChallenge={selectedChallenge}
                selectionLocked={challengeIsLocked}
                targetPreview={targetPreview}
                todayCentral={currentCentralDate}
                canNominateForDaily={identitySession?.status === "claimed"}
              />
            ) : null}

            {visibleTab === "leaderboard" ? (
              <LeaderboardPanel
                leaderboard={leaderboard}
                onDisclosePath={(runId) => void loadRunPath(runId)}
                runPaths={runPaths}
              />
            ) : null}

            {visibleTab === "challenges" ? (
              <ChallengeBrowser
                challenges={challenges}
                canNominateForDaily={identitySession?.status === "claimed"}
                onCreateChallenge={createChallenge}
                onSelectChallenge={(challengeId) => void selectChallenge(challengeId)}
                selectedChallengeId={selectedChallenge?.id ?? null}
                selectionLocked={challengeIsLocked}
                todayCentral={currentCentralDate}
              />
            ) : null}

            {visibleTab === "stats" ? (
              <StatsPanel
                stats={accountStats}
              />
            ) : null}

            {visibleTab === "admin" && identitySession ? (
              <AdminDailies
                apiClient={apiClient}
                challenges={challenges}
                previewGateway={previewWikipediaGateway}
                token={identitySession.token}
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
      )}

      {authPrompt ? (
        <IdentityPrompt
          authBusy={authBusy}
          authMode={authMode}
          confirmPasswordDraft={confirmPasswordDraft}
          displayNameDraft={displayNameDraft}
          displayNameIsReady={displayNameIsReady}
          identitySession={identitySession}
          error={visibleError}
          onCreate={() => void createVGamesAccount()}
          onClose={() => {
            if (!authBusy) {
              setAuthPrompt(null);
            }
          }}
          onContinueAsGuest={() => void continueAsGuest()}
          onDisplayNameChange={setDisplayNameDraft}
          onLogin={(input) => void login(input)}
          onPasswordChange={setPasswordDraft}
          onConfirmPasswordChange={setConfirmPasswordDraft}
          onSetAuthMode={(mode) => {
            setError(null);
            setAuthMode(mode);
          }}
          onUsernameChange={setUsernameDraft}
          passwordDraft={passwordDraft}
          returnFocusRef={identityTrigger}
          usernameDraft={usernameDraft}
        />
      ) : null}
      {endConfirmationOpen ? (
        <ModalDialog
          busy={modeState === "abandoning"}
          className="end-run-dialog"
          onClose={() => setEndConfirmationOpen(false)}
          returnFocusRef={endRunTrigger}
          titleId="end-run-title"
        >
          <h2 id="end-run-title">End this run?</h2>
          <p>{endRunConfirmCopy}</p>
          {visibleError ? <p role="alert">{visibleError}</p> : null}
          <button disabled={modeState === "abandoning"} type="button" onClick={() => setEndConfirmationOpen(false)}>Continue run</button>
          <button disabled={modeState === "abandoning"} type="button" onClick={() => void confirmEndRun()}>
            {race.recoveryRun ? "Confirm End Old Run" : "Confirm End Run"}
          </button>
        </ModalDialog>
      ) : null}
    </main>
  );
}

function IdentityPrompt({
  authBusy,
  authMode,
  confirmPasswordDraft,
  displayNameDraft,
  displayNameIsReady,
  error,
  identitySession,
  onCreate,
  onClose,
  onContinueAsGuest,
  onDisplayNameChange,
  onLogin,
  onPasswordChange,
  onConfirmPasswordChange,
  onSetAuthMode,
  onUsernameChange,
  passwordDraft,
  returnFocusRef,
  usernameDraft,
}: {
  authBusy: boolean;
  authMode: AuthMode;
  confirmPasswordDraft: string;
  displayNameDraft: string;
  displayNameIsReady: boolean;
  error: string | null;
  identitySession: VGamesIdentitySession | null;
  onCreate: () => void;
  onClose: () => void;
  onContinueAsGuest: () => void;
  onDisplayNameChange: (value: string) => void;
  onLogin: (input: LoginFormInput) => void;
  onPasswordChange: (value: string) => void;
  onConfirmPasswordChange: (value: string) => void;
  onSetAuthMode: (mode: AuthMode) => void;
  onUsernameChange: (value: string) => void;
  passwordDraft: string;
  returnFocusRef: RefObject<HTMLElement | null>;
  usernameDraft: string;
}) {
  const isGhost = identitySession?.status === "ghost";

  return (
    <ModalDialog
      busy={authBusy}
      className="identity-dialog"
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      titleId="identity-prompt-title"
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

        <p className="identity-copy">
          {isGhost
            ? "Turn this guest into a VGames account without losing any runs. "
            : "Create a VGames account before the timer starts. "}
          Free, no email - keeps your name and stats on every device. One
          account works across all V games.
        </p>

        {error ? <p role="alert">{error}</p> : null}

        <div
          className="auth-mode-switch"
          role="group"
          aria-label="Identity options"
        >
          <button
            aria-pressed={authMode === "guest"}
            disabled={authBusy}
            onClick={() => onSetAuthMode("guest")}
            type="button"
          >
            Guest
          </button>
          <button
            aria-pressed={authMode === "create"}
            disabled={authBusy}
            onClick={() => onSetAuthMode("create")}
            type="button"
          >
            Create New
          </button>
          <button
            aria-pressed={authMode === "login"}
            disabled={authBusy}
            onClick={() => onSetAuthMode("login")}
            type="button"
          >
            Log In / Existing
          </button>
        </div>

        {authMode === "guest" ? (
          <form
            className="identity-form"
            noValidate
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
                  placeholder="e.g. a nickname"
                  value={displayNameDraft}
                />
                <p className="name-hint">
                  Your name and winning paths appear on the public leaderboard —
                  use a nickname if you&apos;d rather stay anonymous.
                </p>
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

        {authMode === "create" ? (
          <form
            className="identity-form"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              onCreate();
            }}
          >
            <label className="name-control">
              <span>VGames username</span>
              <input
                aria-label="VGames username"
                autoCapitalize="none"
                autoFocus
                autoComplete="username"
                maxLength={20}
                minLength={3}
                onChange={(event) => onUsernameChange(event.target.value.toLowerCase())}
                pattern="[a-z0-9_]{3,20}"
                placeholder="e.g. vijay"
                spellCheck={false}
                value={usernameDraft}
              />
              <p className="name-hint">This is also your public display name.</p>
            </label>
            <label className="name-control">
              <span>Password</span>
              <input
                aria-label="Password"
                autoComplete="new-password"
                maxLength={128}
                minLength={6}
                onChange={(event) => onPasswordChange(event.target.value)}
                type="password"
                value={passwordDraft}
              />
            </label>
            <label className="name-control">
              <span>Confirm password</span>
              <input
                aria-label="Confirm password"
                autoComplete="new-password"
                maxLength={128}
                minLength={6}
                onChange={(event) => onConfirmPasswordChange(event.target.value)}
                type="password"
                value={confirmPasswordDraft}
              />
            </label>
            <button disabled={authBusy} type="submit">
              Create VGames account
            </button>
          </form>
        ) : null}

        {authMode === "login" ? (
          <form
            aria-busy={authBusy}
            className="identity-form"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              onLogin({
                username: String(form.get("username") ?? ""),
                password: String(form.get("password") ?? ""),
              });
            }}
          >
            <label className="name-control">
              <span>Username</span>
              <input
                aria-label="Username"
                autoCapitalize="none"
                autoComplete="username"
                autoFocus
                maxLength={20}
                name="username"
                onChange={(event) => onUsernameChange(event.target.value)}
                spellCheck={false}
                value={usernameDraft}
              />
            </label>
            <label className="name-control">
              <span>Password</span>
              <input
                aria-label="Password"
                autoComplete="current-password"
                name="password"
                onChange={(event) => onPasswordChange(event.target.value)}
                type="password"
                value={passwordDraft}
              />
            </label>
            <button disabled={authBusy} type="submit">
              {authBusy ? "Logging in..." : "Log in"}
            </button>
          </form>
        ) : null}
    </ModalDialog>
  );
}

function ModalDialog({
  busy = false,
  children,
  className,
  onClose,
  returnFocusRef,
  titleId,
}: {
  busy?: boolean;
  children: ReactNode;
  className: string;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
  titleId: string;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const focusCycle = useRef(0);

  useEffect(() => {
    const cycle = ++focusCycle.current;
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement && dialogRef.current?.contains(activeElement))) {
      const first = focusableElements(dialogRef.current)[0];
      (first ?? dialogRef.current)?.focus();
    }
    return () => {
      queueMicrotask(() => {
        if (focusCycle.current === cycle && returnFocusRef.current?.isConnected) {
          returnFocusRef.current.focus();
        }
      });
    };
  }, [returnFocusRef]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  function close() {
    if (busy) return;
    onClose();
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = focusableElements(dialogRef.current);
    if (focusable.length === 0) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className={className}
        onKeyDown={handleKeyDown}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        {children}
      </section>
    </div>
  );
}

function focusableElements(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(
    "button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
  ));
}

function PlayPanel({
  canNominateForDaily,
  challenges,
  onCreateChallenge,
  onSelectChallenge,
  selectedChallenge,
  selectionLocked,
  targetPreview,
  todayCentral,
}: {
  canNominateForDaily: boolean;
  challenges: Challenge[];
  onCreateChallenge: (input: CreateChallengeInput) => Promise<void>;
  onSelectChallenge: (challengeId: string) => void;
  selectedChallenge: Challenge | null;
  selectionLocked: boolean;
  targetPreview: TargetPreviewState;
  todayCentral: string;
}) {
  // The race flow (preview -> active -> results) is a full-screen takeover
  // rendered by RaceFlow once engaged (see raceEngaged in App.tsx); this
  // panel therefore only ever renders the idle "pick a challenge" view.
  return (
    <section className="home-layout">
      <p className="how-to-play muted">
        Race from the start article to the target using only links inside the page. Fastest time wins.
      </p>
      {selectedChallenge ? (
        <TargetPreviewPanel
          challenge={selectedChallenge}
          targetPreview={targetPreview}
        />
      ) : (
        <section className="empty-state">
          <span>Challenge</span>
          <h2>Loading challenge catalog</h2>
          <p>Pick a challenge.</p>
        </section>
      )}

      <ChallengeBrowser
        canNominateForDaily={canNominateForDaily}
        challenges={challenges}
        onCreateChallenge={onCreateChallenge}
        onSelectChallenge={onSelectChallenge}
        selectedChallengeId={selectedChallenge?.id ?? null}
        selectionLocked={selectionLocked}
        todayCentral={todayCentral}
      />
    </section>
  );
}

function TargetPreviewPanel({
  challenge,
  targetPreview,
}: {
  challenge: Challenge;
  targetPreview: TargetPreviewState;
}) {
  const readyPreview =
    targetPreview.status === "ready" && targetPreview.challengeId === challenge.id
      ? targetPreview
      : null;
  const unavailable =
    targetPreview.status === "unavailable" && targetPreview.challengeId === challenge.id;
  const title = readyPreview?.canonicalTitle ?? challenge.target.title;

  return (
    <section
      aria-label="Target preview"
      className="target-preview-panel"
      role="region"
    >
      <div className="target-preview-copy">
        <span className="target-preview-kicker">Target preview</span>
        <h2 id="target-preview-title">{title}</h2>
        {readyPreview ? (
          <p className="target-preview-blurb">
            {readyPreview.preview.blurb ?? "Wikipedia does not provide a short lead for this target."}
          </p>
        ) : unavailable ? (
          <p className="target-preview-blurb muted">Preview unavailable. You can still start the challenge.</p>
        ) : (
          <p className="target-preview-blurb muted">Loading target preview...</p>
        )}
        {readyPreview ? (
          <p className="target-preview-attribution">
            <a href={readyPreview.attributionUrl} rel="noreferrer noopener" target="_blank">
              Source revision
            </a>{" "}
            ·{" "}
            <a
              href="https://creativecommons.org/licenses/by-sa/4.0/"
              rel="noreferrer noopener"
              target="_blank"
            >
              CC BY-SA 4.0
            </a>
          </p>
        ) : null}
        <ChallengeShareButton challengeId={challenge.id} />
      </div>
    </section>
  );
}

function ChallengeBrowser({
  canNominateForDaily,
  challenges,
  onCreateChallenge,
  onSelectChallenge,
  selectionLocked = false,
  selectedChallengeId,
  todayCentral,
}: {
  canNominateForDaily: boolean;
  challenges: Challenge[];
  onCreateChallenge: (input: CreateChallengeInput) => Promise<void>;
  onSelectChallenge: (challengeId: string) => void;
  selectionLocked?: boolean;
  selectedChallengeId: string | null;
  todayCentral: string;
}) {
  const [startTitle, setStartTitle] = useState("");
  const [targetTitle, setTargetTitle] = useState("");
  const [nominateForDaily, setNominateForDaily] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const canCreate =
    startTitle.trim().length > 0 && targetTitle.trim().length > 0;

  useEffect(() => {
    if (!canNominateForDaily) setNominateForDaily(false);
  }, [canNominateForDaily]);

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
          Create Challenge
        </button>
      </form>
      {challenges.length ? (
        <ol className="challenge-list">
          {challenges.map((challenge) => (
            <li key={challenge.id}>
              <button
                aria-pressed={selectedChallengeId === challenge.id}
                disabled={selectionLocked}
                onClick={() => onSelectChallenge(challenge.id)}
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

function createChallengeNotice(outcome: CreateChallengeOutcome): string {
  const challengeLabel = outcome.challenge.label ?? outcome.challenge.id;
  const creation = outcome.disposition === "existing"
    ? `It already exists as ${challengeLabel}.`
    : "Challenge created.";

  switch (outcome.nomination) {
    case "pending":
      return `${creation} Daily nomination pending review.`;
    case "already_exists":
      return `${creation} It already has a Daily nomination.`;
    case "previously_featured":
      return `${creation} It has already been featured as a Daily.`;
    case "account_required":
      return `${creation} Claim or log in to nominate for a future Daily.`;
    case "not_requested":
      return creation;
  }
}

function mergeCreatedChallenge(
  current: Challenge[],
  incoming: Challenge,
): Challenge {
  const existingFeature = current.find((challenge) => challenge.id === incoming.id)
    ?.dailyFeature;
  if (incoming.dailyFeature || !existingFeature) {
    return incoming;
  }
  return {
    ...incoming,
    mode: "daily",
    origin: "daily",
    dailyDate: existingFeature.dailyDate,
    dailyFeature: existingFeature,
    source: existingFeature.selectionSource === "automatic"
      ? "wikipedia_random"
      : "curated",
  };
}

function LeaderboardPanel({
  leaderboard,
  onDisclosePath,
  runPaths,
}: {
  leaderboard: RankedLeaderboardRow[];
  onDisclosePath: (runId: string) => void;
  runPaths: Record<string, ServerPathStep[]>;
}) {
  return (
    <section className="leaderboard-panel">
      <h2>Leaderboard</h2>
      {leaderboard.length ? (
        <ol className="leaderboard">
          {leaderboard.map((row) => (
            <li className={row.status === "abandoned" ? "dnf" : undefined} key={row.runId}>
              <span className="rank">
                {row.status === "abandoned" ? "DNF" : `#${row.rank}`}
              </span>
              <span className="leaderboard-player">
                <span>{row.displayName}</span>
                <span
                  className={`provenance-badge ${
                    row.protocolVersion === 1 ? "historical" : "verified"
                  }`}
                  title={row.protocolVersion === 1
                    ? "Recorded before server-tracked race protocol"
                    : "Identity, timing, and path continuity tracked by the server"}
                >
                  {row.protocolVersion === 1 ? "Historical" : "Server tracked"}
                </span>
                {row.isRepeatRun ? (
                  <span className="provenance-badge repeat">Repeat run</span>
                ) : null}
              </span>
              <span>{formatElapsed(row.elapsedMs)}</span>
              <span>
                {row.clickCount} {row.clickCount === 1 ? "click" : "clicks"}
              </span>
              <details onToggle={(event) => {
                if (event.currentTarget.open) onDisclosePath(row.runId);
              }}>
                <summary>
                  {row.status === "abandoned" ? "View path" : "View winning path"}
                </summary>
                {runPaths[row.runId] ? (
                  <ol className="winning-path">
                    {runPaths[row.runId].map((step) => (
                      <li key={step.stepNumber}>{step.sourceTitle} {"->"} {step.destinationTitle}</li>
                    ))}
                  </ol>
                ) : <p>Loading path...</p>}
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

function StatsPanel({ stats }: { stats: AccountStats | null }) {
  const totals = stats?.totals;

  return (
    <section className="stats-panel">
      <h2>Stats</h2>
      <dl className="stat-grid">
        <div>
          <dt>Attempts</dt>
          <dd>{totals?.attempts ?? "-"}</dd>
        </div>
        <div>
          <dt>Completed</dt>
          <dd>{totals?.completed ?? "-"}</dd>
        </div>
        <div>
          <dt>DNFs</dt>
          <dd>{totals?.abandoned ?? "-"}</dd>
        </div>
        <div>
          <dt>Best speed</dt>
          <dd>{totals?.bestElapsedMs === null || totals?.bestElapsedMs === undefined ? "-" : formatElapsed(totals.bestElapsedMs)}</dd>
        </div>
        <div>
          <dt>Best clicks</dt>
          <dd>{totals?.bestClicks ?? "-"}</dd>
        </div>
        <div>
          <dt>Completed clicks</dt>
          <dd>{totals?.totalClicks ?? "-"}</dd>
        </div>
      </dl>
      <StatsList
        title="Top starts"
        items={stats?.topStarts.map((item) => item.title) ?? []}
      />
      <StatsList
        title="Top targets"
        items={stats?.topTargets.map((item) => item.title) ?? []}
      />
      <StatsList title="Visited pages" items={stats?.mostVisited.map((item) => item.title) ?? []} />
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

function isAdminDailiesRoute(): boolean {
  return typeof window !== "undefined" && window.location.pathname === "/admin/dailies";
}

function syncAdminDailiesUrl() {
  if (typeof window === "undefined" || isAdminDailiesRoute()) {
    return;
  }
  const url = new URL(window.location.href);
  url.pathname = "/admin/dailies";
  window.history.pushState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

function syncChallengeUrl(
  challengeId: string,
  historyMode: "push" | "replace" = "push",
) {
  if (typeof window === "undefined" || !challengeId) {
    return;
  }

  if (isAdminDailiesRoute()) {
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

function errorMessage(caught: unknown, fallback: string): string {
  return caught instanceof Error ? caught.message : fallback;
}

function suggestUsername(displayName: string): string {
  return displayName
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9_\s-]/g, "")
    .trim()
    .replace(/[\s-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 20);
}

function isUnauthorizedError(caught: unknown): boolean {
  return caught !== null && typeof caught === "object" &&
    (("status" in caught && caught.status === 401) ||
      ("code" in caught && caught.code === "unauthorized"));
}
