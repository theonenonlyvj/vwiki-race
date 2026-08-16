import { describe, expect, it } from "vitest";
import { labelIsRevealOnly, type LabelVisibilityInput } from "./labelVisibility";

function node(overrides: Partial<LabelVisibilityInput> = {}): LabelVisibilityInput {
  return {
    alwaysLabel: false,
    showLabelDesktop: false,
    crowdedOut: false,
    isMobile: false,
    isPortrait: false,
    ...overrides,
  };
}

describe("labelIsRevealOnly", () => {
  it("shows an anchor or merge-point label by default", () => {
    expect(labelIsRevealOnly(node({ alwaysLabel: true }))).toBe(false);
  });

  it("shows a breadcrumb label that the A4 policy selected", () => {
    expect(labelIsRevealOnly(node({ showLabelDesktop: true }))).toBe(false);
  });

  it("hides a solo interim label the A4 policy did not select", () => {
    expect(labelIsRevealOnly(node())).toBe(true);
  });

  // The bug this pins: `revealOnly` used to start `!alwaysLabel && ...`, so a
  // SHARED node whose label the placer could not fit still rendered - at its
  // fallback position, printed straight over a neighbour. Crowding has to win
  // over importance, because the whole point of marking a label crowded out is
  // that there is nowhere for it to go.
  it("hides even an always-label node when the placer found nowhere to put it", () => {
    expect(labelIsRevealOnly(node({ alwaysLabel: true, crowdedOut: true }))).toBe(true);
  });

  it("hides a crowded-out breadcrumb too", () => {
    expect(labelIsRevealOnly(node({ showLabelDesktop: true, crowdedOut: true }))).toBe(true);
  });

  // A8's blanket narrow-viewport suppression only ever made sense for the old
  // squeezed overview, where labels rendered at ~3px. The portrait canvas
  // renders them at 10-13px.
  it("suppresses solo labels on a narrow LANDSCAPE viewport", () => {
    expect(labelIsRevealOnly(node({ showLabelDesktop: true, isMobile: true }))).toBe(true);
  });

  it("keeps selected labels on the portrait canvas at the same width", () => {
    expect(
      labelIsRevealOnly(node({ showLabelDesktop: true, isMobile: true, isPortrait: true })),
    ).toBe(false);
  });
});
