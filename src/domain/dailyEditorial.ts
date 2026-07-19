import type { Challenge } from "./types";

export type DailyFlavor = "recognizable" | "weird" | "hard";
export type DailySelectionSource = "automatic" | "community" | "admin";

export interface DailyFeature {
  dailyDate: string;
  flavor: DailyFlavor;
  selectionSource: DailySelectionSource;
  /**
   * PKG-07 (council 2026-07-19, owner-proxy ruling): this daily's 1-indexed
   * position in calendar-date order among ALL dailies ever run - "DAILY #7"
   * in every ratified mockup (mockup-home-stateful-v2, mockup-target-
   * preview, mockup-boards-trends). Server-computed
   * (d1TrackingRepository's `mapChallengeRow`: `COUNT(daily_features WHERE
   * daily_date <= this.daily_date)`, a permanent count against
   * `daily_features` itself, never the client's active-only challenge
   * catalog - Home/Boards' own comments document that the catalog silently
   * drops a daily once its day passes, so counting through it client-side
   * would drift as entries age out and could disagree between two clients
   * loaded at different trim states). Optional because it postdates this
   * field's introduction - older fixtures/responses may not carry it;
   * every renderer using it must degrade gracefully (omit the "#N"
   * fragment) rather than show "Daily #undefined".
   */
  dailyNumber?: number;
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

/**
 * The "Daily #N" fragment on its own (PKG-07: composeShareText,
 * shared.tsx, leads a daily's share line with exactly this). `null` when
 * `dailyNumber` hasn't loaded/isn't known - callers omit the fragment
 * rather than render a placeholder.
 */
export function dailyNumberLabel(dailyNumber: number | null | undefined): string | null {
  return typeof dailyNumber === "number" ? `Daily #${dailyNumber}` : null;
}

/**
 * The shared daily badge text - Home's hero, Boards' Today segment, and
 * the pre-race preview all compose their `.daily-badge` pill through this
 * one function (PKG-07, council 2026-07-19, owner-proxy ruling) so the
 * three can't independently drift on format the way the flavor-only badge
 * used to (each screen inlined its own near-identical template literal).
 * `framing: "yesterday"` reproduces Home/Boards' pre-drop "Yesterday's
 * daily · <Flavor>" copy exactly (FIX 4); `"today"` is the plain flavor
 * badge used everywhere else, including Preview (which has no yesterday-
 * specific framing of its own). The "Daily #N" suffix only appears once
 * `dailyFeature.dailyNumber` is known (see `dailyNumberLabel`) - with it
 * absent, this reduces to exactly the pre-PKG-07 text, so an older fixture
 * or test that hasn't been updated to carry `dailyNumber` keeps rendering
 * identically.
 */
export function dailyFlavorBadgeText(
  dailyFeature: Pick<DailyFeature, "flavor" | "dailyNumber">,
  framing: "today" | "yesterday" = "today",
): string {
  const flavorText = dailyFlavorLabel(dailyFeature.flavor);
  const numberLabel = dailyNumberLabel(dailyFeature.dailyNumber);
  if (framing === "yesterday") {
    const base = `Yesterday's daily · ${flavorText}`;
    return numberLabel ? `${base} · ${numberLabel}` : base;
  }
  return numberLabel ? `${flavorText} · ${numberLabel}` : flavorText;
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
