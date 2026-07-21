import { describe, expect, it } from "vitest";
import { pathStepsToChain } from "./winningPath";
import type { ServerPathStep } from "./types";

function step(override: Partial<ServerPathStep> = {}): ServerPathStep {
  return {
    stepNumber: 1,
    sourceTitle: "Pizza",
    clickedAnchorText: "Latin",
    destinationTitle: "Latin",
    createdAt: "2026-07-20T00:00:00.000Z",
    ...override,
  };
}

describe("pathStepsToChain", () => {
  it("collapses a single hop into its two endpoints", () => {
    expect(pathStepsToChain([step({ sourceTitle: "Apple", destinationTitle: "Fruit" })]))
      .toEqual(["Apple", "Fruit"]);
  });

  it("collapses multi-hop pairs into one chain with each interim article exactly once", () => {
    // Old pair rendering: "Pizza → Latin", "Latin → Roman Empire" - "Latin"
    // printed twice. The chain form lists it once, as the interim link.
    const steps: ServerPathStep[] = [
      step({ stepNumber: 1, sourceTitle: "Pizza", destinationTitle: "Latin" }),
      step({ stepNumber: 2, sourceTitle: "Latin", destinationTitle: "Roman Empire" }),
    ];

    const chain = pathStepsToChain(steps);

    expect(chain).toEqual(["Pizza", "Latin", "Roman Empire"]);
    expect(chain.filter((title) => title === "Latin")).toHaveLength(1);
  });

  it("returns an empty chain for an empty path rather than a stray title", () => {
    expect(pathStepsToChain([])).toEqual([]);
  });
});
