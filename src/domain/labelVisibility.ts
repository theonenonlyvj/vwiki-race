/**
 * GR-2: whether a node's title renders by default, or waits for a focus reveal.
 *
 * Three independent reasons a label can be held back, and the order matters:
 *
 *  1. CROWDING WINS OVER IMPORTANCE. If the placer found nowhere to put a
 *     label, it must not render - even for a shared node or a DNF terminal.
 *     This used to read `!alwaysLabel && ...`, which let an unplaceable shared
 *     label render anyway at its fallback position, printed straight over a
 *     neighbour. The whole point of marking a label crowded out is that there
 *     is nowhere for it to go; importance cannot conjure space.
 *     Anchors (start/target) never reach this branch - the placer force-places
 *     them and never marks them crowded out, because they are the frame of
 *     reference for reading everything else.
 *
 *  2. A4's structural policy: long solo stretches fall back to breadcrumbs, so
 *     an unselected solo interim node stays quiet.
 *
 *  3. A8's narrow-viewport tier, now scoped to the LANDSCAPE canvas only. It
 *     existed because the old squeezed mobile overview rendered every label at
 *     ~3px, where showing more was pointless. The portrait canvas renders them
 *     at 10-13px, so there it defers to (1) and (2) like the desktop does.
 *
 * Held-back titles stay reachable through the node's native <title> tooltip and
 * the A6 focus reveal.
 */
export interface LabelVisibilityInput {
  alwaysLabel: boolean;
  showLabelDesktop: boolean;
  crowdedOut: boolean;
  isMobile: boolean;
  isPortrait: boolean;
}

export function labelIsRevealOnly({
  alwaysLabel,
  showLabelDesktop,
  crowdedOut,
  isMobile,
  isPortrait,
}: LabelVisibilityInput): boolean {
  if (crowdedOut) return true;
  if (alwaysLabel) return false;
  if (isMobile && !isPortrait) return true;
  return !showLabelDesktop;
}
