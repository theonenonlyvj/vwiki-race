import { describe, expect, it } from "vitest";
import {
  clickOperationKey,
  fingerprintAbandonRun,
  fingerprintGiveUpChallenge,
  fingerprintRunClick,
  fingerprintStartRun,
  MIN_GIVE_UP_CLICKS,
  MIN_GIVE_UP_WALL_MS,
} from "./runProtocol";

describe("run protocol fingerprints", () => {
  it("hashes start requests with a fixed canonical field order", async () => {
    await expect(
      fingerprintStartRun({
        idempotencyKey: "start-key-is-not-fingerprinted",
        challengeId: "challenge-0001",
      }),
    ).resolves.toBe(
      "1720e0972cc7bbe7296452470f7d1161070cb62b4b612e940dd007ec4c885e11",
    );
  });

  it("hashes every click decision field without account or token material", async () => {
    const click = {
      runId: "run-1",
      clientEventId: "00000000-0000-4000-8000-000000000001",
      expectedStepNumber: 1,
      sourceTitle: "Moon",
      sourcePageId: 19331,
      sourceRevisionId: undefined,
      clickedAnchorText: "gravity",
      requestedTitle: "Gravity",
      destinationTitle: "Gravity",
      destinationPageId: 38579,
      decisionElapsedMs: 4200,
      clientObservedAt: "2026-07-14T01:00:04.200Z",
    };

    await expect(fingerprintRunClick(click)).resolves.toBe(
      "11ee36f65a77abedd0cbd77bbfc25dc0d9dd97c95c1f178d243abb911c92c2a3",
    );
    expect(clickOperationKey(click.runId, click.clientEventId)).toBe(
      "click:run-1:00000000-0000-4000-8000-000000000001",
    );
  });

  it("distinguishes protocol-1 recovery abandonment from normal abandonment", async () => {
    const normal = await fingerprintAbandonRun({
      runId: "run-1",
      idempotencyKey: "abandon-key",
    });
    const recovery = await fingerprintAbandonRun({
      runId: "run-1",
      idempotencyKey: "abandon-key",
      recoveryProtocolVersion: 1,
    });

    expect(recovery).not.toBe(normal);
  });

  it("\"I gave up\" (owner spec, 2026-08-02): fingerprints give-up requests by challenge only, deterministically", async () => {
    const first = await fingerprintGiveUpChallenge({ challengeId: "challenge-0001" });
    const second = await fingerprintGiveUpChallenge({ challengeId: "challenge-0001" });
    const different = await fingerprintGiveUpChallenge({ challengeId: "challenge-0002" });

    expect(first).toBe(second);
    expect(first).not.toBe(different);
  });

  it("\"I gave up\" thresholds are distinct constants from FB-7's MIN_COUNTED_DNF_CLICKS, per the give-up-specific 'real attempt' bar", () => {
    expect(MIN_GIVE_UP_CLICKS).toBe(5);
    expect(MIN_GIVE_UP_WALL_MS).toBe(180_000);
  });
});
