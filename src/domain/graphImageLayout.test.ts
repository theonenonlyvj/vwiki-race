import { describe, expect, it } from "vitest";
import {
  EXPORT_SCALE,
  exportFileName,
  graphImageLayout,
  type GraphImageLegendEntry,
} from "./graphImageLayout";

function legend(count: number): GraphImageLegendEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    player: `P${i + 1}`,
    color: "#fcbe00",
    dash: null,
    stat: "1:23 · 5 clk",
    status: "completed" as const,
    isWinner: i === 0,
  }));
}

describe("graphImageLayout", () => {
  it("reserves room below the graph for every legend row", () => {
    const one = graphImageLayout({ graphWidth: 330, graphHeight: 600, legend: legend(1) });
    const many = graphImageLayout({ graphWidth: 330, graphHeight: 600, legend: legend(8) });

    expect(many.height).toBeGreaterThan(one.height);
    expect(many.rows).toHaveLength(8);
  });

  // The point of the export is that the image carries the whole story even
  // though the on-screen legend is collapsed to a 44px strip. If a row landed
  // outside the canvas it would simply be missing from what gets shared.
  it("keeps every legend row inside the canvas", () => {
    const layout = graphImageLayout({ graphWidth: 330, graphHeight: 600, legend: legend(12) });

    for (const row of layout.rows) {
      expect(row.y).toBeGreaterThanOrEqual(layout.graphHeight);
      expect(row.y).toBeLessThanOrEqual(layout.height);
    }
  });

  it("lays narrow canvases out in one column and wide ones in two", () => {
    const phone = graphImageLayout({ graphWidth: 330, graphHeight: 600, legend: legend(6) });
    const desktop = graphImageLayout({ graphWidth: 1080, graphHeight: 640, legend: legend(6) });

    expect(new Set(phone.rows.map((r) => r.x)).size).toBe(1);
    expect(new Set(desktop.rows.map((r) => r.x)).size).toBe(2);
    expect(desktop.height).toBeLessThan(phone.height);
  });

  it("renders at a device-independent scale so the image is sharp when shared", () => {
    const layout = graphImageLayout({ graphWidth: 330, graphHeight: 600, legend: legend(3) });
    expect(layout.pixelWidth).toBe(Math.round(layout.width * EXPORT_SCALE));
    expect(layout.pixelHeight).toBe(Math.round(layout.height * EXPORT_SCALE));
    expect(EXPORT_SCALE).toBeGreaterThanOrEqual(2);
  });

  it("handles a solo run without collapsing the legend area", () => {
    const layout = graphImageLayout({ graphWidth: 330, graphHeight: 600, legend: legend(1) });
    expect(layout.rows).toHaveLength(1);
    expect(layout.height).toBeGreaterThan(layout.graphHeight);
  });

  it("still produces a usable canvas when there are no runs at all", () => {
    const layout = graphImageLayout({ graphWidth: 330, graphHeight: 600, legend: [] });
    expect(layout.rows).toEqual([]);
    expect(layout.height).toBeGreaterThanOrEqual(layout.graphHeight);
    expect(layout.pixelHeight).toBeGreaterThan(0);
  });
});

describe("exportFileName", () => {
  it("names the file after the challenge so a thread of them stays sortable", () => {
    expect(exportFileName("Opus Film", "Technology")).toBe("opus-film-to-technology.png");
  });

  it("strips punctuation that would break a filename", () => {
    expect(exportFileName("Slippery Rock, Pennsylvania", "Psychology")).toBe(
      "slippery-rock-pennsylvania-to-psychology.png",
    );
  });

  it("falls back to a generic name when the titles are missing", () => {
    expect(exportFileName(null, null)).toBe("vwiki-race-paths.png");
  });

  it("does not run away on a pathological title", () => {
    const name = exportFileName("x".repeat(400), "y".repeat(400));
    expect(name.length).toBeLessThanOrEqual(80);
    expect(name.endsWith(".png")).toBe(true);
  });
});
