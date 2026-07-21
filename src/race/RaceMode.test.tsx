import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GameSession } from "../domain/gameSession";
import type { Article, Challenge } from "../domain/types";
import type { TargetPreviewState } from "../hooks/useTargetPreview";
import RaceMode from "./RaceMode";

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

function renderRaceMode(redirectedFrom: string | null) {
  return render(
    <RaceMode
      article={article}
      session={session}
      elapsedMs={1_000}
      redirectedFrom={redirectedFrom}
      pendingNavigationTitle={null}
      pendingRetry={null}
      onRetryPending={() => {}}
      targetPreview={idlePreview}
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
});
