/**
 * GR-2: draw "Everyone's path" to a PNG for sharing.
 *
 * Canvas2D, NOT SVG serialization. Rasterizing an SVG goes through
 * `new Image()` with a data: URL, and an image loaded that way is its own
 * document: it cannot see the page's webfonts, so every label silently falls
 * back to a default serif and the shared PNG looks nothing like the screen.
 * Embedding the font as a base64 @font-face would fix that at the cost of
 * shipping ~40KB of Merriweather through a data URI on every export.
 *
 * Canvas2D avoids the problem outright - `fillText` uses the fonts the
 * DOCUMENT has already loaded - and `new Path2D(d)` accepts SVG path syntax,
 * so the bezier edges the layout already computed are reused verbatim rather
 * than re-derived.
 */
import {
  exportFileName,
  graphImageLayout,
  type GraphImageLegendEntry,
} from "../domain/graphImageLayout";

export interface GraphImageEdge {
  d: string;
  color: string;
  dash: string | null;
  opacity: number;
  strokeWidth: number;
}

export interface GraphImageNode {
  cx: number;
  cy: number;
  radius: number;
  fill: string;
  stroke: string;
  labelText: string;
  labelColor: string;
  labelDx: number;
  labelDy: number;
  labelVisible: boolean;
  fontSize: number;
  bold: boolean;
  visitorCount: number;
  isTarget: boolean;
  isStart: boolean;
  isDnfTerminal: boolean;
}

export interface GraphImageRequest {
  width: number;
  height: number;
  background: string;
  edges: GraphImageEdge[];
  nodes: GraphImageNode[];
  legend: GraphImageLegendEntry[];
  caption: string;
  /** Portrait centres the caption; landscape left-anchors it at the margin. */
  captionCentred: boolean;
  /** Drives the target's convergence halo, as on the canvas. */
  finisherCount: number;
  targetGlowOpacity: number;
  startTitle: string | null;
  targetTitle: string | null;
  fontFamily: string;
}

const MUTED = "#9fb8bd";
const BRIGHT = "#dffbfb";
const INK = "#061014";
const TARGET_COLOR = "#ff765f";
const DNF_MARK = "#e0655a";
/** MARGIN_LEFT in the landscape canvas, where the SVG anchors its caption. */
const LANDSCAPE_CAPTION_X = 100;

function applyDash(ctx: CanvasRenderingContext2D, dash: string | null): void {
  ctx.setLineDash(dash ? dash.split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n)) : []);
}

export function drawGraphImage(
  ctx: CanvasRenderingContext2D,
  request: GraphImageRequest,
): { width: number; height: number } {
  const layout = graphImageLayout({
    graphWidth: request.width,
    graphHeight: request.height,
    legend: request.legend,
  });

  ctx.save();
  ctx.fillStyle = request.background;
  ctx.fillRect(0, 0, layout.width, layout.height);

  // Edges first, then nodes, then labels - same paint order as the SVG, so a
  // node never has an edge drawn across its face.
  for (const edge of request.edges) {
    ctx.save();
    ctx.globalAlpha = edge.opacity;
    ctx.strokeStyle = edge.color;
    ctx.lineWidth = edge.strokeWidth;
    ctx.lineCap = "round";
    applyDash(ctx, edge.dash);
    ctx.stroke(new Path2D(edge.d));
    ctx.restore();
  }

  // A7: the target's halo scales with how many players actually finished. It
  // is the picture's payoff - "this is where everyone ended up" - so the
  // export would read as a different, flatter graph without it.
  const target = request.nodes.find((node) => node.isTarget);
  if (target) {
    const outer = target.radius + 6 + 2 * request.finisherCount;
    ctx.save();
    ctx.globalAlpha = request.targetGlowOpacity;
    // A radial gradient rather than ctx.filter = "blur(...)". Canvas filter
    // support only arrived in Safari 16.4, and where it is missing the
    // declaration is silently IGNORED - which would not degrade to "no glow",
    // it would paint a hard-edged coral disc several times the target's size
    // over the convergence. A gradient renders identically everywhere.
    const glow = ctx.createRadialGradient(
      target.cx,
      target.cy,
      Math.max(1, target.radius * 0.5),
      target.cx,
      target.cy,
      outer,
    );
    glow.addColorStop(0, TARGET_COLOR);
    glow.addColorStop(0.55, `${TARGET_COLOR}80`);
    glow.addColorStop(1, `${TARGET_COLOR}00`);
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(target.cx, target.cy, outer, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  for (const node of request.nodes) {
    // The SVG blooms every SHARED node faintly white ("everyone was here").
    // Leaving it out of the export flattened the merge points, which are the
    // reason the graph is drawn merged at all.
    if (!node.isTarget && node.visitorCount > 1) {
      ctx.save();
      // A gradient, not a flat disc: the SVG runs this through the blur filter,
      // so a hard-edged circle read as a visible ring around every merge point
      // in the exported image.
      const bloom = ctx.createRadialGradient(
        node.cx,
        node.cy,
        Math.max(0.5, node.radius * 0.6),
        node.cx,
        node.cy,
        node.radius + 5,
      );
      bloom.addColorStop(0, "rgba(255,255,255,0.16)");
      bloom.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = bloom;
      ctx.beginPath();
      ctx.arc(node.cx, node.cy, node.radius + 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    ctx.save();
    ctx.beginPath();
    ctx.arc(node.cx, node.cy, node.radius, 0, Math.PI * 2);
    ctx.fillStyle = node.fill;
    ctx.fill();
    if (node.stroke !== "none") {
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = node.stroke;
      ctx.stroke();
    }
    ctx.restore();

    // A5: 3+ visitors carry a small centred count - the merge points are the
    // whole reason the graph is drawn merged rather than as parallel lanes.
    // Matching the SVG exactly: start and target are excluded. The start node
    // is visited by EVERY player, so without the exclusion the export stamped
    // a visitor count inside the start dot that the screen never shows.
    if (node.visitorCount >= 3 && !node.isTarget && !node.isStart) {
      ctx.save();
      ctx.font = `600 10px ${request.fontFamily}`; // 10px, as the SVG sets
      ctx.fillStyle = INK;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(node.visitorCount), node.cx, node.cy);
      ctx.restore();
    }

    if (node.isTarget) {
      ctx.save();
      ctx.font = `600 12px ${request.fontFamily}`; // 12px, as the SVG sets
      ctx.fillStyle = INK;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("\u2605", node.cx, node.cy + 1);
      ctx.restore();
    }

    // The DNF cross: without it an abandoned run just stops, and the export
    // reads as though that player is still out there somewhere.
    if (node.isDnfTerminal) {
      ctx.save();
      ctx.strokeStyle = DNF_MARK;
      ctx.lineWidth = 2.4;
      ctx.lineCap = "round";
      ctx.globalAlpha = 0.8; // the SVG stamp is 0.8, not opaque
      const arm = 6; // the SVG arms run +-6, not +-5
      ctx.beginPath();
      ctx.moveTo(node.cx - arm, node.cy - arm);
      ctx.lineTo(node.cx + arm, node.cy + arm);
      ctx.moveTo(node.cx + arm, node.cy - arm);
      ctx.lineTo(node.cx - arm, node.cy + arm);
      ctx.stroke();
      ctx.restore();
    }
  }

  for (const node of request.nodes) {
    if (!node.labelVisible || !node.labelText) continue;
    ctx.save();
    ctx.font = `${node.bold ? 600 : 500} ${node.fontSize}px ${request.fontFamily}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    // The SVG paints a halo behind label text (paint-order: stroke) so titles
    // stay readable where they cross a strand; without it the PNG loses
    // legibility exactly where the graph is busiest.
    ctx.lineWidth = 3;
    ctx.lineJoin = "round";
    ctx.strokeStyle = request.background;
    ctx.strokeText(node.labelText, node.cx + node.labelDx, node.cy + node.labelDy);
    ctx.fillStyle = node.labelColor;
    ctx.fillText(node.labelText, node.cx + node.labelDx, node.cy + node.labelDy);
    ctx.restore();
  }

  ctx.save();
  ctx.font = `400 11px ${request.fontFamily}`;
  ctx.fillStyle = MUTED;
  ctx.globalAlpha = 0.8;
  // Follows the SVG: centred in portrait, left-anchored at the plot margin in
  // landscape. Centring both made the exported landscape image differ from the
  // screen for no reason.
  ctx.textAlign = request.captionCentred ? "center" : "left";
  ctx.fillText(
    request.caption,
    request.captionCentred ? layout.width / 2 : LANDSCAPE_CAPTION_X,
    request.height - 12,
  );
  ctx.restore();

  for (const row of layout.rows) {
    ctx.save();
    // Swatch: a short line, matching the on-screen legend and the strand it
    // stands for, dash included.
    // Row dimming has to be set BEFORE the swatch is stroked, or an abandoned
    // run's swatch prints at full strength beside its dimmed name.
    ctx.globalAlpha = row.status === "abandoned" ? 0.9 : 1;
    ctx.strokeStyle = row.color;
    ctx.lineWidth = 4;
    // BUTT caps, not round. A round cap extends half the line width past each
    // dash end, which on a 16px swatch bridges the gaps and paints a dashed
    // strand as a solid one - so in the shared PNG the 8th player became
    // indistinguishable from the 1st, which is the exact confusion the dash
    // exists to prevent. The dash is also scaled to the swatch (5 on / 3 off)
    // rather than reusing the strand's 9/5, which would show one dash and no
    // gap at this length.
    ctx.lineCap = "butt";
    applyDash(ctx, row.dash ? "5 3" : null);
    ctx.beginPath();
    ctx.moveTo(row.x, row.y + 8);
    ctx.lineTo(row.x + 16, row.y + 8);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = `600 12px ${request.fontFamily}`;
    ctx.fillStyle = BRIGHT;
    const nameX = row.x + 24;
    ctx.fillText(row.player, nameX, row.y + 8);
    const nameWidth = ctx.measureText(row.player).width;

    ctx.font = `400 12px ${request.fontFamily}`;
    ctx.fillStyle = MUTED;
    const statX = nameX + nameWidth + 8;
    ctx.fillText(row.stat, statX, row.y + 8);
    const statWidth = ctx.measureText(row.stat).width;

    if (row.isWinner) {
      ctx.fillStyle = row.color;
      ctx.fillText("★ 1st", statX + statWidth + 8, row.y + 8);
    } else if (row.status === "abandoned") {
      ctx.fillStyle = "#e0655a";
      ctx.fillText("DNF", statX + statWidth + 8, row.y + 8);
    }
    ctx.restore();
  }

  ctx.restore();
  return { width: layout.width, height: layout.height };
}

/**
 * SYNCHRONOUS on purpose. iOS Safari only honours navigator.share() while the
 * page holds transient activation from the user's tap, and an intervening
 * `await` gives that up - so the obvious `await canvas.toBlob(...)` would make
 * the share sheet never appear on the one device this feature is for. Drawing
 * is synchronous anyway; the only async step was the encode, so this uses
 * toDataURL (synchronous) and decodes the base64 itself, keeping the whole
 * path - draw, encode, share - inside the tap's own task.
 *
 * The cost is holding the PNG as a base64 string briefly. At the sizes this
 * produces (a phone export is ~1MB) that is not worth an await.
 */
export function graphImageBlob(request: GraphImageRequest): Blob {
  const layout = graphImageLayout({
    graphWidth: request.width,
    graphHeight: request.height,
    legend: request.legend,
  });
  const canvas = document.createElement("canvas");
  canvas.width = layout.pixelWidth;
  canvas.height = layout.pixelHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas_unavailable");
  ctx.scale(layout.pixelWidth / layout.width, layout.pixelHeight / layout.height);
  drawGraphImage(ctx, request);

  const dataUrl = canvas.toDataURL("image/png");
  const comma = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:image/png") || comma < 0) throw new Error("canvas_encode_failed");
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: "image/png" });
}

/**
 * Hand the image to the OS share sheet where that exists (which is the whole
 * point on a phone - it puts the PNG straight into a message thread), and fall
 * back to a download everywhere else.
 *
 * `canShare` must be consulted with the actual file: Safari reports
 * `navigator.share` present but refuses file payloads in some contexts, and an
 * unguarded call rejects after the user has already tapped.
 */
export async function shareGraphImage(
  blob: Blob,
  startTitle: string | null,
  targetTitle: string | null,
): Promise<"shared" | "cancelled" | "downloaded" | "failed"> {
  const name = exportFileName(startTitle, targetTitle);
  const file = new File([blob], name, { type: "image/png" });
  const nav = navigator as Navigator & {
    canShare?: (data: { files: File[] }) => boolean;
    share?: (data: { files: File[]; title?: string }) => Promise<void>;
  };

  if (typeof nav.share === "function" && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: "Everyone's path" });
      return "shared";
    } catch (error) {
      // A user dismissing the share sheet raises AbortError. That is a
      // deliberate "no", not a failure to fall back from - downloading the
      // file anyway would be the opposite of what they just asked for.
      // Dismissed. Distinct from "shared": no file exists, so the caller must
      // not report a save - but we also must not download behind their back,
      // which is the opposite of what they just asked for.
      if (error instanceof Error && error.name === "AbortError") return "cancelled";
      // The sheet said it could take the file and then refused for a real
      // reason. Fall through to the download below rather than giving up: on a
      // desktop browser that genuinely works, and refusing to try left those
      // users with no file at all - which was a worse outcome than the false
      // "downloaded" it was meant to prevent.
      //
      // The residual risk is narrow and stated here rather than papered over:
      // on iOS, after a share rejection, we are outside the tap's activation
      // and the programmatic download may do nothing, so "downloaded" can
      // still over-claim. That needs BOTH the sync-share path to fail AND the
      // platform to be iOS, and the alternative penalises every other browser
      // for it.
    }
  }

  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    // Revoking synchronously can cancel the download in Safari; one frame is
    // enough for the navigation to have been taken.
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  return "downloaded";
}
