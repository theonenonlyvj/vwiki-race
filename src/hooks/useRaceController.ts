import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { createGameSession, followResolvedLink, type GameSession } from "../domain/gameSession";
import { normalizeTitle } from "../domain/rules";
import type { Article, Challenge, LeaderboardContext, ServerPathStep } from "../domain/types";
import type { ActiveRunRecord } from "../server/trackingRepository";
import { apiErrorCode, type ErrorReporter } from "../services/errorReporting";
import type { RecordTrackedClickRequest, VWikiRaceApiClient } from "../services/vwikiRaceApiClient";
import type { WikipediaGateway } from "../services/wikipediaGateway";
import { useElapsedDecisionTime } from "./useElapsedDecisionTime";

export type RacePhase = "idle" | "preparing" | "active" | "syncing" | "completed" | "abandoning";

// RC-07 Step 2: folded in from App.tsx's own App-level `dnfResult` state -
// see endRun's abandoned branch below for where it's constructed, and
// RaceFlow.tsx (its sole consumer besides App.tsx) for where it's read.
export interface DnfResultSnapshot {
  challenge: Challenge;
  clicks: number;
  elapsedMs: number;
  runId: string | null;
}

export type StartOutcome =
  | { status: "started"; challengeId: string }
  | { status: "recovery-required"; challengeId: string; run: ActiveRunRecord | null }
  | { status: "unauthorized"; challengeId: string }
  | { status: "failed"; challengeId: string }
  | { status: "ignored" }
  | { status: "stale" };

export type ClickOutcome =
  | { status: "active" | "completed"; challengeId: string }
  | { status: "retryable"; challengeId: string }
  | { status: "unauthorized"; challengeId: string }
  | { status: "failed"; challengeId: string }
  | { status: "ignored" }
  | { status: "stale" };

export type RecoveryOutcome =
  | { status: "none" }
  | { status: "recovered"; challengeId: string }
  | { status: "recovery-required"; challengeId: string | null; run: ActiveRunRecord }
  | { status: "unauthorized" }
  | { status: "failed" }
  | { status: "stale" };

export type EndRunOutcome =
  // PKG-03: the "abandoned" case carries the server's own just-persisted
  // elapsedMs (when the response included one - older/legacy responses
  // may not) so callers can use the same source of truth the eventual
  // leaderboard/board row will read from, instead of a pre-call client
  // timer snapshot - see App.tsx's confirmEndRun.
  | { status: "abandoned"; elapsedMs?: number }
  | { status: "completed" }
  | { status: "unauthorized" }
  | { status: "failed" }
  | { status: "ignored" }
  | { status: "stale" };

export interface RaceControllerOptions {
  apiClient: VWikiRaceApiClient;
  gateway: WikipediaGateway;
  now?: () => number;
  observedAt?: () => string;
  createEventId?: () => string;
  // This package: RaceFlow.tsx renders `error` (below) verbatim as the
  // race-takeover's error banner - every commitState({ error: errorMessage
  // (...) }) call site in this file is a real, user-visible failure and now
  // beacons through this SAME reporter App.tsx already built (never a
  // second instance). Optional so every existing test double that doesn't
  // care about telemetry keeps compiling unchanged.
  errorReporter?: Pick<ErrorReporter, "reportVisibleError">;
}

interface PendingClick {
  runId: string;
  challengeId: string;
  destination: Article;
  body: RecordTrackedClickRequest;
  sourceState: RaceState;
}

interface RaceState {
  phase: RacePhase;
  challenge: Challenge | null;
  run: ActiveRunRecord | null;
  session: GameSession | null;
  article: Article | null;
  // LK-1: the anchor's pre-redirect title whenever the just-accepted click's
  // requestedTitle resolved to a DIFFERENT canonical article (a Wikipedia
  // redirect) - null otherwise. Scoped to the current article only: every
  // commitState that changes `article` also (re)computes this, so it never
  // survives past the next navigation. Display-only - never fed back into
  // the click protocol, path steps, or server records (those stay
  // canonical, unaffected by this field).
  redirectedFrom: string | null;
  pendingNavigationTitle: string | null;
  pendingClick: PendingClick | null;
  error: string | null;
  leaderboardContext: LeaderboardContext | null;
  recoveryRun: ActiveRunRecord | null;
  // RC-07 Step 2: single-sourced here instead of a parallel App-level
  // `dnfResult` state the caller had to hand-sync at 6+ call sites - see
  // endRun's abandoned branch for construction and resetCompleted for the
  // one place it's cleared alongside everything else.
  dnfResult: DnfResultSnapshot | null;
}

const initialState: RaceState = {
  phase: "idle",
  challenge: null,
  run: null,
  session: null,
  article: null,
  redirectedFrom: null,
  pendingNavigationTitle: null,
  pendingClick: null,
  error: null,
  leaderboardContext: null,
  recoveryRun: null,
  dnfResult: null,
};
const defaultNow = () => performance.now();
const defaultObservedAt = () => new Date().toISOString();
const defaultEventId = () => crypto.randomUUID();

export function useRaceController(options: RaceControllerOptions) {
  const now = options.now ?? defaultNow;
  const observedAt = options.observedAt ?? defaultObservedAt;
  const createEventId = options.createEventId ?? defaultEventId;
  const [state, setState] = useState<RaceState>(initialState);
  // MB-1 Part 2: true only while the CURRENT navigation's automatic retry
  // (article fetch leash or click-POST leash - both mirror the shipped
  // login pattern, see wikipediaGateway.ts/vwikiRaceApiClient.ts) is in
  // flight. Deliberately kept OUTSIDE RaceState/commitState: it's a
  // transient signal scoped to a single followLink/retryPendingClick call,
  // not part of the race's durable state machine, so it never needs to be
  // threaded through every `{...snapshot, ...}` transition object below.
  const [navigationRetrying, setNavigationRetrying] = useState(false);
  const stateRef = useRef(state);
  const requestGeneration = useRef(0);
  const operationAbort = useRef<AbortController | null>(null);
  const prewarmAbort = useRef<AbortController | null>(null);
  const prewarmTitle = useRef<string | null>(null);
  const mounted = useRef(false);
  stateRef.current = state;
  const timer = useElapsedDecisionTime({
    active: state.phase === "active" && state.pendingClick === null,
    now,
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestGeneration.current += 1;
      operationAbort.current?.abort();
      operationAbort.current = null;
      prewarmAbort.current?.abort();
      prewarmAbort.current = null;
      prewarmTitle.current = null;
      options.gateway.clear();
    };
  }, [options.gateway]);

  const commitState = useCallback((next: RaceState) => {
    stateRef.current = next;
    if (mounted.current) setState(next);
  }, []);

  const beginOperation = useCallback(() => {
    operationAbort.current?.abort();
    const controller = new AbortController();
    operationAbort.current = controller;
    return { controller, generation: ++requestGeneration.current };
  }, []);

  const start = useCallback(async (challenge: Challenge, token: string): Promise<StartOutcome> => {
    if (!["idle", "completed"].includes(stateRef.current.phase)) return { status: "ignored" };
    const operation = beginOperation();
    prewarmAbort.current?.abort();
    prewarmAbort.current = null;
    prewarmTitle.current = null;
    options.gateway.clear();
    commitState({ ...initialState, phase: "preparing", challenge });
    try {
      const article = await options.gateway.getArticle(challenge.start.title, {
        ruleset: challenge.ruleset,
        signal: operation.controller.signal,
      });
      if (!isCurrent(operation, requestGeneration, mounted)) return { status: "stale" };
      if (!matchesChallengeStart(article, challenge)) {
        throw new Error("The preloaded article no longer matches this challenge's start.");
      }
      const run = await options.apiClient.startRun({ challengeId: challenge.id }, token);
      if (!isCurrent(operation, requestGeneration, mounted)) return { status: "stale" };
      timer.reset(0);
      commitState({
        ...initialState,
        phase: "active",
        challenge,
        run,
        article,
        session: createGameSession(challenge, now()),
      });
      return { status: "started", challengeId: challenge.id };
    } catch (caught) {
      if (!isCurrent(operation, requestGeneration, mounted)) return { status: "stale" };
      if (isUnauthorized(caught)) {
        commitState({ ...initialState, challenge });
        return { status: "unauthorized", challengeId: challenge.id };
      }
      if (errorCode(caught) === "active_run_exists") {
        try {
          const activeRun = await options.apiClient.getActiveRun(token);
          if (!isCurrent(operation, requestGeneration, mounted)) return { status: "stale" };
          commitState({
            ...initialState,
            challenge,
            recoveryRun: activeRun,
            error: activeRun?.protocolVersion === 2
              ? "Resume or end the active run before starting this challenge."
              : "End the old run before starting this challenge.",
          });
          return { status: "recovery-required", challengeId: challenge.id, run: activeRun };
        } catch (recoveryError) {
          if (!isCurrent(operation, requestGeneration, mounted)) return { status: "stale" };
          if (isUnauthorized(recoveryError)) {
            commitState({ ...initialState, challenge });
            return { status: "unauthorized", challengeId: challenge.id };
          }
        }
      }
      const startErrorMessage = errorMessage(caught, "Could not start that challenge.");
      reportVisibleRaceError(options, "start", caught, startErrorMessage);
      commitState({ ...initialState, challenge, error: startErrorMessage });
      return { status: "failed", challengeId: challenge.id };
    }
  }, [beginOperation, commitState, now, options.apiClient, options.gateway, timer]);

  const acceptClick = useCallback(async (
    pending: PendingClick,
    token: string,
    operation: Operation,
    onRetry?: () => void,
  ): Promise<ClickOutcome> => {
    try {
      const response = await options.apiClient.recordClick(
        pending.runId,
        pending.body,
        token,
        onRetry ? { onRetry } : undefined,
      );
      if (!isCurrent(operation, requestGeneration, mounted)) return { status: "stale" };
      const source = pending.sourceState;
      if (!source.session || !source.run) return { status: "stale" };
      const completed = response.transition.runStatus === "completed";
      const session = followResolvedLink(source.session, {
        clickedAnchorText: pending.body.clickedAnchorText,
        requestedTitle: pending.body.requestedTitle,
        resolvedDestination: {
          canonicalTitle: pending.destination.canonicalTitle,
          pageId: pending.destination.pageId,
        },
        timestamp: now(),
      });
      const redirectedFrom = computeRedirectedFrom(
        pending.body.requestedTitle,
        pending.destination.canonicalTitle,
      );
      commitState({
        ...source,
        phase: completed ? "completed" : "active",
        article: pending.destination,
        redirectedFrom,
        session: {
          ...session,
          clicks: response.transition.clickCount,
          status: completed ? "completed" : "active",
          completedAt: completed ? session.completedAt : undefined,
        },
        run: {
          ...source.run,
          status: completed ? "completed" : "active",
          clickCount: response.transition.clickCount,
          completedAt: response.transition.completedAt,
          elapsedMs: response.transition.elapsedMs,
        },
        pendingClick: null,
        pendingNavigationTitle: null,
        error: null,
        leaderboardContext: response.leaderboardContext ?? null,
      });
      if (completed) options.gateway.clear();
      return { status: completed ? "completed" : "active", challengeId: pending.challengeId };
    } catch (caught) {
      if (!isCurrent(operation, requestGeneration, mounted)) return { status: "stale" };
      const source = pending.sourceState;
      if (isUnauthorized(caught)) {
        commitState({ ...source, phase: "active", pendingClick: pending, pendingNavigationTitle: null, error: null });
        return { status: "unauthorized", challengeId: pending.challengeId };
      }
      const retryable = isRecoverable(caught);
      const clickErrorMessage = errorMessage(caught, "Could not sync that click.");
      reportVisibleRaceError(options, "click", caught, clickErrorMessage);
      commitState({
        ...source,
        phase: "active",
        pendingClick: retryable ? pending : null,
        pendingNavigationTitle: null,
        error: clickErrorMessage,
      });
      return { status: retryable ? "retryable" : "failed", challengeId: pending.challengeId };
    }
  }, [commitState, now, options.apiClient, options.gateway]);

  const followLink = useCallback(async (
    title: string,
    anchorText: string,
    token: string,
  ): Promise<ClickOutcome> => {
    const snapshot = stateRef.current;
    if (snapshot.phase !== "active" || !snapshot.article || !snapshot.run || !snapshot.session || !snapshot.challenge) {
      return { status: "ignored" };
    }
    if (snapshot.pendingClick) return { status: "ignored" };
    const operation = beginOperation();
    const decisionElapsedMs = Math.round(timer.readElapsed());
    setNavigationRetrying(false);
    commitState({
      ...snapshot,
      phase: "syncing",
      pendingNavigationTitle: anchorText || title,
      error: null,
    });
    try {
      const destinationRequest = options.gateway.getArticle(title, {
        ruleset: snapshot.challenge.ruleset,
        signal: operation.controller.signal,
        onRetry: () => setNavigationRetrying(true),
      });
      prewarmAbort.current?.abort();
      prewarmAbort.current = null;
      prewarmTitle.current = null;
      const destination = await destinationRequest;
      if (!isCurrent(operation, requestGeneration, mounted)) return { status: "stale" };
      const pending: PendingClick = {
        runId: snapshot.run.id,
        challengeId: snapshot.challenge.id,
        destination,
        sourceState: snapshot,
        body: {
          clientEventId: createEventId(),
          expectedStepNumber: snapshot.run.clickCount + 1,
          sourceTitle: snapshot.session.currentPage.canonicalTitle,
          sourcePageId: snapshot.article.pageId,
          sourceRevisionId: snapshot.article.revisionId,
          clickedAnchorText: anchorText,
          requestedTitle: title,
          destinationTitle: destination.canonicalTitle,
          destinationPageId: destination.pageId,
          decisionElapsedMs,
          clientObservedAt: observedAt(),
        },
      };
      commitState({
        ...snapshot,
        phase: "syncing",
        article: destination,
        // Keeps the optimistic "syncing" reveal (article set ahead of
        // server acceptance, per the test above) consistent with the
        // redirect line acceptClick computes on success - both flip
        // together instead of the heading updating a beat before the line.
        redirectedFrom: computeRedirectedFrom(title, destination.canonicalTitle),
        pendingClick: pending,
        pendingNavigationTitle: anchorText || title,
        error: null,
      });
      setNavigationRetrying(false);
      return await acceptClick(pending, token, operation, () => setNavigationRetrying(true));
    } catch (caught) {
      if (!isCurrent(operation, requestGeneration, mounted)) return { status: "stale" };
      const articleErrorMessage = errorMessage(caught, "Could not load that article.");
      reportVisibleRaceError(options, "article", caught, articleErrorMessage);
      commitState({
        ...snapshot,
        phase: "active",
        pendingNavigationTitle: null,
        error: articleErrorMessage,
      });
      return { status: "failed", challengeId: snapshot.challenge.id };
    } finally {
      setNavigationRetrying(false);
    }
  }, [acceptClick, beginOperation, commitState, createEventId, observedAt, options.gateway, timer]);

  const prewarmLink = useCallback((title: string): void => {
    const snapshot = stateRef.current;
    if (
      snapshot.phase !== "active" ||
      snapshot.pendingClick ||
      !snapshot.challenge ||
      !normalizeTitle(title)
    ) {
      return;
    }
    const normalizedTitle = normalizeTitle(title);
    if (
      prewarmTitle.current === normalizedTitle &&
      prewarmAbort.current &&
      !prewarmAbort.current.signal.aborted
    ) {
      return;
    }
    prewarmAbort.current?.abort();
    const controller = new AbortController();
    prewarmAbort.current = controller;
    prewarmTitle.current = normalizedTitle;
    void options.gateway.getArticle(title, {
      ruleset: snapshot.challenge.ruleset,
      signal: controller.signal,
    }).catch(() => undefined);
  }, [options.gateway]);

  const retryPendingClick = useCallback(async (token: string): Promise<ClickOutcome> => {
    const snapshot = stateRef.current;
    const pending = snapshot.pendingClick;
    if (snapshot.phase !== "active" || !pending) return { status: "ignored" };
    const operation = beginOperation();
    setNavigationRetrying(false);
    commitState({
      ...snapshot,
      phase: "syncing",
      pendingNavigationTitle: pending.body.clickedAnchorText || pending.body.requestedTitle,
      error: null,
    });
    try {
      return await acceptClick(pending, token, operation, () => setNavigationRetrying(true));
    } finally {
      setNavigationRetrying(false);
    }
  }, [acceptClick, beginOperation, commitState]);

  const recoverActiveRun = useCallback(async (
    challenges: Challenge[],
    token: string,
  ): Promise<RecoveryOutcome> => {
    const snapshot = stateRef.current;
    const operation = beginOperation();
    commitState({
      ...snapshot,
      phase: "preparing",
      pendingNavigationTitle: null,
      error: null,
    });
    try {
      const run = await options.apiClient.getActiveRun(token);
      if (!isCurrent(operation, requestGeneration, mounted)) return { status: "stale" };
      if (!run) {
        commitState({ ...snapshot, phase: "idle", error: null });
        return { status: "none" };
      }
      const challenge = challenges.find((entry) => entry.id === run.challengeId) ?? null;
      if (!challenge || run.protocolVersion === 1) {
        commitState({
          ...initialState,
          challenge,
          recoveryRun: run,
          error: run.protocolVersion === 1
            ? "End the old run to continue. Protocol 1 runs cannot be resumed."
            : "End the old run because its challenge is no longer available.",
        });
        return { status: "recovery-required", challengeId: challenge?.id ?? null, run };
      }
      const path = await options.apiClient.getActiveRunPath(run.id, token);
      if (!isCurrent(operation, requestGeneration, mounted)) return { status: "stale" };
      const acceptedPage = acceptedLastPage(run, path);
      const article = await options.gateway.getArticle(acceptedPage.title, {
        ruleset: challenge.ruleset,
        signal: operation.controller.signal,
      });
      if (!isCurrent(operation, requestGeneration, mounted)) return { status: "stale" };
      if (!sameAcceptedPage(article, acceptedPage)) {
        commitState({
          ...initialState,
          challenge,
          recoveryRun: run,
          error: "The recovered article did not match the last server-accepted page. End the old run to continue.",
        });
        return { status: "recovery-required", challengeId: challenge.id, run };
      }
      const session = recoveredSession(challenge, run, path, article, now());
      timer.reset(acceptedDecisionBase(path));
      commitState({ ...initialState, phase: "active", challenge, run, article, session });
      return { status: "recovered", challengeId: challenge.id };
    } catch (caught) {
      if (!isCurrent(operation, requestGeneration, mounted)) return { status: "stale" };
      if (isUnauthorized(caught)) {
        commitState({ ...snapshot, phase: "idle", error: null });
        return { status: "unauthorized" };
      }
      const recoveryErrorMessage = errorMessage(caught, "Could not recover the active run.");
      reportVisibleRaceError(options, "recovery", caught, recoveryErrorMessage);
      commitState({
        ...snapshot,
        phase: "idle",
        error: recoveryErrorMessage,
      });
      return { status: "failed" };
    }
  }, [beginOperation, commitState, now, options.apiClient, options.gateway, timer]);

  const endRun = useCallback(async (
    token: string,
    recoveryProtocolVersion?: 1,
  ): Promise<EndRunOutcome> => {
    const snapshot = stateRef.current;
    const run = snapshot.recoveryRun ?? snapshot.run;
    const canEndRecovery = Boolean(snapshot.recoveryRun) && snapshot.phase === "idle";
    const canEndCurrent = !snapshot.recoveryRun &&
      snapshot.phase === "active" &&
      snapshot.pendingClick === null;
    if (
      !run ||
      snapshot.phase === "abandoning" ||
      (!canEndRecovery && !canEndCurrent)
    ) {
      return { status: "ignored" };
    }
    // RC-07 Step 2 (Judge A amend 1 - ported from App.tsx's confirmEndRun,
    // NOT from the "completed" branch a few lines below, which is unrelated
    // to DNF): Recovery's "End Old Run" (a stale/legacy run from this or
    // another device) has no live session/path to show - it resolves
    // straight back to the shell, never a DNF Results screen. Snapshotted
    // BEFORE the abandon call resolves, at the same instant App.tsx's
    // confirmEndRun used to read race.elapsedMs, so a mid-call render can't
    // skew the client-side reading below.
    const isRecoveryEnd = Boolean(snapshot.recoveryRun);
    const acceptedClickCount = snapshot.recoveryRun?.clickCount ?? snapshot.session?.clicks ?? 0;
    const dnfSnapshot: DnfResultSnapshot | null = !isRecoveryEnd && snapshot.challenge
      ? {
          challenge: snapshot.challenge,
          clicks: acceptedClickCount,
          elapsedMs: snapshot.run?.elapsedMs ?? timer.elapsedMs,
          runId: snapshot.run?.id ?? null,
        }
      : null;
    const operation = beginOperation();
    commitState({ ...snapshot, phase: "abandoning", pendingNavigationTitle: null, error: null });
    try {
      const response = await options.apiClient.abandonRun(
        run.id,
        token,
        recoveryProtocolVersion ? { recoveryProtocolVersion } : undefined,
      );
      if (!isCurrent(operation, requestGeneration, mounted)) return { status: "stale" };
      options.gateway.clear();
      if (response.runStatus === "completed") {
        timer.reset(response.elapsedMs ?? timer.readElapsed());
        commitState({
          ...snapshot,
          phase: "completed",
          recoveryRun: null,
          pendingClick: null,
          pendingNavigationTitle: null,
          // A genuine completion is never a DNF, regardless of whatever
          // dnfResult happened to be sitting around from a prior run.
          dnfResult: null,
          session: snapshot.session ? {
            ...snapshot.session,
            status: "completed",
            completedAt: now(),
          } : null,
          run: {
            ...run,
            status: "completed",
            completedAt: response.completedAt,
            elapsedMs: response.elapsedMs,
          },
        });
        return { status: "completed" };
      }
      // PKG-03 (council 2026-07-19): the header/board-row time mismatch
      // ("0:04" vs "0:05") traced to dnfSnapshot using the client's
      // pre-call timer reading while the eventual board row reads the
      // server's own abandoned_at-based elapsedMs. The abandon response
      // now echoes that same server value (see AbandonRunTransition's doc
      // comment) - prefer it here, in the SAME already-in-flight call,
      // rather than a later, separate leaderboard refetch (which would
      // also risk a visible number flip after the Results screen mounts).
      // Falls back to the client snapshot only if an older/legacy response
      // omitted it.
      const resolvedDnfSnapshot = dnfSnapshot && response.elapsedMs !== undefined
        ? { ...dnfSnapshot, elapsedMs: response.elapsedMs }
        : dnfSnapshot;
      // Judge B amend 2: this `clicks > 0` DISPLAY gate is distinct from
      // (and smaller than) MIN_COUNTED_DNF_CLICKS/FB-7's board-visibility
      // threshold, which App.tsx's confirmEndRun still owns separately - a
      // single click still earns the DNF Results screen; only a genuine
      // 0-click voluntary End Run falls back to a plain shell notice.
      const finalDnfResult = resolvedDnfSnapshot && resolvedDnfSnapshot.clicks > 0
        ? resolvedDnfSnapshot
        : null;
      commitState({ ...initialState, dnfResult: finalDnfResult });
      return { status: "abandoned", elapsedMs: response.elapsedMs };
    } catch (caught) {
      if (!isCurrent(operation, requestGeneration, mounted)) return { status: "stale" };
      if (isUnauthorized(caught)) {
        commitState({ ...snapshot, phase: snapshot.recoveryRun ? "idle" : "active", pendingNavigationTitle: null });
        return { status: "unauthorized" };
      }
      const endRunErrorMessage = errorMessage(caught, "Could not end the active run.");
      reportVisibleRaceError(options, "end-run", caught, endRunErrorMessage);
      commitState({
        ...snapshot,
        phase: snapshot.recoveryRun ? "idle" : "active",
        pendingNavigationTitle: null,
        error: endRunErrorMessage,
      });
      return { status: "failed" };
    }
  }, [beginOperation, commitState, now, options.apiClient, options.gateway, timer]);

  const resetCompleted = useCallback((): boolean => {
    // Judge B amend 1: widened from a bare `phase !== "completed"` guard.
    // A plain abandon (the non-recovery branch above) lands on phase
    // "idle" with dnfResult possibly SET - exactly the state the DNF
    // Results screen renders from - so a caller exiting FROM that screen
    // (App.tsx's exitCompletedRaceTo/exitCompletedRaceToChallenge) must
    // still be able to clear it here, not just from "completed". Reset
    // fires whenever there's EITHER a completed run OR a folded dnfResult
    // to clear; a genuinely idle run with nothing to show remains a no-op.
    if (stateRef.current.phase !== "completed" && stateRef.current.dnfResult === null) {
      return false;
    }
    operationAbort.current?.abort();
    operationAbort.current = null;
    prewarmAbort.current?.abort();
    prewarmAbort.current = null;
    prewarmTitle.current = null;
    requestGeneration.current += 1;
    options.gateway.clear();
    timer.reset(0);
    commitState(initialState);
    return true;
  }, [commitState, options.gateway, timer]);

  return {
    ...state,
    pendingRetry: state.pendingClick
      ? { title: state.pendingClick.body.requestedTitle, anchorText: state.pendingClick.body.clickedAnchorText }
      : null,
    elapsedMs: state.run?.elapsedMs ?? timer.elapsedMs,
    navigationRetrying,
    start,
    prewarmLink,
    followLink,
    retryPendingClick,
    recoverActiveRun,
    endRun,
    resetCompleted,
  };
}

interface Operation {
  controller: AbortController;
  generation: number;
}

function isCurrent(
  operation: Operation,
  current: MutableRefObject<number>,
  mounted: MutableRefObject<boolean>,
) {
  return mounted.current &&
    !operation.controller.signal.aborted &&
    operation.generation === current.current;
}

// LK-1: normalizeTitle collapses underscore/space/case differences (the
// same comparison matchesChallengeStart/sameAcceptedPage use below), so a
// plain formatting mismatch like "Foo_bar" -> "Foo bar" never reports a
// redirect - only a genuine Wikipedia redirect to a DIFFERENT title
// (requested !== canonical once both are normalized) does.
function computeRedirectedFrom(requestedTitle: string, canonicalTitle: string): string | null {
  return normalizeTitle(requestedTitle) === normalizeTitle(canonicalTitle) ? null : requestedTitle;
}

function acceptedLastPage(run: ActiveRunRecord, path: ServerPathStep[]) {
  // MB-1 Part 3 (old-Safari compat): Array.prototype.at is Safari 15.4+.
  const last = path[path.length - 1];
  return {
    title: last?.destinationTitle ?? run.lastTitle ?? run.startTitle,
    pageId: last?.destinationPageId ?? run.lastPageId ?? run.startPageId,
  };
}

function matchesChallengeStart(article: Article, challenge: Challenge) {
  if (challenge.start.pageId !== undefined) {
    return article.pageId === challenge.start.pageId;
  }
  return normalizeTitle(article.canonicalTitle) === normalizeTitle(challenge.start.title);
}

function sameAcceptedPage(article: Article, accepted: { title: string; pageId?: number }) {
  if (accepted.pageId !== undefined && article.pageId !== accepted.pageId) return false;
  return normalizeTitle(article.canonicalTitle) === normalizeTitle(accepted.title);
}

function acceptedDecisionBase(path: ServerPathStep[]) {
  // MB-1 Part 3 (old-Safari compat): Array.prototype.at is Safari 15.4+.
  return Math.max(0, path[path.length - 1]?.elapsedSinceStartMs ?? 0);
}

function recoveredSession(
  challenge: Challenge,
  run: ActiveRunRecord,
  path: ServerPathStep[],
  article: Article,
  startedAt: number,
) {
  const session = createGameSession(challenge, startedAt);
  session.currentPage = { canonicalTitle: article.canonicalTitle, pageId: article.pageId };
  session.clicks = run.clickCount;
  session.path = path.map((step) => ({
    sourcePage: { canonicalTitle: step.sourceTitle },
    clickedAnchorText: step.clickedAnchorText,
    requestedTitle: step.destinationTitle,
    resolvedDestination: {
      canonicalTitle: step.destinationTitle,
      pageId: step.destinationPageId,
    },
    timestamp: Date.parse(step.createdAt),
    clickNumber: step.stepNumber,
  }));
  return session;
}

function isUnauthorized(caught: unknown) {
  return errorStatus(caught) === 401 || errorCode(caught) === "unauthorized";
}

function isRecoverable(caught: unknown) {
  const status = errorStatus(caught);
  return status === 0 || status === 408 || status === 429 || status >= 500 ||
    ["network_error", "timeout", "rate_limited"].includes(errorCode(caught) ?? "");
}

function errorStatus(caught: unknown) {
  return caught && typeof caught === "object" && "status" in caught && typeof caught.status === "number"
    ? caught.status
    : 0;
}

function errorCode(caught: unknown): string | null {
  return caught && typeof caught === "object" && "code" in caught && typeof caught.code === "string"
    ? caught.code
    : null;
}

// RC-01 (Judge A amend): prefer `fallback` over the caught error's own
// message whenever the server tagged it `internal_error` - see App.tsx's
// identical copy of this helper for the full rationale (worker.ts's generic
// catch-all "Something went wrong." is never useful to show verbatim, and
// checking `.code` via the existing errorCode() helper above - rather than
// comparing message text - survives that server-side copy ever changing).
function errorMessage(caught: unknown, fallback: string) {
  if (errorCode(caught) === "internal_error") return fallback;
  return caught instanceof Error ? caught.message : fallback;
}

/**
 * Beacons one of this file's five race-flow failures (start/click/article/
 * recovery/end-run) - every one renders verbatim as RaceFlow.tsx's error
 * banner, so `message` here is exactly what the player just saw. `flow`
 * distinguishes which protocol step failed since all five share the single
 * "race-flow" surface (one rendered error banner). A no-op when no reporter
 * was injected (test doubles that don't care about telemetry).
 */
function reportVisibleRaceError(
  options: RaceControllerOptions,
  flow: "start" | "click" | "article" | "recovery" | "end-run",
  caught: unknown,
  message: string,
): void {
  options.errorReporter?.reportVisibleError("race-flow", apiErrorCode(caught), message, { flow });
}
