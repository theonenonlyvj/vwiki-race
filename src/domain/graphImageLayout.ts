/**
 * GR-2: geometry for the shareable PNG of "Everyone's path".
 *
 * Owner brief (verbatim): "i love sending screenshots of the whole graph to
 * friends in a thread to discuss." On a phone that is hard to do well - iOS
 * cannot usefully full-page-screenshot a web view, and the on-screen legend is
 * deliberately collapsed to a 44px strip so the graph gets the whole sheet. A
 * screenshot of the screen would therefore share a graph with no key.
 *
 * So the export is composed rather than captured: the graph canvas, plus the
 * COMPLETE legend underneath it, regardless of what happens to be expanded on
 * screen. This module is the pure geometry half - what size the image is and
 * where each legend row sits - kept separate from the drawing so it can be
 * tested without a canvas.
 */

export interface GraphImageLegendEntry {
  player: string;
  color: string;
  dash: string | null;
  stat: string;
  status: "completed" | "abandoned";
  isWinner: boolean;
}

export interface GraphImageLegendRow extends GraphImageLegendEntry {
  x: number;
  y: number;
}

export interface GraphImageLayout {
  /** CSS-pixel canvas size. */
  width: number;
  height: number;
  /** Backing-store size; what the PNG actually contains. */
  pixelWidth: number;
  pixelHeight: number;
  graphHeight: number;
  rows: GraphImageLegendRow[];
  columns: number;
}

/**
 * 3x. The image is viewed inside a chat client, often after that client has
 * re-compressed it, and frequently pinch-zoomed to read a title. 2x survives
 * the first of those; 3x survives all three, and a phone-sized graph at 3x is
 * still only ~1000x2200 - well inside what a message thread will carry.
 */
export const EXPORT_SCALE = 3;

const LEGEND_TOP_GAP = 6;
const LEGEND_ROW_HEIGHT = 26;
const LEGEND_BOTTOM_PAD = 14;
const LEGEND_SIDE_PAD = 14;
/** Below this the legend cannot hold two readable columns of name + stat. */
const TWO_COLUMN_MIN_WIDTH = 620;

export function graphImageLayout({
  graphWidth,
  graphHeight,
  legend,
}: {
  graphWidth: number;
  graphHeight: number;
  legend: GraphImageLegendEntry[];
}): GraphImageLayout {
  const columns = graphWidth >= TWO_COLUMN_MIN_WIDTH ? 2 : 1;
  const perColumn = Math.ceil(legend.length / columns);
  const columnWidth = (graphWidth - LEGEND_SIDE_PAD * 2) / columns;

  const rows: GraphImageLegendRow[] = legend.map((entry, index) => {
    const column = Math.floor(index / perColumn);
    const rowInColumn = index % perColumn;
    return {
      ...entry,
      x: LEGEND_SIDE_PAD + column * columnWidth,
      y: graphHeight + LEGEND_TOP_GAP + rowInColumn * LEGEND_ROW_HEIGHT,
    };
  });

  const legendHeight = legend.length
    ? LEGEND_TOP_GAP + perColumn * LEGEND_ROW_HEIGHT + LEGEND_BOTTOM_PAD
    : 0;
  const width = graphWidth;
  const height = graphHeight + legendHeight;

  return {
    width,
    height,
    pixelWidth: Math.round(width * EXPORT_SCALE),
    pixelHeight: Math.round(height * EXPORT_SCALE),
    graphHeight,
    rows,
    columns,
  };
}

const MAX_NAME_LENGTH = 76; // leaves room for ".png" inside a 80-char budget

/**
 * A thread accumulates these, so the filename has to say which challenge it is
 * rather than being image-3.png six times over.
 */
export function exportFileName(startTitle: string | null, targetTitle: string | null): string {
  const slug = (value: string) =>
    value
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

  const from = startTitle ? slug(startTitle) : "";
  const to = targetTitle ? slug(targetTitle) : "";
  if (!from && !to) return "vwiki-race-paths.png";

  const joined = from && to ? `${from}-to-${to}` : from || to;
  return `${joined.slice(0, MAX_NAME_LENGTH).replace(/-+$/, "")}.png`;
}
