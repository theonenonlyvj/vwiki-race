import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ChallengePathGraphButton from "./ChallengePathGraphButton";
import type { ChallengePathsResponse } from "../server/contracts";
import type { VWikiRaceApiClient } from "../services/vwikiRaceApiClient";

const fixture: ChallengePathsResponse = {
  totalRuns: 2,
  runs: [
    {
      player: "Fast",
      status: "completed",
      elapsedMs: 3_000,
      clicks: 1,
      steps: [{ n: 1, from: "Start", to: "Target" }],
    },
    {
      player: "Slow",
      status: "completed",
      elapsedMs: 9_000,
      clicks: 2,
      steps: [
        { n: 1, from: "Start", to: "Middle" },
        { n: 2, from: "Middle", to: "Target" },
      ],
    },
  ],
};

function mockApiClient(getChallengePaths: VWikiRaceApiClient["getChallengePaths"]): VWikiRaceApiClient {
  return {
    getChallengePaths,
  } as unknown as VWikiRaceApiClient;
}

describe("ChallengePathGraphButton", () => {
  it("renders nothing when the viewer couldn't see paths - never a locked/disabled affordance", () => {
    render(
      <ChallengePathGraphButton
        apiClient={mockApiClient(vi.fn())}
        errorReporter={{ reportVisibleError: vi.fn() }}
        challengeId="challenge-0001"
        identityToken="token-1"
        unlocked={false}
      />,
    );
    expect(screen.queryByRole("button", { name: /view graph/i })).toBeNull();
  });

  it("renders the subtle 'View graph' affordance once unlocked, opens the modal, fetches on open, and renders the graph from the fixture payload", async () => {
    const getChallengePaths = vi.fn().mockResolvedValue(fixture);
    const user = userEvent.setup();
    render(
      <ChallengePathGraphButton
        apiClient={mockApiClient(getChallengePaths)}
        errorReporter={{ reportVisibleError: vi.fn() }}
        challengeId="challenge-0001"
        identityToken="viewer-token"
        unlocked
      />,
    );

    const trigger = screen.getByRole("button", { name: /^view graph$/i });
    expect(trigger).toHaveClass("link-button");
    expect(getChallengePaths).not.toHaveBeenCalled();

    await user.click(trigger);

    await screen.findByRole("dialog", { name: /everyone's path/i });
    expect(getChallengePaths).toHaveBeenCalledWith("challenge-0001", "viewer-token");
    expect(getChallengePaths).toHaveBeenCalledTimes(1);

    // Legend renders once the fetch resolves - fixture-driven, not fabricated.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /fast/i })).toBeVisible();
    });
    expect(screen.getByRole("button", { name: /slow/i })).toBeVisible();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: /everyone's path/i })).toBeNull();
  });

  it("shows a quiet retry line on a failed fetch, and retries on demand", async () => {
    const getChallengePaths = vi.fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(fixture);
    const errorReporter = { reportVisibleError: vi.fn() };
    const user = userEvent.setup();
    render(
      <ChallengePathGraphButton
        apiClient={mockApiClient(getChallengePaths)}
        errorReporter={errorReporter}
        challengeId="challenge-0001"
        identityToken="viewer-token"
        unlocked
      />,
    );

    await user.click(screen.getByRole("button", { name: /^view graph$/i }));
    expect(await screen.findByText(/couldn't load the graph/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: /^fast$/i })).toBeNull();
    // This package: the rendered failure above beacons through the
    // "path-graph" surface.
    expect(errorReporter.reportVisibleError).toHaveBeenCalledWith(
      "path-graph",
      expect.any(String),
      "Couldn't load the graph.",
    );

    await user.click(screen.getByRole("button", { name: /try again/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /fast/i })).toBeVisible();
    });
    expect(getChallengePaths).toHaveBeenCalledTimes(2);
  });

  // GX-1: every call site (Challenge Detail, Boards, Home, Results) mounts
  // this button inside a clip-path'd panel, which creates a stacking
  // context and traps an inline `.modal-backdrop`'s z-index inside that
  // panel - later page content then paints over the "modal" instead of the
  // other way around (diagnosed with a real browser repro; see ModalDialog's
  // own doc comment for the full mechanism). The fix portals the backdrop
  // straight to `document.body`, so its own parent is `document.body`
  // itself rather than whatever ancestor happened to host the trigger.
  it("portals the modal backdrop to document.body, escaping any clip-path'd ancestor panel", async () => {
    const getChallengePaths = vi.fn().mockResolvedValue(fixture);
    const user = userEvent.setup();
    const { container } = render(
      <div className="leaderboard-panel">
        <ChallengePathGraphButton
          apiClient={mockApiClient(getChallengePaths)}
          errorReporter={{ reportVisibleError: vi.fn() }}
          challengeId="challenge-0001"
          identityToken="viewer-token"
          unlocked
        />
      </div>,
    );

    await user.click(screen.getByRole("button", { name: /^view graph$/i }));
    await screen.findByRole("dialog", { name: /everyone's path/i });

    // Not inside the render container (i.e. not a descendant of the
    // clip-path'd `.leaderboard-panel` it was triggered from)...
    expect(container.querySelector(".modal-backdrop")).toBeNull();
    // ...but mounted directly on document.body instead.
    const backdrop = document.body.querySelector(":scope > .modal-backdrop");
    expect(backdrop).not.toBeNull();
    expect(backdrop?.querySelector('[role="dialog"]')).toHaveClass("graph-modal");
  });

  it("closes via the explicit close button and returns focus to the trigger", async () => {
    const getChallengePaths = vi.fn().mockResolvedValue({ runs: [], totalRuns: 0 });
    const user = userEvent.setup();
    render(
      <ChallengePathGraphButton
        apiClient={mockApiClient(getChallengePaths)}
        errorReporter={{ reportVisibleError: vi.fn() }}
        challengeId="challenge-0001"
        identityToken="viewer-token"
        unlocked
      />,
    );

    const trigger = screen.getByRole("button", { name: /^view graph$/i });
    await user.click(trigger);
    await screen.findByRole("dialog", { name: /everyone's path/i });

    await user.click(screen.getByRole("button", { name: /close graph/i }));
    expect(screen.queryByRole("dialog", { name: /everyone's path/i })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
