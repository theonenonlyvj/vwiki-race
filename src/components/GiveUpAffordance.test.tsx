import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import GiveUpAffordance from "./GiveUpAffordance";
import type { VWikiRaceApiClient } from "../services/vwikiRaceApiClient";

function mockApiClient(giveUpChallenge: VWikiRaceApiClient["giveUpChallenge"]): VWikiRaceApiClient {
  return { giveUpChallenge } as unknown as VWikiRaceApiClient;
}

describe("GiveUpAffordance", () => {
  it("renders nothing without a real identity token, even before any click", () => {
    render(
      <GiveUpAffordance
        eligible
        onRace={vi.fn()}
        apiClient={mockApiClient(vi.fn())}
        errorReporter={{ reportVisibleError: vi.fn() }}
        challengeId="challenge-0001"
        identityToken={null}
        onPeeked={vi.fn()}
      />,
    );
    expect(screen.queryByText(/show me the answers/i)).toBeNull();
  });

  it("renders the collapsed muted link-button by default - no confirm copy visible yet", () => {
    render(
      <GiveUpAffordance
        eligible
        onRace={vi.fn()}
        apiClient={mockApiClient(vi.fn())}
        errorReporter={{ reportVisibleError: vi.fn() }}
        challengeId="challenge-0001"
        identityToken="jwt-1"
        onPeeked={vi.fn()}
      />,
    );

    const trigger = screen.getByRole("button", { name: /show me the answers/i });
    expect(trigger).toHaveClass("link-button");
    expect(trigger).toHaveClass("muted");
    expect(screen.queryByText(/future attempts on this challenge/i)).toBeNull();
  });

  it("clicking it reveals the exact confirm copy and both actions, without calling the API yet", async () => {
    const giveUpChallenge = vi.fn();
    const user = userEvent.setup();
    render(
      <GiveUpAffordance
        eligible
        onRace={vi.fn()}
        apiClient={mockApiClient(giveUpChallenge)}
        errorReporter={{ reportVisibleError: vi.fn() }}
        challengeId="challenge-0001"
        identityToken="jwt-1"
        onPeeked={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /show me the answers/i }));

    expect(screen.getByText(
      "Future attempts on this challenge won't rank. You can still play for practice.",
    )).toBeVisible();
    expect(screen.getByRole("dialog", { name: /show me the answers/i })).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("button", { name: /yes, show me/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeVisible();
    expect(giveUpChallenge).not.toHaveBeenCalled();
  });

  it("cancel collapses back to the plain link-button without calling the API", async () => {
    const giveUpChallenge = vi.fn();
    const user = userEvent.setup();
    render(
      <GiveUpAffordance
        eligible
        onRace={vi.fn()}
        apiClient={mockApiClient(giveUpChallenge)}
        errorReporter={{ reportVisibleError: vi.fn() }}
        challengeId="challenge-0001"
        identityToken="jwt-1"
        onPeeked={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /show me the answers/i }));
    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(screen.getByRole("button", { name: /show me the answers/i })).toBeVisible();
    expect(screen.queryByText(/future attempts on this challenge/i)).toBeNull();
    expect(giveUpChallenge).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: /show me the answers/i })).toHaveFocus());
  });

  it("confirming calls giveUpChallenge with the exact challengeId/token and fires onPeeked on success", async () => {
    const giveUpChallenge = vi.fn().mockResolvedValue({ challengeId: "challenge-0001", peeked: true });
    const onPeeked = vi.fn();
    const user = userEvent.setup();
    render(
      <GiveUpAffordance
        eligible
        onRace={vi.fn()}
        apiClient={mockApiClient(giveUpChallenge)}
        errorReporter={{ reportVisibleError: vi.fn() }}
        challengeId="challenge-0001"
        identityToken="jwt-1"
        onPeeked={onPeeked}
      />,
    );

    await user.click(screen.getByRole("button", { name: /show me the answers/i }));
    await user.click(screen.getByRole("button", { name: /yes, show me/i }));

    await waitFor(() => expect(giveUpChallenge).toHaveBeenCalledWith("challenge-0001", "jwt-1"));
    await waitFor(() => expect(onPeeked).toHaveBeenCalledTimes(1));
  });

  it.each(["account", "challenge", "unmount"] as const)("ignores reveal settlement after %s changes", async (change) => {
    let resolve!: (value: { challengeId: string; peeked: true }) => void;
    const giveUpChallenge = vi.fn(() => new Promise<{ challengeId: string; peeked: true }>(done => { resolve = done; }));
    const onPeeked = vi.fn();
    const props = { eligible: true, onRace: vi.fn(), apiClient: mockApiClient(giveUpChallenge), errorReporter: { reportVisibleError: vi.fn() }, challengeId: "challenge-0001", identityToken: "jwt-1", onPeeked };
    const view = render(<GiveUpAffordance {...props} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Show me the answers" }));
    await user.click(screen.getByRole("button", { name: "Yes, show me" }));
    if (change === "unmount") view.unmount();
    else view.rerender(<GiveUpAffordance {...props} {...(change === "account" ? { identityToken: "jwt-2" } : { challengeId: "challenge-0002" })} />);
    await act(async () => resolve({ challengeId: "challenge-0001", peeked: true }));
    expect(onPeeked).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows a busy label while the request is in flight and disables both buttons", async () => {
    let resolveGiveUp: (value: { challengeId: string; peeked: true }) => void = () => {};
    const giveUpChallenge = vi.fn(() => new Promise<{ challengeId: string; peeked: true }>((resolve) => {
      resolveGiveUp = resolve;
    }));
    const user = userEvent.setup();
    render(
      <GiveUpAffordance
        eligible
        onRace={vi.fn()}
        apiClient={mockApiClient(giveUpChallenge)}
        errorReporter={{ reportVisibleError: vi.fn() }}
        challengeId="challenge-0001"
        identityToken="jwt-1"
        onPeeked={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /show me the answers/i }));
    await user.click(screen.getByRole("button", { name: /yes, show me/i }));

    const busyButton = await screen.findByRole("button", { name: /revealing…/i });
    expect(busyButton).toBeDisabled();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeDisabled();

    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(giveUpChallenge).toHaveBeenCalledTimes(1);
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
        eligible
        onRace={vi.fn()}
        apiClient={mockApiClient(giveUpChallenge)}
        errorReporter={errorReporter}
        challengeId="challenge-0001"
        identityToken="jwt-1"
        onPeeked={onPeeked}
      />,
    );

    await user.click(screen.getByRole("button", { name: /show me the answers/i }));
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
        eligible
        onRace={vi.fn()}
        apiClient={mockApiClient(giveUpChallenge)}
        errorReporter={{ reportVisibleError: vi.fn() }}
        challengeId="challenge-0001"
        identityToken="jwt-1"
        onPeeked={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /show me the answers/i }));
    await user.click(screen.getByRole("button", { name: /yes, show me/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't record that. Try again.");
  });

  it("cancel after a failed attempt clears the error and collapses", async () => {
    const giveUpChallenge = vi.fn().mockRejectedValue(new Error("nope"));
    const user = userEvent.setup();
    render(
      <GiveUpAffordance
        eligible
        onRace={vi.fn()}
        apiClient={mockApiClient(giveUpChallenge)}
        errorReporter={{ reportVisibleError: vi.fn() }}
        challengeId="challenge-0001"
        identityToken="jwt-1"
        onPeeked={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /show me the answers/i }));
    await user.click(screen.getByRole("button", { name: /yes, show me/i }));
    await screen.findByRole("alert");

    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(screen.getByRole("button", { name: /show me the answers/i })).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("Escape cancels the popup without revealing and restores focus", async () => {
    const user = userEvent.setup();
    const giveUpChallenge = vi.fn();
    render(
      <GiveUpAffordance
        eligible
        onRace={vi.fn()}
        apiClient={mockApiClient(giveUpChallenge)}
        errorReporter={{ reportVisibleError: vi.fn() }}
        challengeId="challenge-0001"
        identityToken="jwt-1"
        onPeeked={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("button", { name: /show me the answers/i });
    await user.click(trigger);
    expect(screen.getByRole("dialog")).toBeVisible();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(giveUpChallenge).not.toHaveBeenCalled();
  });
  it("explains an ineligible DNF and routes to racing without revealing", async () => {
    const user = userEvent.setup();
    const giveUpChallenge = vi.fn();
    const onRace = vi.fn();
    render(<GiveUpAffordance eligible={false} onRace={onRace}
      apiClient={mockApiClient(giveUpChallenge)} errorReporter={{ reportVisibleError: vi.fn() }}
      challengeId="challenge-0001" identityToken="jwt-1" onPeeked={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Show me the answers" }));
    expect(screen.getByRole("dialog", { name: "Answers are still locked" })).toBeVisible();
    expect(screen.getByText(/attempts with at least 2 clicks.*5-click or 3-minute requirement/i)).toBeVisible();
    expect(screen.getByText(/at least 2 clicks.*5 clicks.*3 minutes/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: /yes, show me/i })).toBeNull();
    await user.click(screen.getByRole("button", { name: "▶ Race" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onRace).toHaveBeenCalledOnce();
    expect(giveUpChallenge).not.toHaveBeenCalled();
  });

  it("keeps Race disabled when the caller cannot start another race", async () => {
    const user = userEvent.setup();
    const onRace = vi.fn();
    render(<GiveUpAffordance eligible={false} onRace={onRace} raceDisabled
      apiClient={mockApiClient(vi.fn())} errorReporter={{ reportVisibleError: vi.fn() }}
      challengeId="challenge-0001" identityToken="jwt-1" onPeeked={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Show me the answers" }));
    expect(screen.getByRole("button", { name: "▶ Race" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onRace).not.toHaveBeenCalled();
  });

  it.each([0, 1])("explains the missed click minimum using the recorded count (%s)", async count => {
    const giveUpChallenge = vi.fn();
    render(<GiveUpAffordance eligible={false} ineligibleReason="minimum-clicks" attemptClickCount={count}
      onRace={vi.fn()} apiClient={mockApiClient(giveUpChallenge)} errorReporter={{ reportVisibleError: vi.fn() }}
      challengeId="challenge-0001" identityToken="jwt-1" onPeeked={vi.fn()} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Show me the answers" }));
    expect(screen.getByText(`This attempt recorded ${count} accepted ${count === 1 ? "click" : "clicks"}. At least 2 are required before answers can unlock.`)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Yes, show me" })).toBeNull();
    expect(giveUpChallenge).not.toHaveBeenCalled();
  });

  it("explains the missed progress threshold with a known counted attempt", async () => {
    render(<GiveUpAffordance eligible={false} ineligibleReason="more-progress" attemptClickCount={3}
      onRace={vi.fn()} apiClient={mockApiClient(vi.fn())} errorReporter={{ reportVisibleError: vi.fn() }}
      challengeId="challenge-0001" identityToken="jwt-1" onPeeked={vi.fn()} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Show me the answers" }));
    expect(screen.getByText("This attempt recorded 3 accepted clicks, below the 5-click requirement, and didn't qualify for the 3-minute alternative.")).toBeVisible();
  });

});
