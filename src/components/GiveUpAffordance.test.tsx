import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import GiveUpAffordance from "./GiveUpAffordance";
import type { VWikiRaceApiClient } from "../services/vwikiRaceApiClient";

function mockApiClient(giveUpChallenge: VWikiRaceApiClient["giveUpChallenge"]): VWikiRaceApiClient {
  return { giveUpChallenge } as unknown as VWikiRaceApiClient;
}

describe("GiveUpAffordance (\"I gave up\", owner spec 2026-08-02)", () => {
  it("renders nothing without a real identity token, even before any click", () => {
    render(
      <GiveUpAffordance
        apiClient={mockApiClient(vi.fn())}
        errorReporter={{ reportVisibleError: vi.fn() }}
        challengeId="challenge-0001"
        identityToken={null}
        onPeeked={vi.fn()}
      />,
    );
    expect(screen.queryByText(/i give up/i)).toBeNull();
  });

  it("renders the collapsed muted link-button by default - no confirm copy visible yet", () => {
    render(
      <GiveUpAffordance
        apiClient={mockApiClient(vi.fn())}
        errorReporter={{ reportVisibleError: vi.fn() }}
        challengeId="challenge-0001"
        identityToken="jwt-1"
        onPeeked={vi.fn()}
      />,
    );

    const trigger = screen.getByRole("button", { name: /i give up — show me the solution/i });
    expect(trigger).toHaveClass("link-button");
    expect(trigger).toHaveClass("muted");
    expect(screen.queryByText(/boards close for you/i)).toBeNull();
  });

  it("clicking it reveals the exact confirm copy and both actions, without calling the API yet", async () => {
    const giveUpChallenge = vi.fn();
    const user = userEvent.setup();
    render(
      <GiveUpAffordance
        apiClient={mockApiClient(giveUpChallenge)}
        errorReporter={{ reportVisibleError: vi.fn() }}
        challengeId="challenge-0001"
        identityToken="jwt-1"
        onPeeked={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /i give up/i }));

    expect(screen.getByText(
      "See the solution? This challenge's boards close for you — future runs won't rank.",
    )).toBeVisible();
    expect(screen.getByRole("button", { name: /yes, show me/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeVisible();
    expect(giveUpChallenge).not.toHaveBeenCalled();
  });

  it("cancel collapses back to the plain link-button without calling the API", async () => {
    const giveUpChallenge = vi.fn();
    const user = userEvent.setup();
    render(
      <GiveUpAffordance
        apiClient={mockApiClient(giveUpChallenge)}
        errorReporter={{ reportVisibleError: vi.fn() }}
        challengeId="challenge-0001"
        identityToken="jwt-1"
        onPeeked={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /i give up/i }));
    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(screen.getByRole("button", { name: /i give up — show me the solution/i })).toBeVisible();
    expect(screen.queryByText(/boards close for you/i)).toBeNull();
    expect(giveUpChallenge).not.toHaveBeenCalled();
  });

  it("confirming calls giveUpChallenge with the exact challengeId/token and fires onPeeked on success", async () => {
    const giveUpChallenge = vi.fn().mockResolvedValue({ challengeId: "challenge-0001", peeked: true });
    const onPeeked = vi.fn();
    const user = userEvent.setup();
    render(
      <GiveUpAffordance
        apiClient={mockApiClient(giveUpChallenge)}
        errorReporter={{ reportVisibleError: vi.fn() }}
        challengeId="challenge-0001"
        identityToken="jwt-1"
        onPeeked={onPeeked}
      />,
    );

    await user.click(screen.getByRole("button", { name: /i give up/i }));
    await user.click(screen.getByRole("button", { name: /yes, show me/i }));

    await waitFor(() => expect(giveUpChallenge).toHaveBeenCalledWith("challenge-0001", "jwt-1"));
    await waitFor(() => expect(onPeeked).toHaveBeenCalledTimes(1));
  });

  it("shows a busy label while the request is in flight and disables both buttons", async () => {
    let resolveGiveUp: (value: { challengeId: string; peeked: true }) => void = () => {};
    const giveUpChallenge = vi.fn(() => new Promise<{ challengeId: string; peeked: true }>((resolve) => {
      resolveGiveUp = resolve;
    }));
    const user = userEvent.setup();
    render(
      <GiveUpAffordance
        apiClient={mockApiClient(giveUpChallenge)}
        errorReporter={{ reportVisibleError: vi.fn() }}
        challengeId="challenge-0001"
        identityToken="jwt-1"
        onPeeked={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /i give up/i }));
    await user.click(screen.getByRole("button", { name: /yes, show me/i }));

    const busyButton = await screen.findByRole("button", { name: /giving up…/i });
    expect(busyButton).toBeDisabled();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeDisabled();

    resolveGiveUp({ challengeId: "challenge-0001", peeked: true });
  });

  it("shows the server's real rejection message (give_up_not_eligible) on failure, never calls onPeeked, and lets the caller retry", async () => {
    const giveUpChallenge = vi.fn()
      .mockRejectedValueOnce(new Error("Give up unlocks after a real attempt on this challenge."))
      .mockResolvedValueOnce({ challengeId: "challenge-0001", peeked: true });
    const onPeeked = vi.fn();
    const errorReporter = { reportVisibleError: vi.fn() };
    const user = userEvent.setup();
    render(
      <GiveUpAffordance
        apiClient={mockApiClient(giveUpChallenge)}
        errorReporter={errorReporter}
        challengeId="challenge-0001"
        identityToken="jwt-1"
        onPeeked={onPeeked}
      />,
    );

    await user.click(screen.getByRole("button", { name: /i give up/i }));
    await user.click(screen.getByRole("button", { name: /yes, show me/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Give up unlocks after a real attempt on this challenge.",
    );
    expect(onPeeked).not.toHaveBeenCalled();
    // This package: the rendered failure above beacons through the
    // "give-up" surface.
    expect(errorReporter.reportVisibleError).toHaveBeenCalledWith(
      "give-up",
      expect.any(String),
      "Give up unlocks after a real attempt on this challenge.",
    );

    // Retrying (still confirming) succeeds the second time.
    await user.click(screen.getByRole("button", { name: /yes, show me/i }));
    await waitFor(() => expect(onPeeked).toHaveBeenCalledTimes(1));
  });

  it("falls back to a generic message for a non-Error rejection", async () => {
    const giveUpChallenge = vi.fn().mockRejectedValue("not an Error instance");
    const user = userEvent.setup();
    render(
      <GiveUpAffordance
        apiClient={mockApiClient(giveUpChallenge)}
        errorReporter={{ reportVisibleError: vi.fn() }}
        challengeId="challenge-0001"
        identityToken="jwt-1"
        onPeeked={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /i give up/i }));
    await user.click(screen.getByRole("button", { name: /yes, show me/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't record that. Try again.");
  });

  it("cancel after a failed attempt clears the error and collapses", async () => {
    const giveUpChallenge = vi.fn().mockRejectedValue(new Error("nope"));
    const user = userEvent.setup();
    render(
      <GiveUpAffordance
        apiClient={mockApiClient(giveUpChallenge)}
        errorReporter={{ reportVisibleError: vi.fn() }}
        challengeId="challenge-0001"
        identityToken="jwt-1"
        onPeeked={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /i give up/i }));
    await user.click(screen.getByRole("button", { name: /yes, show me/i }));
    await screen.findByRole("alert");

    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(screen.getByRole("button", { name: /i give up — show me the solution/i })).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
