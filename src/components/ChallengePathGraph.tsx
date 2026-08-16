import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { formatTimeAndClicks } from "../domain/formatting";
import { strandStyleForIndex, type StrandStyle } from "../domain/strandStyle";
import { graphImageBlob, shareGraphImage } from "./graphImageExport";
import { labelIsRevealOnly } from "../domain/labelVisibility";
import { tapRadiiFor } from "../domain/tapRadius";
import {
  LABEL_PRIORITY_ANCHOR,
  LABEL_PRIORITY_BREADCRUMB,
  LABEL_PRIORITY_SHARED,
  LABEL_PRIORITY_SUPPRESSED,
  LANDSCAPE_SLOTS,
  PORTRAIT_SLOTS,
  placeLabels,
} from "../domain/labelPlacement";

/**
 * GR-1 ("View graph"): ported verbatim from the visualize-graph branch
 * prototype (commit 0cd6d41; full layout rationale + self-critique in that
 * branch's PROTOTYPE.md, kept there as history - not duplicated here). Only
 * this doc comment's opening two paragraphs changed on the port (no logic
 * touched); everything below "Layout heuristic" is the original v1+v2
 * writeup verbatim. Renders every player's run on one challenge as a single
 * MERGED graph - nodes deduped by article title, so the shared opening hops
 * braid together into one thick trunk instead of four separate lanes
 * repeating the same nodes. Mounted via `ChallengePathGraphButton`'s modal
 * (src/components/ChallengePathGraphButton.tsx) from Challenge Detail,
 * Stats Today/Yesterday, Results, and (best-effort) Home.
 *
 * Input shape mirrors the `graph-fixture.json` fixture 1:1 - and, as
 * predicted, matches `GET /api/v2/challenges/{id}/paths`'s real response
 * shape (`ChallengePathsResponse.runs`, src/server/contracts.ts) exactly, so
 * the server payload drops straight into this component's `runs` prop with
 * zero transformation: one entry per run, each an ordered list of
 * `{from, to}` hops. No graph/vis library - plain SVG, computed by hand
 * below.
 *
 * Layout heuristic (full rationale + self-critique in PROTOTYPE.md):
 *  - x target: each node's position STARTS as the mean, across every player
 *    who visits it, of that player's own normalized progress through THEIR
 *    path (visit index / that player's own step count) - the spec's
 *    suggested heuristic. The mean is WEIGHTED by each visitor's own step
 *    count (a 30-hop path's opinion counts more than a 5-hop path's for a
 *    node they both share): unweighted, a shared node lands closer to the
 *    short path's coarse per-hop fraction than the long path's fine one,
 *    which then sits ahead of that long path's own very next hop.
 *  - x repair: even weighted, a shared node can still land at/after a node
 *    one of its visitors reaches later (two paths simply disagree by too
 *    much). Fixed with a one-pass forward DP in topological order
 *    (longest-path layering over the DAG of real hops gives that order for
 *    free): a node is only nudged past a REAL predecessor of its own, never
 *    against unrelated chains - so an unaffected run like Reks' Film →
 *    Phonograph → Patent keeps its natural spacing untouched. An earlier
 *    version of this pass used a single global ordering (isotonic
 *    regression over ALL nodes) and over-corrected, flattening unrelated
 *    chains into one pooled plateau - see PROTOTYPE.md.
 *  - y: players get an evenly spaced "home lane"; a node's y is the average
 *    of the home lanes of everyone who visits it, so shared nodes pull
 *    toward the group's center and solo nodes sit in their player's lane.
 *  - labels: a greedy 2D collision check (`boxesOverlap`) places each label
 *    at the nearest above/below offset that doesn't overlap any
 *    already-placed label's actual on-screen box, so dense clusters (e.g.
 *    rnaik24's 27-hop solo stretch) or labels from different player lanes
 *    that happen to land at a similar x don't stack text on top of itself.
 *
 * v2 - council amendments (see the amendment brief in the visualize-graph
 * branch history for the full rationale behind each). Summary of what
 * changed on top of the v1 layout above:
 *  - A1: solo-node dot color read off the node's actual sole visitor, not
 *    its (usually empty) DNF set - fixed a bug that painted every non-DNF
 *    solo node teal.
 *  - A2: only the real target reaches x=1, so an abandoned run's terminal
 *    node can never land in the target's pixel column.
 *  - A3: the x-repair pass (still fully edge-scoped, never a global remap)
 *    now enforces a wider pixel-floor gap for early/shared nodes so the
 *    opening braid gets room to fan out before the layout's normal
 *    proportional spacing takes over.
 *  - A4: a label density policy - always label anchors, shared nodes and
 *    DNF terminals; long solo runs (>8 hops) fall back to breadcrumbs
 *    (every 5th hop + that stretch's first/last) on desktop, and to no
 *    solo interim labels at all on narrow viewports. Suppressed titles
 *    stay reachable via the node's native `<title>` tooltip and via the
 *    focused-player reveal (A6).
 *  - A5: node radius/emphasis rebalanced so merge points read co-equal
 *    with, never above, the start/target anchors; 3+ visitor nodes get a
 *    small centered count numeral.
 *  - A6: one shared `activePlayer` focus state driven by legend
 *    hover/click, per-player edge-group hover, and node tap - dims
 *    everyone else, reveals that player's suppressed labels, and (for a
 *    non-winner) rings the last node they share with the winner's route.
 *  - A7: winner's strand paints last (on top) at the convergence, its
 *    final edge into the target renders thicker, the target's halo scales
 *    with the number of finishers, and an abandoned run's last few edges
 *    taper toward the DNF mark instead of stopping abruptly.
 *  - A8: under ~480px the graph defaults to a fit-to-width overview (the
 *    whole shape, not scrollable); an "Explore path" toggle switches to
 *    the original 1080px scrollable layout with a fade hint at the
 *    trailing edge.
 *  - A9: a CSS-only entrance animation (respecting
 *    prefers-reduced-motion) that draws the shared trunk in first, then
 *    trickles each solo stretch in on a time-normalized ~1.5s budget
 *    regardless of run length.
 *  - A10: an on-canvas caption stating the x-axis is normalized progress,
 *    not click count or time - nothing else on the canvas corrects that
 *    assumption otherwise.
 */

export interface ChallengePathStep {
  n: number;
  from: string;
  to: string;
}

export interface ChallengePathRun {
  player: string;
  status: "completed" | "abandoned";
  elapsedMs: number;
  clicks: number;
  steps: ChallengePathStep[];
}

const SVG_WIDTH = 1080;
const MARGIN_LEFT = 100;
const MARGIN_RIGHT = 112;
const MARGIN_TOP = 56;
const MARGIN_BOTTOM = 40;
const PLOT_WIDTH = SVG_WIDTH - MARGIN_LEFT - MARGIN_RIGHT;

// GX-1: height used to be a flat 560px regardless of how many players'
// lanes actually need stacking - a fine fit around 4-6 runs, but a solo
// (or 2-run) result left most of that height an empty void beneath one or
// two lanes. Derived from lane count instead: a fixed base (room for the
// legend/margins/one lane) plus a per-lane increment, clamped so a 1-lane
// graph doesn't collapse too thin to read and a many-lane graph doesn't
// grow unbounded.
const SVG_HEIGHT_BASE = 190;
const SVG_HEIGHT_PER_LANE = 75;
const SVG_HEIGHT_MIN = 260;
const SVG_HEIGHT_MAX = 640;

function computeSvgHeight(laneCount: number): number {
  const raw = SVG_HEIGHT_BASE + SVG_HEIGHT_PER_LANE * laneCount;
  return Math.min(SVG_HEIGHT_MAX, Math.max(SVG_HEIGHT_MIN, raw));
}

/**
 * GR-2: which axis carries progress.
 *
 * The graph has a DENSE axis (progress - up to 37 hops on a real daily) and a
 * SPARSE one (player lanes - at most 12). Landscape gives the dense axis the
 * fixed 1080px width and the sparse one 640px of height. On a 390x844 phone
 * that is exactly backwards: fitting a 1080-wide canvas into 390px is a 2.8x
 * squeeze that renders every label at 2.8-3.9px, and "explore" mode shows 27%
 * of the canvas per sideways swipe.
 *
 * Portrait swaps them, so progress runs down the axis a phone actually has -
 * and the axis whose gesture (scroll) is native rather than hostile.
 */
export type GraphOrientation = "landscape" | "portrait";

interface GraphCanvas {
  orientation: GraphOrientation;
  width: number;
  height: number;
  marginLeft: number;
  marginRight: number;
  marginTop: number;
  marginBottom: number;
}

function landscapeCanvas(laneCount: number): GraphCanvas {
  return {
    orientation: "landscape",
    width: SVG_WIDTH,
    height: computeSvgHeight(laneCount),
    marginLeft: MARGIN_LEFT,
    marginRight: MARGIN_RIGHT,
    marginTop: MARGIN_TOP,
    marginBottom: MARGIN_BOTTOM,
  };
}

// Portrait margins are tight left/right (every pixel of width is label room
// and there are only ~390 of them) and roomier top/bottom, where the start and
// target anchors need space for their own labels.
/** Ties the collapsed legend's disclosure button to the list it reveals. */
const LEGEND_LIST_ID = "cpg-legend-list";
const PORTRAIT_MARGIN_X = 10;
const PORTRAIT_MARGIN_TOP = 40;
const PORTRAIT_MARGIN_BOTTOM = 46;
/** Room kept below the canvas for the "Save image" row and the sheet's padding. */
const PORTRAIT_FOOTER_PX = 76;
/** A landscape phone is short; the canvas still needs to be worth scrolling. */
const PORTRAIT_MIN_HEIGHT = 460;

function portraitCanvas(width: number, height: number): GraphCanvas {
  return {
    orientation: "portrait",
    width,
    height,
    marginLeft: PORTRAIT_MARGIN_X,
    marginRight: PORTRAIT_MARGIN_X,
    marginTop: PORTRAIT_MARGIN_TOP,
    marginBottom: PORTRAIT_MARGIN_BOTTOM,
  };
}

// GR-2: strand identity (hue + dash) now lives in domain/strandStyle.ts, with
// the measurement behind the 7-hue ceiling. The prototype's 6 hues were cycled
// by lane index, which painted five PAIRS of players identically on the
// 11-strand 2026-07-20 daily. 82% of challenges to date field <= 7 strands and
// so never repeat a hue at all; the rest are told apart by the dash.
const DNF_MARK_COLOR = "#e0655a";
const START_RING_COLOR = "#8ff3e6";
const TARGET_COLOR = "#ff765f";

const LABEL_ROW_OFFSETS = [0, 18, -18, 36, -36, 54, -54, 72, -72, 90, -90];
const LABEL_GAP_PX = 8;
/**
 * Feeds `estimateLabelWidth`, which drives label collision spacing in the
 * SVG - so an UNDER-estimate overlaps labels, while an over-estimate merely
 * leaves them roomier. Deliberately left at Fredoka's 6.6 through the
 * 2026-08-15 Merriweather swap: Merriweather-500 measures 5.95px per
 * character at 12px over a sample of real page titles (fontTools, weighted
 * by the actual glyph advances), so 6.6 is now a ~11% safety margin rather
 * than a fit. Keep any future value at or ABOVE the measured advance of the
 * body face; tightening it to the exact figure trades invisible slack for a
 * visible overlap bug the first time a title runs wide.
 */
const CHAR_WIDTH_PX = 6.6;

/**
 * GR-2: below this width the graph lays out in PORTRAIT.
 *
 * Was 480 (A8's "phone" tier). Raised to 900 after measuring the middle
 * widths, which were the worst of both worlds: at 768px the landscape canvas
 * rendered at full size but 35% of it sat outside the modal, so reading the
 * graph meant swiping sideways through it. Portrait at the same width shows
 * the whole thing at once - 71 visible labels at >=10.5px, no sideways scroll.
 *
 * 900 rather than 1080 because the modal is min(1200px, 92vw): a 1080px canvas
 * needs roughly 1175px of window before it fits without scrolling, and between
 * 900 and 1175 landscape still reads well enough that flipping the axis would
 * be more disruptive than the scroll.
 */
const PORTRAIT_BREAKPOINT = 900;
const SCROLL_HINT_KEY = "cpg-scroll-hint-seen";

function truncateTitle(title: string, max = 20): string {
  return title.length > max ? `${title.slice(0, max)}…` : title;
}

function estimateLabelWidth(text: string, fontSize: number): number {
  return text.length * CHAR_WIDTH_PX * (fontSize / 12) + 12;
}

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

interface NodeAgg {
  title: string;
  isStart: boolean;
  isTarget: boolean;
  visitors: Map<string, number[]>; // player -> fractions (usually one; averaged if a path revisits)
  dnfTerminalFor: Set<string>;
}

interface NodeLayout {
  title: string;
  isStart: boolean;
  isTarget: boolean;
  visitorCount: number;
  visitorPlayers: string[];
  soleVisitor?: string; // A1: the one player who visits this node, when visitorCount === 1
  dnfTerminalFor: Set<string>;
  cx: number;
  cy: number;
  radius: number;
  alwaysLabel: boolean; // anchor, shared, or DNF terminal - never suppressed
  showLabelDesktop: boolean; // alwaysLabel || A4 breadcrumb-selected
  labelDx: number;
  /** GR-2: false when revealing this label would overprint a co-revealed one. */
  labelRevealable: boolean;
  /** GR-2: this node's own collision-free tap radius. */
  hitRadius: number;
  labelCrowdedOut: boolean; // GR-2: no collision-free slot existed
  labelText: string;
  labelFull: string;
  labelDy: number;
  fontSize: number;
  arrivalMs: number; // A9: earliest incoming-edge arrival, for the entrance pop
}

interface EdgeLayout {
  key: string;
  player: string;
  color: string;
  /** GR-2: SVG `stroke-dasharray` for strands past the 7 distinct hues. */
  dash: string | null;
  opacity: number;
  strokeWidth: number;
  d: string;
  groupSize: number;
  isTrunk: boolean;
  fromTitle: string;
  toTitle: string;
  isDnf: boolean;
  isWinnerFinalEdge: boolean;
  delayMs: number;
  durMs: number;
}

interface GraphLayout {
  nodes: NodeLayout[];
  edgesByPlayer: Array<{ player: string; edges: EdgeLayout[] }>;
  startTitle: string | null;
  targetTitle: string | null;
  winnerPlayer: string | null;
  finisherCount: number;
  targetGlowOpacity: number;
  entranceTotalMs: number;
  svgWidth: number;
  orientation: GraphOrientation;
  svgHeight: number;
}

function buildGraph(orderedRuns: ChallengePathRun[], canvas?: GraphCanvas): GraphLayout {
  const playerOrder = orderedRuns.map((r) => r.player);
  const winnerRun = orderedRuns.find((r) => r.status === "completed") ?? null;
  const finisherCount = orderedRuns.filter((r) => r.status === "completed").length;

  // GX-1: lane-count-driven height - computed once, up front, so every
  // downstream calculation (lane placement, the weighted-mean fallback, the
  // raw node fallback) already flows from the real height instead of the old
  // fixed 560.
  const box = canvas ?? landscapeCanvas(Math.max(1, playerOrder.length));
  const svgWidth = box.width;
  const svgHeight = box.height;
  const plotWidth = svgWidth - box.marginLeft - box.marginRight;
  const plotHeight = svgHeight - box.marginTop - box.marginBottom;

  // GR-2: everything below computes NORMALIZED progress and lane fractions;
  // only these four values decide which screen axis each one lands on, so the
  // whole layout heuristic (weighted means, the DAG repair pass, the
  // start/target rescale) is shared verbatim between orientations.
  const isPortrait = box.orientation === "portrait";
  const progressPx = isPortrait ? plotHeight : plotWidth;
  const lanePx = isPortrait ? plotWidth : plotHeight;
  const progressOrigin = isPortrait ? box.marginTop : box.marginLeft;
  const laneOrigin = isPortrait ? box.marginLeft : box.marginTop;

  const nodeAggs = new Map<string, NodeAgg>();

  function touchNode(title: string): NodeAgg {
    let agg = nodeAggs.get(title);
    if (!agg) {
      agg = { title, isStart: false, isTarget: false, visitors: new Map(), dnfTerminalFor: new Set() };
      nodeAggs.set(title, agg);
    }
    return agg;
  }

  function addVisit(title: string, player: string, frac: number) {
    const agg = touchNode(title);
    const list = agg.visitors.get(player);
    if (list) list.push(frac);
    else agg.visitors.set(player, [frac]);
  }

  const startCounts = new Map<string, number>();
  const targetCounts = new Map<string, number>();

  for (const run of orderedRuns) {
    const total = Math.max(1, run.steps.length);
    if (run.steps.length === 0) continue;
    const startTitleLocal = run.steps[0].from;
    startCounts.set(startTitleLocal, (startCounts.get(startTitleLocal) ?? 0) + 1);
    addVisit(startTitleLocal, run.player, 0);

    run.steps.forEach((step, index) => {
      const frac = (index + 1) / total;
      addVisit(step.to, run.player, frac);
    });

    if (run.status === "completed") {
      const finalTitle = run.steps[run.steps.length - 1].to;
      targetCounts.set(finalTitle, (targetCounts.get(finalTitle) ?? 0) + 1);
    } else {
      const finalTitle = run.steps[run.steps.length - 1].to;
      touchNode(finalTitle).dnfTerminalFor.add(run.player);
    }
  }

  let startTitle: string | null = null;
  let startBest = 0;
  for (const [title, count] of startCounts) {
    if (count > startBest) {
      startBest = count;
      startTitle = title;
    }
  }
  let targetTitle: string | null = null;
  let targetBest = 0;
  for (const [title, count] of targetCounts) {
    if (count > targetBest) {
      targetBest = count;
      targetTitle = title;
    }
  }
  if (startTitle) touchNode(startTitle).isStart = true;
  if (targetTitle) touchNode(targetTitle).isTarget = true;

  const laneIndex = new Map<string, number>();
  playerOrder.forEach((player, i) => laneIndex.set(player, i));
  const laneCount = Math.max(1, playerOrder.length);
  const laneGap = lanePx / (laneCount + 1);
  /** Pixel position along the LANE axis (y in landscape, x in portrait). */
  function laneCoord(player: string): number {
    const i = laneIndex.get(player) ?? 0;
    return laneOrigin + laneGap * (i + 1);
  }

  interface Raw {
    agg: NodeAgg;
    xFrac: number;
    /** Pixel position along the lane axis. */
    lane: number;
    visitorCount: number;
  }

  // Initial x target: mean, across every visitor, of THEIR OWN normalized
  // progress (spec heuristic) - but WEIGHTED by each visitor's own step
  // count. See the module docblock for the full rationale.
  const weightedMeanFracByTitle = new Map<string, number>();
  const laneCoordByTitle = new Map<string, number>();
  const stepCountByPlayer = new Map<string, number>();
  for (const run of orderedRuns) stepCountByPlayer.set(run.player, Math.max(1, run.steps.length));
  for (const agg of nodeAggs.values()) {
    let weightedSum = 0;
    let weightTotal = 0;
    let ySum = 0;
    let n = 0;
    for (const [player, fracs] of agg.visitors) {
      const meanFrac = fracs.reduce((a, b) => a + b, 0) / fracs.length;
      const w = stepCountByPlayer.get(player) ?? 1;
      weightedSum += meanFrac * w;
      weightTotal += w;
      ySum += laneCoord(player);
      n += 1;
    }
    weightedMeanFracByTitle.set(agg.title, weightTotal ? weightedSum / weightTotal : 0);
    laneCoordByTitle.set(agg.title, n ? ySum / n : laneOrigin + lanePx / 2);
  }

  // Repair pass: a valid left-to-right ORDER for every node via longest-path
  // layering over the DAG of actual hops (edge weight 1) - layer(v) is
  // guaranteed strictly greater than layer(u) for every real hop u->v, so
  // processing nodes in increasing layer order visits every predecessor of
  // a node before the node itself, in one forward pass.
  const hopEdges: Array<[string, string]> = [];
  const predecessors = new Map<string, Set<string>>();
  for (const run of orderedRuns) {
    let prevTitle = run.steps.length ? run.steps[0].from : null;
    if (prevTitle) {
      run.steps.forEach((step) => {
        hopEdges.push([prevTitle as string, step.to]);
        const set = predecessors.get(step.to) ?? new Set<string>();
        set.add(prevTitle as string);
        predecessors.set(step.to, set);
        prevTitle = step.to;
      });
    }
  }
  const layer = new Map<string, number>();
  for (const title of nodeAggs.keys()) layer.set(title, 0);
  for (let pass = 0; pass < nodeAggs.size + 1; pass++) {
    let changed = false;
    for (const [from, to] of hopEdges) {
      const need = (layer.get(from) ?? 0) + 1;
      if ((layer.get(to) ?? 0) < need) {
        layer.set(to, need);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Only nudges a node when one of its OWN real predecessors would
  // otherwise land at/after it - a local, edge-scoped fix (never a global
  // total order across unrelated chains), so an unaffected chain like
  // Reks' Film → Phonograph → Patent keeps its natural, honest spacing
  // untouched.
  //
  // A3: the gap this pass enforces is widened to a 64px pixel floor for
  // early layers (<=2 hops in) or nodes any two runs actually share - the
  // start/target rescale below borrows the extra width from the sparser
  // tail automatically, so the opening braid gets room to fan out before
  // falling back to the tight default gap deeper into solo stretches.
  const MIN_GAP_FRAC = 0.012;
  const TRUNK_GAP_PX = 64;
  const order = [...nodeAggs.keys()].sort((a, b) => (layer.get(a) ?? 0) - (layer.get(b) ?? 0));
  const rawFrac = new Map<string, number>();
  for (const title of order) {
    let x = weightedMeanFracByTitle.get(title) ?? 0;
    for (const pred of predecessors.get(title) ?? []) {
      const gapFrac =
        (layer.get(title) ?? 0) <= 2 || (nodeAggs.get(title)?.visitors.size ?? 1) > 1
          ? TRUNK_GAP_PX / progressPx
          : MIN_GAP_FRAC;
      const need = (rawFrac.get(pred) ?? 0) + gapFrac;
      if (need > x) x = need;
    }
    rawFrac.set(title, x);
  }

  // Rescale so the start sits at exactly 0 and the target at exactly 1
  // (spec: "start node far left... target ONE node far right"), regardless
  // of where the fit above landed them.
  const rawStart = startTitle ? rawFrac.get(startTitle) ?? 0 : 0;
  const rawTarget = targetTitle ? rawFrac.get(targetTitle) ?? 1 : 1;
  const span = rawTarget - rawStart || 1;

  const raws: Raw[] = [];
  for (const agg of nodeAggs.values()) {
    const scaled = ((rawFrac.get(agg.title) ?? 0) - rawStart) / span;
    // A2: only the real target reaches x=1, so an abandoned run's terminal
    // node can never land in the same pixel column as the target star.
    const xFrac = agg.isStart ? 0 : agg.isTarget ? 1 : Math.min(0.94, Math.max(0, scaled));
    raws.push({
      agg,
      xFrac,
      lane: laneCoordByTitle.get(agg.title) ?? laneOrigin + lanePx / 2,
      visitorCount: agg.visitors.size,
    });
  }

  raws.sort((a, b) => a.xFrac - b.xFrac);

  // GR-2: tap targets are sized per node from how close that node's own
  // nearest neighbour is - see domain/tapRadius.ts for why a flat 44 units
  // silently handed taps to the wrong node, and why one global minimum would
  // have shrunk every target in the graph to the floor.
  const hitRadii = tapRadiiFor(
    raws.map((raw) => {
      const progress = progressOrigin + raw.xFrac * progressPx;
      return isPortrait ? { x: raw.lane, y: progress } : { x: progress, y: raw.lane };
    }),
  );

  // A4: label density policy. Always label anchors, shared nodes and DNF
  // terminals. Solo interim nodes on runs > 8 hops instead get
  // breadcrumbs: that stretch's first and last node, plus every 5th hop.
  // Runs <= 8 hops (the elegant/flat wins) are exempt - every solo node
  // stays labeled, matching the v1 behavior for the runs where it never
  // caused noise. This is the *structural* (desktop) tier; the mobile
  // "zero solo interim labels" tier is a render-time viewport decision
  // layered on top in the component, since it doesn't affect layout.
  const alwaysLabelTitles = new Set<string>();
  for (const agg of nodeAggs.values()) {
    const isSolo = agg.visitors.size === 1;
    if (agg.isStart || agg.isTarget || !isSolo || agg.dnfTerminalFor.size > 0) {
      alwaysLabelTitles.add(agg.title);
    }
  }
  const breadcrumbEligibleTitles = new Set<string>();
  for (const run of orderedRuns) {
    const total = run.steps.length;
    if (total === 0) continue;
    // GR-2: portrait has roughly a third of landscape's label room, so the
    // breadcrumb rule tightens rather than letting the placer arbitrate by
    // crowding alone. A stretch's FIRST and LAST node - where a player left
    // the pack and where they rejoined it - carry nearly all the meaning; the
    // every-5th-hop samples in between are the first thing worth dropping.
    // Measured on the 11-strand daily: 51 default labels down to 33, all of
    // them still attached to a visible node.
    const longRun = total > (isPortrait ? 5 : 8);
    let stretch: Array<{ title: string; hopIndex: number }> = [];
    const flush = () => {
      if (!stretch.length) return;
      if (!longRun) {
        for (const s of stretch) breadcrumbEligibleTitles.add(s.title);
      } else {
        breadcrumbEligibleTitles.add(stretch[0].title);
        breadcrumbEligibleTitles.add(stretch[stretch.length - 1].title);
        if (!isPortrait) {
          for (const s of stretch) {
            if (s.hopIndex % 5 === 0) breadcrumbEligibleTitles.add(s.title);
          }
        }
      }
      stretch = [];
    };
    run.steps.forEach((step, index) => {
      const title = step.to;
      if (alwaysLabelTitles.has(title)) {
        flush();
      } else {
        stretch.push({ title, hopIndex: index + 1 });
      }
    });
    flush();
  }

  // Label placement now lives in domain/labelPlacement.ts - see that file for
  // why priority order, sideways slots and suppression-instead-of-collision
  // replaced the prototype's "try 11 vertical offsets, then overprint anyway".
  // It runs as its own pass because the placer needs EVERY candidate's box up
  // front to sort by priority; the old inline version could only ever see the
  // labels that happened to come earlier in layout order.
  const labelInputs = raws.map((raw) => {
    const big = raw.agg.isStart || raw.agg.isTarget;
    const alwaysLabel = alwaysLabelTitles.has(raw.agg.title);
    const breadcrumbEligible = !alwaysLabel && breadcrumbEligibleTitles.has(raw.agg.title);
    const fontSize = big ? 14 : 12;
    // Portrait has ~390px of width for a label to live in, against 1080 in
    // landscape, so titles truncate harder there or nothing else fits beside
    // them.
    const labelText = truncateTitle(raw.agg.title, isPortrait ? (big ? 18 : 15) : big ? 26 : 20);
    const progress = progressOrigin + raw.xFrac * progressPx;
    const lanePos = raw.lane;
    return {
      cx: isPortrait ? lanePos : progress,
      cy: isPortrait ? progress : lanePos,
      // Spread labels OUTWARD from the middle of the canvas, into the margins
      // that would otherwise sit empty, instead of piling every one of them on
      // the same flank.
      preferSide: isPortrait
        ? lanePos < box.marginLeft + plotWidth / 2
          ? ("left" as const)
          : ("right" as const)
        : undefined,
      width: estimateLabelWidth(labelText, fontSize),
      // Merriweather's ascender-to-descender box runs ~1.35x its font size.
      // Deliberately generous, for the same reason CHAR_WIDTH_PX is.
      height: Math.ceil(fontSize * 1.35),
      // Only a SOLO node can be revealed by focusing a player, so only a solo
      // node has an owner to avoid siblings of.
      owner: raw.agg.visitors.size === 1 ? [...raw.agg.visitors.keys()][0] : undefined,
      priority: big
        ? LABEL_PRIORITY_ANCHOR
        : alwaysLabel
          ? LABEL_PRIORITY_SHARED
          : breadcrumbEligible
            ? LABEL_PRIORITY_BREADCRUMB
            : LABEL_PRIORITY_SUPPRESSED,
      big,
      alwaysLabel,
      showLabelDesktop: alwaysLabel || breadcrumbEligible,
      fontSize,
      labelText,
    };
  });
  // Labels may use the margins (that is what they are for) but not run off the
  // canvas, where they render clipped.
  const labelPlacements = placeLabels(
    labelInputs,
    { minX: 4, maxX: svgWidth - 4, minY: 2, maxY: svgHeight - 2 },
    isPortrait ? PORTRAIT_SLOTS : LANDSCAPE_SLOTS,
  );

  const nodes: NodeLayout[] = raws.map((raw, index) => {
    const input = labelInputs[index];
    const placement = labelPlacements[index];
    const { cx, cy, big, alwaysLabel, showLabelDesktop, fontSize, labelText } = input;

    const visitorCount = raw.visitorCount;
    // A5: merge points read co-equal with (never above) the start/target
    // anchors; solo nodes shrink further once A4 drops their label.
    const radius = big
      ? 11
      : visitorCount >= 4
        ? 12
        : visitorCount === 3
          ? 9.5
          : visitorCount === 2
            ? 7
            : showLabelDesktop
              ? 3
              : 2.5;

    const visitorPlayers = [...raw.agg.visitors.keys()];
    const soleVisitor = visitorPlayers.length === 1 ? visitorPlayers[0] : undefined;

    return {
      title: raw.agg.title,
      isStart: raw.agg.isStart,
      isTarget: raw.agg.isTarget,
      visitorCount,
      visitorPlayers,
      soleVisitor,
      dnfTerminalFor: raw.agg.dnfTerminalFor,
      cx,
      cy,
      radius,
      alwaysLabel,
      showLabelDesktop,
      labelText,
      labelFull: raw.agg.title,
      hitRadius: hitRadii[index],
      labelDx: placement.dx,
      labelRevealable: placement.revealable,
      labelDy: placement.dy,
      // GR-2: the placer found no collision-free slot for this one. It stays
      // reachable through the node's <title> tooltip and the A6 focus reveal,
      // but must not render by default - an overprinted label destroys the
      // label it lands on as well as itself.
      labelCrowdedOut: placement.hidden && input.priority !== LABEL_PRIORITY_SUPPRESSED,
      fontSize,
      arrivalMs: 0, // filled in below, once edge timing is known
    };
  });

  const nodeByTitle = new Map(nodes.map((n) => [n.title, n]));

  const groupCounts = new Map<string, number>();
  for (const run of orderedRuns) {
    for (const step of run.steps) {
      const key = `${step.from}→${step.to}`;
      groupCounts.set(key, (groupCounts.get(key) ?? 0) + 1);
    }
  }
  const groupSeen = new Map<string, number>();

  const playerStyle = (player: string): StrandStyle =>
    strandStyleForIndex(laneIndex.get(player) ?? 0);

  // A7: the abandoned run's last three edges taper from the DNF baseline
  // opacity/width down toward the mark, so it reads as losing steam rather
  // than an arbitrary stop.
  const DNF_TAPER_OPACITY = [0.4, 0.275, 0.15];
  const DNF_TAPER_WIDTH = [2.25, 1.875, 1.5];

  const rawEdges: EdgeLayout[] = [];
  orderedRuns.forEach((run) => {
    const total = run.steps.length;
    run.steps.forEach((step) => {
      const from = nodeByTitle.get(step.from);
      const to = nodeByTitle.get(step.to);
      if (!from || !to) return;
      const key = `${step.from}→${step.to}`;
      const groupSize = groupCounts.get(key) ?? 1;
      const seenIndex = groupSeen.get(key) ?? 0;
      groupSeen.set(key, seenIndex + 1);

      const dx = to.cx - from.cx;
      const dy = to.cy - from.cy;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;
      const offset = (seenIndex - (groupSize - 1) / 2) * 7;

      const c1x = from.cx + dx / 3 + nx * offset;
      const c1y = from.cy + dy / 3 + ny * offset;
      const c2x = from.cx + (2 * dx) / 3 + nx * offset;
      const c2y = from.cy + (2 * dy) / 3 + ny * offset;

      const isDnf = run.status === "abandoned";
      const isWinnerFinalEdge = !!winnerRun && run.player === winnerRun.player && to.isTarget;

      let opacity: number;
      let strokeWidth: number;
      if (isDnf) {
        const posFromEnd = total - step.n; // 0 = the final edge
        if (posFromEnd <= 2) {
          opacity = DNF_TAPER_OPACITY[2 - posFromEnd];
          strokeWidth = DNF_TAPER_WIDTH[2 - posFromEnd];
        } else {
          opacity = 0.4;
          strokeWidth = 2.25;
        }
      } else {
        opacity = 0.85;
        strokeWidth = isWinnerFinalEdge ? 3.5 : 2.25;
      }

      // A9: trunk hops (anything more than one run shares) braid in
      // together as one confident stroke; solo hops trickle in afterward
      // on a run-length-normalized budget, so a 30-click odyssey doesn't
      // take 6x longer to draw than a 5-click win.
      const isTrunk = groupSize > 1;
      const rawStep = 1000 / Math.max(1, total);
      const delayStep = Math.min(160, Math.max(30, rawStep));
      const dur = Math.min(280, Math.max(90, rawStep));
      const delayMs = isTrunk ? 0 : 420 + (step.n - 1) * delayStep;
      const durMs = isTrunk ? 420 : dur;

      rawEdges.push({
        key: `${run.player}-${step.n}-${step.from}-${step.to}`,
        player: run.player,
        color: playerStyle(run.player).color,
        dash: playerStyle(run.player).dash,
        opacity,
        strokeWidth,
        d: `M ${from.cx} ${from.cy} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${to.cx} ${to.cy}`,
        groupSize,
        isTrunk,
        fromTitle: step.from,
        toTitle: step.to,
        isDnf,
        isWinnerFinalEdge,
        delayMs,
        durMs,
      });
    });
  });

  // A7: paint order only, independent of the entrance timing above - DNFs
  // paint first, the winner's strand paints LAST so it's on top at the
  // shared convergence. Offsets/colors above were already computed in
  // canonical (finisher-fastest-first) order, so reordering here only
  // changes SVG paint order, not the braid geometry.
  const paintRank = new Map<string, number>();
  [...orderedRuns].reverse().forEach((run, i) => paintRank.set(run.player, i));
  const edges = [...rawEdges].sort((a, b) => (paintRank.get(a.player) ?? 0) - (paintRank.get(b.player) ?? 0));

  const edgesByPlayer: Array<{ player: string; edges: EdgeLayout[] }> = [];
  for (const edge of edges) {
    const last = edgesByPlayer[edgesByPlayer.length - 1];
    if (last && last.player === edge.player) {
      last.edges.push(edge);
    } else {
      edgesByPlayer.push({ player: edge.player, edges: [edge] });
    }
  }

  // A9: each node's entrance pop fires at the earliest moment any incoming
  // edge finishes drawing into it (the start has no incoming edge and pops
  // immediately).
  const arrivalByTitle = new Map<string, number>();
  for (const edge of edges) {
    const arrival = edge.delayMs + edge.durMs;
    const prev = arrivalByTitle.get(edge.toTitle);
    if (prev === undefined || arrival < prev) arrivalByTitle.set(edge.toTitle, arrival);
  }
  const finalNodes = nodes.map((n) => ({ ...n, arrivalMs: n.isStart ? 0 : arrivalByTitle.get(n.title) ?? 0 }));
  const entranceTotalMs = edges.reduce((max, e) => Math.max(max, e.delayMs + e.durMs), 0);

  // A7: the target's halo scales with how many players actually finished.
  const targetGlowOpacity = 0.18 + 0.05 * finisherCount;

  return {
    nodes: finalNodes,
    edgesByPlayer,
    startTitle,
    targetTitle,
    winnerPlayer: winnerRun ? winnerRun.player : null,
    finisherCount,
    targetGlowOpacity,
    entranceTotalMs,
    svgWidth,
    svgHeight,
    orientation: box.orientation,
  };
}

// A8: viewport-responsive tier - kept out of buildGraph (pure, layout-only)
// since it never affects node/edge positions, only default label/SVG-sizing
// decisions at render time.
function useMediaQuery(query: string): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    setIsMobile(mql.matches);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    if (mql.addEventListener) mql.addEventListener("change", handler);
    // Safari < 14 fallback.
    else mql.addListener(handler);
    return () => {
      if (mql.removeEventListener) mql.removeEventListener("change", handler);
      else mql.removeListener(handler);
    };
  }, [query]);
  return isMobile;
}

function useIsMobile(breakpointPx: number): boolean {
  return useMediaQuery(`(max-width: ${breakpointPx}px)`);
}

/**
 * GR-2: how a node is painted, as literal colours.
 *
 * The SVG could use `var(--ink-soft, #102329)`, but Canvas2D cannot resolve a
 * CSS custom property, and the shared PNG must look like the screen. Rather
 * than keep two copies of the rules - which WOULD drift, since the only thing
 * checking them is a human comparing a screenshot to a download - both
 * renderers read from here. The literals are the same values the var()
 * fallbacks already carried, and this app ships a single dark theme.
 */
const INK = "#061014";
const INK_SOFT = "#102329";
const TEXT_BRIGHT = "#dffbfb";

function nodeVisuals(
  node: NodeLayout,
  playerColorOf: (player: string) => string,
): { fill: string; stroke: string; labelColor: string } {
  const soloColor = playerColorOf(node.soleVisitor ?? "");
  return {
    fill: node.isStart
      ? INK_SOFT
      : node.isTarget
        ? TARGET_COLOR
        : node.visitorCount > 1
          ? TEXT_BRIGHT
          : soloColor,
    stroke: node.isStart ? START_RING_COLOR : node.isTarget ? TARGET_COLOR : "none",
    // A4: tint surviving solo labels to their owner; shared labels stay bright
    // white ("everyone was here"). At FULL opacity - these used to be drawn at
    // alpha 0.65 for recession, which put bronze at 2.69:1 and violet at
    // 3.16:1 against the 4.5:1 AA floor for 12px text. The hue by itself
    // separates a solo label from a shared one without dimming it, since the
    // shared ones are white.
    labelColor:
      node.isStart || node.isTarget || node.visitorCount > 1 ? TEXT_BRIGHT : soloColor,
  };
}

export default function ChallengePathGraph({ runs }: { runs: ChallengePathRun[] }) {
  // Legend/lane order: finishers fastest-first, then DNFs - tells the story
  // top-to-bottom (winners, then the odyssey, then the one who bailed) and
  // gives each player a stable home lane for the y heuristic above.
  const orderedRuns = useMemo(() => {
    return [...runs].sort((a, b) => {
      if (a.status !== b.status) return a.status === "completed" ? -1 : 1;
      return a.elapsedMs - b.elapsedMs;
    });
  }, [runs]);

  const playerOrder = useMemo(() => orderedRuns.map((r) => r.player), [orderedRuns]);
  const playerStyleOf = (player: string): StrandStyle =>
    strandStyleForIndex(Math.max(0, playerOrder.indexOf(player)));
  const playerColorOf = (player: string) => playerStyleOf(player).color;

  // GR-2: on a phone the graph is laid out in PORTRAIT against the real
  // measured sheet, so the whole thing fits the screen it is actually on
  // (the owner screenshots this view to share) instead of being a 1080px
  // landscape canvas squeezed to 28%.
  const isNarrow = useIsMobile(PORTRAIT_BREAKPOINT);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [sheet, setSheet] = useState<{ width: number; height: number } | null>(null);
  // Declared above the measurement effect because expanding the legend moves
  // the canvas's top edge, so the effect depends on it.
  const [legendOpen, setLegendOpen] = useState(false);
  // Toggling the legend UNMOUNTS the button that was just activated, which
  // drops keyboard focus to <body> - a keyboard user loses their place and has
  // to tab in from the top of the dialog again. Move focus onto the control
  // that replaced it.
  const legendToggleRef = useRef<HTMLButtonElement | null>(null);
  const legendHideRef = useRef<HTMLButtonElement | null>(null);
  const [focusLegendControl, setFocusLegendControl] = useState<"show" | "hide" | null>(null);
  useEffect(() => {
    if (!focusLegendControl) return;
    const target = focusLegendControl === "hide" ? legendHideRef.current : legendToggleRef.current;
    target?.focus();
    setFocusLegendControl(null);
  }, [focusLegendControl, legendOpen]);
  useEffect(() => {
    if (!isNarrow) {
      setSheet(null);
      return;
    }
    const measure = () => {
      const el = shellRef.current;
      if (!el || typeof window === "undefined") return;
      // MEASURE THE CANVAS'S OWN BOX, not the component root. The root's
      // clientWidth includes its 32px of horizontal padding, which made the
      // canvas 32px wider than the space it had and cost ~10% scale; and the
      // root's top sits ABOVE the legend, so the height budget double-counted
      // whatever the legend was occupying and the graph's bottom edge ran off
      // the sheet whenever the width was not the binding constraint.
      const width = el.clientWidth;
      if (width <= 0) return;
      const top = el.getBoundingClientRect().top;
      const available = window.innerHeight - top - PORTRAIT_FOOTER_PX;
      const height = Math.max(PORTRAIT_MIN_HEIGHT, Math.round(available));
      // Bail when nothing moved. Every setSheet is a new object identity, which
      // re-runs the whole layout through useMemo; iOS fires resize continuously
      // while the URL bar collapses, and without this the graph would relayout
      // on every one of those frames.
      setSheet((current) =>
        current && current.width === width && current.height === height
          ? current
          : { width, height },
      );
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
    };
    // isPortrait and legendOpen both belong here, because both move the
    // canvas's own top edge:
    //  - The FIRST measurement necessarily runs against the landscape layout
    //    (sheet is null until it completes), where the legend is expanded and
    //    ~300px tall. Without re-measuring once the portrait legend collapses
    //    to 44px, the canvas keeps a height budget computed against the tall
    //    layout and lands on the PORTRAIT_MIN_HEIGHT floor - a 460px canvas in
    //    620px of room.
    //  - Expanding the legend by hand moves it back down again.
    // Depending on `sheet` itself is what catches the first case, since
    // orientation is derived from it further down. This converges rather than
    // looping: setSheet returns the EXISTING object when the numbers have not
    // moved, so identity stops changing and the effect stops re-running.
  }, [isNarrow, legendOpen, sheet]);

  const graph = useMemo(
    () => buildGraph(orderedRuns, sheet ? portraitCanvas(sheet.width, sheet.height) : undefined),
    [orderedRuns, sheet],
  );
  const isPortrait = graph.orientation === "portrait";
  // "done" is distinct from "idle" so a completed save is visible at all: the
  // button used to return straight to "Save image", which is exactly what it
  // says when nothing has happened.
  const [exportState, setExportState] = useState<"idle" | "working" | "done" | "failed">("idle");

  // A6: one shared focus state. Legend hover/click, per-player edge-group
  // hover, and node tap all funnel into this same setter.
  // A6 focus, split into HOVER and PIN.
  //
  // It used to be one value driven by pointerenter/pointerleave/click, which
  // made clicking useless with a mouse: entering the row already set it, so the
  // click's toggle immediately CLEARED it, and leaving the row cleared it
  // again. There was no way to pin a player and then go read their strand -
  // exactly what the affordance exists for. A pin now outranks a hover and
  // survives the pointer leaving.
  const [pinnedPlayer, setPinnedPlayer] = useState<string | null>(null);
  const [hoveredPlayer, setHoveredPlayer] = useState<string | null>(null);
  const activePlayer = pinnedPlayer ?? hoveredPlayer;
  const clearFocus = () => {
    setPinnedPlayer(null);
    setHoveredPlayer(null);
  };
  const hoverOn = (player: string) => setHoveredPlayer(player);
  const hoverOff = (player: string) =>
    setHoveredPlayer((cur) => (cur === player ? null : cur));
  const togglePin = (player: string) =>
    setPinnedPlayer((cur) => (cur === player ? null : player));
  const [callout, setCallout] = useState<{ title: string; cx: number; cy: number } | null>(null);

  const winnerRun = useMemo(
    () => (graph.winnerPlayer ? orderedRuns.find((r) => r.player === graph.winnerPlayer) ?? null : null),
    [graph.winnerPlayer, orderedRuns],
  );

  // A6: "here's where I diverged" - the last node the active (non-winner)
  // player's own path shares with the winner's, walked forward in the
  // active player's own order. The target is deliberately excluded from
  // the shared-node set: every completed run ends there by definition, so
  // without excluding it the "last shared node" is always the trivial
  // finish-line reconvergence, not the actual mid-path divergence point.
  const divergenceTitle = useMemo(() => {
    if (!activePlayer || !winnerRun || activePlayer === winnerRun.player) return null;
    const activeRun = orderedRuns.find((r) => r.player === activePlayer);
    if (!activeRun || !activeRun.steps.length) return null;
    const targetTitle = graph.targetTitle;
    const winnerTitles = new Set<string>();
    winnerTitles.add(winnerRun.steps[0]?.from ?? "");
    for (const step of winnerRun.steps) {
      if (step.to !== targetTitle) winnerTitles.add(step.to);
    }
    let last: string | null = winnerTitles.has(activeRun.steps[0].from) ? activeRun.steps[0].from : null;
    for (const step of activeRun.steps) {
      if (winnerTitles.has(step.to)) last = step.to;
    }
    return last;
  }, [activePlayer, winnerRun, orderedRuns, graph.targetTitle]);

  // GR-2: the A9 entrance draws each strand in by animating
  // `stroke-dasharray`/`stroke-dashoffset`, so a strand that carries its own
  // dash (the 8th and beyond - see strandStyle.ts) can only take it once that
  // animation is finished; applying both at once leaves the strand undrawn.
  // Reduced-motion skips the entrance entirely, so the dash is there from the
  // first paint.
  const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [entranceDone, setEntranceDone] = useState(false);
  useEffect(() => {
    if (reduceMotion) {
      setEntranceDone(true);
      return;
    }
    setEntranceDone(false);
    const timer = setTimeout(() => setEntranceDone(true), graph.entranceTotalMs + 80);
    return () => clearTimeout(timer);
  }, [graph.entranceTotalMs, reduceMotion]);

  // A8 is retired on phones: the portrait canvas already fits the screen, so
  // there is nothing to fit-to-width and nothing to swipe sideways through.
  // The scroll machinery stays for the landscape canvas in a narrow window.
  const [scrollMode, setScrollMode] = useState(false);
  // Fallback only: reachable in the frame before the sheet has been measured
  // (or if it ever measures 0 width), where the landscape canvas would
  // otherwise overflow a narrow container with no way to see the whole shape.
  const useOverview = isNarrow && !isPortrait && !scrollMode;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [showScrollFade, setShowScrollFade] = useState(false);
  const [hintSeen, setHintSeen] = useState<boolean>(() => {
    try {
      return typeof localStorage !== "undefined" && localStorage.getItem(SCROLL_HINT_KEY) === "1";
    } catch {
      return false;
    }
  });

  // NOT async, and it must stay that way: iOS Safari only honours
  // navigator.share() while the page holds transient activation from the tap,
  // and any await before the share() call gives that up - the sheet then never
  // appears on the one device this feature exists for. Everything up to and
  // including the share() call runs in the tap's own task.
  const handleExport = () => {
    setExportState("working");
    try {
      const blob = graphImageBlob({
        width: graph.svgWidth,
        height: graph.svgHeight,
        background: INK,
        fontFamily: '"Merriweather", ui-serif, Georgia, serif',
        caption: isPortrait
          ? "down = % through each player's own path"
          : "position = % through each player's own path — not click count",
        captionCentred: isPortrait,
        startTitle: graph.startTitle,
        targetTitle: graph.targetTitle,
        finisherCount: graph.finisherCount,
        targetGlowOpacity: graph.targetGlowOpacity,
        // The export is deliberately independent of the focus state: it always
        // draws every strand undimmed and every label the layout could place,
        // so what gets shared is the whole picture rather than whichever
        // player happened to be highlighted when the button was tapped.
        edges: graph.edgesByPlayer.flatMap((group) =>
          group.edges.map((edge) => ({
            d: edge.d,
            color: edge.color,
            dash: edge.dash,
            opacity: edge.opacity,
            strokeWidth: edge.strokeWidth,
          })),
        ),
        nodes: graph.nodes.map((node) => {
          const visuals = nodeVisuals(node, playerColorOf);
          return {
            cx: node.cx,
            cy: node.cy,
            radius: node.radius,
            fill: visuals.fill,
            stroke: visuals.stroke,
            labelText: node.labelText,
            labelColor: visuals.labelColor,
            labelDx: node.labelDx,
            labelDy: node.labelDy,
            labelVisible: !labelIsRevealOnly({
              alwaysLabel: node.alwaysLabel,
              showLabelDesktop: node.showLabelDesktop,
              crowdedOut: node.labelCrowdedOut,
              isMobile: isNarrow,
              isPortrait,
            }),
            fontSize: node.fontSize,
            bold: node.isStart || node.isTarget,
            visitorCount: node.visitorCount,
            isTarget: node.isTarget,
            isStart: node.isStart,
            isDnfTerminal: node.dnfTerminalFor.size > 0,
          };
        }),
        legend: orderedRuns.map((run) => {
          const strand = playerStyleOf(run.player);
          return {
            player: run.player,
            color: strand.color,
            dash: strand.dash,
            stat: formatTimeAndClicks(run.elapsedMs, run.clicks),
            status: run.status,
            isWinner: winnerRun !== null && run.player === winnerRun.player,
          };
        }),
      });
      void shareGraphImage(blob, graph.startTitle, graph.targetTitle)
        .then((outcome) =>
          // A dismissed share sheet resolves as "shared" so we do not download
          // behind the user's back - but it is NOT a save, and claiming
          // "Saved" (and announcing "Image ready") after they explicitly
          // cancelled is a plain lie. Only a delivered file says done.
          setExportState(
            outcome === "failed" ? "failed" : outcome === "cancelled" ? "idle" : "done",
          ),
        )
        .catch(() => setExportState("failed"));
    } catch {
      // Nothing here is worth a thrown error reaching the user as a blank
      // modal: the graph they were looking at is still on screen and still
      // fine. Surface it on the button itself and let them retry.
      setExportState("failed");
    }
  };

  const updateScrollFade = () => {
    const el = scrollRef.current;
    if (!el) return;
    setShowScrollFade(el.scrollLeft < el.scrollWidth - el.clientWidth - 4);
  };

  useEffect(() => {
    if (scrollMode) updateScrollFade();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollMode]);

  const handleScroll = () => {
    updateScrollFade();
    if (!hintSeen) {
      setHintSeen(true);
      try {
        localStorage.setItem(SCROLL_HINT_KEY, "1");
      } catch {
        /* ignore - localStorage unavailable */
      }
    }
  };

  return (
    <div className={`cpg-root${isPortrait ? " is-portrait" : ""}`}>
      <style>{`
        .cpg-root {
          font-family: var(--viota-ui-font, "Merriweather", ui-serif, Georgia, serif);
          color: var(--text, #eef7f8);
          background: var(--ink, #061014);
          border: 1px solid var(--line, #295159);
          border-radius: 12px;
          padding: 16px 16px 8px;
        }
        .cpg-legend {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 10px 18px;
          margin: 0 0 14px;
          padding: 0;
          list-style: none;
        }
        .cpg-legend-item {
          display: flex;
          align-items: center;
        }
        .cpg-legend-btn {
          display: flex;
          align-items: center;
          gap: 7px;
          font: inherit;
          font-size: 0.85rem;
          color: inherit;
          background: none;
          border: none;
          border-radius: 8px;
          padding: 6px 6px;
          min-height: 44px;
          cursor: pointer;
        }
        .cpg-legend-btn:hover,
        .cpg-legend-btn:focus-visible {
          background: rgba(255, 255, 255, 0.07);
        }
        .cpg-legend-btn[aria-pressed="true"] {
          background: rgba(255, 255, 255, 0.12);
        }
        .cpg-reset-chip {
          font-size: 0.76rem;
          font-weight: 600;
          color: var(--muted, #9fb8bd);
          background: none;
          border: 1px solid var(--line, #295159);
          border-radius: 999px;
          padding: 4px 12px;
          min-height: 44px;
          cursor: pointer;
        }
        .cpg-reset-chip:hover,
        .cpg-reset-chip:focus-visible {
          color: var(--text-bright, #dffbfb);
          border-color: var(--text-bright, #dffbfb);
        }
        /* GR-2: a line swatch, not a dot - the legend stands for a STRAND, and
           past 7 players a strand is identified by hue AND dash, which a dot
           cannot show. Mirroring the mark also makes the mapping literal. */
        .cpg-chip {
          width: 16px;
          height: 4px;
          border-radius: 2px;
          flex: none;
          box-shadow: 0 0 6px currentColor;
        }
        /* Punch the gaps with a mask rather than repainting the background, so
           the swatch keeps its hue as a real background-color (a gradient
           built from currentColor would report as transparent, and would drop
           the hue entirely wherever mask support is missing). */
        .cpg-chip.is-dashed {
          -webkit-mask-image: repeating-linear-gradient(90deg, #000 0 5px, transparent 5px 8px);
          mask-image: repeating-linear-gradient(90deg, #000 0 5px, transparent 5px 8px);
          box-shadow: none;
        }
        /* GR-2: the collapsed portrait legend - one row, ~44px, instead of the
           638px the expanded list took on a 844px phone. */
        .cpg-visually-hidden {
          position: absolute;
          width: 1px;
          height: 1px;
          margin: -1px;
          padding: 0;
          overflow: hidden;
          clip: rect(0 0 0 0);
          clip-path: inset(50%);
          white-space: nowrap;
          border: 0;
        }
        .cpg-legend-bar {
          display: flex;
          align-items: center;
          gap: 8px;
          margin: 0 0 10px;
        }
        .cpg-legend-toggle {
          display: flex;
          align-items: center;
          gap: 9px;
          flex: 1 1 auto;
          min-width: 0;
          min-height: 44px;
          padding: 4px 10px;
          font: inherit;
          font-size: 0.78rem;
          color: var(--text-bright, #dffbfb);
          background: none;
          border: 1px solid var(--line, #295159);
          border-radius: 999px;
          cursor: pointer;
        }
        .cpg-legend-swatches {
          display: flex;
          align-items: center;
          gap: 3px;
          flex-wrap: nowrap;
          overflow: hidden;
        }
        .cpg-legend-swatches .cpg-chip {
          width: 9px;
          height: 4px;
          border-radius: 2px;
        }
        .cpg-legend-count {
          color: var(--muted, #9fb8bd);
          white-space: nowrap;
        }
        .cpg-legend-toggle::after {
          content: "▾";
          margin-left: auto;
          color: var(--muted, #9fb8bd);
        }
        /* Expanded on a phone: one player per row reads far better than the
           desktop's wrap-as-you-go flow at 390px. */
        .cpg-root.is-portrait .cpg-legend {
          gap: 2px 10px;
          margin-bottom: 10px;
          max-height: 46vh;
          overflow-y: auto;
        }
        .cpg-root.is-portrait .cpg-legend-item {
          flex: 1 0 100%;
        }
        .cpg-legend-name {
          font-weight: 600;
          color: var(--text-bright, #dffbfb);
        }
        .cpg-legend-stat {
          color: var(--muted, #9fb8bd);
        }
        /* 0.72 put the DNF pill at 3.40:1 against the ink - under the 4.5:1
           AA floor for its small text - because a row's opacity applies to
           every descendant, pill included. 0.9 keeps the row reading as
           secondary while the pill measures 4.76:1. */
        .cpg-legend-item.is-dnf {
          opacity: 0.9;
        }
        .cpg-flag {
          margin-left: 1px;
        }
        .cpg-legend-badge {
          font-size: 0.68rem;
          /* NV-1: chip/badge chrome, capped at 600 (was 700). */
          font-weight: 600;
          letter-spacing: 0.04em;
          border: 1px solid currentColor;
          border-radius: 999px;
          padding: 1px 6px;
          margin-left: 2px;
        }
        .cpg-dnf-pill {
          font-size: 0.68rem;
          /* NV-1: chip/badge chrome, capped at 600 (was 700). */
          font-weight: 600;
          letter-spacing: 0.04em;
          color: ${DNF_MARK_COLOR};
          border: 1px solid ${DNF_MARK_COLOR};
          border-radius: 999px;
          padding: 1px 6px;
          margin-left: 2px;
        }
        .cpg-scroll-wrap {
          position: relative;
        }
        .cpg-scroll {
          overflow-x: auto;
          overflow-y: hidden;
          border-radius: 8px;
        }
        .cpg-svg {
          display: block;
        }
        .cpg-explore-pill {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          font: inherit;
          font-size: 0.78rem;
          font-weight: 600;
          color: var(--text-bright, #dffbfb);
          background: none;
          border: 1px solid var(--line, #295159);
          border-radius: 999px;
          padding: 5px 12px;
          min-height: 44px;
          cursor: pointer;
        }
        .cpg-actions {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 8px;
          margin-top: 8px;
        }
        .cpg-share-pill {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font: inherit;
          font-size: 0.78rem;
          font-weight: 600;
          color: var(--text-bright, #dffbfb);
          background: none;
          border: 1px solid var(--line, #295159);
          border-radius: 999px;
          padding: 5px 14px;
          min-height: 44px;
          cursor: pointer;
        }
        .cpg-share-pill:hover:not(:disabled),
        .cpg-share-pill:focus-visible {
          border-color: var(--text-bright, #dffbfb);
        }
        .cpg-share-pill:disabled {
          opacity: 0.6;
          cursor: progress;
        }
        .cpg-scroll-fade {
          position: absolute;
          top: 0;
          right: 0;
          bottom: 0;
          width: 28px;
          pointer-events: none;
          background: linear-gradient(to right, transparent, var(--ink, #061014));
          opacity: 0;
          transition: opacity 200ms ease-out;
        }
        .cpg-scroll-fade.is-visible {
          opacity: 1;
        }
        .cpg-scroll-hint {
          position: absolute;
          top: 8px;
          right: 8px;
          font-size: 0.7rem;
          color: var(--muted, #9fb8bd);
          background: rgba(6, 16, 20, 0.88);
          border: 1px solid var(--line, #295159);
          border-radius: 999px;
          padding: 3px 9px;
          opacity: 1;
          transition: opacity 400ms ease-out;
          pointer-events: none;
        }
        .cpg-scroll-hint.is-hidden {
          opacity: 0;
        }

        /* A6: shared focus state - hover/click any of legend, edge group,
           or node all drive the same activePlayer, expressed as classes so
           the dim/active transition is CSS-driven, not recomputed inline. */
        .cpg-edge {
          transition: opacity 180ms ease-out;
        }
        .cpg-edge.is-dimmed {
          opacity: 0.12;
        }
        .cpg-edge.is-active {
          opacity: 1 !important;
          stroke-width: 3.25px;
        }
        .cpg-node circle {
          transition: opacity 180ms ease-out;
        }
        .cpg-node.is-dimmed circle {
          opacity: 0.3;
        }
        .cpg-node.is-dimmed text {
          opacity: 0.25;
        }
        .cpg-label-hidden {
          transition: opacity 140ms ease-out;
        }

        /* A9: CSS-only entrance animation, replays on every mount. */
        @media (prefers-reduced-motion: no-preference) {
          .cpg-edge-anim {
            stroke-dasharray: 1;
            stroke-dashoffset: 1;
            animation: cpg-draw var(--dur, 300ms) linear var(--delay, 0ms) both;
          }
          @keyframes cpg-draw {
            from {
              stroke-dashoffset: 1;
            }
            to {
              stroke-dashoffset: 0;
            }
          }
          .cpg-node-pop {
            transform-box: fill-box;
            transform-origin: center;
            animation: cpg-pop 220ms cubic-bezier(0.34, 1.56, 0.64, 1) var(--pop-delay, 0ms) both;
          }
          @keyframes cpg-pop {
            0% {
              transform: scale(0);
            }
            60% {
              transform: scale(1.18);
            }
            100% {
              transform: scale(1);
            }
          }
          .cpg-target-halo {
            opacity: 0;
            animation: cpg-target-glow 360ms ease-out var(--glow-delay, 0ms) forwards;
          }
          @keyframes cpg-target-glow {
            0% {
              opacity: 0;
            }
            50% {
              opacity: 0.4;
            }
            100% {
              opacity: var(--target-final-opacity, 0.3);
            }
          }
          .cpg-dnf-stamp {
            transform-box: fill-box;
            transform-origin: center;
            animation: cpg-stamp 180ms cubic-bezier(0.34, 1.56, 0.64, 1) var(--stamp-delay, 0ms) both;
          }
          @keyframes cpg-stamp {
            0% {
              transform: scale(1.4) rotate(-12deg);
            }
            100% {
              transform: scale(1) rotate(0deg);
            }
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .cpg-edge-anim {
            stroke-dashoffset: 0 !important;
            animation: none !important;
          }
          .cpg-node-pop {
            animation: none !important;
            transform: none !important;
          }
          .cpg-target-halo {
            animation: none !important;
            opacity: var(--target-final-opacity, 0.3) !important;
          }
          .cpg-dnf-stamp {
            animation: none !important;
            transform: none !important;
          }
          .cpg-edge,
          .cpg-node circle,
          .cpg-node text,
          .cpg-label-hidden {
            transition-duration: 1ms !important;
          }
        }
      `}</style>

      {/* GR-2: on a phone the full legend measured 638px of an 844px viewport
          - 76% of the screen, pushing the graph itself below the fold. It
          collapses to a one-row strip of strand swatches that still says who
          is here and still resets focus; the full list is one tap away, and
          the shared PNG always carries the complete legend regardless of what
          is expanded on screen. */}
      {isPortrait && !legendOpen ? (
        <div className="cpg-legend-bar">
          <button
            type="button"
            className="cpg-legend-toggle"
            ref={legendToggleRef}
            onClick={() => {
              setLegendOpen(true);
              setFocusLegendControl("hide");
            }}
            aria-expanded={false}
            aria-controls={LEGEND_LIST_ID}
          >
            <span className="cpg-legend-swatches" aria-hidden="true">
              {orderedRuns.map((run) => {
                const strand = playerStyleOf(run.player);
                return (
                  <span
                    key={run.player}
                    className={`cpg-chip${strand.dash ? " is-dashed" : ""}`}
                    style={{ background: strand.color, color: strand.color }}
                  />
                );
              })}
            </span>
            {/* "Show N players" rather than "N players": with the list
                collapsed this is a disclosure control, and its name has to say
                that activating it reveals the names, times and results. The
                swatch strip beside it is decorative (aria-hidden) - it repeats
                colours the list already carries. */}
            <span className="cpg-legend-count">
              Show {orderedRuns.length} {orderedRuns.length === 1 ? "player" : "players"}
            </span>
          </button>
          {activePlayer ? (
            <button type="button" className="cpg-reset-chip" onClick={clearFocus}>
              Show all
            </button>
          ) : null}
        </div>
      ) : (
      <ul className="cpg-legend" id={LEGEND_LIST_ID}>
        <li className="cpg-legend-item">
          <button
            type="button"
            className="cpg-reset-chip"
            onClick={clearFocus}
            aria-pressed={activePlayer === null}
          >
            Show all
          </button>
        </li>
        {isPortrait ? (
          <li className="cpg-legend-item">
            <button
              type="button"
              className="cpg-reset-chip"
              ref={legendHideRef}
              onClick={() => {
                setLegendOpen(false);
                setFocusLegendControl("show");
              }}
              aria-expanded
              aria-controls={LEGEND_LIST_ID}
            >
              Hide names
            </button>
          </li>
        ) : null}
        {orderedRuns.map((run) => {
          const strand = playerStyleOf(run.player);
          const color = strand.color;
          const isWinner = winnerRun !== null && run.player === winnerRun.player;
          return (
            <li
              key={run.player}
              className={`cpg-legend-item${run.status === "abandoned" ? " is-dnf" : ""}`}
            >
              <button
                type="button"
                className="cpg-legend-btn"
                aria-pressed={pinnedPlayer === run.player}
                onPointerEnter={() => hoverOn(run.player)}
                onPointerLeave={() => hoverOff(run.player)}
                onFocus={() => hoverOn(run.player)}
                onBlur={() => hoverOff(run.player)}
                onClick={() => togglePin(run.player)}
              >
                {/* GR-2: the chip is the only thing mapping a name to a
                    strand, so past the 7 distinct hues it has to carry the
                    dash too - otherwise two players read as one. */}
                <span
                  className={`cpg-chip${strand.dash ? " is-dashed" : ""}`}
                  style={{ background: color, color }}
                  {...(strand.dash ? { "data-dash": strand.dash } : {})}
                />
                <span className="cpg-legend-name">{run.player}</span>
                <span className="cpg-legend-stat">{formatTimeAndClicks(run.elapsedMs, run.clicks)}</span>
                {run.status === "completed" ? (
                  isWinner ? (
                    <span className="cpg-legend-badge" style={{ color, borderColor: color }}>
                      {"★ 1st"}
                    </span>
                  ) : (
                    <span className="cpg-flag" aria-label="finished">
                      {"\u{1F3C1}"}
                    </span>
                  )
                ) : (
                  <span className="cpg-dnf-pill">DNF</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      )}

      <div className="cpg-scroll-wrap" ref={shellRef}>
        <div className="cpg-scroll" ref={scrollRef} onScroll={scrollMode ? handleScroll : undefined}>
          <svg
            className="cpg-svg"
            viewBox={`0 0 ${graph.svgWidth} ${graph.svgHeight}`}
            {...(useOverview ? {} : { width: graph.svgWidth, height: graph.svgHeight })}
            style={
              useOverview
                ? { width: "100%", height: "auto", display: "block" }
                : isPortrait
                  ? { display: "block", width: "100%", height: "auto" }
                  : { display: "block", minWidth: graph.svgWidth }
            }
            role="img"
            aria-label="Merged graph of every player's path through this challenge"
          >
            <defs>
              <filter id="cpg-glow" x="-60%" y="-60%" width="220%" height="220%">
                <feGaussianBlur stdDeviation="4" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>

            {/* Empty-canvas tap dismisses the on-canvas callout (A6c). */}
            <rect x={0} y={0} width={graph.svgWidth} height={graph.svgHeight} fill="transparent" onClick={() => setCallout(null)} />

            <g>
              {graph.edgesByPlayer.map(({ player, edges }) => {
                const dimmed = activePlayer !== null && activePlayer !== player;
                const active = activePlayer === player;
                return (
                  <g
                    key={player}
                    data-player={player}
                    onPointerEnter={() => hoverOn(player)}
                    onPointerLeave={() => hoverOff(player)}
                  >
                    {edges.map((edge) => (
                      <g key={edge.key}>
                        <path
                          d={edge.d}
                          {...(entranceDone ? {} : { pathLength: 1 })}
                          fill="none"
                          stroke={edge.color}
                          strokeWidth={edge.strokeWidth}
                          strokeLinecap="round"
                          opacity={edge.opacity}
                          // GR-2: the dash only lands once the draw-in is
                          // done - until then `cpg-edge-anim` owns
                          // stroke-dasharray and the two would fight.
                          {...(entranceDone && edge.dash ? { strokeDasharray: edge.dash } : {})}
                          className={`cpg-edge${entranceDone ? "" : " cpg-edge-anim"}${dimmed ? " is-dimmed" : ""}${active ? " is-active" : ""}`}
                          style={{ "--delay": `${edge.delayMs}ms`, "--dur": `${edge.durMs}ms` } as CSSProperties}
                        />
                        {/* Invisible wide hit-path - the 2.25px visible stroke is too thin to hover reliably. */}
                        <path d={edge.d} fill="none" stroke="transparent" strokeWidth={14} style={{ pointerEvents: "stroke" }} />
                      </g>
                    ))}
                  </g>
                );
              })}
            </g>

            <g>
              {graph.nodes.map((node) => {
                const isDnfTerminal = node.dnfTerminalFor.size > 0;
                const isTarget = node.isTarget;
                const dimmed = activePlayer !== null && !node.visitorPlayers.includes(activePlayer);

                // Shared with the PNG export so the two can never drift.
                const { fill, stroke, labelColor } = nodeVisuals(node, playerColorOf);

                // Shared with the PNG export - see labelVisibility.ts for why
                // crowding outranks importance.
                const revealOnly = labelIsRevealOnly({
                  alwaysLabel: node.alwaysLabel,
                  showLabelDesktop: node.showLabelDesktop,
                  crowdedOut: node.labelCrowdedOut,
                  isMobile: isNarrow,
                  isPortrait,
                });
                // A reveal turns a whole solo stretch on AT ONCE, and each
                // title carries a 3px ink halo, so showing one that could not
                // be placed clear of its siblings destroys both of them. The
                // placer says which are safe; the rest stay on the node's
                // tooltip and the tap callout.
                const labelVisible =
                  !revealOnly || (activePlayer === node.soleVisitor && node.labelRevealable);

                const secondaryHalo = !isTarget && node.visitorCount > 1;

                return (
                  <g
                    key={node.title}
                    className={`cpg-node cpg-node-pop${dimmed ? " is-dimmed" : ""}`}
                    style={{ "--pop-delay": `${node.arrivalMs}ms` } as CSSProperties}
                  >
                    <title>{node.labelFull}</title>

                    {isTarget ? (
                      <circle
                        className="cpg-target-halo"
                        cx={node.cx}
                        cy={node.cy}
                        r={node.radius + 6 + 2 * graph.finisherCount}
                        fill={TARGET_COLOR}
                        filter="url(#cpg-glow)"
                        style={
                          {
                            "--glow-delay": `${graph.entranceTotalMs}ms`,
                            "--target-final-opacity": graph.targetGlowOpacity,
                          } as CSSProperties
                        }
                      />
                    ) : null}
                    {secondaryHalo ? (
                      <circle cx={node.cx} cy={node.cy} r={node.radius + 4} fill="#ffffff" opacity={0.12} filter="url(#cpg-glow)" />
                    ) : null}

                    <circle
                      cx={node.cx}
                      cy={node.cy}
                      r={node.radius}
                      fill={fill}
                      stroke={stroke}
                      strokeWidth={node.isStart || isTarget ? 2.5 : 0}
                    />

                    {!node.isStart && !isTarget && node.visitorCount >= 3 ? (
                      <text
                        x={node.cx}
                        y={node.cy + 3.4}
                        textAnchor="middle"
                        fontSize={10}
                        // NV-1: capped at 600 (was 700) - this is Fredoka
                        // (--viota-ui-font), not the display font.
                        fontWeight={600}
                        fill="var(--ink, #061014)"
                        fontFamily="var(--viota-ui-font, Merriweather, ui-serif, Georgia, serif)"
                        pointerEvents="none"
                      >
                        {node.visitorCount}
                      </text>
                    ) : null}

                    {isTarget ? (
                      <text
                        x={node.cx}
                        y={node.cy + 4}
                        textAnchor="middle"
                        fontSize={12}
                        fill="var(--ink, #061014)"
                        fontFamily="var(--viota-ui-font, Merriweather, ui-serif, Georgia, serif)"
                        // NV-1: capped at 600 (was 700).
                        fontWeight={600}
                        pointerEvents="none"
                      >
                        {"★"}
                      </text>
                    ) : null}

                    {isDnfTerminal ? (
                      <g
                        className="cpg-dnf-stamp"
                        style={{ "--stamp-delay": `${node.arrivalMs}ms` } as CSSProperties}
                        stroke={DNF_MARK_COLOR}
                        strokeWidth={2.4}
                        strokeLinecap="round"
                        opacity={0.8}
                      >
                        <line x1={node.cx - 6} y1={node.cy - 6} x2={node.cx + 6} y2={node.cy + 6} />
                        <line x1={node.cx - 6} y1={node.cy + 6} x2={node.cx + 6} y2={node.cy - 6} />
                      </g>
                    ) : null}

                    {node.title === divergenceTitle ? (
                      <circle
                        cx={node.cx}
                        cy={node.cy}
                        r={node.radius + 5}
                        fill="none"
                        stroke="var(--text-bright, #dffbfb)"
                        strokeWidth={1.5}
                        pointerEvents="none"
                      />
                    ) : null}

                    <text
                      // GR-2: labelDx/labelDy are the FINAL offsets the
                      // collision placer chose. Adding any further nudge here
                      // would move the label away from the box that was
                      // collision-checked - exactly the bug that let 87 label
                      // pairs overlap.
                      x={node.cx + node.labelDx}
                      y={node.cy + node.labelDy}
                      textAnchor="middle"
                      fontSize={node.fontSize}
                      fontWeight={node.isStart || isTarget ? 600 : 500}
                      fontFamily="var(--viota-ui-font, Merriweather, ui-serif, Georgia, serif)"
                      fill={labelColor}
                      paintOrder="stroke"
                      stroke="var(--ink, #061014)"
                      strokeWidth={3}
                      strokeLinejoin="round"
                      pointerEvents="none"
                      className={revealOnly ? "cpg-label-hidden" : undefined}
                      style={revealOnly ? { opacity: labelVisible ? 1 : 0 } : undefined}
                      // Why this label is (or isn't) on screen. Makes label
                      // density measurable from outside - the 87-overlap
                      // regression was invisible to every unit test we had.
                      data-label={
                        !revealOnly
                          ? "shown"
                          : node.labelCrowdedOut
                            ? "crowded-out"
                            : "suppressed"
                      }
                    >
                      {node.labelText}
                    </text>

                    {/* 44px tap target (A6c): solo node sets focus + opens
                        callout; shared node opens only the callout. */}
                    <circle
                      cx={node.cx}
                      cy={node.cy}
                      // Floored at the DRAWN radius so the whole dot is
                      // tappable. That can exceed the collision-free radius
                      // for a 12-unit merge node, but only where two dots are
                      // already overlapping on screen - and there the
                      // topmost-wins rule at least picks the one painted on
                      // top. The dense case is solo nodes at radius 2.5-3,
                      // where the safe radius is the larger of the two and
                      // this floor never binds.
                      r={Math.max(node.radius, node.hitRadius)}
                      fill="transparent"
                      style={{ cursor: "pointer" }}
                      onClick={(e) => {
                        e.stopPropagation();
                        // SET, never toggle. Walking a strand dot by dot is
                        // the only way to read crowded-out titles on touch,
                        // and toggling flipped the reveal off on every second
                        // tap. Toggling belongs on the legend row, where
                        // "that player again" genuinely means "stop".
                        if (node.soleVisitor) setPinnedPlayer(node.soleVisitor);
                        setCallout((cur) =>
                          cur && cur.title === node.labelFull ? null : { title: node.labelFull, cx: node.cx, cy: node.cy },
                        );
                      }}
                    />
                  </g>
                );
              })}
            </g>

            {callout
              ? (() => {
                  // GR-2: the callout is the ONLY way to read a title the
                  // placer crowded out on a touch device, so it must never be
                  // the thing that gets clipped. Its width was taken straight
                  // from the untruncated title, and on a ~320-unit portrait
                  // canvas anything past ~42 characters made the clamp
                  // negative: the box ran off the right edge and the UA cut
                  // the text off. Fit the box to the canvas first, then fit
                  // the text to the box.
                  const maxWidth = graph.svgWidth - 8;
                  const fullWidth = estimateLabelWidth(callout.title, 13) + 10;
                  const width = Math.min(fullWidth, maxWidth);
                  const calloutText =
                    fullWidth <= maxWidth
                      ? callout.title
                      : truncateTitle(callout.title, Math.max(6, Math.floor((maxWidth - 16) / 7.15)));
                  const height = 26;
                  const x = Math.max(
                    4,
                    Math.min(graph.svgWidth - 4 - width, callout.cx - width / 2),
                  );
                  const yAbove = callout.cy - 34;
                  const y = yAbove < 4 ? callout.cy + 20 : yAbove;
                  return (
                    <g pointerEvents="none">
                      <rect x={x} y={y} width={width} height={height} rx={6} fill="var(--ink-soft, #102329)" stroke="var(--line, #295159)" />
                      <text
                        x={x + width / 2}
                        y={y + height / 2 + 4}
                        textAnchor="middle"
                        fontSize={13}
                        fill="var(--text-bright, #dffbfb)"
                        fontFamily="var(--viota-ui-font, Merriweather, ui-serif, Georgia, serif)"
                      >
                        {calloutText}
                      </text>
                    </g>
                  );
                })()
              : null}

            {/* A10: axis honesty - nothing else on the canvas corrects the
                default "distance along the axis = time/clicks" assumption.
                Portrait moves progress onto the vertical axis, so the wording
                follows it rather than saying "position" and leaving the reader
                to guess which axis is meant. */}
            <text
              x={isPortrait ? graph.svgWidth / 2 : MARGIN_LEFT}
              y={graph.svgHeight - 12}
              textAnchor={isPortrait ? "middle" : "start"}
              fontSize={11}
              fill="var(--muted, #9fb8bd)"
              opacity={0.8}
              fontFamily="var(--viota-ui-font, Merriweather, ui-serif, Georgia, serif)"
            >
              {isPortrait
                ? "down = % through each player's own path"
                : "position = % through each player's own path — not click count"}
            </text>
          </svg>
        </div>
        {scrollMode && showScrollFade ? <div className="cpg-scroll-fade is-visible" /> : null}
        {scrollMode && !hintSeen ? <div className="cpg-scroll-hint">swipe for full path →</div> : null}
      </div>

      <div className="cpg-actions">
        {isNarrow && !isPortrait ? (
          <button type="button" className="cpg-explore-pill" onClick={() => setScrollMode((s) => !s)}>
            {scrollMode ? "← Overview" : "Explore path →"}
          </button>
        ) : null}
        {/* GR-2, owner brief: "i love sending screenshots of the whole graph to
            friends in a thread to discuss." A screenshot cannot do that job on
            a phone - iOS will not usefully full-page-capture a web view, and
            the on-screen legend is collapsed so the graph gets the whole sheet,
            so a screenshot would share a graph with no key. This composes the
            graph AND the complete legend into one PNG. */}
        <button
          type="button"
          className="cpg-share-pill"
          onClick={handleExport}
          disabled={exportState === "working"}
        >
          {exportState === "working"
            ? "Saving…"
            : exportState === "failed"
              ? "Couldn't save — retry"
              : exportState === "done"
                ? "Saved ✓"
                : "Save image"}
        </button>
        {/* The button's own label changing is not announced, because the button
            keeps focus while it changes - a screen reader user taps Save and
            hears nothing at all. A polite live region says what happened. */}
        <span className="cpg-visually-hidden" role="status" aria-live="polite">
          {exportState === "working"
            ? "Preparing image"
            : exportState === "failed"
              ? "Could not save the image"
              : exportState === "done"
                ? "Image ready"
                : ""}
        </span>
      </div>
    </div>
  );
}
