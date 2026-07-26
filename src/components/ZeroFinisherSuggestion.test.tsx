import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ZeroFinisherSuggestion from "./ZeroFinisherSuggestion";
import type { Challenge } from "../domain/types";
import type { PlayAnotherSuggestionState } from "../domain/playAnother";

const suggestedChallenge: Challenge = {
  id: "challenge-0003",
  label: "Challenge #3",
  mode: "solo",
  start: { title: "Bicycle" },
  target: { title: "France" },
  ruleset: "ranked_classic",
  source: "curated",
};

function renderSuggestion(overrides: Partial<Parameters<typeof ZeroFinisherSuggestion>[0]> = {}) {
  const onOpenChallenge = vi.fn();
  const onBrowseChallenges = vi.fn();
  const props = {
    identityAccountId: "acc-1" as string | null,
    suggestion: { status: "loading" } as PlayAnotherSuggestionState,
    onOpenChallenge,
    onBrowseChallenges,
    ...overrides,
  };
  render(<ZeroFinisherSuggestion {...props} />);
  return { onOpenChallenge, onBrowseChallenges };
}

describe("ZeroFinisherSuggestion (zero-finisher escape hatch, owner ask 2026-07-26)", () => {
  it("signed in + suggestion ready: shows 'Try an easier one ›', opening that challenge's Detail on click", async () => {
    const user = userEvent.setup();
    const { onOpenChallenge } = renderSuggestion({
      suggestion: { status: "ready", challenge: suggestedChallenge, playerCount: 3 },
    });

    const link = screen.getByRole("button", { name: /try an easier one/i });
    expect(link).toBeVisible();
    expect(screen.queryByText(/browse all challenges/i)).toBeNull();

    await user.click(link);
    expect(onOpenChallenge).toHaveBeenCalledWith("challenge-0003");
  });

  it("signed in but suggestion empty (played everything): falls back to 'Browse all challenges ›'", async () => {
    const user = userEvent.setup();
    const { onBrowseChallenges } = renderSuggestion({ suggestion: { status: "empty" } });

    const link = screen.getByRole("button", { name: /browse all challenges/i });
    expect(link).toBeVisible();
    expect(screen.queryByText(/try an easier one/i)).toBeNull();

    await user.click(link);
    expect(onBrowseChallenges).toHaveBeenCalledTimes(1);
  });

  it("signed in, suggestion still loading or errored: degrades to Browse-all - never a broken/stale suggestion (F6)", () => {
    renderSuggestion({ suggestion: { status: "loading" } });
    expect(screen.getByRole("button", { name: /browse all challenges/i })).toBeVisible();
    expect(screen.queryByText(/try an easier one/i)).toBeNull();

    renderSuggestion({ suggestion: { status: "error" } });
    expect(screen.getAllByRole("button", { name: /browse all challenges/i }).length).toBeGreaterThan(0);
    expect(screen.queryByText(/try an easier one/i)).toBeNull();
  });

  it("anonymous viewer: links Browse directly, even with a 'ready' suggestion in hand - the endpoint needs an account", async () => {
    const user = userEvent.setup();
    const { onBrowseChallenges, onOpenChallenge } = renderSuggestion({
      identityAccountId: null,
      suggestion: { status: "ready", challenge: suggestedChallenge, playerCount: 3 },
    });

    const link = screen.getByRole("button", { name: /browse all challenges/i });
    expect(link).toBeVisible();
    expect(screen.queryByText(/try an easier one/i)).toBeNull();

    await user.click(link);
    expect(onBrowseChallenges).toHaveBeenCalledTimes(1);
    expect(onOpenChallenge).not.toHaveBeenCalled();
  });
});
