import { describe, expect, it } from "vitest";
import { challengeHeading, humanChallengeCreator } from "./challengePresentation";
import type { Challenge } from "./types";
const challenge: Challenge = { id: "challenge-test", label: "Challenge", mode: "daily", origin: "daily", dailyDate: "2026-07-18", start: { title: "Moon" }, target: { title: "Gravity" }, ruleset: "ranked_classic", source: "curated" };
describe("Challenge provenance", () => {
  it("uses a calendar date for Daily titles", () => expect(challengeHeading(challenge)).toBe("Daily 7/18/26"));
  it("hides only the system account, retaining human credit on promoted dailies", () => {
    expect(humanChallengeCreator({ ...challenge, createdBy: { accountId: "vwiki-race:daily", displayName: "VWiki Race", identityStatus: "claimed" } })).toBeNull();
    expect(humanChallengeCreator({ ...challenge, createdBy: { accountId: "human", displayName: "VWiki Race", identityStatus: "claimed" } })).toBe("VWiki Race");
  });
});
