import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type MouseEvent,
} from "react";
import ModalDialog from "./components/ModalDialog";
import { getSortedChallenges } from "./domain/challenges";
import {
  centralDateKey,
  isDailyToday,
  selectDefaultChallenge,
} from "./domain/challengeSelection";
import { msUntilNextCentralDrop } from "./domain/dailyCountdown";
import type { CreateChallengeOutcome } from "./domain/dailyEditorial";
import { ghostGuardRequired } from "./domain/identityStakes";
import { describeRandomChallengeError, type PlayAnotherSuggestionState } from "./domain/playAnother";
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
// FB-7 (owner ruling, 2026-07-19): shared with the server's DNF eligibility
// threshold - see MIN_COUNTED_DNF_CLICKS's doc comment in runProtocol.ts.
import { MIN_COUNTED_DNF_CLICKS } from "./server/runProtocol";
import {
  clearChallengeUrl,
  exitAdminDailiesUrl,
  isAdminDailiesRoute,
  readChallengeIdFromUrl,
  syncChallengeUrl,
} from "./services/urlRouting";
import { createWikipediaGateway } from "./services/wikipediaGateway";
import { ApiRequestError } from "./services/apiRequest";
import { useRaceController } from "./hooks/useRaceController";
import { useTargetPreview } from "./hooks/useTargetPreview";
import RaceFlow, { type DnfResultSnapshot } from "./race/RaceFlow";
import AppShell, { type ChallengesView, type ModeKey } from "./modes/AppShell";
import type { BoardsSegment } from "./modes/Boards";
import type { CreateChallengeInput } from "./modes/challenges/Browse";

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
type AuthPromptIntent =
  | { type: "start"; challengeId: string }
  | { type: "retry-click" }
  | { type: "end-run" }
  | { type: "claim" }
  | { type: "random-challenge" }
  | {
      type: "create";
      input: CreateChallengeInput;
    }
  // "Honest You" (spec §2.3/§2.4): covers both "Play as someone else"
  // (freshName: true - forces the Guest form's name input open even though
  // a session exists) and "Switch account" (freshName: false - opens
  // straight on Log in). `resumeAfterIdentity` treats this as a no-op, same
  // as "claim" - there is no pending action to resume, the identity swap
  // itself was the whole point.
  | { type: "switch"; freshName: boolean };

// "Honest You" (spec §2.2/§2.3): which destructive-path entry point
// triggered the ghost-loss guard. Two entries, not a bare boolean, so the
// guard's waiver (§2.2 "hasn't been waived this sheet-opening") can be
// scoped per entry rather than per sheet-opening as a whole - a fresh-entry
// waiver ("Start fresh anyway") must never silently suppress a later,
// same-opening pivot to the Log in tab (the guest-form's "Log in instead"
// link, §2.6) against the same at-stake ghost, and vice versa.
type GhostGuardEntry = "login" | "fresh";
interface GhostGuardState {
  entry: GhostGuardEntry;
  pendingLogin?: LoginFormInput;
}

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
 * FB-6 (approved defaults batch, 2026-07-19): wraps a storage backend so a
 * write failure - private browsing, a blocked-storage policy, a full quota
 * - can be observed exactly once without changing behavior otherwise. The
 * write still throws through to the caller (createVGamesIdentityRepository
 * already has its own catch that swallows it and falls back to in-memory
 * for the tab); this just lets App also notice, so it can surface "your
 * progress won't stick" instead of failing silently.
 */
function withStorageBlockedDetection(
  storage: StorageLike,
  onBlocked: () => void,
): StorageLike {
  return {
    getItem: (key) => storage.getItem(key),
    setItem: (key, value) => {
      try {
        storage.setItem(key, value);
      } catch (caught) {
        onBlocked();
        throw caught;
      }
    },
    removeItem: (key) => {
      try {
        storage.removeItem(key);
      } catch (caught) {
        onBlocked();
        throw caught;
      }
    },
  };
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
  // Bottom-nav mode shell (Increment 2 - see src/modes/AppShell.tsx). The
  // `/admin/dailies` bypass reads window.location directly inside AppShell
  // rather than being tracked here, so `mode` only ever holds the four real
  // nav destinations - see `locationVersion` below for how admin
  // enter/exit still forces a re-render without its own piece of state.
  const [mode, setMode] = useState<ModeKey>("home");
  const [challengesView, setChallengesView] = useState<ChallengesView>("browse");
  const [locationVersion, setLocationVersion] = useState(0);
  const [raceStage, setRaceStage] = useState<"preview" | null>(null);
  const [canManageDailies, setCanManageDailies] = useState<boolean | null>(null);
  const [authPrompt, setAuthPrompt] = useState<AuthPromptIntent | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode>("create");
  const [authBusy, setAuthBusy] = useState(false);
  // "Honest You" (spec §2.2/§2.3): non-null while the ghost-loss guard
  // dialog is showing INSTEAD of the identity sheet (§8 "Dialog layering" -
  // `authPrompt && ghostGuard` renders the guard, never both at once).
  const [ghostGuard, setGhostGuard] = useState<GhostGuardState | null>(null);
  // Per-entry waiver (judge amendment, 2026-07-20 - scoped by entry type,
  // not by sheet-opening as a whole): cleared whenever the sheet opens or
  // fully closes (openAuthPrompt/closeAuthPrompt below), consulted per
  // entry so a "Start fresh anyway" waiver can never suppress the login
  // guard for a same-opening pivot to Log in against the same ghost.
  const [ghostGuardWaivedFor, setGhostGuardWaivedFor] =
    useState<ReadonlySet<GhostGuardEntry>>(new Set());
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
  // Boards v1 (Increment 3) owns its own [Today][Yesterday] segment state
  // internally, but the *initial* segment on mount depends on how you got
  // there: the bottom-nav Boards item always cold-starts on Today (Open
  // Question 4 - avoids duplicating Home's yesterday pre-play card), while
  // Home's "see full board" link under its yesterday recap means Yesterday
  // specifically - see goToBoardsFor/selectMode below.
  const [boardsInitialSegment, setBoardsInitialSegment] = useState<BoardsSegment>("today");
  const [endConfirmationOpen, setEndConfirmationOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runNotice, setRunNotice] = useState<string | null>(null);
  // FB-6: set once, the first time an identity/session storage write
  // throws (private browsing, a blocked-storage policy, a full quota) -
  // see withStorageBlockedDetection below. Dismissal is in-memory only
  // (storage is by definition unavailable to remember it) and lasts for
  // this page load.
  const [storageBlocked, setStorageBlocked] = useState(false);
  const [storageNoticeDismissed, setStorageNoticeDismissed] = useState(false);
  const [dnfResult, setDnfResult] = useState<DnfResultSnapshot | null>(null);
  const [catalogLoadFailed, setCatalogLoadFailed] = useState(false);
  // Bumped after every run-ending event (completed or abandoned) to force a
  // fresh account-stats read - the app-shell teaching gate (migration note
  // iii) and Results' first-finish ritual hook both need up-to-date
  // totals.completed, not whatever was cached before this run. See the
  // account-stats effect below, which now fetches proactively (any
  // identified session, not just while "You" is open) for this reason.
  const [statsRefreshVersion, setStatsRefreshVersion] = useState(0);
  // Local, session-only memory of "ended a run for this challenge" - Home's
  // DNF sub-state (spec: "attempted-not-finished" = "a board-visible DNF row
  // or an end-run this session"). This is the only way Home can reflect that
  // acknowledgment immediately, without waiting on/adding a server refetch.
  // FB-7 (owner ruling, 2026-07-19): only recorded when the ended run had >=
  // MIN_COUNTED_DNF_CLICKS - a sub-threshold bail is a non-attempt and must
  // leave Home in the FRESH state, matching the server's view (which also
  // never surfaces a sub-threshold DNF as a board row) on reload. Reset only
  // by a full reload (deliberately not persisted - it's "this session's"
  // memory, distinct from the teaching gate, which must never read
  // device-local state).
  const [sessionDnfChallengeIds, setSessionDnfChallengeIds] = useState<
    ReadonlySet<string>
  >(new Set());
  // Increment 5 (UX redesign spec §Home "Play-another suggestion logic" +
  // §Race flow beat 3): centrally fetched here - like accountStats - so
  // Home's post-play card and Results' Play-another slot always agree on
  // the same suggestion, rather than each independently racing the endpoint.
  const [playAnotherSuggestion, setPlayAnotherSuggestion] =
    useState<PlayAnotherSuggestionState>({ status: "loading" });
  const [randomChallengeBusy, setRandomChallengeBusy] = useState(false);
  const [randomChallengeError, setRandomChallengeError] = useState<string | null>(null);
  const identityTrigger = useRef<HTMLElement | null>(null);
  const endRunTrigger = useRef<HTMLElement | null>(null);
  const requestedPaths = useRef(new Set<string>());
  const catalogRequest = useRef(0);
  const catalogRefreshQueued = useRef(false);
  const leaderboardRequest = useRef(0);
  const statsRequest = useRef(0);
  const suggestionRequest = useRef(0);
  // Increment 5 (spec: "a per-account concurrency cap of 1 in-flight
  // request... Disable while in flight (no double-fire)") - one lock shared
  // by every entry point (Browse's bottom action, Home's and Results'
  // null-suggestion slot), mirroring challengeLockRef/startLockRef's
  // existing pattern.
  const randomChallengeLockRef = useRef(false);
  // Ritual hook snapshot (M2 fix - see RaceResults' preRaceCompletions doc
  // comment): the account's totals.completed captured at the moment a run
  // actually starts (startChallengeWithSession, below), not read live off
  // whatever accountStats holds whenever Results later renders - immune to
  // how long the post-race stats refetch takes, in either direction. Stays
  // null across a recovered-then-completed run (no fresh start happened
  // this page load to snapshot) - the ritual simply doesn't fire there
  // rather than guessing from a live value again.
  const preRaceCompletionsRef = useRef<number | null>(null);
  const recoveredToken = useRef<string | null>(null);
  const challengeLockRef = useRef(false);
  const startLockRef = useRef(false);
  const loginRequestLock = useRef(false);
  // QF-07: same synchronous-ref double-fire guard `login` already has
  // (`authBusy` alone has a real window before re-render where a second
  // tap/Enter fires a second request) - `continueAsGuest`/
  // `createVGamesAccount` were missing it.
  const continueAsGuestLock = useRef(false);
  const createVGamesAccountLock = useRef(false);
  // One-shot guard for migration note (iv): a challenge share link
  // (?challenge=<id>) routes to Challenges/Detail on the very first catalog
  // load that honors it. Without this, a later focus-triggered catalog
  // refresh would keep re-reading the same URL param and yank the player
  // back to Detail even after they'd already navigated elsewhere in-app.
  const initialUrlRouteApplied = useRef(false);

  const apiClient = useMemo(
    () => injectedApiClient ?? createVWikiRaceApiClient(fetchImpl, { apiOrigin }),
    [apiOrigin, fetchImpl, injectedApiClient],
  );
  const identityClient = useMemo(
    () => injectedIdentityClient ?? createVGamesIdentityClient(fetchImpl, { apiOrigin }),
    [apiOrigin, fetchImpl, injectedIdentityClient],
  );
  const identityStorage = useMemo(
    () => withStorageBlockedDetection(
      storage ?? readBrowserStorage(),
      () => setStorageBlocked(true),
    ),
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
  // "Play as someone else" (spec §2.3) forces the Guest form's name input
  // open even though `identitySession` already holds a name - readiness
  // must key off the freshly-typed draft, not the OLD session's name, or
  // the submit button would stay enabled with an empty (blanked-on-open)
  // input.
  const forceGuestNameEntry = authPrompt?.type === "switch" && authPrompt.freshName;
  const displayNameIsReady = forceGuestNameEntry
    ? displayNameDraft.trim().length > 0
    : (identitySession?.displayName ?? displayNameDraft).trim().length > 0;
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

    // QF-06 (round-2 quickfix, owner-proxy ruling): self-heal a tab left
    // foregrounded straight through the 5:00 AM Central daily-drop boundary.
    // The focus/visibilitychange listeners above only ever refresh on the
    // NEXT blur/focus cycle - a tab that's simply being read through the
    // boundary may never trigger either one. This lives here (App-level),
    // not inside Home's own `useDailyCountdown`, because Home fully
    // unmounts on every other tab (AppShell.tsx's mode switch) - a timer
    // owned by Home would silently stop self-healing the moment the player
    // isn't parked on Home. Reuses `queueCatalogRefresh` (the exact trigger
    // focus already uses) rather than any new fetch path, and re-derives +
    // reschedules off the same DST-safe `msUntilNextCentralDrop` Home's
    // countdown already trusts, so it keeps self-healing across however
    // many drops the tab happens to survive.
    let dropTimer: ReturnType<typeof window.setTimeout> | null = null;
    const scheduleNextDrop = () => {
      const delay = Math.max(0, msUntilNextCentralDrop(new Date()));
      dropTimer = window.setTimeout(() => {
        queueCatalogRefresh();
        scheduleNextDrop();
      }, delay);
    };
    scheduleNextDrop();

    return () => {
      window.removeEventListener("focus", queueCatalogRefresh);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (dropTimer !== null) window.clearTimeout(dropTimer);
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
        const requestedIdHonored = Boolean(
          requestedChallengeId && nextChallenge && requestedChallengeId === nextChallenge.id,
        );
        if (
          nextChallenge &&
          race.phase === "idle" &&
          (requestedIdHonored || nextChallenge.origin === "daily")
        ) {
          syncChallengeUrl(nextChallenge.id, "replace");
        }
        // Migration note (iv): a challenge share link opens Challenges mode
        // -> Detail for that id. A plain load (no ?challenge=, or one that
        // doesn't match a real challenge) is unaffected - Home keeps
        // showing today's daily exactly as before.
        //
        // B1 fix: initialUrlRouteApplied latches on the very FIRST catalog
        // pass, whether or not that pass honored a requested id - not just
        // inside the branch that does. A plain load of today's daily
        // replace-syncs the URL to /?challenge=<daily-id> above; if this
        // guard only latched when requestedIdHonored was true, that flag
        // would stay false forever on a plain load, and the very next
        // focus/visibilitychange-triggered catalog refresh would re-read
        // that *app-synced* URL, see requestedIdHonored=true this time, and
        // force-navigate to Challenges -> Detail out from under whatever the
        // player is doing - including mid-race, under an active takeover.
        if (!initialUrlRouteApplied.current) {
          initialUrlRouteApplied.current = true;
          if (requestedIdHonored) {
            setMode("challenges");
            setChallengesView("detail");
          }
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
      // Forces a re-render even on branches below that don't otherwise
      // touch state (e.g. entering/leaving /admin/dailies), so AppShell's
      // own isAdminDailiesRoute() read - and every other read of
      // window.location during this render - reflects the URL popstate
      // just navigated to. pushState/replaceState never trigger React on
      // their own.
      setLocationVersion((version) => version + 1);
      const lockedChallengeId = race.challenge?.id ?? race.recoveryRun?.challengeId ?? selectedChallengeId;
      if (challengeIsLocked) {
        if (lockedChallengeId) syncChallengeUrl(lockedChallengeId, "replace");
        return;
      }
      if (isAdminDailiesRoute()) {
        setError(null);
        return;
      }
      const requestedId = readChallengeIdFromUrl();
      const requested = challenges.find((challenge) => challenge.id === requestedId);
      if (!requested) return;
      race.resetCompleted();
      setSelectedChallengeId(requested.id);
      // Migration note (iv): back/forward through a challenge share link
      // lands on Detail, same as the initial load.
      setMode("challenges");
      setChallengesView("detail");
      setError(null);
      void refreshLeaderboard(requested.id).catch((caught) => {
        setError(errorMessage(caught, "Could not load the leaderboard."));
      });
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [challengeIsLocked, challenges, race.challenge, race.recoveryRun, selectedChallengeId]);

  // Account stats are fetched proactively for ANY identified session - not
  // gated on "You" being open - because the app-shell teaching gate
  // (migration note iii) and Results' first-finish ritual hook both need
  // totals.completed on Home/Detail/Results, which are usually visited long
  // before "You" ever is. `statsRefreshVersion` (bumped after every
  // run-ending event) keeps this fresh across a session without needing the
  // player to revisit "You" - see followArticleLink/retryPendingClick/
  // confirmEndRun below.
  useEffect(() => {
    if (!identitySession) return;
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
  }, [apiClient, identitySession, statsRefreshVersion]);

  // Play-another suggestion (Increment 5): same proactive-fetch shape as
  // account stats above, for the same reason - Home's post-play card and
  // Results' Play-another slot both need it, and Results in particular is
  // reached long before "You." Re-fetched on `statsRefreshVersion` (bumped
  // after every run-ending event) so a just-finished/just-abandoned
  // challenge drops out of "never started" promptly.
  useEffect(() => {
    if (!identitySession) {
      setPlayAnotherSuggestion({ status: "loading" });
      return;
    }
    let cancelled = false;
    const request = ++suggestionRequest.current;
    const token = identitySession.token;
    setPlayAnotherSuggestion({ status: "loading" });
    void (async () => {
      try {
        const suggested = await apiClient.getPlayAnotherSuggestion(token);
        if (cancelled || request !== suggestionRequest.current) return;
        if (!suggested) {
          setPlayAnotherSuggestion({ status: "empty" });
          return;
        }
        let playerCount: number | null = null;
        try {
          const summary = await apiClient.getChallengesSummary();
          playerCount = summary.find((entry) => entry.challengeId === suggested.id)?.playerCount ?? null;
        } catch {
          // Degrade gracefully - the suggestion title just omits player
          // count (same "never fabricate" rule as Browse's own meta line).
        }
        if (cancelled || request !== suggestionRequest.current) return;
        setPlayAnotherSuggestion({ status: "ready", challenge: suggested, playerCount });
      } catch {
        if (cancelled || request !== suggestionRequest.current) return;
        setPlayAnotherSuggestion({ status: "error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiClient, identitySession, statsRefreshVersion]);

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

  // Plan-drift fix: Browse's cards now open Challenge Detail directly (spec
  // IA) instead of selecting and landing back on Home - Detail's own "Race
  // this" is the race entry point from there.
  async function openChallengeDetail(challengeId: string) {
    if (challengeLockRef.current) return;
    race.resetCompleted();
    setSelectedChallengeId(challengeId);
    syncChallengeUrl(challengeId);
    setMode("challenges");
    setChallengesView("detail");
    setError(null);
    setRunNotice(null);
    try {
      await refreshLeaderboard(challengeId);
    } catch (caught) {
      setError(errorMessage(caught, "Could not load the leaderboard."));
    }
  }

  // Home's DAILY hero and Challenge Detail's "Race this" both resolve here:
  // select the target challenge and open the pre-race preview in one shot,
  // rather than relying on `selectedChallenge` already matching (Home's
  // hero specifically targets today's daily, which is often not whatever
  // challenge was last browsed elsewhere in the app). Named distinctly from
  // RaceFlow's own `raceChallenge` prop (the currently in-flight challenge)
  // to avoid confusion between the two.
  function openRacePreviewFor(challengeId: string) {
    if (challengeLockRef.current) return;
    if (!challenges.some((item) => item.id === challengeId)) return;
    setSelectedChallengeId(challengeId);
    syncChallengeUrl(challengeId);
    setRaceStage("preview");
  }

  // Home's yesterday recap card ("see full board ›") - Boards computes its
  // own Yesterday segment independently now (Increment 3 rebuild), so this
  // only needs to land on Boards with that segment pre-selected, not sync
  // any shared challenge-selection state the old v0 selector used.
  function goToBoardsFor() {
    setBoardsInitialSegment("yesterday");
    setMode("boards");
  }

  function selectMode(nextMode: ModeKey) {
    setMode(nextMode);
    // Tapping the Challenges nav item always returns to its root (Browse) -
    // Detail is reached only via a share link/back-forward, never the nav.
    if (nextMode === "challenges") setChallengesView("browse");
    // The bottom-nav Boards item is always a cold entry - Today (Open
    // Question 4) - distinct from goToBoardsFor's Yesterday-specific link.
    if (nextMode === "boards") setBoardsInitialSegment("today");
  }

  function closeChallengeDetail() {
    setChallengesView("browse");
    clearChallengeUrl();
  }

  function exitAdmin() {
    exitAdminDailiesUrl();
    setLocationVersion((version) => version + 1);
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
        // Plan-drift fix (consistent with Browse's card->Detail change): a
        // freshly created/found challenge lands on its own Detail, not Home
        // - Home's hero is always today's daily and would otherwise show no
        // trace of what was just created.
        setMode("challenges");
        setChallengesView("detail");
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

  // Increment 5 (spec: "Create-random UX... generated idempotencyKey;
  // bounded fun loading state... success → the new challenge's Detail; 429
  // ... 503 ...; Disable while in flight (no double-fire)"). Shared by
  // Browse's bottom action and the null-suggestion Play-another slot (Home
  // and Results) via one App-level busy flag/lock, mirroring
  // createChallenge/createChallengeWithSession's own auth-prompt-then-resume
  // shape exactly.
  async function createRandomChallenge() {
    if (randomChallengeLockRef.current) return;
    if (!identitySession) {
      openAuthPrompt({ type: "random-challenge" });
      return;
    }
    await createRandomChallengeWithSession(identitySession);
  }

  async function createRandomChallengeWithSession(
    sessionForRequest: VGamesIdentitySession,
  ) {
    if (randomChallengeLockRef.current) return;
    randomChallengeLockRef.current = true;
    setRandomChallengeBusy(true);
    setRandomChallengeError(null);
    try {
      const outcome = await apiClient.createRandomChallenge(sessionForRequest.token);
      const { challenge } = outcome;
      catalogRequest.current += 1;
      setChallenges((current) => getSortedChallenges([
        ...current.filter((item) => item.id !== challenge.id),
        challenge,
      ]));
      if (!challengeLockRef.current) {
        race.resetCompleted();
        setSelectedChallengeId(challenge.id);
        syncChallengeUrl(challenge.id);
        setLeaderboardProjection({ challengeId: challenge.id, rows: [] });
        setRaceStage(null);
        setMode("challenges");
        setChallengesView("detail");
      }
      setRunNotice("Found a fresh challenge for you.");
      if (!challengeLockRef.current) {
        try {
          await refreshLeaderboard(challenge.id);
        } catch (caught) {
          setError(errorMessage(caught, "Could not load the leaderboard."));
        }
      }
    } catch (caught) {
      if (isUnauthorizedError(caught)) {
        clearStaleIdentity({ type: "random-challenge" });
        return;
      }
      setRandomChallengeError(describeRandomChallengeError(toRandomChallengeFailure(caught)));
    } finally {
      randomChallengeLockRef.current = false;
      setRandomChallengeBusy(false);
    }
  }

  function exitRaceFlow(nextMode: ModeKey) {
    setRaceStage(null);
    selectMode(nextMode);
  }

  function exitCompletedRaceTo(nextMode: ModeKey) {
    race.resetCompleted();
    setDnfResult(null);
    setRaceStage(null);
    selectMode(nextMode);
  }

  // Play-another's suggestion (Home and Results) opens Challenge Detail -
  // same route as Browse's own cards (spec: "route consistent with Browse
  // cards → Detail"). From inside the race takeover this must also exit the
  // takeover first, unlike onOpenChallengeDetail (App-shell-only).
  function exitCompletedRaceToChallenge(challengeId: string) {
    race.resetCompleted();
    setDnfResult(null);
    setRaceStage(null);
    void openChallengeDetail(challengeId);
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

    // M2 fix: snapshot pre-race completions HERE, before the run starts -
    // see preRaceCompletionsRef's doc comment above.
    preRaceCompletionsRef.current = accountStats?.totals.completed ?? 0;

    setError(null);
    setRunNotice(null);
    setDnfResult(null);
    setMode("home");
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
    // A brand-new sheet-opening never carries a prior waiver forward (§2.2:
    // "cleared whenever authPrompt closes/reopens").
    setGhostGuard(null);
    setGhostGuardWaivedFor(new Set());
    setPasswordDraft("");
    setConfirmPasswordDraft("");
    if (intent.type === "switch" && intent.freshName) {
      // "Play as someone else" (spec §2.3): the old name must not pre-fill
      // the Guest form's name input.
      setDisplayNameDraft("");
    }
    if (preferredMode) {
      setAuthMode(preferredMode);
    } else {
      // FB-2 (owner decision 1b, 2026-07-19): guest-first for everyone,
      // not just returning ghosts - QF-01 had already flipped the fallback
      // to Guest for a returning ghost (a name to play under, one tap to
      // keep racing under it); this finishes the job so a brand-new
      // visitor also lands on Guest instead of the Create form. Still
      // pre-fill the username draft for a returning ghost in case they
      // tab over to Create/Log in.
      setAuthMode("guest");
      if (identitySession) {
        setUsernameDraft(suggestUsername(identitySession.displayName));
      }
    }
  }

  // Closes the sheet AND the guard together (§2.2: "waiver resets when
  // authPrompt closes/reopens") - used on every path out of the identity
  // flow (the X/backdrop close, and every success path below) so a
  // half-finished guard never survives into the next sheet-opening.
  function closeAuthPrompt() {
    setAuthPrompt(null);
    setGhostGuard(null);
    setGhostGuardWaivedFor(new Set());
  }

  async function continueAsGuest() {
    if (!authPrompt || continueAsGuestLock.current) {
      return;
    }

    continueAsGuestLock.current = true;
    try {
      const prompt = authPrompt;
      // "Play as someone else" (spec §2.3): forces a NEW guest session even
      // though `identitySession` already holds the old ghost - the existing
      // short-circuit below (reusing `nextIdentitySession = identitySession`)
      // is exactly the behavior this must bypass.
      const forceNameEntry = prompt.type === "switch" && prompt.freshName;
      // AC-1 fix: Cancel on the fresh-entry guard (confirmGhostGuardStartFreshAnyway
      // was never called) only closes the guard dialog, not the sheet
      // underneath (§2.3 layering) - without re-checking here, a typed name
      // + submit would orphan the old ghost's stakes anyway, making Cancel
      // and "Start fresh anyway" behaviorally identical. Re-interpose the
      // SAME guard at the actual point of replacement, mirroring login()'s
      // submit-time interception, so "Start fresh anyway" stays the only
      // way through.
      if (
        forceNameEntry &&
        ghostGuardRequired(identitySession, accountStats) &&
        !ghostGuardWaivedFor.has("fresh")
      ) {
        setGhostGuard({ entry: "fresh" });
        return;
      }
      let nextIdentitySession = identitySession;
      if (!nextIdentitySession || forceNameEntry) {
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
          if (forceNameEntry) {
            // Per-tab DNF memory belongs to the account that raced (§2.1) -
            // a fresh guest name must not inherit the old ghost's.
            setSessionDnfChallengeIds(new Set());
          }
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

      closeAuthPrompt();
      try {
        await resumeAfterIdentity(prompt, nextIdentitySession);
      } finally {
        setAuthBusy(false);
      }
    } finally {
      continueAsGuestLock.current = false;
    }
  }

  async function createVGamesAccount() {
    if (!authPrompt || createVGamesAccountLock.current) {
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

    createVGamesAccountLock.current = true;
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
      closeAuthPrompt();
      await resumeAfterIdentity(prompt, claimedSession);
    } catch (caught) {
      setError(vgamesIdentityErrorMessage(caught, "Could not create that VGames account."));
    } finally {
      createVGamesAccountLock.current = false;
      setAuthBusy(false);
    }
  }

  // "Honest You" (spec §2.2): the universal interception point - every
  // entry into the Log in form (You's claim-CTA "Log in", the sheet's Log
  // in tab reached from any auth-prompt intent, and the guest-form's "Log
  // in instead" link, §2.6) submits through this one function, so the
  // ghost-loss guard covers all of them for free. Only interposes on
  // SUBMIT, never on merely opening the tab.
  function login(input: LoginFormInput) {
    if (!authPrompt || loginRequestLock.current) {
      return;
    }
    if (ghostGuardRequired(identitySession, accountStats) && !ghostGuardWaivedFor.has("login")) {
      setGhostGuard({ entry: "login", pendingLogin: input });
      return;
    }
    void performLogin(input);
  }

  async function performLogin(input: LoginFormInput) {
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
      // Every login replaces the active account - a later session must
      // never inherit the previous one's per-tab DNF memory (§2.1/§2.2).
      setSessionDnfChallengeIds(new Set());
      closeAuthPrompt();
      await resumeAfterIdentity(prompt, loggedInSession);
    } catch (caught) {
      setError(vgamesIdentityErrorMessage(caught, "Could not log in."));
      // Login FAILURE (§2.2): the sheet re-opens on the Log in tab with
      // this error - `authPrompt` was never cleared, so it's already
      // showing. The guard stays waived for this entry for the rest of
      // this sheet-opening (ghostGuardWaivedFor is untouched here), so a
      // resubmit doesn't re-trigger it.
      setGhostGuard(null);
      setAuthMode("login");
    } finally {
      loginRequestLock.current = false;
      setAuthBusy(false);
    }
  }

  // Guard button 1 (§2.2/§2.3, both entries): close the guard, switch the
  // sheet to Create with password drafts cleared so a typed login password
  // never pre-fills the new-password fields - `usernameDraft` keeps its
  // `suggestUsername` prefill. `authPrompt` itself is untouched, so the
  // ORIGINAL auth-prompt intent (not the abandoned login/switch intent)
  // resumes via `resumeAfterIdentity` after a successful claim.
  function confirmGhostGuardClaimFirst() {
    setGhostGuard(null);
    setAuthMode("create");
    setPasswordDraft("");
    setConfirmPasswordDraft("");
  }

  // Guard button 2, login entry ("Log in anyway", coral - this IS the
  // destructive commit, §2.2): waive the login guard for the rest of this
  // sheet-opening FIRST, then fire immediately with the stashed
  // credentials - no re-entry.
  function confirmGhostGuardLoginAnyway() {
    if (!ghostGuard?.pendingLogin) return;
    const pendingLogin = ghostGuard.pendingLogin;
    setGhostGuardWaivedFor((current) => new Set(current).add("login"));
    setGhostGuard(null);
    void performLogin(pendingLogin);
  }

  // Guard button 2, fresh entry ("Start fresh anyway", coral, §2.3): unlike
  // the login-anyway path, this does NOT fire a network call immediately -
  // cancel-safety means the old ghost session stays untouched until a new
  // guest name is actually submitted. The sheet is already open underneath
  // the guard (on the Guest tab, forceNameEntry, opened by
  // requestPlayAsSomeoneElse below) - dismissing the guard just reveals it.
  function confirmGhostGuardStartFreshAnyway() {
    setGhostGuardWaivedFor((current) => new Set(current).add("fresh"));
    setGhostGuard(null);
  }

  // Guard button 3 (§2.2/§2.3, both entries): re-show the sheet with drafts
  // intact - drafts already live in App state, nothing to restore.
  function cancelGhostGuard() {
    setGhostGuard(null);
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

  // "Honest You" (spec §2.1, amendment 1): the shared core clearStaleIdentity
  // and `logOut` both need - local session teardown with no network call
  // (no revocation endpoint exists; bearer JWTs can't be invalidated
  // server-side, so this is local-only BY DESIGN, not a gap). Device
  // credential (`vwiki-race:vgames-device-credential`) is deliberately KEPT
  // - it's a device identifier, not a session.
  function resetIdentityState() {
    identityRepository.clearSession();
    recoveredToken.current = null;
    statsRequest.current += 1;
    setAccountStatsProjection(null);
    setIdentitySession(null);
    setDisplayNameDraft("");
    setUsernameDraft("");
    setPasswordDraft("");
    setConfirmPasswordDraft("");
    // Per-tab DNF memory belongs to the account that raced (§2.1) - a later
    // login (including a fresh guest attaching by device credential) must
    // not inherit it.
    setSessionDnfChallengeIds(new Set());
  }

  function clearStaleIdentity(intent?: AuthPromptIntent) {
    resetIdentityState();
    if (intent) {
      openAuthPrompt(intent, "login");
    }
  }

  // "Honest You" (spec §2.1, State C's "Log out"): unlike `clearStaleIdentity`,
  // this must NOT open the login prompt - it's a deliberate, player-chosen
  // exit, not a stale-session recovery. Local, synchronous, reversible
  // ("Log back in anytime") - a 2026-07-20 judge amendment cut the brief's
  // confirm-dialog hardening for exactly that reason: gating a fully
  // reversible, non-destructive action behind a modal is friction this
  // package doesn't need to add. The device-scope caveat that dialog would
  // have carried lives in this notice instead.
  function logOut() {
    resetIdentityState();
    setRunNotice("Logged out - other devices stay logged in.");
  }

  // "Honest You" (spec §2.3, State B's ghost exit): if the ghost has real
  // stakes, interpose the SAME guard dialog as login-over-ghost, with the
  // fresh-entry body/verb. Either way, this always opens the sheet on the
  // Guest tab with forceNameEntry - the guard (when shown) simply renders
  // on top of that already-open sheet (§8 layering) rather than gating the
  // open itself, so dismissing the guard costs no extra step.
  function requestPlayAsSomeoneElse() {
    openAuthPrompt({ type: "switch", freshName: true }, "guest");
    if (ghostGuardRequired(identitySession, accountStats)) {
      setGhostGuard({ entry: "fresh" });
    }
  }

  // "Honest You" (spec §2.4, State C's "Switch account"): opens straight on
  // Log in, no pre-clear (amendment 2, §9) - Cancel/close leaves the player
  // exactly as they were, still logged in. No guard: a claimed session's
  // guard predicate is always false (ghostGuardRequired requires a ghost),
  // matching "a claimed account's stats live server-side; nothing is at
  // stake."
  function requestSwitchAccount() {
    openAuthPrompt({ type: "switch", freshName: false }, "login");
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
      // Results' guest claim CTA (spec beat 3) and You's persistent claim
      // CTA: there is no pending action to resume -
      // continueAsGuest/createVGamesAccount/login already upgraded the
      // identity and persisted it. Nothing further to do.
      return;
    }

    if (prompt.type === "switch") {
      // "Honest You" (spec §2.3/§2.4): "Play as someone else"/"Switch
      // account" - the identity swap itself was the whole point, same as
      // "claim" above. Nothing further to resume.
      return;
    }

    if (prompt.type === "random-challenge") {
      await createRandomChallengeWithSession(nextIdentitySession);
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
    if (outcome.status === "completed") {
      await refreshLeaderboard(outcome.challengeId);
      bumpStatsRefresh();
    }
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
    if (outcome.status === "completed") {
      await refreshLeaderboard(outcome.challengeId);
      bumpStatsRefresh();
    }
  }

  // Forces the account-stats effect above to refetch - see its comment for
  // why this needs to reach further than just the "You" tab.
  function bumpStatsRefresh() {
    setStatsRefreshVersion((version) => version + 1);
  }

  function markSessionDnf(challengeId: string) {
    setSessionDnfChallengeIds((current) => {
      if (current.has(challengeId)) return current;
      const next = new Set(current);
      next.add(challengeId);
      return next;
    });
  }

  async function retryRecovery() {
    if (!identitySession) return;
    const outcome = await race.recoverActiveRun(challenges, identitySession.token);
    if (outcome.status === "unauthorized") {
      clearStaleIdentity();
    }
  }

  async function loadRunPath(runId: string) {
    // FB-4: disclosure is now authenticated server-side (the viewer-finished
    // guard needs a real identity) - every caller of onDisclosePath already
    // requires pathsUnlocked, which itself requires a completed run, which
    // requires a session, so this should never actually fire in practice.
    // Still, no session means nothing to disclose - fail closed, not open.
    if (!identitySession) return;
    if (requestedPaths.current.has(runId)) return;
    requestedPaths.current.add(runId);
    try {
      const path = await apiClient.getRunPath(runId, identitySession.token);
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
      // PKG-03 (council 2026-07-19): the header/board-row time mismatch
      // ("0:04" vs "0:05") traced to dnfSnapshot using the client's
      // pre-call timer reading while the eventual board row reads the
      // server's own abandoned_at-based elapsedMs. The abandon response
      // now echoes that same server value (see AbandonRunTransition's doc
      // comment) - prefer it here, in the SAME already-in-flight call,
      // rather than a later, separate leaderboard refetch (which would
      // also risk a visible number flip after the Results screen mounts).
      // Falls back to the client snapshot only if an older/legacy
      // response omitted it.
      const resolvedDnfSnapshot = dnfSnapshot && outcome.elapsedMs !== undefined
        ? { ...dnfSnapshot, elapsedMs: outcome.elapsedMs }
        : dnfSnapshot;
      if (resolvedDnfSnapshot && resolvedDnfSnapshot.clicks > 0) {
        setDnfResult(resolvedDnfSnapshot);
        setRunNotice(null);
      } else {
        setDnfResult(null);
        setRunNotice(acceptedClickCount > 0
          ? "Run ended. Your DNF and path were saved."
          : "Run ended. The attempt was saved to your stats.");
      }
      // Home's DNF sub-state (spec: "an end-run this session") - local
      // memory of it, not a server read, so Home can reflect it immediately.
      // Recovery's "End Old Run" is excluded (matches dnfSnapshot's own
      // guard above) - it's a stale/legacy run being cleared out, not "the
      // account tried and gave up on today's daily this session." FB-7
      // (owner ruling, 2026-07-19): also gated on
      // `acceptedClickCount >= MIN_COUNTED_DNF_CLICKS` - a sub-threshold
      // bail is a non-attempt and must leave Home in the FRESH state, same
      // as the server (which never surfaces a sub-threshold DNF as a board
      // row) shows on reload.
      if (endedChallengeId && !isRecoveryEnd && acceptedClickCount >= MIN_COUNTED_DNF_CLICKS) {
        markSessionDnf(endedChallengeId);
      }
      if (endedChallengeId) {
        await refreshLeaderboard(endedChallengeId);
      }
      bumpStatsRefresh();
    } else if (outcome.status === "completed") {
      setEndConfirmationOpen(false);
      setDnfResult(null);
      setRunNotice(null);
      if (endedChallengeId) {
        await refreshLeaderboard(endedChallengeId);
      }
      bumpStatsRefresh();
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

    // PKG-12 (council 2026-07-19, Judge B amendment 2): the anchor's own
    // `href` is the in-app synthetic `#article:<title>` hash rewritten by
    // rewriteArticleLinks (services/wikipediaSanitizer.ts) - there is no
    // hash router anywhere in this app, so simply skipping preventDefault
    // on a modifier/middle click would open a new tab at this app's own
    // current URL with a dead fragment, not the Wikipedia article the user
    // meant to peek at. The real source URL is captured separately in
    // data-vwiki-race-href - open that instead, and still preventDefault so
    // the in-app SPA nav (which would also cost a race click) never fires
    // alongside it.
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) {
      event.preventDefault();
      const sourceUrl = link.dataset.vwikiRaceHref;
      if (sourceUrl) {
        window.open(sourceUrl, "_blank", "noopener");
      }
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
  // QF-05: "DNF" spelled out here too, matching RaceResults' own kicker
  // ("DNF — Did not finish") - this dialog is often a first-time player's
  // first encounter with the term, before they've ever seen Results.
  const endRunConfirmCopy = endRunClickCount >= 1
    ? `It'll count as a DNF — Did not finish — with ${endRunClickCount} ${endRunClickCount === 1 ? "click" : "clicks"}.`
    : "This cannot be resumed after the server accepts it.";
  const showBanners = !authPrompt && !endConfirmationOpen;
  const bannerError = showBanners ? visibleError : null;
  const bannerNotice = showBanners ? runNotice : null;

  return (
    <main
      className="app-shell"
      aria-busy={isBusy}
    >
      {raceEngaged ? (
        <RaceFlow
          apiClient={apiClient}
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
          runId={race.run?.id ?? null}
          dnfResult={dnfResult}
          todayCentral={currentCentralDate}
          identityStatus={identitySession?.status ?? null}
          identityAccountId={identitySession?.accountId ?? null}
          identityToken={identitySession?.token ?? null}
          identityDisplayName={identitySession?.displayName ?? ""}
          preRaceCompletions={preRaceCompletionsRef.current}
          playAnotherSuggestion={playAnotherSuggestion}
          randomChallengeBusy={randomChallengeBusy}
          randomChallengeError={randomChallengeError}
          error={bannerError}
          authBusy={authBusy}
          endRunIsBlocked={endRunIsBlocked}
          onCreateRandomChallenge={() => void createRandomChallenge()}
          onOpenChallenge={(challengeId) => exitCompletedRaceToChallenge(challengeId)}
          onRetryPending={() => void retryPendingClick()}
          onRetryRecovery={() => void retryRecovery()}
          onRetryCatalog={() => setCatalogRefreshVersion((version) => version + 1)}
          onRequestEndRun={requestEndRun}
          onBackFromPreview={() => exitRaceFlow("home")}
          onSeeOtherChallengesFromPreview={() => exitRaceFlow("challenges")}
          onStartFromPreview={() => void startSelectedChallenge()}
          onPlayAgain={() => void startSelectedChallenge()}
          onShowLeaderboard={() => {
            // PKG-05 (council 2026-07-19, owner-proxy ruling): challenge-
            // aware, not a blind exit to global (daily-only) Boards - an
            // older daily or a custom challenge has no place on Boards, so
            // it routes to that challenge's own Challenge Detail leaderboard
            // instead (the same exitCompletedRaceToChallenge onOpenChallenge
            // already uses). `session` (completed) falls back to
            // `dnfResult` (DNF) - useRaceController.endRun wipes `session`
            // on a genuine abandon, so only one of the two is ever set here.
            // Same `isDailyToday` calc RaceResults' own header/board-title
            // copy uses, so the two can't independently drift.
            const racedChallenge = session?.challenge ?? dnfResult?.challenge ?? null;
            if (racedChallenge && !isDailyToday(racedChallenge, currentCentralDate)) {
              exitCompletedRaceToChallenge(racedChallenge.id);
              return;
            }
            exitCompletedRaceTo("boards");
          }}
          onShowChallenges={() => exitCompletedRaceTo("challenges")}
          onClaimIdentity={(mode) => openAuthPrompt({ type: "claim" }, mode)}
          onGoHome={() => exitCompletedRaceTo("home")}
          handleArticleClick={handleArticleClick}
          handleArticlePrewarm={handleArticlePrewarm}
        />
      ) : (
        <AppShell
          accountStats={accountStats}
          apiClient={apiClient}
          authBusy={authBusy}
          bannerError={bannerError}
          bannerNotice={bannerNotice}
          boardsInitialSegment={boardsInitialSegment}
          canManageDailies={canManageDailies}
          canNominateForDaily={identitySession?.status === "claimed"}
          challenges={challenges}
          challengesView={challengesView}
          identitySession={identitySession}
          leaderboard={leaderboard}
          mode={mode}
          onClaimIdentity={(mode) => openAuthPrompt({ type: "claim" }, mode)}
          onCloseChallengeDetail={closeChallengeDetail}
          onCreateChallenge={createChallenge}
          onCreateRandomChallenge={() => void createRandomChallenge()}
          onDisclosePath={(runId) => void loadRunPath(runId)}
          onDismissStorageNotice={() => setStorageNoticeDismissed(true)}
          onExitAdmin={exitAdmin}
          onGoToBoardsFor={goToBoardsFor}
          onLogOut={logOut}
          onOpenChallengeDetail={(challengeId) => void openChallengeDetail(challengeId)}
          onPlayAsSomeoneElse={requestPlayAsSomeoneElse}
          onRaceChallenge={openRacePreviewFor}
          onSelectMode={selectMode}
          onSwitchAccount={requestSwitchAccount}
          playAnotherSuggestion={playAnotherSuggestion}
          previewWikipediaGateway={previewWikipediaGateway}
          randomChallengeBusy={randomChallengeBusy}
          randomChallengeError={randomChallengeError}
          runPaths={runPaths}
          selectedChallenge={selectedChallenge}
          selectionLocked={challengeIsLocked}
          sessionDnfChallengeIds={sessionDnfChallengeIds}
          storageBlockedNotice={storageBlocked && !storageNoticeDismissed}
          todayCentral={currentCentralDate}
        />
      )}

      {/* "Honest You" (spec §8 "Dialog layering"): the guard and the sheet
          never render simultaneously - `ghostGuard` (when set) renders
          INSTEAD of `IdentityPrompt`, on top of the same already-open
          `authPrompt`. Cancel just nulls `ghostGuard`, which brings the
          sheet back with every draft intact. */}
      {authPrompt && ghostGuard ? (
        <GhostGuardDialog
          busy={authBusy}
          entry={ghostGuard.entry}
          name={identitySession?.displayName ?? ""}
          onCancel={cancelGhostGuard}
          onClaimFirst={confirmGhostGuardClaimFirst}
          onProceed={ghostGuard.entry === "login" ? confirmGhostGuardLoginAnyway : confirmGhostGuardStartFreshAnyway}
          returnFocusRef={identityTrigger}
        />
      ) : authPrompt ? (
        <IdentityPrompt
          authBusy={authBusy}
          authMode={authMode}
          confirmPasswordDraft={confirmPasswordDraft}
          displayNameDraft={displayNameDraft}
          displayNameIsReady={displayNameIsReady}
          forceNameEntry={forceGuestNameEntry}
          identitySession={identitySession}
          error={visibleError}
          onCreate={() => void createVGamesAccount()}
          onClose={() => {
            if (!authBusy) {
              closeAuthPrompt();
            }
          }}
          onContinueAsGuest={() => void continueAsGuest()}
          onDisplayNameChange={setDisplayNameDraft}
          onLogin={(input) => login(input)}
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
          {/* PKG-11 (council 2026-07-19): "End Run" is the sole ratified
              Title Case exception in the sentence-case sweep (RaceMode's own
              "End Run" button ships Title Case in mockup-race-flow-v3) - this
              confirm button and its recovery variant stay Title Case too,
              as the same naming family, rather than reading as a mismatched
              "Confirm end run" beside RaceMode's "End Run" trigger. */}
          {/* QF-04: coral (`.end-run-button`, matching the HUD's own
              trigger) is reserved for the commit action - "Continue run"
              stays a bare neutral button so the two are visually distinct
              at a glance instead of both defaulting to the same fill. */}
          <button
            className="end-run-button"
            disabled={modeState === "abandoning"}
            type="button"
            onClick={() => void confirmEndRun()}
          >
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
  forceNameEntry,
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
  // "Honest You" (spec §2.3): "Play as someone else" - shows the Guest
  // form's name input EVEN THOUGH a session already exists (normally
  // short-circuited to "Playing as {name}" below).
  forceNameEntry: boolean;
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
            <span className="vwiki-mark">VWiki Race</span>
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
          {authMode === "guest" ? (
            "Pick a name and go - claim it later. No email, no password."
          ) : (
            <>
              {isGhost
                ? "Turn this guest into a VGames account without losing any runs. "
                : "Create a VGames account before the timer starts. "}
              Free, no email - keeps your name and stats on every device. One
              account works across every VGames title.
            </>
          )}
        </p>

        {error ? <p role="alert">{error}</p> : null}

        {/* PKG-11 (council 2026-07-19, copy sweep): one account-verb pair
            app-wide - "Create account" / "Log in" - replacing the tab
            switcher's old "Create New"/"Log In / Existing" (and, below, the
            create form's old "Create VGames account" submit). The tab and
            its matching form's submit button now say the exact same thing
            while that mode is active (e.g. "Log in" tab + "Log in" submit) -
            a deliberate choice, not an oversight: they're structurally
            distinct (a `role="group"` mode switcher vs. a form's own
            submit), so an identical label reads as reinforcement, not
            confusion, the same way a "Log in" nav link sitting above a
            "Log in" page button does on most sites. Tests disambiguate the
            two via container scoping (`within` the switcher group vs.
            `within` the form), not by giving them different text. */}
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
            Create account
          </button>
          <button
            aria-pressed={authMode === "login"}
            disabled={authBusy}
            onClick={() => onSetAuthMode("login")}
            type="button"
          >
            Log in
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
            {!identitySession || forceNameEntry ? (
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
              disabled={authBusy || ((!identitySession || forceNameEntry) && !displayNameIsReady)}
              type="submit"
            >
              Continue as guest
            </button>
            {/* "Honest You" (spec §2.6): always rendered, regardless of
                forceNameEntry - closes the federated-player hole (a
                viota/vjaipur account holder landing on the guest-first
                default minting a throwaway duplicate ghost). Routes through
                the same universal `login()` interception point as every
                other Log in entry, so the ghost-loss guard covers this one
                too. */}
            <p className="guest-form-cross-link">
              Already have a VGames account?{" "}
              <button
                className="link-button"
                disabled={authBusy}
                onClick={() => onSetAuthMode("login")}
                type="button"
              >
                Log in instead.
              </button>
            </p>
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
              Create account
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

/**
 * "Honest You" (spec §2.2/§2.3): the ghost-loss guard - one dialog, two
 * parametrized entries (amendment 4, §9). Renders INSTEAD of `IdentityPrompt`
 * while open (§8 layering), on the same `returnFocusRef` the sheet itself
 * uses, so focus lands back on the original trigger once the whole flow
 * closes, not on some intermediate element.
 */
function GhostGuardDialog({
  busy,
  entry,
  name,
  onCancel,
  onClaimFirst,
  onProceed,
  returnFocusRef,
}: {
  busy: boolean;
  entry: "login" | "fresh";
  name: string;
  onCancel: () => void;
  onClaimFirst: () => void;
  onProceed: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const body = entry === "login"
    ? `${name}'s streak and stats live only on this device. Logging in won't bring them along - claim this name first if you want to keep them.`
    : `${name}'s streak and stats live only on this device. A new name won't bring them along - claim this name first if you want to keep them.`;
  // Copy is worst-case honest ON PURPOSE (spec §2.2): the identity design
  // spec's login ghost-fold "should" merge the device ghost, but the
  // council confirmed orphaning happens in practice - never promise
  // recovery the backend doesn't guarantee.
  const proceedLabel = entry === "login" ? "Log in anyway" : "Start fresh anyway";

  return (
    <ModalDialog
      busy={busy}
      className="ghost-guard-dialog"
      onClose={onCancel}
      returnFocusRef={returnFocusRef}
      titleId="ghost-guard-title"
    >
      <h2 id="ghost-guard-title">{`Leave ${name} behind?`}</h2>
      <p>{body}</p>
      <div className="ghost-guard-actions">
        <button disabled={busy} type="button" onClick={onClaimFirst}>
          {`Claim ${name} first`}
        </button>
        {/* This IS the destructive commit - coral, matching the end-run
            dialog grammar (§2.2). */}
        <button className="end-run-button" disabled={busy} type="button" onClick={onProceed}>
          {proceedLabel}
        </button>
        <button className="link-button" disabled={busy} type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </ModalDialog>
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

function errorMessage(caught: unknown, fallback: string): string {
  return caught instanceof Error ? caught.message : fallback;
}

/**
 * Extracts the plain primitives `describeRandomChallengeError` (a pure
 * domain function, no src/services dependency) needs from a caught
 * `ApiRequestError` - the one place in App.tsx that reaches into the error
 * class itself for this particular flow.
 */
function toRandomChallengeFailure(caught: unknown): {
  status: number | null;
  message: string;
  retryAfterSeconds: number | null;
} {
  if (caught instanceof ApiRequestError) {
    return {
      status: caught.status,
      message: caught.message,
      retryAfterSeconds: caught.retryAfterMs !== null ? Math.ceil(caught.retryAfterMs / 1000) : null,
    };
  }
  return { status: null, message: errorMessage(caught, ""), retryAfterSeconds: null };
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
