import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { GameSession } from "../domain/gameSession";
import type { Article, Challenge } from "../domain/types";
import type { TargetPreviewState } from "../hooks/useTargetPreview";
import RaceMode, { PathStrip } from "./RaceMode";

const challenge: Challenge = {
  id: "challenge-1",
  label: "Challenge #1",
  mode: "daily",
  start: { title: "J2000", pageId: 1 },
  target: { title: "Fruit", pageId: 2 },
  ruleset: "ranked_classic",
  source: "curated",
};

const article: Article = {
  canonicalTitle: "Epoch (astronomy)",
  pageId: 4,
  revisionId: 1,
  sourceUrl: "https://en.wikipedia.org/wiki/Epoch_(astronomy)",
  attributionUrl: "https://en.wikipedia.org/w/index.php?title=Epoch_(astronomy)&oldid=1",
  attribution: "Wikipedia revision 1",
  links: [],
  sanitizedHtml: "<p>Test article body.</p>" as Article["sanitizedHtml"],
};

const session: GameSession = {
  challenge,
  status: "active",
  startedAt: 0,
  clicks: 1,
  currentPage: { canonicalTitle: "Epoch (astronomy)", pageId: 4 },
  path: [],
};

const idlePreview: TargetPreviewState = { status: "idle" };

function renderRaceMode(
  redirectedFrom: string | null,
  overrides: {
    session?: GameSession;
    targetPreview?: TargetPreviewState;
    pendingNavigationTitle?: string | null;
    navigationRetrying?: boolean;
  } = {},
) {
  return render(
    <RaceMode
      article={article}
      session={overrides.session ?? session}
      elapsedMs={1_000}
      redirectedFrom={redirectedFrom}
      pendingNavigationTitle={overrides.pendingNavigationTitle ?? null}
      navigationRetrying={overrides.navigationRetrying ?? false}
      pendingRetry={null}
      onRetryPending={() => {}}
      targetPreview={overrides.targetPreview ?? idlePreview}
      endRunDisabled={false}
      onRequestEndRun={() => {}}
      checkingActiveRun={false}
      handleArticleClick={vi.fn()}
      handleArticlePrewarm={vi.fn()}
    />,
  );
}

describe("RaceMode", () => {
  // LK-1: the player clicked "J2000" but the fetched article's canonical
  // title is "Epoch (astronomy)" (a Wikipedia redirect) - the heading must
  // show the canonical title (unchanged) with a small note directly under
  // it explaining why, mirroring Wikipedia's own "(Redirected from X)".
  it("renders a redirect note under the article heading when redirectedFrom is set", () => {
    renderRaceMode("J2000");

    const heading = screen.getByRole("heading", { name: "Epoch (astronomy)" });
    expect(heading).toBeVisible();
    expect(screen.getByText("(redirected from J2000)")).toBeVisible();
  });

  it("renders no redirect note when redirectedFrom is null", () => {
    renderRaceMode(null);

    expect(screen.getByRole("heading", { name: "Epoch (astronomy)" })).toBeVisible();
    expect(screen.queryByText(/redirected from/i)).toBeNull();
  });

  // MB-1 Part 2: an automatic retry (article fetch or click-POST leash,
  // see useRaceController's navigationRetrying) must read as honest
  // progress, not a silently-unchanging "Opening.../Loading next
  // article..." spinner - mirrors the shipped login "Still connecting..."
  // treatment.
  describe("pending-navigation copy", () => {
    it("shows 'Opening <title>...' while a navigation is pending and no retry is in flight", () => {
      renderRaceMode(null, { pendingNavigationTitle: "Fruit" });

      expect(screen.getByText("Opening Fruit...")).toBeVisible();
      expect(screen.getByText("Loading next article...")).toBeVisible();
      expect(screen.queryByText("Still loading...")).toBeNull();
    });

    it("swaps to 'Still loading...' once the automatic retry kicks in", () => {
      renderRaceMode(null, { pendingNavigationTitle: "Fruit", navigationRetrying: true });

      expect(screen.queryByText(/Opening Fruit/)).toBeNull();
      expect(screen.getAllByText("Still loading...")).toHaveLength(2);
    });
  });

  // RC-1: the target used to only surface via a disclosure cell in the
  // static (non-sticky) path strip, which scrolls out of view mid-article -
  // this locks in that it now also lives in the sticky race-hud, one tap
  // from the same preview, at every scroll position.
  describe("target chip (sticky HUD)", () => {
    it("renders inside the sticky race-hud, closed by default, with the untruncated title", () => {
      renderRaceMode(null);

      const chip = screen.getByRole("button", { name: "Target: Fruit" });
      expect(chip.closest(".race-hud")).not.toBeNull();
      expect(within(chip).getByText("Fruit")).toBeVisible();
      expect(chip).toHaveAttribute("aria-expanded", "false");
      expect(
        screen.queryByText("The target preview was not ready when this run began."),
      ).toBeNull();
    });

    it("hard-truncates a long target title to 16 characters plus an ellipsis, keeping the full title in the accessible name", () => {
      const longTargetSession: GameSession = {
        ...session,
        challenge: {
          ...challenge,
          target: { title: "Voynich manuscript", pageId: 2 },
        },
      };
      renderRaceMode(null, { session: longTargetSession });

      const chip = screen.getByRole("button", { name: "Target: Voynich manuscript" });
      expect(within(chip).getByText("Voynich manuscri…")).toBeVisible();
      expect(within(chip).queryByText("Voynich manuscript")).toBeNull();
    });

    it("toggles the shared target-preview popover open and closed on click, reusing the useTargetPreview blurb", async () => {
      const user = userEvent.setup();
      const readyPreview: TargetPreviewState = {
        status: "ready",
        challengeId: challenge.id,
        canonicalTitle: "Fruit",
        attributionUrl: "https://en.wikipedia.org/wiki/Fruit",
        preview: { blurb: "A fruit is the seed-bearing structure in plants." },
      };
      renderRaceMode(null, { targetPreview: readyPreview });

      const chip = screen.getByRole("button", { name: "Target: Fruit" });
      expect(screen.queryByText(/seed-bearing structure/i)).toBeNull();

      await user.click(chip);
      expect(chip).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByText(/seed-bearing structure/i)).toBeVisible();

      await user.click(chip);
      expect(chip).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByText(/seed-bearing structure/i)).toBeNull();
    });

    it("falls back to the not-ready copy when opened before the target preview resolves", async () => {
      const user = userEvent.setup();
      renderRaceMode(null, { targetPreview: { status: "loading", challengeId: challenge.id } });

      await user.click(screen.getByRole("button", { name: "Target: Fruit" }));
      expect(
        screen.getByText("The target preview was not ready when this run began."),
      ).toBeVisible();
    });
  });
});

describe("PathStrip (RC-1: purely a path trail, no target cell)", () => {
  it("renders only the visited titles, dropping the trailing target from the breadcrumb", () => {
    render(
      <PathStrip
        titles={["J2000", "Epoch (astronomy)", "Fruit"]}
        endRunDisabled={false}
        onRequestEndRun={() => {}}
      />,
    );

    const strip = screen.getByRole("navigation", { name: /run path/i });
    expect(within(strip).getByText("J2000")).toBeVisible();
    expect(within(strip).getByText("Epoch (astronomy)")).toBeVisible();
    expect(within(strip).queryByText("Fruit")).toBeNull();
    expect(screen.queryByRole("button", { name: /target/i })).toBeNull();
    expect(screen.queryByRole("group", { name: /target/i })).toBeNull();
  });
});

// HD-1 (owner report): End Run moved out of the sticky race-hud and into
// this strip's own row, right-aligned against the breadcrumb - "the end run
// can be in the line with the path?". Both props are required on PathStrip
// now (see its own HD-1 comment): RaceMode's only caller always supplies
// them whenever a run is active, so there is no path where this strip
// renders without an End Run affordance.
describe("PathStrip (HD-1: End Run lives in the strip row)", () => {
  it("renders an enabled End Run button inside the strip that fires onRequestEndRun on click", async () => {
    const user = userEvent.setup();
    const onRequestEndRun = vi.fn();
    render(
      <PathStrip
        titles={["J2000", "Fruit"]}
        endRunDisabled={false}
        onRequestEndRun={onRequestEndRun}
      />,
    );

    const strip = screen.getByRole("navigation", { name: /run path/i });
    const endRun = within(strip).getByRole("button", { name: /^end run$/i });
    expect(endRun).toHaveClass("end-run-button");
    expect(endRun).toBeEnabled();

    await user.click(endRun);
    expect(onRequestEndRun).toHaveBeenCalledTimes(1);
  });

  it("disables End Run in the strip when endRunDisabled is true", () => {
    render(
      <PathStrip
        titles={["J2000", "Fruit"]}
        endRunDisabled={true}
        onRequestEndRun={() => {}}
      />,
    );

    const strip = screen.getByRole("navigation", { name: /run path/i });
    expect(within(strip).getByRole("button", { name: /^end run$/i })).toBeDisabled();
  });
});

// HD-1: locks in the new one-row HUD shape (owner: "just the timer, click
// count and the [target] peek") - End Run is gone from `.race-hud` entirely,
// living only in the path strip below it now (see the PathStrip describe
// blocks above/below).
describe("RaceMode (HD-1: one-row sticky HUD, End Run lives with the path)", () => {
  it("keeps End Run out of the sticky race-hud but present in the path strip beneath it", () => {
    renderRaceMode(null);

    const hud = document.querySelector(".race-hud");
    expect(hud).not.toBeNull();
    expect(within(hud as HTMLElement).queryByRole("button", { name: /^end run$/i })).toBeNull();

    const strip = screen.getByRole("navigation", { name: /run path/i });
    const endRun = within(strip).getByRole("button", { name: /^end run$/i });
    expect(endRun).toBeVisible();
    expect(endRun).toHaveClass("end-run-button");
  });

  it("keeps the Run chip and Target chip as the sole race-hud-metrics content, still on one line", () => {
    renderRaceMode(null);

    const hud = document.querySelector(".race-hud") as HTMLElement;
    const metrics = within(hud).getByLabelText(/current run/i);
    const targetChip = within(hud).getByRole("button", { name: /^target:/i });
    expect(metrics.closest(".race-hud-metrics")).not.toBeNull();
    expect(targetChip.closest(".race-hud-metrics")).toBe(metrics.closest(".race-hud-metrics"));
  });
});
