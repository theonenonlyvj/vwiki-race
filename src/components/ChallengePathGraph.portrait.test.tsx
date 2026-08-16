import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChallengePathGraph, { type ChallengePathRun } from "./ChallengePathGraph";

/**
 * The portrait layout is the headline change and jsdom renders the LANDSCAPE
 * one by default: matchMedia reports no match and every element measures 0, so
 * the sheet is never measured and the orientation never flips. Every other test
 * in this suite therefore exercises the branch that was already working.
 *
 * These force the portrait branch by stubbing the two things it reads - the
 * media query and the canvas container's own box - so the axis swap, the
 * collapsed legend and the measurement convergence are actually covered.
 */
const PHONE_WIDTH = 390;
const PHONE_HEIGHT = 844;
/** What .cpg-scroll-wrap measures inside the modal on that phone. */
const CANVAS_WIDTH = 298;
const CANVAS_TOP = 144;

let widthSpy: ReturnType<typeof vi.spyOn> | null = null;
let rectSpy: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(() => {
  vi.stubGlobal("innerHeight", PHONE_HEIGHT);
  vi.stubGlobal(
    "matchMedia",
    (query: string): MediaQueryList =>
      ({
        // Evaluate the query for real against the phone width. A stub that
        // just tests /max-width/ would report a match for ANY breakpoint,
        // including 0 - so these tests would pass with the portrait layout
        // switched off entirely, which is exactly the vacuous-test trap this
        // file exists to avoid.
        matches: (() => {
          const max = /\(max-width:\s*(\d+)px\)/.exec(query);
          if (max) return PHONE_WIDTH <= Number(max[1]);
          return false; // prefers-reduced-motion and anything else
        })(),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );
  widthSpy = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains("cpg-scroll-wrap") ? CANVAS_WIDTH : PHONE_WIDTH;
  });
  rectSpy = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      const top = this.classList.contains("cpg-scroll-wrap") ? CANVAS_TOP : 0;
      return { top, left: 0, right: CANVAS_WIDTH, bottom: top, width: CANVAS_WIDTH, height: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
    });
});

afterEach(() => {
  widthSpy?.mockRestore();
  rectSpy?.mockRestore();
  vi.unstubAllGlobals();
});

const runs: ChallengePathRun[] = [
  {
    player: "Fast",
    status: "completed",
    elapsedMs: 3_000,
    clicks: 3,
    steps: [
      { n: 1, from: "Start", to: "Middle" },
      { n: 2, from: "Middle", to: "Nearly" },
      { n: 3, from: "Nearly", to: "Target" },
    ],
  },
  {
    player: "Slow",
    status: "completed",
    elapsedMs: 9_000,
    clicks: 3,
    steps: [
      { n: 1, from: "Start", to: "Other" },
      { n: 2, from: "Other", to: "Middle" },
      { n: 3, from: "Middle", to: "Target" },
    ],
  },
];

function viewBoxOf(container: HTMLElement): { width: number; height: number } {
  const parts = (container.querySelector(".cpg-svg")?.getAttribute("viewBox") ?? "").split(" ");
  return { width: Number(parts[2]), height: Number(parts[3]) };
}

describe("ChallengePathGraph in portrait", () => {
  it("lays the canvas out taller than it is wide, against the measured sheet", async () => {
    const { container } = render(<ChallengePathGraph runs={runs} />);

    await waitFor(() => {
      const box = viewBoxOf(container);
      expect(box.width).toBe(CANVAS_WIDTH);
      expect(box.height).toBeGreaterThan(box.width);
    });
  });

  // The measurement converges rather than sticking on its first pass: that pass
  // necessarily runs against the LANDSCAPE layout (sheet is null until it
  // completes), where the legend is expanded and tall, and re-running once the
  // portrait legend collapses is what recovers the full height. Sticking on
  // pass one left a 460px canvas inside 624px of room.
  it("converges on the full available height rather than the minimum floor", async () => {
    const { container } = render(<ChallengePathGraph runs={runs} />);

    await waitFor(() => {
      // innerHeight 844 - canvas top 144 - footer 76 = 624.
      expect(viewBoxOf(container).height).toBe(624);
    });
  });

  it("puts progress on the vertical axis - the target sits below the start", async () => {
    const { container } = render(<ChallengePathGraph runs={runs} />);

    await waitFor(() => expect(viewBoxOf(container).height).toBe(624));

    const texts = [...container.querySelectorAll(".cpg-svg text")];
    const start = texts.find((t) => t.textContent === "Start");
    const target = texts.find((t) => t.textContent === "Target");
    expect(start).toBeTruthy();
    expect(target).toBeTruthy();
    expect(Number(target!.getAttribute("y"))).toBeGreaterThan(Number(start!.getAttribute("y")));
  });

  // The legend took 638px of an 844px viewport before this, pushing the graph
  // below the fold.
  it("collapses the legend to a disclosure instead of listing every player", async () => {
    render(<ChallengePathGraph runs={runs} />);

    const toggle = await screen.findByRole("button", { name: /show 2 players/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: /^Fast/ })).not.toBeInTheDocument();
  });

  it("reveals the full legend when the disclosure is activated", async () => {
    const user = userEvent.setup();
    render(<ChallengePathGraph runs={runs} />);

    await user.click(await screen.findByRole("button", { name: /show 2 players/i }));
    expect(screen.getByRole("button", { name: /fast/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /hide names/i })).toBeVisible();
  });

  // Toggling unmounts the button that was just activated; without moving focus
  // it lands on <body> and a keyboard user has to tab in from the top again.
  it("keeps keyboard focus on the control that replaced the one it removed", async () => {
    const user = userEvent.setup();
    render(<ChallengePathGraph runs={runs} />);

    await user.click(await screen.findByRole("button", { name: /show 2 players/i }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /hide names/i })).toHaveFocus(),
    );

    await user.click(screen.getByRole("button", { name: /hide names/i }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /show 2 players/i })).toHaveFocus(),
    );
  });

  it("offers the share affordance rather than the landscape swipe toggle", async () => {
    const { container } = render(<ChallengePathGraph runs={runs} />);

    // Anchored to the portrait branch: without this the assertions below hold
    // in landscape too, and the test would pass with portrait switched off.
    await waitFor(() => expect(container.querySelector(".cpg-root.is-portrait")).toBeTruthy());
    expect(screen.getByRole("button", { name: /save image/i })).toBeVisible();
    expect(screen.queryByRole("button", { name: /explore path/i })).not.toBeInTheDocument();
  });

  it("tells the reader which axis carries progress", async () => {
    const { container } = render(<ChallengePathGraph runs={runs} />);

    await waitFor(() => expect(viewBoxOf(container).height).toBe(624));
    expect(container.textContent).toContain("down = % through each player's own path");
  });
});
