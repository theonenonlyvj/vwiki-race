import { dailyDateForChallenge } from "./challengeSelection";
import type { Challenge } from "./types";

export function challengeHeading(challenge: Challenge): string {
  const date = dailyDateForChallenge(challenge);
  if (!date) return challenge.label ?? challenge.id;
  const [year, month, day] = date.split("-");
  return `Daily ${Number(month)}/${Number(day)}/${year.slice(-2)}`;
}

export function humanChallengeCreator(challenge: Challenge): string | null {
  const creator = challenge.createdBy;
  return creator && creator.accountId !== "vwiki-race:daily" ? creator.displayName : null;
}
