import type { ServerPathStep } from "./types";

/**
 * Collapses a run's hop-pair steps ("Pizza→Latin", "Latin→Roman Empire", ...)
 * into the single ordered chain of articles they describe (`["Pizza",
 * "Latin", "Roman Empire"]`). Every interim article is both the destination
 * of one hop and the source of the next, so the old per-surface rendering
 * that printed each step as its own "source → destination" pair showed it
 * twice - owner feedback on a Challenge Detail screenshot (2026-07-20):
 * "listing each interim twice feels redundant." `steps` is already in
 * `stepNumber` order (server contract); an empty path collapses to an empty
 * chain rather than a single stray title.
 */
export function pathStepsToChain(steps: ServerPathStep[]): string[] {
  if (steps.length === 0) return [];
  return [steps[0].sourceTitle, ...steps.map((step) => step.destinationTitle)];
}
