export const RUN_EXPIRY_MS = 24 * 60 * 60 * 1000;
export const MAX_RUN_CLICKS = 250;
export const DECISION_TIME_GRACE_MS = 5_000;

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
}

export interface CreateChallengeRequestFingerprintInput {
  startTitle: string;
  targetTitle: string;
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
  return sha256(JSON.stringify({
    startTitle: input.startTitle,
    startPageId: input.startPageId,
    startAllowedLinkCount: input.startAllowedLinkCount,
    targetTitle: input.targetTitle,
    targetPageId: input.targetPageId,
  }));
}

export function fingerprintCreateChallengeRequest(
  input: CreateChallengeRequestFingerprintInput,
): Promise<string> {
  return sha256(JSON.stringify({
    startTitle: input.startTitle.trim(),
    targetTitle: input.targetTitle.trim(),
  }));
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
