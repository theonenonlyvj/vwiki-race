/**
 * GR-2: how a strand on the "Everyone's path" graph is painted.
 *
 * The graph shipped with a 6-hue palette cycled by lane index, which was fine
 * for the 4-6 run fields it was designed against. Fields have since grown past
 * that: 2026-07-20's daily served 11 strands, so FIVE pairs of players drew in
 * the identical hue (theonenonlyvj/Kaleigj teal, reks/rnaik24 amber,
 * lollerskates/mattman violet, SunnyD/RK green, chase3/FranTheGreat peach) and
 * the legend chip - the only thing mapping a name to a strand - could not tell
 * them apart either.
 *
 * The fix is NOT "more hues". Measured with the dataviz palette validator
 * (OKLab ΔE ×100, Machado CVD simulation) against this app's #061014 ground:
 * 7 spaced hues is the ceiling. At 8 the best achievable worst-pair separation
 * collapses to ΔE 5.6 normal-vision / 5.6 CVD, well under the 15 / 8 floors -
 * and that is a property of human vision, not of the search. Okabe-Ito, the
 * field-standard CVD-safe set, fails all-pairs here too.
 *
 * So identity uses TWO channels: hue for the first 7 strands, then the same
 * hues again with a dash pattern. 7 hues x 3 dash patterns = 21 unique
 * (color, dash) pairs, comfortably past the server's 12-strand cap
 * (CHALLENGE_PATHS_LIMIT), with no pair repeating.
 *
 * The hue set below was found by constrained optimization (random-restart hill
 * climbing over OKLCH, hue-anchored so the legend reads as a spectrum rather
 * than three greens) and then confirmed with the validator:
 *
 *   CVD separation      worst all-pairs ΔE 8.3 (protan) · tritan 8.7   PASS
 *   Normal-vision floor worst all-pairs ΔE 15.1                        PASS
 *   Chroma floor        all 7 >= 0.1                                   PASS
 *   Contrast vs surface all 7 >= 3:1                                   PASS
 *
 * The validator's one remaining complaint is its dark-mode LIGHTNESS BAND
 * (L 0.48-0.67); these sit at 0.60-0.84. That override is deliberate: the band
 * is calibrated for filled areas, and these are 2-3px strokes on a near-black
 * ground, where dropping into the band measurably dims the thinnest strands.
 * Do not "fix" it by darkening - re-run the validator if you change a hue.
 *
 * Reserved colors these deliberately clear by >= ΔE 15: the start ring
 * (#8ff3e6), the target (#ff765f), the DNF mark (#e0655a) and the node fill
 * (#ffffff).
 */

export interface StrandStyle {
  color: string;
  /** SVG `stroke-dasharray`, or null for a solid strand. */
  dash: string | null;
}

export const STRAND_HUES = [
  "#fcbe00", // amber
  "#00eb78", // spring green
  "#00a898", // teal
  "#68b5ff", // sky
  "#b470f9", // violet
  "#ff6cc9", // pink
  "#9f7b00", // bronze
] as const;

/**
 * Dash patterns for the second and third passes through the hue list. Both are
 * long-on/short-off so a dashed strand still reads as a continuous route at a
 * glance, and neither collides with the DNF taper (which varies width and
 * opacity, never the dash).
 */
const STRAND_DASHES: (string | null)[] = [null, "9 5", "2.5 4"];

export function strandStyleForIndex(index: number): StrandStyle {
  const safe = Number.isFinite(index) && index > 0 ? Math.floor(index) : 0;
  const hue = STRAND_HUES[safe % STRAND_HUES.length];
  const dash = STRAND_DASHES[
    Math.floor(safe / STRAND_HUES.length) % STRAND_DASHES.length
  ];
  return { color: hue, dash };
}

/** Stable identity for a style, for uniqueness checks and React keys. */
export function strandStyleKey(style: StrandStyle): string {
  return `${style.color}|${style.dash ?? "solid"}`;
}


const INK_SURFACE_RGB = [0x06, 0x10, 0x14];

function channelLuminance(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * WCAG contrast of a hue against the app's ink surface, optionally composited
 * at `alpha` first.
 *
 * Compositing is done in GAMMA-ENCODED sRGB, which is what a browser does for
 * `rgba()` - doing it in linear space instead overstates the result badly. Solo
 * node labels used to be drawn at alpha 0.65 for visual recession, which put
 * bronze at 2.69:1 and violet at 3.16:1, well under the 4.5:1 AA floor for
 * 12px text. At full opacity every hue clears it, and the hue alone is enough
 * to separate a solo label from a shared one, which is white.
 */
export function contrastOnInk(hex: string, alpha = 1): number {
  const clean = hex.replace(/^#/, "");
  const rgb = [0, 2, 4].map((i) => parseInt(clean.slice(i, i + 2), 16));
  const composited = rgb.map((c, i) => alpha * c + (1 - alpha) * INK_SURFACE_RGB[i]);
  const lum = (channels: number[]) =>
    0.2126 * channelLuminance(channels[0]) +
    0.7152 * channelLuminance(channels[1]) +
    0.0722 * channelLuminance(channels[2]);
  const [hi, lo] = [lum(composited), lum(INK_SURFACE_RGB)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}
