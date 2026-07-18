import type { Challenge } from "./types";

export type DailyFlavor = "recognizable" | "weird" | "hard";
export type DailySelectionSource = "automatic" | "community" | "admin";

export interface DailyFeature {
  dailyDate: string;
  flavor: DailyFlavor;
  selectionSource: DailySelectionSource;
}

export interface DailyClassification {
  recognizableScore: number | null;
  weirdScore: number | null;
  hardScore: number | null;
  suggestedFlavor: DailyFlavor | null;
  confidence: "high" | "medium" | "low" | "unclassified";
  classifierVersion: string;
}

export interface DailyNomination extends DailyClassification {
  id: string;
  challengeId: string;
  nominatedByAccountId: string;
  nominatedByDisplayName: string;
  status: "pending" | "approved" | "declined";
  reviewedByAccountId: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DailyQueueEntry {
  id: string;
  challengeId: string;
  nominationId: string | null;
  flavor: DailyFlavor;
  source: "community" | "admin";
  status: "queued" | "consumed" | "removed" | "invalid";
  queuedByAccountId: string;
  queuedAt: string;
  consumedDailyDate: string | null;
  consumedAt: string | null;
  updatedAt: string;
}

export type ChallengeCreationDisposition = "created" | "existing";
export type NominationDisposition =
  | "not_requested"
  | "pending"
  | "already_exists"
  | "previously_featured"
  | "account_required";

export interface CreateChallengeOutcome {
  challenge: Challenge;
  disposition: ChallengeCreationDisposition;
  nomination: NominationDisposition;
}

/**
 * Display label for a Daily flavor ("recognizable"/"weird"/"hard" ->
 * "Recognizable"/"Weird"/"Hard") - shared by AdminDailies' queue/direct-
 * promotion UI and Home's daily hero badge (UX redesign spec: "flavor badge
 * from dailyFeature").
 */
export function dailyFlavorLabel(flavor: DailyFlavor): string {
  return `${flavor.slice(0, 1).toUpperCase()}${flavor.slice(1)}`;
}

export function dailyFlavorForCentralDate(date: string): DailyFlavor {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("A Central calendar date in YYYY-MM-DD format is required.");
  }

  const parsed = new Date(`${date}T12:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error("A valid Central calendar date is required.");
  }

  const weekday = parsed.getUTCDay();
  if (weekday === 0 || weekday === 6) return "hard";
  if (weekday === 4 || weekday === 5) return "weird";
  return "recognizable";
}
