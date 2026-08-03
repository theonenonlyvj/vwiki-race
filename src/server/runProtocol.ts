export const RUN_EXPIRY_MS = 24 * 60 * 60 * 1000;
export const MAX_RUN_CLICKS = 250;
export const DECISION_TIME_GRACE_MS = 5_000;
// Below this many clicks, a protocol-2 active run is a transient "ghost"
// that startRunV2 auto-abandons on a fresh Start so it doesn't dead-end a
// new attempt. RC-02 (owner-proxy ruling, "no silent run loss", root-cause
// fix, 2026-07-24): this NO LONGER gates findActiveRun/GET
// /api/v2/runs/active - that query must surface every active run
// regardless of click_count, or a mid-race reload after 0/1 clicks silently
// loses the run (journey8). Conflating "is there an active run" with "is
// this run worth auto-abandoning on a new start" was the original bug;
// they're kept as one constant here only because both auto-abandon
// thresholds happen to share the same value today, not because they're the
// same concept - see MIN_COUNTED_DNF_CLICKS below for the (also distinct)
// read-side "did this count as playing" gate.
export const MIN_RESUMABLE_CLICKS = 2;
// FB-7 (owner ruling, 2026-07-19: "hide DNF runs [that] don't involve >1
// click from the start. those dont really even count, no?"): a DNF only
// counts as a real attempt - board-visible, played for
// streak/trend/guard/roster-adjacent purposes - at this many clicks or more.
// Below it, a DNF is usually an accidental open, the same artifact family as
// the phantom "in progress" runs already fixed elsewhere. Completed runs
// always count regardless of clicks; this only gates DNFs. Shares
// `MIN_RESUMABLE_CLICKS`'s value but is a distinct concept (this gates
// read-side "did this count as playing," not write-side active-run
// visibility) - kept as its own named constant so the two can diverge later
// without silently coupling.
export const MIN_COUNTED_DNF_CLICKS = 2;

// "I gave up" affordance (owner spec, 2026-08-02: "I don't want to be
// encouraging people to give up" - no in-race button; the affordance lives
// POST-RUN, gated on a REAL attempt, not a cursory one). A DNF only
// qualifies an account for the give-up affordance on a challenge once it
// clears BOTH: FB-7's `MIN_COUNTED_DNF_CLICKS` floor (it must already be a
// counted attempt) AND one of these two "real attempt" thresholds - a
// player who genuinely worked the puzzle for a while (many clicks) or spent
// real wall-clock time on it (even with few clicks - reading, thinking)
// both count. Deliberately separate constants from `MIN_COUNTED_DNF_CLICKS`
// (same distinct-constants-even-when-values-could-drift convention as
// `MIN_RESUMABLE_CLICKS` above) - this gate answers "have they earned the
// right to peek," not "does this count as playing at all."
export const MIN_GIVE_UP_CLICKS = 5;
export const MIN_GIVE_UP_WALL_MS = 180_000;

export interface GiveUpChallengeInput {
  challengeId: string;
  idempotencyKey: string;
}

export interface StartRunV2Input {
  challengeId: string;
  idempotencyKey: string;
}

export interface CreateChallengeV2FingerprintInput {
  startTitle: string;
  startPageId: number;
  startAllowedLinkCount: number;
  targetTitle: string;
  targetPageId: number;
  nominateForDaily?: boolean;
}

export interface CreateChallengeRequestFingerprintInput {
  startTitle: string;
  targetTitle: string;
  nominateForDaily?: boolean;
}

export interface RecordClickV2Input {
  runId: string;
  clientEventId: string;
  expectedStepNumber: number;
  sourceTitle: string;
  sourcePageId: number;
  sourceRevisionId?: number;
  clickedAnchorText: string;
  requestedTitle: string;
  destinationTitle: string;
  destinationPageId: number;
  decisionElapsedMs: number;
  clientObservedAt?: string;
}

export interface AbandonRunV2Input {
  runId: string;
  idempotencyKey: string;
  recoveryProtocolVersion?: 1;
}

export function fingerprintStartRun(input: StartRunV2Input): Promise<string> {
  return sha256(JSON.stringify({ challengeId: input.challengeId }));
}

export function fingerprintCreateChallenge(
  input: CreateChallengeV2FingerprintInput,
): Promise<string> {
  const payload: Record<string, unknown> = {
    startTitle: input.startTitle,
    startPageId: input.startPageId,
    startAllowedLinkCount: input.startAllowedLinkCount,
    targetTitle: input.targetTitle,
    targetPageId: input.targetPageId,
  };
  if (input.nominateForDaily === true) payload.nominateForDaily = true;
  return sha256(JSON.stringify(payload));
}

export function fingerprintCreateChallengeRequest(
  input: CreateChallengeRequestFingerprintInput,
): Promise<string> {
  const payload: Record<string, unknown> = {
    startTitle: input.startTitle.trim(),
    targetTitle: input.targetTitle.trim(),
  };
  if (input.nominateForDaily === true) payload.nominateForDaily = true;
  return sha256(JSON.stringify(payload));
}

export async function legacyCreateOperationKey(
  accountId: string,
  input: CreateChallengeRequestFingerprintInput,
): Promise<string> {
  const fingerprint = await sha256(JSON.stringify({
    accountId: accountId.trim(),
    startTitle: input.startTitle.trim(),
    targetTitle: input.targetTitle.trim(),
  }));
  return `legacy-create:${fingerprint}`;
}

export function fingerprintRunClick(input: RecordClickV2Input): Promise<string> {
  return sha256(JSON.stringify({
    runId: input.runId,
    clientEventId: input.clientEventId,
    expectedStepNumber: input.expectedStepNumber,
    sourceTitle: input.sourceTitle,
    sourcePageId: input.sourcePageId,
    sourceRevisionId: input.sourceRevisionId ?? null,
    clickedAnchorText: input.clickedAnchorText,
    requestedTitle: input.requestedTitle,
    destinationTitle: input.destinationTitle,
    destinationPageId: input.destinationPageId,
    decisionElapsedMs: input.decisionElapsedMs,
    clientObservedAt: input.clientObservedAt ?? null,
  }));
}

export function fingerprintAbandonRun(input: AbandonRunV2Input): Promise<string> {
  return sha256(JSON.stringify({
    runId: input.runId,
    recoveryProtocolVersion: input.recoveryProtocolVersion ?? null,
  }));
}

export function fingerprintGiveUpChallenge(
  input: { challengeId: string },
): Promise<string> {
  return sha256(JSON.stringify({ challengeId: input.challengeId }));
}

export function clickOperationKey(runId: string, clientEventId: string): string {
  return `click:${runId}:${clientEventId}`;
}

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
