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
  CatalogStatus,
  Challenge,
  RankedLeaderboardRow,
  ServerPathStep,
} from "./domain/types";
import {
  createVGamesIdentityClient,
  createVGamesIdentityRepository,
  isAccountAlreadySecuredFailure,
  isIdentityConnectivityFailure,
  vgamesIdentityErrorCode,
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
import { resolveApiOrigin } from "./services/apiOrigin";
import { apiErrorCode, createErrorReporter, type ErrorReporter } from "./services/errorReporting";
// FB-7 (owner ruling, 2026-07-19): shared with the server's DNF eligibility
// threshold - see MIN_COUNTED_DNF_CLICKS's doc comment in runProtocol.ts.
import { MIN_COUNTED_DNF_CLICKS } from "./server/runProtocol";
import {
  clearChallengeUrl,
  exitAdminDailiesUrl,
  isAdminDailiesRoute,
  isInAppHistoryState,
  readChallengeIdFromUrl,
  syncChallengeUrl,
} from "./services/urlRouting";
import { createWikipediaGateway } from "./services/wikipediaGateway";
import { ApiRequestError } from "./services/apiRequest";
import { useRaceController } from "./hooks/useRaceController";
import { useNavigationIntents } from "./hooks/useNavigationIntents";
import { useTargetPreview } from "./hooks/useTargetPreview";
import { useMeasuredHeight } from "./hooks/useMeasuredHeight";
import { deriveScreen } from "./race/deriveScreen";
import RaceFlow from "./race/RaceFlow";
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
  // LR-2: reused for the identity retry ladder's exhaustion telemetry (see
  // reportIdentityStall below) - defaults to a real beacon reporter so
  // production always names its own stalls; main.tsx injects the SAME
  // instance it already built for ErrorBoundary rather than standing up a
  // second one. Widened (this package) to also cover reportVisibleError -
  // every HANDLED error this file renders to a player now beacons through
  // the SAME instance, not a second reporter.
  errorReporter?: Pick<ErrorReporter, "report" | "reportVisibleError">;
}

type AuthMode = "guest" | "create" | "login";
interface LoginFormInput {
  username: string;
  password: string;
}
// RC-06 ("one honest loading/error system"): `status` is the fetch tri-state
// for THIS challenge's leaderboard - "error" is what lets Challenge Detail's
// "Your history" strip tell a genuine failure apart from "you haven't tried
// this one yet." instead of silently reusing the empty-rows shape for both
// (Changes item 2 / Judge B amendment 2's "vanishing global banner" fix).
type LeaderboardFetchStatus = "loading" | "error" | "ready";
interface LeaderboardProjection {
  challengeId: string;
  rows: RankedLeaderboardRow[];
  status: LeaderboardFetchStatus;
  // Pre-existing house convention this package must not regress (proven by
  // two already-shipped App.test.tsx cases): a MEANINGFUL server error (e.g.
  // "Leaderboard unavailable.") is shown verbatim via the shared
  // errorMessage() helper below, which only ever substitutes a generic
  // fallback for the genuinely-uninformative internal_error catch-all - so
  // "error" status alone isn't enough for Detail's "Your history" copy;
  // this carries what to actually say. `null` outside "error" status.
  message: string | null;
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
// LR-2: mirrors the other services' own default-origin resolution
// (vgamesIdentity.ts/vwikiRaceApiClient.ts) - only exercised when a caller
// doesn't inject its own errorReporter (main.tsx always does, reusing the
// one instance it already built for ErrorBoundary).
const DEFAULT_API_ORIGIN = resolveApiOrigin(import.meta.env.VITE_VWIKI_RACE_API_URL, {
  production: import.meta.env.PROD,
});

// LR-2: 0 = no retry yet (idle/first-attempt busy copy), 1 = the ladder's
// first retry is in flight ("Still connecting..."), 2 = its second and
// final retry is in flight ("Almost there - retrying..."). Shared by every
// identity flow's button copy (login/guest/create) so a stall reads the
// same way wherever it happens. Plain `number` (not a 0|1|2 literal union)
// so it can be set directly from an IdentityRetryHooks.onRetry callback's
// `attempt` ordinal without a cast.
type IdentityRetryStage = number;

function identityRetryStageLabel(stage: IdentityRetryStage, idleBusyLabel: string): string {
  if (stage === 1) return "Still connecting...";
  if (stage === 2) return "Almost there — retrying...";
  return idleBusyLabel;
}

/**
 * LR-2 telemetry ("so the next stall names itself"): when an identity
 * flow's retry ladder exhausts on a connectivity-class failure (never a
 * real answer like bad credentials or a taken username - see
 * isIdentityConnectivityFailure), beacon it through the EXISTING
 * /api/client-error reporter with the ladder's own attempt timings, so a
 * live burst shows up in Workers Logs instead of requiring another owner
 * screenshot. A no-op for any other kind of failure.
 */
function reportIdentityStall(
  errorReporter: Pick<ErrorReporter, "report">,
  flow: "login" | "guest" | "create",
  caught: unknown,
  retryAtMs: number[],
  totalMs: number,
): void {
  if (!isIdentityConnectivityFailure(caught)) {
    return;
  }
  errorReporter.report("manual", caught, {
    detail:
      `identity-retry-ladder flow=${flow} attempts=${retryAtMs.length + 1} ` +
      `retryAtMs=[${retryAtMs.join(",")}] totalMs=${Math.round(totalMs)}`,
  });
}

/**
 * Beacons the identity-sheet's own rendered error line (whatever
 * vgamesIdentityErrorMessage just computed for `setError`) - the gap
 * reportIdentityStall above doesn't cover, since that one only fires for a
 * connectivity-class exhaustion. Every OTHER code (not_ghost reaching here,
 * an unmapped/internal_error response, ...) is exactly the kind of thing a
 * report requires guessing about today; reportVisibleError's own surface
 * allowlist (errorReporting.ts) still suppresses the genuinely-expected
 * validation codes (bad credentials, a taken username) so this never turns
 * ordinary user mistakes into noise.
 */
function reportVisibleIdentityError(
  errorReporter: Pick<ErrorReporter, "reportVisibleError">,
  flow: "login" | "guest" | "create",
  caught: unknown,
  message: string,
  accountId: string | null | undefined,
): void {
  errorReporter.reportVisibleError("identity-sheet", vgamesIdentityErrorCode(caught), message, {
    flow,
    accountId: accountId ?? undefined,
  });
}

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

/**
 * Companion to readCachedIdentitySession above, for the name-draft
 * initializer: the last display name any session on this device played
 * under, which survives clearSession() by design (see
 * VGamesIdentityRepository.getLastDisplayName). Lets a cold boot with NO
 * live session - e.g. a stale token was wiped in a previous visit - still
 * open the guest form prefilled with the name the device's ghost is already
 * known by server-side, instead of a blank input that reads as "the app
 * forgot me."
 */
function readCachedLastDisplayName(
  storage: StorageLike | undefined,
  injectedIdentityRepository: VGamesIdentityRepository | undefined,
): string | null {
  const resolvedStorage = storage ?? readBrowserStorage();
  const repository = injectedIdentityRepository ?? createVGamesIdentityRepository(resolvedStorage);
  return repository.getLastDisplayName();
}

/**
 * RC-03 (Judge B amendment 5, the lower-risk third option): content
 * equality for the fields that actually matter to the app, not object
 * identity. `readCachedIdentitySession` above builds a THROWAWAY repository
 * per lazy useState initializer (three separate ones at mount, one per
 * initializer), and the real memoized `identityRepository` used everywhere
 * else is a FOURTH, independent instance - each one's own `getSession()`
 * re-parses storage into a brand-new object, so two calls a tick apart are
 * deeply equal but never reference-equal. The post-mount resync effect
 * below used to compare by reference and so treated that as a genuine
 * change every time, cascading a second capabilities/suggestion/stats fetch
 * on every cold load with a cached identity even though nothing changed.
 */
function identitySessionsEqual(
  a: VGamesIdentitySession | null,
  b: VGamesIdentitySession | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.accountId === b.accountId &&
    a.token === b.token &&
    a.displayName === b.displayName &&
    a.status === b.status;
}

// RC-10 (change 2): capabilities/stats/play-another-suggestion are all
// non-gating background reads (nothing on the critical guest-continue path
// awaits them - see deriveScreen.ts, which never consults canManageDailies/
// accountStats/playAnotherSuggestion) that today fire in the same tick as
// every OTHER boot-time request (catalog, recovery's own active-run check).
// On a throttled mobile CPU, that pile-up competes with the recovery ->
// race-start article render for main-thread time right when it matters
// most. Yielding one idle turn (native requestIdleCallback; a same-macrotask
// setTimeout fallback everywhere else - jsdom under test included, per this
// package's own "requestIdleCallback with setTimeout fallback" instruction)
// costs nothing when the thread is already idle (the common non-recovery
// boot) and lets a real in-flight paint finish first when it isn't. Judge A
// amendment 2 (owner-proxy ruling): this is kept as a reasonable background-
// work hygiene change, explicitly NOT relied upon to hit the p95<=3.5s
// guest-continue acceptance number - see RC-10's package notes.
function scheduleBackgroundWork(callback: () => void): () => void {
  const idleScheduler = (globalThis as {
    requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  }).requestIdleCallback;
  if (typeof idleScheduler === "function") {
    // Cleanup pass: an unbounded requestIdleCallback can starve indefinitely
    // on a sustained-busy main thread, silently delaying
    // capabilities/stats/play-another-suggestion well past the point this
    // was ever meant to defer them. 1500ms caps that wait - long enough to
    // yield to a genuinely idle-soon thread (the common case this exists
    // for), short enough that a busy thread still gets this work forced
    // through in a bounded window rather than never.
    const handle = idleScheduler(callback, { timeout: 1500 });
    return () => {
      (globalThis as { cancelIdleCallback?: (handle: number) => void })
        .cancelIdleCallback?.(handle);
    };
  }
  const timeout = setTimeout(callback, 0);
  return () => clearTimeout(timeout);
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
  errorReporter: injectedErrorReporter,
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
  // LR-2: which rung of the login retry ladder is in flight (0 = none) -
  // drives the honest "Still connecting..."/"Almost there - retrying..."
  // button copy so a slow first attempt never reads as a silent hang.
  const [authRetryAttempt, setAuthRetryAttempt] = useState<IdentityRetryStage>(0);
  // Same idea for continueAsGuest's and createVGamesAccount's own (fully or
  // partially laddered - see vgamesIdentity.ts) identity calls.
  const [guestRetryAttempt, setGuestRetryAttempt] = useState<IdentityRetryStage>(0);
  const [createRetryAttempt, setCreateRetryAttempt] = useState<IdentityRetryStage>(0);
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
    () => readCachedIdentitySession(storage, injectedIdentityRepository)?.displayName ??
      readCachedLastDisplayName(storage, injectedIdentityRepository) ?? "",
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
  // RC-06 ("one honest loading/error system", Judge B amendment 1 - the
  // GHOST-GUARD COLLISION fix): a status SEPARATE from `accountStatsProjection`
  // itself, purely for You.tsx's tri-state display. `ghostGuardRequired`/
  // `guestHasStakes`/the teaching gate/the at-risk nav dot all read the
  // DERIVED `accountStats` value below and treat `null` as "unresolved, fail
  // closed" by explicit design - this status must never feed back into that
  // derivation (no "last-known-value" leak into the one variable those
  // guards trust). It's derived, not independently tracked: "ready" whenever
  // `accountStats` itself is non-null (including a background
  // stale-while-revalidate refetch already in flight - RC-04's "never blank
  // live UI" promise stays intact for You's numbers too), else whatever the
  // fetch effect below most recently observed for a null result.
  const [accountStatsFetchStatus, setAccountStatsFetchStatus] =
    useState<"loading" | "error">("loading");
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
  // RC-03: the very first run of the catalog-load effect below is a plain
  // cold-load read (happy to reuse a cache, though there's nothing to reuse
  // yet) - every SUBSEQUENT run was asked for on purpose, either by
  // `queueCatalogRefresh` (window focus, `visibilitychange`-to-visible, AND
  // the 5:00 AM Central daily-drop timer all funnel through that one
  // callback - see its own comment) bumping `catalogRefreshVersion`, or by
  // `currentCentralDate` itself changing. Either way, "please check for
  // updates now" is exactly the signal `listChallenges`'s `force` option
  // exists for - a 60s-stale catalog silently sitting through a real daily
  // drop would defeat the self-heal these triggers exist to provide.
  const initialCatalogLoadRef = useRef(true);
  const leaderboardRequest = useRef(0);
  const statsRequest = useRef(0);
  const suggestionRequest = useRef(0);
  // RC-04 (stale-while-revalidate): the identity token each effect last
  // fetched FOR - not just "did `identitySession` change reference"
  // (identitySessionsEqual already lets a content-identical cached-session
  // re-read through unchanged, but a real display-name update on the SAME
  // account still produces a new `identitySession` object). Only an actual
  // token change (login/switch/logout) is the correctness-bug case where
  // stale numbers must be cleared; every other retrigger - a
  // `statsRefreshVersion` bump after a race ends, or a benign session
  // content refresh - keeps last-good data on screen while revalidating.
  const statsIdentityTokenRef = useRef<string | null>(null);
  const suggestionIdentityTokenRef = useRef<string | null>(null);
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
  // RC-04: latest-ref mirror of `selectedChallengeId`, assigned
  // unconditionally in the render body below (never only from inside the
  // catalog effect) - selection also changes via openChallengeDetail,
  // openRacePreviewFor, the popstate handler, and the locked-challenge pin
  // effect, all of which bypass the catalog effect entirely. An
  // effect-local copy would go stale the moment any of those fire, and the
  // catalog effect's own "did the id actually change" comparison below
  // would then see a spurious mismatch against a selection the player
  // already navigated to/from.
  const selectedChallengeIdRef = useRef<string | null>(null);
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
  const errorReporter = useMemo(
    () =>
      injectedErrorReporter ??
      createErrorReporter({ apiOrigin: apiOrigin ?? DEFAULT_API_ORIGIN, fetchImpl }),
    [apiOrigin, fetchImpl, injectedErrorReporter],
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
  const race = useRaceController({ apiClient, gateway: wikipediaGateway, now, errorReporter });
  const modeState = race.phase;
  const session = race.session;
  const article = race.article;
  const pendingNavigationTitle = race.pendingNavigationTitle;
  const navigationRetrying = race.navigationRetrying;
  const challengeIsLocked =
    ["preparing", "active", "syncing", "abandoning"].includes(race.phase) ||
    Boolean(race.recoveryRun);
  const startIsLocked =
    !["idle", "completed"].includes(race.phase) || Boolean(race.recoveryRun);
  challengeLockRef.current = challengeIsLocked;
  startLockRef.current = startIsLocked;
  selectedChallengeIdRef.current = selectedChallengeId;
  // RC-07 Step 3: the single place owning the "?challenge= iff Detail-or-
  // locked-race"/Back-ladder-depth invariants for every app-initiated
  // navigation - see useNavigationIntents.ts's own doc comment for the
  // full call-site inventory (migrated vs. deliberately deferred).
  const nav = useNavigationIntents({
    challengeLockRef,
    setMode,
    setChallengesView,
    setBoardsInitialSegment,
    setRaceStage,
  });
  // RC-01: one explicit catalog-readiness signal for Home/AppShell, derived
  // from the existing catalogLoadFailed flag plus challenges.length.
  // 'ready' takes precedence whenever there IS a usable catalog - critical,
  // because catalogRefreshVersion is bumped by window focus,
  // visibilitychange-to-visible, AND the daily-drop-boundary timer above,
  // all silently re-running the SAME catalog effect in the background. A
  // transient failure on one of those refetches sets catalogLoadFailed=true
  // even when `challenges` still holds perfectly good data from the prior
  // successful load (setChallenges is never cleared/rolled back on a later
  // failure) - the naive `catalogLoadFailed ? 'failed' : ...` ordering would
  // pop a spurious "couldn't load, Retry" banner across every tab while the
  // app is actually working fine. Only reads 'failed' once the catalog is
  // genuinely empty AND the load attempt errored; otherwise 'loading' until
  // the first pass settles either way.
  const catalogStatus: CatalogStatus = challenges.length > 0
    ? "ready"
    : catalogLoadFailed
      ? "failed"
      : "loading";
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
  // RC-07 Step 1: one precomputed screen selector replaces the old
  // `raceEngaged` boolean (full-screen, zero-chrome race-flow takeover -
  // spec: "Race flow" section) AND RaceFlow's own internal 7-branch
  // if/else-if ladder - see deriveScreen.ts's doc comment for the full
  // precedence table this preserves verbatim.
  const screen = deriveScreen({
    raceStage,
    racePhase: race.phase,
    recoveryRun: race.recoveryRun,
    hasSession: Boolean(race.session),
    dnfResult: race.dnfResult,
    recoveryGatePending,
  });

  const selectedChallenge =
    challenges.find((challenge) => challenge.id === selectedChallengeId) ??
    challenges[0] ??
    null;
  const currentCentralDate = todayUtc();
  // RC-10 (change 3): used to be `modeState === "idle" && !race.recoveryRun`
  // - true (and firing a full-parse Wikipedia fetch) for the ENTIRE time a
  // challenge is selected while idle, i.e. every ordinary Home/Browse/
  // Detail/You landing, long before the player has shown any intent to
  // actually see the target. `raceStage === "preview"` is the moment that
  // intent becomes real: Home's hero, Browse's cards, and Challenge Detail's
  // "Race this" all resolve through the SAME `openRacePreviewFor`/nav path
  // (see its own doc comment) to get here, and `raceStage` clears itself the
  // instant an actual run starts (the effect just below this file's earlier
  // `raceStage`-clearing block) - so this fetch now only ever runs for the
  // full-screen pre-race preview beat that actually renders the blurb
  // (PreRacePreview) or the in-race Target chip's popover (RaceMode, which
  // reads this same frozen "ready" state - see useTargetPreview's own
  // disabled-but-retains-ready-state guard). `!race.recoveryRun` is kept
  // for defense in depth even though `raceStage` and a recovery run are
  // already mutually exclusive in deriveScreen's precedence table.
  const targetPreview = useTargetPreview({
    challenge: selectedChallenge,
    enabled: raceStage === "preview" && !race.recoveryRun,
    gateway: previewWikipediaGateway,
  });
  const leaderboard = !challengeIsLocked && selectedChallenge &&
      leaderboardProjection?.challengeId === selectedChallenge.id
    ? leaderboardProjection.rows
    : [];
  // RC-06: the exact same gate `leaderboard` above uses (kept as its own
  // inline condition, not hoisted to a shared boolean, so TS's narrowing of
  // `leaderboardProjection` stays intact in both) - Challenge Detail's "Your
  // history" tri-state reads "loading" for every case `leaderboard` itself
  // reads `[]` for a reason OTHER than a genuine empty result (a locked
  // race, a not-yet-matching selection), not just a real in-flight fetch.
  const leaderboardStatus: LeaderboardFetchStatus = !challengeIsLocked && selectedChallenge &&
      leaderboardProjection?.challengeId === selectedChallenge.id
    ? leaderboardProjection.status
    : "loading";
  // RC-06: the specific server message for the "error" status above (house
  // convention: a meaningful message like "Leaderboard unavailable." shows
  // verbatim; only a generic internal_error gets a friendly fallback - see
  // errorMessage()) - `null` whenever `leaderboardStatus` isn't "error".
  const leaderboardErrorMessage: string | null = !challengeIsLocked && selectedChallenge &&
      leaderboardProjection?.challengeId === selectedChallenge.id
    ? leaderboardProjection.message
    : null;
  const accountStats = identitySession &&
      accountStatsProjection?.token === identitySession.token
    ? accountStatsProjection.stats
    : null;
  // RC-06 (Judge B amendment 1): derived from `accountStats` itself, not
  // tracked independently - "ready" whenever there's real data to show
  // (including mid-background-revalidate, so You's numbers never flash back
  // to a loading treatment the moment a race ends and this refetches),
  // otherwise the raw fetch-effect signal for what a null `accountStats`
  // actually means right now. Never read by ghostGuardRequired/
  // guestHasStakes/the teaching gate/the at-risk dot - those all consume
  // `accountStats` directly, unchanged.
  const accountStatsStatus: "loading" | "error" | "ready" =
    accountStats !== null ? "ready" : accountStatsFetchStatus;
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
  // this.
  //
  // RC-03 (Judge B amendment 5): on a perfectly ordinary cold mount (no
  // repository swap at all), `identityRepository.getSession()` here still
  // returns a REFERENTIALLY NEW object - a plain re-parse of the exact same
  // storage value the lazy initializers above already read into
  // `identitySession`. Calling the setters below unconditionally used to
  // treat that as a genuine change every render-cycle, which cascaded a
  // second capabilities/suggestion/stats fetch effect run right after
  // mount (every `identitySession`-keyed effect depends on it by
  // reference). The `identitySessionsEqual` guard makes this a true no-op
  // whenever the cached session is unchanged BY CONTENT, so it only
  // actually updates state on a real swap - deliberately NOT added to the
  // dependency array below (that would change what re-triggers this effect
  // entirely, and risk the mount-time hook ordering the recovery gate
  // depends on being synchronously true on first render - see
  // `readCachedIdentitySession`'s doc comment).
  useEffect(() => {
    const cachedSession = identityRepository.getSession();
    if (cachedSession && identitySessionsEqual(cachedSession, identitySession)) {
      return;
    }
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
    // RC-10 (change 2): non-gating (only the admin route reads this) -
    // see scheduleBackgroundWork's doc comment.
    const cancelSchedule = scheduleBackgroundWork(() => {
      if (cancelled) return;
      void apiClient.getCapabilities(identitySession.token)
        .then((capabilities) => {
          if (!cancelled) setCanManageDailies(capabilities.canManageDailies);
        })
        .catch(() => {
          if (!cancelled) setCanManageDailies(false);
        });
    });

    return () => {
      cancelled = true;
      cancelSchedule();
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
    // See initialCatalogLoadRef's own comment: only the very first run of
    // this effect gets to reuse a cached catalog - every later run (focus/
    // visibilitychange/5am-drop via queueCatalogRefresh, or a bare
    // currentCentralDate change) forces a fresh read.
    const force = !initialCatalogLoadRef.current;
    initialCatalogLoadRef.current = false;

    async function loadChallengeCatalog() {
      setError(null);
      let challengesLoaded = false;
      try {
        const nextChallenges = await apiClient.listChallenges({ force });
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
        const nextChallengeId = nextChallenge?.id ?? null;
        // RC-04 (stale-while-revalidate): this whole effect re-runs on
        // every background catalog refresh (focus/visibilitychange/5am-drop
        // via queueCatalogRefresh) - the common case is the SAME resolved
        // challenge as before. Only touch selection/leaderboard state when
        // the id actually changed, so an already-populated leaderboard
        // keeps rendering its last-good rows instead of blanking to `[]`
        // while the fresh `listLeaderboard` call further down is in
        // flight - it still swaps atomically once that resolves,
        // unconditionally, regardless of this guard. Also skip
        // re-selection entirely whenever a race is locked in
        // (challengeLockRef.current) - even an id CHANGE here must not
        // touch selectedChallengeId mid-race: the freshly refetched catalog
        // can occasionally miss the currently-locked challenge (an
        // isActive flip, a catalog window/pagination edge), and
        // re-selecting under it would feed a wrong-id frame into
        // useTargetPreview, resetting an already-ready preview back to "not
        // ready" (state-machine#6) - the locked-challenge pin effect below
        // is the one place that owns selection during a lock. The
        // URL-sync block right after this still runs unconditionally off
        // `nextChallenge` itself - it's idempotent and load-bearing for the
        // B1 invariant, and must not be swallowed by this short-circuit.
        if (!challengeLockRef.current && nextChallengeId !== selectedChallengeIdRef.current) {
          setSelectedChallengeId(nextChallengeId);
          setLeaderboardProjection(nextChallenge
            ? { challengeId: nextChallenge.id, rows: [], status: "loading", message: null }
            : null);
        }
        const requestedIdHonored = Boolean(
          requestedChallengeId && nextChallenge && requestedChallengeId === nextChallenge.id,
        );
        if (nextChallenge && race.phase === "idle" && requestedIdHonored) {
          syncChallengeUrl(nextChallenge.id, "replace");
        } else if (requestedChallengeId && race.phase === "idle") {
          // Owner-approved URL policy (GRACEFUL DEGRADE): a ?challenge= that
          // no longer resolves to a real, active challenge - expired,
          // deactivated, or simply mistyped - degrades to Home instead of
          // dangling. Replace-clear it so the address bar matches what's
          // actually on screen; old links never error, they just self-heal.
          // Leaves the in-app Back-ladder marker (item 8) unset - this
          // lands on Home, not a step away from it.
          clearChallengeUrl("replace");
        }
        // Migration note (iv): a challenge share link opens Challenges mode
        // -> Detail for that id. A plain load (no ?challenge=, or one that
        // doesn't match a real challenge) is unaffected - Home keeps
        // showing today's daily exactly as before.
        //
        // B1 fix (owner-approved URL policy): this used to also replace-sync
        // the URL to /?challenge=<daily-id> whenever the resolved challenge
        // simply happened to be today's daily, honored request or not - the
        // single root cause of every reported symptom (a second refresh
        // dumping the player into Detail, a bottom-nav tap leaking the param
        // back in after a refresh, a stale tab self-syncing to yesterday's
        // board forever). The rule is now the plain invariant this file
        // enforces everywhere: ?challenge= sits in the address bar if and
        // only if the player is on that challenge's own Detail (or a
        // locked/recovering race) - so this effect only ever WRITES the URL
        // when an explicit request was honored above, never merely because
        // the selected challenge is a daily. initialUrlRouteApplied still
        // latches on the very FIRST catalog pass, whether or not that pass
        // honored a requested id - not just inside the branch that does - so
        // a later focus/visibilitychange-triggered catalog refresh can't
        // re-read a since-changed URL and force-navigate to Challenges ->
        // Detail out from under whatever the player is doing, including
        // mid-race, under an active takeover.
        if (!initialUrlRouteApplied.current) {
          initialUrlRouteApplied.current = true;
          if (requestedIdHonored) {
            setMode("challenges");
            setChallengesView("detail");
          }
        }
        if (nextChallenge) {
          const leaderboardGeneration = ++leaderboardRequest.current;
          // RC-06: this piggyback leaderboard read gets its OWN try/catch,
          // separate from the outer one below - a failure here is a
          // leaderboard problem, not a catalog problem, and used to
          // misreport as "Could not load challenges." in the global banner
          // while leaving `leaderboardProjection` stuck at `status:
          // "loading"` forever (a worse regression than the bug this
          // package fixes: an eternal, un-retriable "Loading…").
          try {
            const nextLeaderboard = await apiClient.listLeaderboard(nextChallenge.id);
            if (
              !cancelled &&
              request === catalogRequest.current &&
              leaderboardGeneration === leaderboardRequest.current
            ) {
              setLeaderboardProjection({
                challengeId: nextChallenge.id,
                rows: nextLeaderboard,
                status: "ready",
                message: null,
              });
            }
          } catch (caught) {
            if (
              !cancelled &&
              request === catalogRequest.current &&
              leaderboardGeneration === leaderboardRequest.current
            ) {
              const message = errorMessage(caught, "Couldn't load your history.");
              errorReporter.reportVisibleError("leaderboard", apiErrorCode(caught), message, {
                accountId: identitySession?.accountId,
              });
              setLeaderboardProjection({
                challengeId: nextChallenge.id,
                rows: [],
                status: "error",
                message,
              });
            }
          }
        }
      } catch (caught) {
        if (!cancelled && request === catalogRequest.current) {
          const message = errorMessage(caught, "Could not load challenges.");
          errorReporter.reportVisibleError("catalog", apiErrorCode(caught), message, {
            accountId: identitySession?.accountId,
          });
          setError(message);
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
    nav.pinLockedChallenge(lockedChallenge.id);
  }, [challengeIsLocked, challenges, nav, race.challenge, race.recoveryRun]);

  // RC-07 Step 3 (Judge B amend 5): subscribes to `popstate` ONCE for the
  // component's whole lifetime instead of re-subscribing on every
  // dependency change (the old effect's dependency array churned on nearly
  // every render). The handler itself is rebuilt fresh on EVERY render and
  // stashed in a ref (a plain assignment during render, not inside an
  // effect - the same established pattern as challengeLockRef/startLockRef
  // above), so it always closes over the CURRENT mode/challenges/race
  // snapshot without ever needing to resubscribe. This is the standard
  // "latest ref" callback pattern, deliberately chosen over a bare ref that
  // ISN'T rebuilt every render, to avoid the exact stale-closure failure
  // mode that produced the original B1 focus-yank family (see
  // "reacts to the CURRENT state, not state captured at mount" in
  // App.test.tsx for a regression test exercising this across multiple
  // transitions without a remount).
  const popstateHandlerRef = useRef<() => void>(() => {});
  popstateHandlerRef.current = () => {
    // Forces a re-render even on branches below that don't otherwise
    // touch state (e.g. entering/leaving /admin/dailies), so AppShell's
    // own isAdminDailiesRoute() read - and every other read of
    // window.location during this render - reflects the URL popstate
    // just navigated to. pushState/replaceState never trigger React on
    // their own.
    setLocationVersion((version) => version + 1);
    if (race.phase === "idle" && race.dnfResult) {
      // Judge B amend 6: Back pressed while a DNF Results screen is
      // showing was previously undefined - phase idle + dnfResult set
      // isn't part of the locked-race pin's `challengeIsLocked` boolean,
      // so a physical Back press used to silently rewrite mode/view state
      // underneath a screen that never itself reacted (a live instance of
      // the "weird, unrecoverable screen" complaint). Defined behavior:
      // Back exits the DNF Results screen to Home, the same destination
      // its own low-emphasis "Home" link already offers.
      race.resetCompleted();
      nav.goHome();
      return;
    }
    const lockedChallengeId = race.challenge?.id ?? race.recoveryRun?.challengeId ?? selectedChallengeId;
    if (challengeIsLocked) {
      if (lockedChallengeId) nav.pinLockedChallenge(lockedChallengeId);
      return;
    }
    if (isAdminDailiesRoute()) {
      setError(null);
      return;
    }
    const requestedId = readChallengeIdFromUrl();
    const requested = challenges.find((challenge) => challenge.id === requestedId);
    if (!requested) {
      // Owner-approved URL policy (PUSH/REPLACE DISCIPLINE): Detail's
      // entry and its paired "<- Challenges" close both push, so a Back
      // step landing on a URL with no resolvable challenge id is Back OUT
      // of Detail - close it so the view visibly follows the URL instead
      // of silently no-opping and leaving Detail stranded on screen.
      //
      // Owner-approved Back ladder (item 8): exactly one demotion per
      // physical Back press - close Detail first if it's open (above);
      // only demote mode to Home on a LATER press, once Detail is already
      // closed, so "Detail -> Browse -> Home" costs two presses, not one.
      // Home itself is never touched here (mode === "home" already means
      // there's nothing left for this handler to do - Back from Home is
      // untouched/no-op on our end, matching "no back-trapping"). This
      // branch is REACTING to a URL the browser already changed - unlike
      // nav's own intents, it deliberately never re-writes history itself.
      const wasDetail = challengesView === "detail";
      const wasHome = mode === "home";
      if (wasDetail) {
        setChallengesView("browse");
      } else {
        if (!wasHome) setMode("home");
        // Adversarial-review fix (2026-07-21, finding 2): this branch is
        // the ladder's terminal rung - after it runs, the player is at
        // Home (whether this press just got them there, or they were
        // already there and this was the "browser-default, no back-
        // trapping" no-op press). A Detail open/close cycle earlier in
        // the session can still leave an extra depth-1 rung sitting
        // directly beneath wherever the player was, separate from the
        // one that just got replaced in place - each such leftover rung
        // used to cost the player one more SILENT Back press (no visible
        // change) before they could actually exit, worse than having no
        // ladder at all. If the entry we just landed on is still one of
        // OUR marked rungs (never the true Home floor, which is
        // unmarked, and never a share-link's own single entry - see the
        // "accepted as-is" note on markInAppMode), chain one more
        // programmatic Back to collapse it immediately, so this single
        // physical press eats every leftover rung in one go and the
        // NEXT physical Back press genuinely exits.
        if (isInAppHistoryState()) {
          window.history.back();
        }
      }
      return;
    }
    race.resetCompleted();
    setSelectedChallengeId(requested.id);
    // Migration note (iv): back/forward through a challenge share link
    // lands on Detail, same as the initial load. Routed through
    // nav.openDetail for consistency with every other Detail arrival -
    // its own syncChallengeUrl call is a guaranteed no-op here (the
    // browser already navigated the address bar to this exact URL).
    nav.openDetail(requested.id);
    setError(null);
    // RC-06 (Judge B amendment 2): Detail's own inline leaderboard tri-state
    // (leaderboardStatus) owns a failure here now too - no global banner.
    void refreshLeaderboard(requested.id).catch(() => {});
  };

  useEffect(() => {
    const onPopState = () => popstateHandlerRef.current();
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

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
    // RC-04: only blank the on-screen stats when this fetch is for a
    // DIFFERENT identity than the last one this effect fetched for (a
    // real login/switch, or the initial cold load) - the correctness-bug
    // case where stale numbers from a different account must never show.
    // A `statsRefreshVersion` bump for the SAME token (a race just ended)
    // revalidates in the background and swaps the totals in atomically on
    // success, leaving the previous numbers on screen until then.
    const identityChanged = statsIdentityTokenRef.current !== token;
    statsIdentityTokenRef.current = token;
    if (identityChanged) {
      setAccountStatsProjection({ token, stats: null });
    }
    // RC-06: "loading" at the start of every run, including a background
    // same-token revalidate - harmless there, since You.tsx only ever
    // consults this status once `accountStats` itself reads null (see its
    // own doc comment above); a revalidate with good data already on screen
    // never surfaces it. A Retry tap (bumps statsRefreshVersion from the
    // "error" state) needs this to flip visibly back to "loading" too.
    setAccountStatsFetchStatus("loading");
    // RC-10 (change 2, scope note): deliberately NOT wrapped in
    // scheduleBackgroundWork, unlike capabilities/suggestion below - a real
    // CPU-throttle repro (see RC-10 package notes / Judge A amendment 2)
    // found this specific deferral isn't needed for the acceptance target
    // and, on closer look, this effect's 401 path (clearStaleIdentity, right
    // below) sits upstream of the recovery-effect's own
    // recoveredToken.current-vs-identitySession guard (the recovery effect a
    // little above this one) - adding even one extra macrotask of delay here
    // opens a window for that guard to observe a stale identitySession
    // closure against an already-cleared recoveredToken.current ref and
    // re-fire recoverActiveRun for a token that's about to be invalidated
    // (confirmed via a reliable repro against
    // "clears stale identity and prior stats when the stats projection
    // returns 401"). That guard is a separate, pre-existing piece of
    // machinery this package doesn't own - staying synchronous here (as
    // before RC-10) is the surgical fix; capabilities/suggestion have no
    // such downstream coupling (neither's failure path clears identity) and
    // keep the idle-callback deferral.
    void apiClient.getAccountStats(identitySession.token)
      .then((stats) => {
        if (request === statsRequest.current) {
          setAccountStatsProjection({ token, stats });
        }
      })
      .catch((caught) => {
        if (request !== statsRequest.current) return;
        // Deliberately still nulled unconditionally (Judge B amendment 1) -
        // ghostGuardRequired's fail-closed contract requires a fetch error
        // to read exactly like "unresolved", the same as mid-flight. Only
        // the NEW `accountStatsFetchStatus` distinguishes them for display.
        setAccountStatsProjection(null);
        setAccountStatsFetchStatus("error");
        if (isUnauthorizedError(caught)) {
          // An expired/invalidated session is an ordinary, expected
          // condition here (clearStaleIdentity already recovers it below) -
          // not a bug worth a beacon, same judgment every other
          // isUnauthorizedError branch in this file already makes by
          // returning before ever reaching its own reportVisibleError call.
          clearStaleIdentity();
        } else {
          errorReporter.reportVisibleError(
            "account-stats",
            apiErrorCode(caught),
            "Couldn't load your stats.",
            { accountId: identitySession?.accountId },
          );
        }
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
      suggestionIdentityTokenRef.current = null;
      return;
    }
    let cancelled = false;
    const request = ++suggestionRequest.current;
    const token = identitySession.token;
    // RC-04 (Judge B amend 1): PlayAnotherSuggestionState carries no token
    // field to derive-filter on at render time the way accountStats does,
    // so the identity-change carve-out has to live here instead - reset to
    // "loading" whenever the identity token changed since the suggestion
    // currently in state was fetched (login/switch/logout), OR whenever
    // there's nothing worth keeping on screen yet (not already "ready").
    // A `statsRefreshVersion` bump for the SAME token with a "ready"
    // suggestion already in state keeps rendering that stale suggestion
    // until the replacement arrives.
    const identityChanged = suggestionIdentityTokenRef.current !== token;
    suggestionIdentityTokenRef.current = token;
    if (identityChanged || playAnotherSuggestion.status !== "ready") {
      setPlayAnotherSuggestion({ status: "loading" });
    }
    // RC-10 (change 2): non-gating - see scheduleBackgroundWork's doc
    // comment. Change (1) / Judge B amendment 2: getChallengesSummary stays
    // conditional on `suggested` actually existing - a literal
    // Promise.all([getPlayAnotherSuggestion, getChallengesSummary]) here
    // would fire the summary request even in the "empty" case (new account,
    // everything already played), where today it never fires at all. That
    // conditional can't be relaxed without adding a network call the "empty"
    // path doesn't have today (see useTargetPreview.test.tsx-style coverage
    // in App.test.tsx for the regression test pinning this).
    const cancelSchedule = scheduleBackgroundWork(() => {
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
    });
    return () => {
      cancelled = true;
      cancelSchedule();
    };
  }, [apiClient, identitySession, statsRefreshVersion]);

  async function refreshLeaderboard(challengeId: string) {
    const request = ++leaderboardRequest.current;
    setLeaderboardProjection({ challengeId, rows: [], status: "loading", message: null });
    try {
      const nextLeaderboard = await apiClient.listLeaderboard(challengeId);
      if (request === leaderboardRequest.current) {
        setLeaderboardProjection({ challengeId, rows: nextLeaderboard, status: "ready", message: null });
      }
    } catch (caught) {
      if (request === leaderboardRequest.current) {
        // RC-06 (Changes item 2 / Judge B amendment 2): an honest "error"
        // status Challenge Detail's "Your history" tri-state can render
        // in-place, instead of the old `rows: []` silently reading as a
        // false "you haven't tried this one yet." Preserves this file's
        // pre-existing errorMessage() convention (proven by two already-
        // shipped App.test.tsx regressions) - a meaningful server message
        // ("Leaderboard unavailable.") still surfaces verbatim; only a
        // generic internal_error gets the friendly fallback substituted.
        const message = errorMessage(caught, "Couldn't load your history.");
        errorReporter.reportVisibleError("leaderboard", apiErrorCode(caught), message, {
          accountId: identitySession?.accountId,
        });
        setLeaderboardProjection({
          challengeId,
          rows: [],
          status: "error",
          message,
        });
      }
      throw caught;
    }
  }

  // RC-06 (Judge B amendment 6): retries `refreshLeaderboard` DIRECTLY for
  // Challenge Detail's own Retry controls ("Leaderboard" panel's board fetch
  // has its own component-local retry - this is only for the App-owned
  // per-attempt leaderboard feeding "Your history") - never a fresh
  // push-based navigation, so the hard-won Back-ladder-depth invariant is
  // untouched by a Detail-local retry tap.
  function retryLeaderboard(challengeId: string) {
    void refreshLeaderboard(challengeId).catch(() => {
      // Already reflected in leaderboardProjection's own "error" status
      // above - nothing else to do with the rejection here.
    });
  }

  // Plan-drift fix: Browse's cards now open Challenge Detail directly (spec
  // IA) instead of selecting and landing back on Home - Detail's own "Race
  // this" is the race entry point from there.
  async function openChallengeDetail(challengeId: string) {
    if (challengeLockRef.current) return;
    race.resetCompleted();
    setSelectedChallengeId(challengeId);
    nav.openDetail(challengeId);
    setError(null);
    setRunNotice(null);
    try {
      await refreshLeaderboard(challengeId);
    } catch {
      // RC-06 (Judge B amendment 2): Detail's own inline leaderboard
      // tri-state (leaderboardStatus, above) now owns this failure - no
      // longer surfaced through the vanishing global banner too, which used
      // to double up with (and outlast) whatever Detail itself renders.
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
    nav.enterRacePreview(challengeId);
  }

  // Home's yesterday recap card ("see full board ›") - Boards computes its
  // own Yesterday segment independently now (Increment 3 rebuild), so this
  // only needs to land on Boards with that segment pre-selected, not sync
  // any shared challenge-selection state the old v0 selector used.
  function goToBoardsFor() {
    nav.goToBoards("yesterday");
  }

  // RC-05 (Judge B amendment 1): Home's FINISHED-state "Today's board" card
  // gets its own "see full board ›" link, distinct from goToBoardsFor's
  // Yesterday-specific one above - it must land on Boards' Today segment,
  // not silently reuse Yesterday's destination. Same Back-ladder marker
  // (item 8) as goToBoardsFor, for the same reason: this is a second Home ->
  // non-Home entry point that bypasses the bottom nav.
  function goToBoardsForToday() {
    nav.goToBoards("today");
  }

  function selectMode(nextMode: ModeKey) {
    // RC-07 Step 3: the URL/Back-ladder invariant enforcement this used to
    // do inline (owner-approved URL policy + Back ladder item 8 - see
    // useNavigationIntents.ts's own doc comment for the full history) now
    // lives in nav.goHome/nav.switchMode, the ONE place both this and
    // every other app-initiated navigation share.
    if (nextMode === "home") {
      nav.goHome();
    } else {
      nav.switchMode(nextMode);
    }
  }

  function closeChallengeDetail() {
    nav.closeDetail();
  }

  function exitAdmin() {
    // Out of scope for nav's `?challenge=`/ladder-depth intents (RC-07 Step
    // 3) - the /admin/dailies pathname bypass is a different invariant
    // entirely, with its own dedicated urlRouting.ts helper.
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
        setLeaderboardProjection({ challengeId: challenge.id, rows: [], status: "loading", message: null });
        // Plan-drift fix (consistent with Browse's card->Detail change): a
        // freshly created/found challenge lands on its own Detail, not Home
        // - Home's hero is always today's daily and would otherwise show no
        // trace of what was just created.
        nav.openDetail(challenge.id);
      }
      setRunNotice(createChallengeNotice(outcome));
      if (!challengeLockRef.current) {
        // RC-06 (Judge B amendment 2): this also lands on Detail (above) -
        // same in-place tri-state, no global banner for this failure either.
        await refreshLeaderboard(challenge.id).catch(() => {});
      }
    } catch (caught) {
      if (isUnauthorizedError(caught)) {
        clearStaleIdentity({ type: "create", input });
        return;
      }
      {
        const message = errorMessage(caught, "Could not create that challenge.");
        errorReporter.reportVisibleError("create-challenge", apiErrorCode(caught), message, {
          accountId: identitySession?.accountId,
        });
        setError(message);
      }
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
        setLeaderboardProjection({ challengeId: challenge.id, rows: [], status: "loading", message: null });
        setRaceStage(null);
        nav.openDetail(challenge.id);
      }
      setRunNotice("Found a fresh challenge for you.");
      if (!challengeLockRef.current) {
        // RC-06 (Judge B amendment 2): same in-place Detail tri-state as
        // every other Detail-open path - no global banner for this failure.
        await refreshLeaderboard(challenge.id).catch(() => {});
      }
    } catch (caught) {
      if (isUnauthorizedError(caught)) {
        clearStaleIdentity({ type: "random-challenge" });
        return;
      }
      {
        const message = describeRandomChallengeError(toRandomChallengeFailure(caught));
        errorReporter.reportVisibleError("random-challenge", apiErrorCode(caught), message, {
          accountId: identitySession?.accountId,
        });
        setRandomChallengeError(message);
      }
    } finally {
      randomChallengeLockRef.current = false;
      setRandomChallengeBusy(false);
    }
  }

  function exitRaceFlow(nextMode: ModeKey) {
    nav.exitRaceTo(nextMode);
  }

  function exitCompletedRaceTo(nextMode: ModeKey) {
    // RC-07 Step 2: race.resetCompleted() now clears a folded-in dnfResult
    // too (Judge B amend 1's widened guard) - the standalone setDnfResult
    // call this used to pair it with is gone, not just moved.
    race.resetCompleted();
    nav.exitRaceTo(nextMode);
  }

  // Play-another's suggestion (Home and Results) opens Challenge Detail -
  // same route as Browse's own cards (spec: "route consistent with Browse
  // cards → Detail"). From inside the race takeover this must also exit the
  // takeover first, unlike onOpenChallengeDetail (App-shell-only).
  function exitCompletedRaceToChallenge(challengeId: string) {
    race.resetCompleted();
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
    // RC-07 Step 2: no standalone dnfResult clear needed here anymore -
    // race.start() below unconditionally commits a fresh `{...initialState,
    // ...}` snapshot (dnfResult included) the instant it flips phase to
    // "preparing".
    setMode("home");
    setLeaderboardProjection({ challengeId: challenge.id, rows: [], status: "loading", message: null });
    setSelectedChallengeId(challenge.id);
    // RC-07 Step 3 (deliberately NOT routed through nav - see
    // useNavigationIntents.ts's own doc comment): this pins the URL for the
    // in-flight race takeover while `mode` stays "home", a shape none of
    // nav's mode-paired intents match. Still the one shared urlRouting.ts
    // primitive directly.
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
    // Password-manager note (owner ask 2026-07-25): drafts clear on CLOSE,
    // never on submit-success while the sheet is still up. Clearing a
    // password input's value before the browser has seen the form go away
    // can suppress Chrome/Safari's save-credentials prompt; here the
    // setAuthPrompt(null) above unmounts the whole <form> in the SAME React
    // commit, so the inputs are removed with their submitted values intact -
    // the browser's provisional save (captured at submit time) is unaffected,
    // and the plaintext password just stops lingering in App state after the
    // sheet is gone.
    setPasswordDraft("");
    setConfirmPasswordDraft("");
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
        setGuestRetryAttempt(0);
        // LR-2: playAsGuest is safe to ladder in full (get-or-create keyed
        // by deviceCredential - see vgamesIdentity.ts) - track attempt
        // timings so an exhausted ladder can beacon itself below.
        const guestCallStartedAt = now();
        const guestRetryAtMs: number[] = [];
        try {
          nextIdentitySession = await identityClient.playAsGuest(
            {
              deviceCredential: identityRepository.getDeviceCredential(),
              displayName,
            },
            {
              onRetry: (attempt) => {
                guestRetryAtMs.push(now() - guestCallStartedAt);
                setGuestRetryAttempt(attempt);
              },
            },
          );
          persistIdentitySession(nextIdentitySession);
          if (forceNameEntry) {
            // Per-tab DNF memory belongs to the account that raced (§2.1) -
            // a fresh guest name must not inherit the old ghost's.
            setSessionDnfChallengeIds(new Set());
          }
        } catch (caught) {
          reportIdentityStall(
            errorReporter,
            "guest",
            caught,
            guestRetryAtMs,
            now() - guestCallStartedAt,
          );
          {
            const message = vgamesIdentityErrorMessage(caught, "Could not start a guest session.");
            reportVisibleIdentityError(errorReporter, "guest", caught, message, identitySession?.accountId);
            setError(message);
          }
          setAuthBusy(false);
          return;
        } finally {
          setGuestRetryAttempt(0);
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
    setCreateRetryAttempt(0);
    const createCallStartedAt = now();
    const createRetryAtMs: number[] = [];
    try {
      let guestSession = identitySession;
      if (!guestSession) {
        // LR-2: the only timeout-safe part of create-account to ladder -
        // this anonymous guest bootstrap is naturally idempotent (see
        // vgamesIdentity.ts's playAsGuest). The secureGuest call just below
        // is NOT laddered: it fans out to a two-step server-side mutation
        // (set-credentials then login) that a client-observed timeout can't
        // safely replay - see the non-goal comment on secureGuest itself.
        guestSession = await identityClient.playAsGuest(
          {
            deviceCredential: identityRepository.getDeviceCredential(),
            displayName: username,
          },
          {
            onRetry: (attempt) => {
              createRetryAtMs.push(now() - createCallStartedAt);
              setCreateRetryAttempt(attempt);
            },
          },
        );
      }

      let claimedSession: VGamesIdentitySession;
      try {
        claimedSession = await identityClient.secureGuest({
          deviceCredential: identityRepository.getDeviceCredential(),
          token: guestSession.token,
          username,
          password,
        });
      } catch (secureCaught) {
        // P0 fix (2026-08-05, live report "Rob couldn't create an
        // account"): playAsGuest's own bootstrap session ALWAYS reports
        // status "ghost" (server/vgamesIdentityClient.ts's `quick()` hard-
        // codes it, regardless of the account's real state - confirmed live
        // against prod), so this is the only point that can ever learn the
        // guest we just bootstrapped was actually already secured - most
        // likely by an earlier attempt whose secureGuest call (single,
        // non-retryable - see the non-goal comment above) timed out on the
        // CLIENT after the mutation had already landed server-side. Calling
        // secureGuest again here always fails the same way (viota's
        // `/auth/set-credentials` correctly rejects a non-ghost token with
        // `not_ghost`, confirmed live) - a resubmit of the identical form
        // reproduces it forever, a genuine dead end. Recovering with
        // `login` is safe to attempt: it's a read-only auth check (not a
        // blind replay of the non-idempotent secure mutation), it's already
        // laddered/retried on its own, and if this really is the same
        // account from a lost response, the just-typed credentials log
        // straight in with no extra step. If they don't match (a different
        // username, or the password was retyped differently on this
        // attempt), it fails exactly like the Log In tab's own "incorrect"
        // case - a real, actionable answer instead of the raw "not_ghost"
        // code.
        if (!isAccountAlreadySecuredFailure(secureCaught)) {
          throw secureCaught;
        }
        claimedSession = await identityClient.login(
          {
            deviceCredential: identityRepository.getDeviceCredential(),
            username,
            password,
          },
          {
            onRetry: (attempt) => {
              createRetryAtMs.push(now() - createCallStartedAt);
              setCreateRetryAttempt(attempt);
            },
          },
        );
      }
      persistIdentitySession(claimedSession);
      closeAuthPrompt();
      await resumeAfterIdentity(prompt, claimedSession);
    } catch (caught) {
      reportIdentityStall(
        errorReporter,
        "create",
        caught,
        createRetryAtMs,
        now() - createCallStartedAt,
      );
      {
        const message = vgamesIdentityErrorMessage(caught, "Could not create that VGames account.");
        reportVisibleIdentityError(errorReporter, "create", caught, message, identitySession?.accountId);
        setError(message);
      }
    } finally {
      createVGamesAccountLock.current = false;
      setAuthBusy(false);
      setCreateRetryAttempt(0);
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
    setAuthRetryAttempt(0);
    // LR-2: the full 3-attempt ladder (4s/8s/15s) replaces 6d54452's single
    // retry - track attempt timings so an exhausted ladder can beacon
    // itself below ("the next stall names itself").
    const loginCallStartedAt = now();
    const loginRetryAtMs: number[] = [];
    try {
      const loggedInSession = await identityClient.login(
        {
          deviceCredential: identityRepository.getDeviceCredential(),
          username,
          password,
        },
        {
          onRetry: (attempt) => {
            loginRetryAtMs.push(now() - loginCallStartedAt);
            setAuthRetryAttempt(attempt);
          },
        },
      );
      persistIdentitySession(loggedInSession);
      // Every login replaces the active account - a later session must
      // never inherit the previous one's per-tab DNF memory (§2.1/§2.2).
      setSessionDnfChallengeIds(new Set());
      closeAuthPrompt();
      await resumeAfterIdentity(prompt, loggedInSession);
    } catch (caught) {
      reportIdentityStall(
        errorReporter,
        "login",
        caught,
        loginRetryAtMs,
        now() - loginCallStartedAt,
      );
      {
        const message = vgamesIdentityErrorMessage(caught, "Could not log in.");
        reportVisibleIdentityError(errorReporter, "login", caught, message, identitySession?.accountId);
        setError(message);
      }
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
      setAuthRetryAttempt(0);
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
    // Owner ask 2026-07-25 ("persist ... someone's chosen name"): a cleared
    // SESSION deliberately does not blank the NAME draft anymore. The device
    // credential survives every clear (see the doc comment above), and guest
    // identity is a get-or-create keyed by it server-side - so after a
    // stale-token wipe (or logout), "Continue as guest" with the same name
    // resumes the SAME ghost. clearSession() persists the outgoing name; the
    // draft keeps it prefilled so re-entry is one tap, not a retype. The
    // "Play as someone else" flow still blanks it explicitly on open
    // (openAuthPrompt's freshName branch), unchanged. The login/create
    // drafts DO clear: username/password are password-manager territory, and
    // an empty pair autofills cleaner than a half-guessed prefill.
    setDisplayNameDraft(identityRepository.getLastDisplayName() ?? "");
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
      const message = errorMessage(caught, "Could not load that winning path.");
      errorReporter.reportVisibleError("run-path", apiErrorCode(caught), message, {
        accountId: identitySession?.accountId,
      });
      setError(message);
    }
  }

  async function confirmEndRun(
    sessionForEnd: VGamesIdentitySession | null = identitySession,
  ) {
    if (!sessionForEnd) return;
    // RC-07 Step 2: the actual DNF snapshot (challenge/clicks/elapsedMs/
    // runId, the isRecoveryEnd exclusion, the clicks>0 display gate, and
    // the server-elapsedMs override) now lives entirely inside
    // useRaceController's endRun - race.dnfResult is the one place both
    // this file and RaceFlow read it from. What's left here are two small,
    // App-owned booleans confirmEndRun still needs for ITS OWN decisions
    // (which runNotice copy to show, and FB-7's board-visibility mark) -
    // read from the exact same pre-call `race` snapshot the hook itself
    // reads a moment later (same tick, same object references, so these
    // can't drift from what the hook decides).
    const isRecoveryEnd = Boolean(race.recoveryRun);
    const endedChallengeId = race.recoveryRun?.challengeId ?? race.challenge?.id ?? null;
    const acceptedClickCount = race.recoveryRun?.clickCount ?? race.session?.clicks ?? 0;
    // Judge B amend 2: mirrors the hook's OWN `clicks > 0` display gate
    // exactly (`!isRecoveryEnd && race.challenge` is dnfResult's other
    // null condition) - true iff the DNF Results screen is about to show,
    // so this file's plain-notice copy never doubles up with it.
    const dnfWillShow = !isRecoveryEnd && Boolean(race.challenge) && acceptedClickCount > 0;
    const outcome = await race.endRun(
      sessionForEnd.token,
      race.recoveryRun?.protocolVersion === 1 ? 1 : undefined,
    );
    if (outcome.status === "abandoned") {
      setEndConfirmationOpen(false);
      if (dnfWillShow) {
        setRunNotice(null);
      } else {
        // Cleanup pass (wave-3 review): this used to branch on plain
        // `acceptedClickCount > 0`, so a 0-OR-1-click end (below FB-7's own
        // `MIN_COUNTED_DNF_CLICKS` board-visibility threshold) still said
        // "was saved"/"DNF and path were saved" - a claim this exact branch
        // never backs up: `markSessionDnf` just below this block requires
        // that same `>= MIN_COUNTED_DNF_CLICKS` threshold before Home's
        // local session state (or any board) ever reflects it. Matching the
        // threshold here means the notice never promises a consequence that
        // didn't happen.
        setRunNotice(acceptedClickCount >= MIN_COUNTED_DNF_CLICKS
          ? "Run ended. Your DNF and path were saved."
          : "Run ended. It won't count as an attempt.");
      }
      // Home's DNF sub-state (spec: "an end-run this session") - local
      // memory of it, not a server read, so Home can reflect it immediately.
      // Recovery's "End Old Run" is excluded (matches the hook's dnfResult
      // guard) - it's a stale/legacy run being cleared out, not "the
      // account tried and gave up on today's daily this session." FB-7
      // (owner ruling, 2026-07-19): also gated on
      // `acceptedClickCount >= MIN_COUNTED_DNF_CLICKS` - a sub-threshold
      // bail is a non-attempt and must leave Home in the FRESH state, same
      // as the server (which never surfaces a sub-threshold DNF as a board
      // row) shows on reload. This threshold is DELIBERATELY separate from
      // (and larger than) the `clicks > 0` display gate above - a 1-click
      // DNF still shows the Results screen but does NOT mark Home's
      // board-visible session state.
      if (endedChallengeId && !isRecoveryEnd && acceptedClickCount >= MIN_COUNTED_DNF_CLICKS) {
        markSessionDnf(endedChallengeId);
      }
      if (endedChallengeId) {
        await refreshLeaderboard(endedChallengeId);
      }
      bumpStatsRefresh();
    } else if (outcome.status === "completed") {
      setEndConfirmationOpen(false);
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
  // RC-08 (Judge B amend 2): the dialog copy must predict confirmEndRun's
  // OWN destination fork exactly, not just click count. Any recovery end
  // ("End Old Run") forces dnfSnapshot to null unconditionally (see
  // confirmEndRun's isRecoveryEnd, above) - it always lands on Home with a
  // notice, DNF Results or not, regardless of how many clicks the stale run
  // being cleared out had racked up. So the DNF-with-N-clicks framing is
  // only ever true for the non-recovery, 1+-click, active-race path; every
  // other case (zero clicks, or ANY recovery end) shares one honest
  // Home-bound line - stating the destination up front instead of leaving
  // it to be discovered after confirming.
  const isRecoveryEnd = Boolean(race.recoveryRun);
  // QF-05: "DNF" spelled out here too, matching RaceResults' own kicker
  // ("DNF — Did not finish") - this dialog is often a first-time player's
  // first encounter with the term, before they've ever seen Results.
  // Cleanup pass (wave-3 review): the old `endRunClickCount >= 1` threshold
  // claimed a 1-click end "counts as a DNF" a full click below
  // MIN_COUNTED_DNF_CLICKS (FB-7's own board-visibility threshold, = 2) -
  // the exact count a 1-click end neither marks Home's session DNF state
  // (confirmEndRun's own `>= MIN_COUNTED_DNF_CLICKS` gate) nor ever shows up
  // on any board. The dialog must not promise (or threaten) a consequence
  // that won't actually happen - only a non-recovery end at/above the real
  // threshold gets the "counts as an attempt" framing now; everything else
  // (0/1 click, or any recovery end - see RC-08's own doc comment above on
  // why recovery ends never count regardless of clicks) keeps the honest
  // "won't count" line.
  const endRunCountsAsAttempt = !isRecoveryEnd && endRunClickCount >= MIN_COUNTED_DNF_CLICKS;
  const endRunConfirmCopy = endRunCountsAsAttempt
    ? "This will end your run — it counts as an attempt (DNF). You'll go back to Home."
    : "Ending now won't count as an attempt — you'll go back to Home.";
  const showBanners = !authPrompt && !endConfirmationOpen;
  const bannerError = showBanners ? visibleError : null;
  const bannerNotice = showBanners ? runNotice : null;

  return (
    <main
      className="app-shell"
      aria-busy={isBusy}
    >
      {screen.kind !== "shell" ? (
        <RaceFlow
          screen={screen}
          apiClient={apiClient}
          errorReporter={errorReporter}
          phase={race.phase}
          raceChallenge={race.challenge}
          recoveryRun={race.recoveryRun}
          previewChallenge={selectedChallenge}
          targetPreview={targetPreview}
          session={session}
          article={article}
          elapsedMs={elapsedMs}
          redirectedFrom={race.redirectedFrom}
          pendingNavigationTitle={pendingNavigationTitle}
          navigationRetrying={navigationRetrying}
          pendingRetry={race.pendingRetry}
          leaderboardContext={race.leaderboardContext}
          runId={race.run?.id ?? null}
          dnfResult={race.dnfResult}
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
            // `race.dnfResult` (DNF) - useRaceController.endRun wipes
            // `session` on a genuine abandon, so only one of the two is
            // ever set here. Same `isDailyToday` calc RaceResults' own
            // header/board-title copy uses, so the two can't independently
            // drift.
            const racedChallenge = session?.challenge ?? race.dnfResult?.challenge ?? null;
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
          accountStatsStatus={accountStatsStatus}
          apiClient={apiClient}
          authBusy={authBusy}
          bannerError={bannerError}
          bannerNotice={bannerNotice}
          boardsInitialSegment={boardsInitialSegment}
          canManageDailies={canManageDailies}
          canNominateForDaily={identitySession?.status === "claimed"}
          catalogStatus={catalogStatus}
          challenges={challenges}
          challengesView={challengesView}
          errorReporter={errorReporter}
          identitySession={identitySession}
          leaderboard={leaderboard}
          leaderboardErrorMessage={leaderboardErrorMessage}
          leaderboardStatus={leaderboardStatus}
          mode={mode}
          onClaimIdentity={(mode) => openAuthPrompt({ type: "claim" }, mode)}
          onCloseChallengeDetail={closeChallengeDetail}
          onCreateChallenge={createChallenge}
          onCreateRandomChallenge={() => void createRandomChallenge()}
          onDisclosePath={(runId) => void loadRunPath(runId)}
          onDismissStorageNotice={() => setStorageNoticeDismissed(true)}
          onExitAdmin={exitAdmin}
          onGoToBoardsFor={goToBoardsFor}
          onGoToBoardsToday={goToBoardsForToday}
          onLogOut={logOut}
          onOpenChallengeDetail={(challengeId) => void openChallengeDetail(challengeId)}
          onPlayAsSomeoneElse={requestPlayAsSomeoneElse}
          onRaceChallenge={openRacePreviewFor}
          onRetryAccountStats={() => setStatsRefreshVersion((version) => version + 1)}
          onRetryCatalog={() => setCatalogRefreshVersion((version) => version + 1)}
          onRetryLeaderboard={retryLeaderboard}
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
          authRetryAttempt={authRetryAttempt}
          guestRetryAttempt={guestRetryAttempt}
          createRetryAttempt={createRetryAttempt}
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
  authRetryAttempt,
  guestRetryAttempt,
  createRetryAttempt,
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
  // LR-2: which rung of each identity flow's own retry ladder is in flight
  // (0 = none) - see performLogin/continueAsGuest/createVGamesAccount.
  authRetryAttempt: IdentityRetryStage;
  guestRetryAttempt: IdentityRetryStage;
  createRetryAttempt: IdentityRetryStage;
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
  // RC-09 (owner-proxy ruling, Judge A item 4 / Judge B amendment 2): the
  // three forms below stay exactly as they were - three separate,
  // mutually-exclusive `authMode === "..." ? <form> : null` expressions
  // (never dual-rendered) - this only measures whichever one is currently
  // mounted so `.identity-form-viewport`'s height can animate between them.
  const { contentRef: identityFormRef, height: identityFormHeight } =
    useMeasuredHeight<HTMLDivElement>();

  // RC-10 (change 5, Judge B's minor implementation note): a bare JSX
  // `autoFocus` on each form's first input used to re-summon the keyboard on
  // every Guest/Create/Log in TAB SWITCH, because the three forms below are
  // separately mode-gated `authMode === X ? <form> : null` blocks that each
  // remount fresh when `authMode` changes - `autoFocus` fires on every one
  // of those remounts, not just the sheet's own first open. `IdentityPrompt`
  // itself, unlike its child forms, mounts exactly once per genuine
  // sheet-opening (the parent only ever renders it via a
  // `authPrompt ? <IdentityPrompt/> : null` transition - see its call site's
  // own doc comment - never keeps it mounted through a tab switch), so one
  // imperative mount-only effect here reaches "focus the very first form
  // shown, and nothing after" without needing per-tab state. Covers the
  // forceGuestNameEntry ("Play as someone else") and "Switch account" paths
  // too, since both open a brand-new `authPrompt` (a fresh mount) rather
  // than mutating props on an already-open sheet.
  useEffect(() => {
    identityFormRef.current?.querySelector<HTMLInputElement>("input")?.focus();
    // Mount-only, deliberately: see the comment above for why re-running
    // this on every authMode/prop change would resurrect the exact bug
    // being fixed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

        <div
          className="identity-form-viewport"
          style={identityFormHeight != null ? { height: identityFormHeight } : undefined}
        >
        {/* RC-09: the measured element is this INNER div, never the outer
            animated one - the outer's own height is exactly what we're
            setting from `identityFormHeight` above, so observing it instead
            would just measure our own last-written value back at ourselves
            rather than the mounted form's real natural size.
            Cleanup pass (wave-3 review, RC-09 untraced finding): this div
            used to carry no styling of its own, which let `.identity-form`'s
            `margin-top: 14px` collapse straight through it and merge with
            `.identity-form-viewport`'s own top edge instead of counting
            toward THIS div's measured height - `getBoundingClientRect()`/
            `ResizeObserver` both measured 14px short of the form's real
            `scrollHeight` on every one of the three tabs (confirmed via a
            local Playwright rig at 390px: viewport `scrollHeight` 229 vs the
            animated `clientHeight` 215, every single state, not just
            mid-transition). `.identity-form-viewport`'s `overflow: hidden`
            then silently cropped that same 14px off the bottom of whichever
            form was showing - `display: flow-root` here gives this div its
            own block-formatting context so the child's margin is contained
            inside the box actually being measured, matching what
            `.identity-form-viewport`'s own doc comment already assumed was
            true. See `.identity-form-measure` in styles.css. */}
        <div className="identity-form-measure" ref={identityFormRef}>
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
                  maxLength={24}
                  name="nickname"
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
              {identityRetryStageLabel(guestRetryAttempt, "Continue as guest")}
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
                autoComplete="username"
                maxLength={20}
                minLength={3}
                name="username"
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
                name="new-password"
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
                name="confirm-new-password"
                onChange={(event) => onConfirmPasswordChange(event.target.value)}
                type="password"
                value={confirmPasswordDraft}
              />
            </label>
            <button disabled={authBusy} type="submit">
              {identityRetryStageLabel(createRetryAttempt, "Create account")}
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
              {authBusy ? identityRetryStageLabel(authRetryAttempt, "Logging in...") : "Log in"}
            </button>
          </form>
        ) : null}
        </div>
        </div>
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

// RC-01 (Judge A amend): prefer `fallback` over the caught error's own
// message whenever the server tagged it `internal_error` - worker.ts's
// catch-all replies with a single generic "Something went wrong." for every
// unhandled exception, which is never useful to show verbatim. Checking
// `.code` (the same duck-typed convention isUnauthorizedError below and
// useRaceController's errorCode already use) instead of comparing the
// message string means this keeps working even if that server-side copy
// ever changes - a literal string match would silently stop firing. This is
// the single fix point for every one of this file's ~15 errorMessage() call
// sites (leaderboard load, account stats, create challenge, path load,
// catalog load, ...), not just the catalog one - see useRaceController.ts's
// identical copy of this helper for its own call sites (start/click/article/
// recovery/end-run).
function errorMessage(caught: unknown, fallback: string): string {
  if (isInternalError(caught)) return fallback;
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

// RC-01: duck-typed `.code === "internal_error"` check shared by
// errorMessage() above - see its doc comment for why this checks the code,
// not the message text.
function isInternalError(caught: unknown): boolean {
  return caught !== null && typeof caught === "object" &&
    "code" in caught && caught.code === "internal_error";
}
