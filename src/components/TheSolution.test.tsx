import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import TheSolution from "./TheSolution";
import type { ChallengePathsResponse } from "../server/contracts";
import type { VWikiRaceApiClient } from "../services/vwikiRaceApiClient";

function mockApiClient(getChallengePaths: VWikiRaceApiClient["getChallengePaths"]): VWikiRaceApiClient {
  return { getChallengePaths } as unknown as VWikiRaceApiClient;
}

describe("TheSolution (\"I gave up\" solution view, owner spec 2026-08-02)", () => {
  it("fetches with the caller's challengeId/token exactly once on mount", async () => {
    const getChallengePaths = vi.fn(async () => ({ runs: [], totalRuns: 0, referencePath: null }));
    render(
      <TheSolution
        apiClient={mockApiClient(getChallengePaths)}
        errorReporter={{ reportVisibleError: vi.fn() }}
        challengeId="challenge-0007"
        identityToken="viewer-token"
      />,
    );

    await screen.findByText(/no one/i);
    expect(getChallengePaths).toHaveBeenCalledWith("challenge-0007", "viewer-token");
    expect(getChallengePaths).toHaveBeenCalledTimes(1);
  });

  it("stages an honest error + Retry on a failed fetch, and recovers on retry", async () => {
    const getChallengePaths = vi.fn<VWikiRaceApiClient["getChallengePaths"]>()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce({ runs: [], totalRuns: 0, referencePath: null });
    const errorReporter = { reportVisibleError: vi.fn() };
    const user = userEvent.setup();
    render(
      <TheSolution
        apiClient={mockApiClient(getChallengePaths)}
        errorReporter={errorReporter}
        challengeId="challenge-0001"
        identityToken="viewer-token"
      />,
    );

    expect(await screen.findByText(/couldn.t load the solution/i)).toBeVisible();
    // This package: the rendered failure above beacons through the
    // "the-solution" surface.
    expect(errorReporter.reportVisibleError).toHaveBeenCalledWith(
      "the-solution",
      expect.any(String),
      "Couldn't load the solution.",
    );
    await user.click(screen.getByRole("button", { name: /retry/i }));

    expect(await screen.findByText(/no one/i)).toBeVisible();
    expect(getChallengePaths).toHaveBeenCalledTimes(2);
  });

  it("re-fetches when challengeId changes, resetting to a clean loading state (no stale content leaks across a switch)", async () => {
    let resolveFirst: (value: ChallengePathsResponse) => void = () => {};
    const getChallengePaths = vi.fn<VWikiRaceApiClient["getChallengePaths"]>()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({
        runs: [{
          player: "Fast", status: "completed", elapsedMs: 1000, clicks: 1,
          steps: [{ n: 1, from: "Start", to: "Target" }],
        }],
        totalRuns: 1,
      });
    const { rerender } = render(
      <TheSolution
        apiClient={mockApiClient(getChallengePaths)}
        errorReporter={{ reportVisibleError: vi.fn() }}
        challengeId="challenge-0001"
        identityToken="viewer-token"
      />,
    );

    rerender(
      <TheSolution
        apiClient={mockApiClient(getChallengePaths)}
        errorReporter={{ reportVisibleError: vi.fn() }}
        challengeId="challenge-0002"
        identityToken="viewer-token"
      />,
    );

    await screen.findByText("Start");
    expect(getChallengePaths).toHaveBeenCalledWith("challenge-0002", "viewer-token");

    // The first (never-resolved, cancelled) fetch resolving late must not
    // clobber the second challenge's already-rendered content.
    await act(async () => {
      resolveFirst({ runs: [], totalRuns: 0, referencePath: null });
    });
    expect(screen.getByText("Start")).toBeVisible();
  });
});
