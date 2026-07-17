export const CLASSIFIER_VERSION = "editorial-v1";
export const LIST_PREFIX = /^(List|Lists|Outline|Index|Glossary|Timeline|Bibliography|Discography) of\b/i;

export type CandidateRejectionReason =
  | "target_list_like"
  | "target_too_short"
  | "target_lead_too_short"
  | "start_too_few_links"
  | "start_too_many_links"
  | "same_article"
  | "direct_edge";

export interface DailyCandidateScoreInput {
  seed: string;
  start: { title: string; pageId?: number; allowedLinks: readonly string[] };
  target: {
    title: string;
    pageId?: number;
    articleBytes: number;
    leadText: string;
    hasThumbnail: boolean;
    recentPageviews: number | null;
    editorial: {
      recognizable: { vitalLevel?: 1 | 2 | 3 } | false;
      weird: boolean;
    };
  };
  directEdge: boolean;
}

export interface ScoredDailyCandidate {
  classifierVersion: typeof CLASSIFIER_VERSION;
  eligible: boolean;
  rejectionReasons: CandidateRejectionReason[];
  recognizableScore: number;
  weirdScore: number;
  hardScore: number;
  confidence: "high" | "medium" | "low";
  tieBreak: number;
  components: {
    editorialMembership: number;
    pageviews: number;
    thumbnail: number;
    lead: number;
    substance: number;
    startLinks: number;
  };
}

/** Sorts higher flavor scores first, with the deterministic seed hash as the final key. */
export function compareScoredDailyCandidates(
  left: ScoredDailyCandidate,
  right: ScoredDailyCandidate,
  flavor: "recognizable" | "weird" | "hard",
): number {
  if (left.eligible !== right.eligible) return left.eligible ? 1 : -1;
  const scoreKey = `${flavor}Score` as const;
  if (left[scoreKey] !== right[scoreKey]) return left[scoreKey] - right[scoreKey];
  return right.tieBreak - left.tieBreak;
}

export function stableSample<T>(pool: readonly T[], requestedCount: number, seed: string): T[] {
  const count = Math.max(0, Math.min(pool.length, Math.floor(requestedCount)));
  return pool
    .map((value, index) => ({ value, index, hash: stableHash(`${seed}:${index}:${stableValue(value)}`) }))
    .sort((left, right) => left.hash - right.hash || left.index - right.index)
    .slice(0, count)
    .map(({ value }) => value);
}

export function scoreDailyCandidate(input: DailyCandidateScoreInput): ScoredDailyCandidate {
  const rejectionReasons: CandidateRejectionReason[] = [];
  const { start, target } = input;
  if (LIST_PREFIX.test(target.title)) rejectionReasons.push("target_list_like");
  if (target.articleBytes < 1_500) rejectionReasons.push("target_too_short");
  if (target.leadText.trim().length < 80) rejectionReasons.push("target_lead_too_short");
  if (start.allowedLinks.length < 8) rejectionReasons.push("start_too_few_links");
  if (start.allowedLinks.length > 200) rejectionReasons.push("start_too_many_links");
  if (sameArticle(start, target)) rejectionReasons.push("same_article");
  if (input.directEdge) rejectionReasons.push("direct_edge");

  const components = {
    editorialMembership: editorialMembership(target.editorial),
    pageviews: pageviewScore(target.recentPageviews),
    thumbnail: target.hasThumbnail ? 8 : 0,
    lead: Math.min(12, Math.floor(target.leadText.trim().length / 80) * 3),
    substance: Math.min(12, Math.floor(target.articleBytes / 1_500) * 3),
    startLinks: Math.max(0, 12 - Math.floor(Math.abs(start.allowedLinks.length - 60) / 10)),
  };
  const common = components.pageviews + components.thumbnail + components.lead + components.substance + components.startLinks;
  const recognizableScore = common + (target.editorial.recognizable ? 30 + (4 - (target.editorial.recognizable.vitalLevel ?? 3)) * 5 : 0);
  const weirdScore = common + (target.editorial.weird ? 38 : 0) - Math.min(20, Math.floor(Math.log10((target.recentPageviews ?? 1) + 1) * 4));
  const hardScore = common + (target.editorial.recognizable ? 12 : 0) + (target.editorial.weird ? 12 : 0) + Math.min(12, Math.floor(start.allowedLinks.length / 20));
  const pageviewsKnown = target.recentPageviews !== null;
  const confidence = pageviewsKnown && target.hasThumbnail ? "high" : pageviewsKnown || target.hasThumbnail ? "medium" : "low";

  return {
    classifierVersion: CLASSIFIER_VERSION,
    eligible: rejectionReasons.length === 0,
    rejectionReasons,
    recognizableScore: Math.trunc(recognizableScore),
    weirdScore: Math.trunc(weirdScore),
    hardScore: Math.trunc(hardScore),
    confidence,
    tieBreak: stableHash(`${input.seed}:${start.pageId ?? start.title}:${target.pageId ?? target.title}`),
    components,
  };
}

function editorialMembership(editorial: DailyCandidateScoreInput["target"]["editorial"]): number {
  return (editorial.recognizable ? 20 : 0) + (editorial.weird ? 20 : 0);
}

function pageviewScore(pageviews: number | null): number {
  if (pageviews === null || pageviews < 0) return 0;
  return Math.min(24, Math.floor(Math.log10(pageviews + 1) * 4));
}

function sameArticle(
  start: DailyCandidateScoreInput["start"],
  target: DailyCandidateScoreInput["target"],
): boolean {
  return (start.pageId !== undefined && target.pageId !== undefined && start.pageId === target.pageId)
    || start.title.trim().toLocaleLowerCase() === target.title.trim().toLocaleLowerCase();
}

function stableHash(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function stableValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
