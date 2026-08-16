import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { formatTimeAndClicks } from "../domain/formatting";
import { strandStyleForIndex, type StrandStyle } from "../domain/strandStyle";

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

const MOBILE_BREAKPOINT = 480;
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
  svgHeight: number;
}

function buildGraph(orderedRuns: ChallengePathRun[]): GraphLayout {
  const playerOrder = orderedRuns.map((r) => r.player);
  const winnerRun = orderedRuns.find((r) => r.status === "completed") ?? null;
  const finisherCount = orderedRuns.filter((r) => r.status === "completed").length;

  // GX-1: lane-count-driven height - computed once, up front, so every
  // downstream y-calculation (laneY, the weighted-mean fallback, the raw
  // node fallback) already flows from the real height instead of the old
  // fixed 560.
  const svgHeight = computeSvgHeight(Math.max(1, playerOrder.length));
  const plotHeight = svgHeight - MARGIN_TOP - MARGIN_BOTTOM;

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
  const laneGap = plotHeight / (laneCount + 1);
  function laneY(player: string): number {
    const i = laneIndex.get(player) ?? 0;
    return MARGIN_TOP + laneGap * (i + 1);
  }

  interface Raw {
    agg: NodeAgg;
    xFrac: number;
    cy: number;
    visitorCount: number;
  }

  // Initial x target: mean, across every visitor, of THEIR OWN normalized
  // progress (spec heuristic) - but WEIGHTED by each visitor's own step
  // count. See the module docblock for the full rationale.
  const weightedMeanFracByTitle = new Map<string, number>();
  const laneYByTitle = new Map<string, number>();
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
      ySum += laneY(player);
      n += 1;
    }
    weightedMeanFracByTitle.set(agg.title, weightTotal ? weightedSum / weightTotal : 0);
    laneYByTitle.set(agg.title, n ? ySum / n : MARGIN_TOP + plotHeight / 2);
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
          ? TRUNK_GAP_PX / PLOT_WIDTH
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
      cy: laneYByTitle.get(agg.title) ?? MARGIN_TOP + plotHeight / 2,
      visitorCount: agg.visitors.size,
    });
  }

  raws.sort((a, b) => a.xFrac - b.xFrac);

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
    const longRun = total > 8;
    let stretch: Array<{ title: string; hopIndex: number }> = [];
    const flush = () => {
      if (!stretch.length) return;
      if (!longRun) {
        for (const s of stretch) breadcrumbEligibleTitles.add(s.title);
      } else {
        breadcrumbEligibleTitles.add(stretch[0].title);
        breadcrumbEligibleTitles.add(stretch[stretch.length - 1].title);
        for (const s of stretch) {
          if (s.hopIndex % 5 === 0) breadcrumbEligibleTitles.add(s.title);
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

  // Label placement: a real 2D collision check against every previously
  // placed label's actual on-screen box (see module docblock). Only labels
  // that will actually render by default (alwaysLabel or breadcrumb-
  // Every node still competes for a collision-safe slot, including labels
  // A4 suppresses by default - they're silent (opacity 0) until a focus
  // reveal (A6), but when revealed, an entire long solo stretch can pop in
  // at once (e.g. rnaik24's ~7 surviving labels), and without a reserved
  // slot each they'd all default to the same nearest-row offset and stack
  // into unreadable overlapping text. Reserving the slot up front costs
  // nothing while hidden and guarantees revealed labels are already legible.
  const LABEL_HEIGHT_PX = 15;
  const placedLabelBoxes: Array<{ x1: number; x2: number; y1: number; y2: number }> = [];
  function boxesOverlap(
    a: { x1: number; x2: number; y1: number; y2: number },
    b: { x1: number; x2: number; y1: number; y2: number },
  ): boolean {
    return a.x1 < b.x2 + LABEL_GAP_PX && b.x1 < a.x2 + LABEL_GAP_PX && a.y1 < b.y2 && b.y1 < a.y2;
  }

  const nodes: NodeLayout[] = raws.map((raw) => {
    const cx = MARGIN_LEFT + raw.xFrac * PLOT_WIDTH;
    const big = raw.agg.isStart || raw.agg.isTarget;
    const alwaysLabel = alwaysLabelTitles.has(raw.agg.title);
    const breadcrumbEligible = !alwaysLabel && breadcrumbEligibleTitles.has(raw.agg.title);
    const showLabelDesktop = alwaysLabel || breadcrumbEligible;
    const fontSize = big ? 14 : 12;
    const labelText = truncateTitle(raw.agg.title, big ? 26 : 20);
    const width = estimateLabelWidth(labelText, fontSize);
    const half = width / 2;

    let chosenDy = LABEL_ROW_OFFSETS[LABEL_ROW_OFFSETS.length - 1];
    let chosenBox: null | { x1: number; x2: number; y1: number; y2: number } = null;
    for (const dy of LABEL_ROW_OFFSETS) {
      const y = raw.cy + dy;
      const box = { x1: cx - half, x2: cx + half, y1: y - LABEL_HEIGHT_PX / 2, y2: y + LABEL_HEIGHT_PX / 2 };
      if (!placedLabelBoxes.some((placed) => boxesOverlap(placed, box))) {
        chosenDy = dy;
        chosenBox = box;
        break;
      }
    }
    if (!chosenBox) {
      const y = raw.cy + chosenDy;
      chosenBox = { x1: cx - half, x2: cx + half, y1: y - LABEL_HEIGHT_PX / 2, y2: y + LABEL_HEIGHT_PX / 2 };
    }
    placedLabelBoxes.push(chosenBox);

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
      cy: raw.cy,
      radius,
      alwaysLabel,
      showLabelDesktop,
      labelText,
      labelFull: raw.agg.title,
      labelDy: chosenDy,
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
    svgHeight,
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

  const graph = useMemo(() => buildGraph(orderedRuns), [orderedRuns]);

  // A6: one shared focus state. Legend hover/click, per-player edge-group
  // hover, and node tap all funnel into this same setter.
  const [activePlayer, setActivePlayer] = useState<string | null>(null);
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

  // A8: mobile defaults to a fit-to-width overview; "Explore path" swaps to
  // the original scrollable 1080px layout.
  const isMobile = useIsMobile(MOBILE_BREAKPOINT);
  const [scrollMode, setScrollMode] = useState(false);
  const useOverview = isMobile && !scrollMode;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [showScrollFade, setShowScrollFade] = useState(false);
  const [hintSeen, setHintSeen] = useState<boolean>(() => {
    try {
      return typeof localStorage !== "undefined" && localStorage.getItem(SCROLL_HINT_KEY) === "1";
    } catch {
      return false;
    }
  });

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
    <div className="cpg-root">
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
        .cpg-legend-name {
          font-weight: 600;
          color: var(--text-bright, #dffbfb);
        }
        .cpg-legend-stat {
          color: var(--muted, #9fb8bd);
        }
        .cpg-legend-item.is-dnf {
          opacity: 0.72;
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
          margin: 8px 0 0;
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

      <ul className="cpg-legend">
        <li className="cpg-legend-item">
          <button
            type="button"
            className="cpg-reset-chip"
            onClick={() => setActivePlayer(null)}
            aria-pressed={activePlayer === null}
          >
            Show all
          </button>
        </li>
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
                aria-pressed={activePlayer === run.player}
                onPointerEnter={() => setActivePlayer(run.player)}
                onPointerLeave={() => setActivePlayer((cur) => (cur === run.player ? null : cur))}
                onClick={() => setActivePlayer((cur) => (cur === run.player ? null : run.player))}
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

      <div className="cpg-scroll-wrap">
        <div className="cpg-scroll" ref={scrollRef} onScroll={scrollMode ? handleScroll : undefined}>
          <svg
            className="cpg-svg"
            viewBox={`0 0 ${SVG_WIDTH} ${graph.svgHeight}`}
            {...(useOverview ? {} : { width: SVG_WIDTH, height: graph.svgHeight })}
            style={
              useOverview
                ? { width: "100%", height: "auto", display: "block" }
                : { display: "block", minWidth: SVG_WIDTH }
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
            <rect x={0} y={0} width={SVG_WIDTH} height={graph.svgHeight} fill="transparent" onClick={() => setCallout(null)} />

            <g>
              {graph.edgesByPlayer.map(({ player, edges }) => {
                const dimmed = activePlayer !== null && activePlayer !== player;
                const active = activePlayer === player;
                return (
                  <g
                    key={player}
                    data-player={player}
                    onPointerEnter={() => setActivePlayer(player)}
                    onPointerLeave={() => setActivePlayer((cur) => (cur === player ? null : cur))}
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

                const fill = node.isStart
                  ? "var(--ink-soft, #102329)"
                  : isTarget
                    ? TARGET_COLOR
                    : node.visitorCount > 1
                      ? "var(--text-bright, #dffbfb)"
                      : playerColorOf(node.soleVisitor ?? "");
                const stroke = node.isStart ? START_RING_COLOR : isTarget ? TARGET_COLOR : "none";

                // A4: tint surviving solo labels to their owner; shared
                // labels stay bright white ("everyone was here").
                const labelColor =
                  node.isStart || isTarget || node.visitorCount > 1
                    ? "var(--text-bright, #dffbfb)"
                    : hexToRgba(playerColorOf(node.soleVisitor ?? ""), 0.65);

                // Suppressed on desktop (A4 structural) OR on mobile (A4
                // viewport tier) - either way it's reveal-on-focus only.
                const revealOnly = !node.alwaysLabel && (isMobile || !node.showLabelDesktop);
                const labelVisible = !revealOnly || activePlayer === node.soleVisitor;

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
                      x={node.cx}
                      y={node.cy + node.labelDy + (node.labelDy >= 0 ? 16 : -10)}
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
                    >
                      {node.labelText}
                    </text>

                    {/* 44px tap target (A6c): solo node sets focus + opens
                        callout; shared node opens only the callout. */}
                    <circle
                      cx={node.cx}
                      cy={node.cy}
                      r={Math.max(node.radius, 22)}
                      fill="transparent"
                      style={{ cursor: "pointer" }}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (node.soleVisitor) setActivePlayer(node.soleVisitor);
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
                  const width = estimateLabelWidth(callout.title, 13) + 10;
                  const height = 26;
                  const x = Math.max(
                    MARGIN_LEFT - 24,
                    Math.min(SVG_WIDTH - MARGIN_RIGHT + 24 - width, callout.cx - width / 2),
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
                        {callout.title}
                      </text>
                    </g>
                  );
                })()
              : null}

            {/* A10: axis honesty - nothing else on the canvas corrects the
                default left-to-right "x = time/clicks" assumption. */}
            <text
              x={MARGIN_LEFT}
              y={graph.svgHeight - 12}
              fontSize={11}
              fill="var(--muted, #9fb8bd)"
              opacity={0.8}
              fontFamily="var(--viota-ui-font, Merriweather, ui-serif, Georgia, serif)"
            >
              position = % through each player&apos;s own path — not click count
            </text>
          </svg>
        </div>
        {scrollMode && showScrollFade ? <div className="cpg-scroll-fade is-visible" /> : null}
        {scrollMode && !hintSeen ? <div className="cpg-scroll-hint">swipe for full path →</div> : null}
      </div>

      {isMobile ? (
        <button type="button" className="cpg-explore-pill" onClick={() => setScrollMode((s) => !s)}>
          {scrollMode ? "← Overview" : "Explore path →"}
        </button>
      ) : null}
    </div>
  );
}
