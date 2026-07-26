import type { DailyFlavor } from "../domain/dailyEditorial";
import type { EditorialTarget } from "./editorialTargetPools";

/**
 * Resilience-ladder rung 3 (PKG-13): a curated, worker-bundled target list
 * used only when BOTH a fresh editorial-pool fetch and the 7-day stale
 * cache have failed (see `EditorialTargetPoolError` in editorialTargetPools.ts).
 * The evaluator loads these titles through the same live Wikipedia metadata
 * + scoring pipeline as any other editorial target - this list only needs
 * to supply good raw candidates, not final answers.
 *
 * Curation criteria (keep every entry meeting ALL of these):
 * - Real, current, mainspace en.wikipedia.org article (verified live against
 *   the API on 2026-07-19: no missing/invalid/disambiguation, all >3KB of
 *   article body - i.e. not stubs).
 * - Famous-but-multi-hop: a title most players recognize on sight, but not
 *   so heavily interlinked with everything that every race becomes trivial.
 * - Stable subject matter (historical figures/events, geography, science)
 *   unlikely to be renamed, merged, or deleted.
 * - No hyper-obscure or single-source topics - only entries that would
 *   read as "a normal daily", not a worst-case placeholder.
 * - Clears its flavor's `INBOUND_LINK_FLOOR` (dailyCandidateEvaluator.ts) -
 *   verified live against the API on 2026-07-26 (recognizable >= 150): every
 *   entry below passed comfortably (all capped out at the 151-link check
 *   itself, i.e. genuinely >=151). See STATIC_WEIRD_TITLES's own note below
 *   for the four entries the SAME pass removed.
 *
 * `pageId` is intentionally omitted: the evaluator resolves these by title
 * through `loadTargets()`'s live Wikipedia query, same as pool-sourced
 * targets, so a hardcoded ID (which drifts as pages are edited) isn't needed.
 */
const STATIC_RECOGNIZABLE_TITLES: readonly string[] = [
  "Albert Einstein",
  "Leonardo da Vinci",
  "World War II",
  "Great Wall of China",
  "Mount Everest",
  "The Beatles",
  "William Shakespeare",
  "Amazon rainforest",
  "Great Barrier Reef",
  "Napoleon",
  "Isaac Newton",
  "Charles Darwin",
  "Nikola Tesla",
  "Mahatma Gandhi",
  "Nelson Mandela",
  "Cleopatra",
  "Julius Caesar",
  "Winston Churchill",
  "Abraham Lincoln",
  "Marie Curie",
  "Wolfgang Amadeus Mozart",
  "Ludwig van Beethoven",
  "Vincent van Gogh",
  "Pablo Picasso",
  "Eiffel Tower",
  "Statue of Liberty",
  "Great Pyramid of Giza",
  "Colosseum",
  "Taj Mahal",
  "Niagara Falls",
  "Grand Canyon",
  "Sahara",
  "Amazon River",
  "Pacific Ocean",
  "Solar System",
  "Apollo 11",
  "International Space Station",
  "Human brain",
  "DNA",
  "Photosynthesis",
  "Industrial Revolution",
  "French Revolution",
  "Roman Empire",
  "Ancient Egypt",
  "Renaissance",
];

/**
 * Verified live against the API on 2026-07-26 for the "weird" floor
 * (INBOUND_LINK_FLOOR.weird = 30, dailyCandidateEvaluator.ts). Four entries
 * failed and were removed: "Bookland" (14 inbound links), "Toynbee tiles"
 * (17), "Dancing plague of 1518" (27), "Emu War" (29) - each below 30, the
 * exact shape of today's incident (a real, well-known-to-trivia-fans
 * article that's still too thin to be reliably reachable). Every remaining
 * entry passed, several right at the edge (e.g. "Bog snorkelling" at
 * exactly 31) - re-run this check if entries are ever added back.
 */
const STATIC_WEIRD_TITLES: readonly string[] = [
  "Gravity hill",
  "Phantom island",
  "Spite house",
  "Great Molasses Flood",
  "Cadaver Synod",
  "Defenestrations of Prague",
  "Tunguska event",
  "Voynich manuscript",
  "Wow! signal",
  "Roswell incident",
  "Bermuda Triangle",
  "Loch Ness Monster",
  "Kraken",
  "Flat Earth",
  "Philadelphia Experiment",
  "Mothman",
  "Chupacabra",
  "Skunk ape",
  "Spontaneous human combustion",
  "Coral Castle",
  "Georgia Guidestones",
  "Kryptos",
  "D. B. Cooper",
  "Zodiac Killer",
  "Dyatlov Pass incident",
  "Mary Celeste",
  "SS Baychimo",
  "Flying Dutchman",
  "Cottingley Fairies",
  "Piltdown Man",
  "Cooper's Hill Cheese-Rolling and Wake",
  "Wife-carrying",
  "World's Strongest Man",
  "Competitive eating",
  "Extreme ironing",
  "Bog snorkelling",
];

const STATIC_RECOGNIZABLE: readonly EditorialTarget[] = STATIC_RECOGNIZABLE_TITLES.map((title) => ({
  title,
  source: "vital",
  vitalLevel: 2,
}));

const STATIC_WEIRD: readonly EditorialTarget[] = STATIC_WEIRD_TITLES.map((title) => ({
  title,
  source: "unusual",
}));

/** Mirrors editorialTargetPools.ts's `forFlavor`: hard is the deduplicated union. */
export function staticFallbackTargets(flavor: DailyFlavor): EditorialTarget[] {
  if (flavor === "recognizable") return [...STATIC_RECOGNIZABLE];
  if (flavor === "weird") return [...STATIC_WEIRD];
  return [...STATIC_RECOGNIZABLE, ...STATIC_WEIRD];
}
