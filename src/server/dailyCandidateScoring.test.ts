import { describe, expect, it } from "vitest";
import {
  CLASSIFIER_VERSION,
  compareScoredDailyCandidates,
  type DailyCandidateScoreInput,
  LIST_PREFIX,
  scoreDailyCandidate,
  stableSample,
} from "./dailyCandidateScoring";

const candidate = {
  start: { title: "Start", pageId: 1, allowedLinks: Array.from({ length: 8 }, (_, index) => `Link ${index}`) },
  target: {
    title: "Target",
    pageId: 2,
    articleBytes: 1_500,
    leadText: "A".repeat(80),
    hasThumbnail: true,
    editorial: { recognizable: { vitalLevel: 1 as const }, weird: false },
    recentPageviews: 10_000,
  },
  directEdge: false,
  seed: "2026-07-23:editorial-v1",
} satisfies DailyCandidateScoreInput;

describe("stableSample", () => {
  it("is deterministic, non-mutating, and never returns more than requested", () => {
    const pool = ["a", "b", "c", "d"];
    expect(stableSample(pool, 10, "2026-07-23:v1")).toEqual(
      stableSample(pool, 10, "2026-07-23:v1"),
    );
    expect(stableSample(pool, 2, "seed")).toHaveLength(2);
    expect(stableSample(pool, 0, "seed")).toEqual([]);
    expect(pool).toEqual(["a", "b", "c", "d"]);
  });
});

describe("daily candidate scoring", () => {
  it.each([
    "List of targets", "Lists of targets", "Outline of targets", "Index of targets",
    "Glossary of targets", "Timeline of targets", "Bibliography of targets", "Discography of targets",
  ])("rejects every list-like prefix: %s", (title) => {
    expect(LIST_PREFIX.test(title)).toBe(true);
    expect(scoreDailyCandidate({ ...candidate, target: { ...candidate.target, title } })).toMatchObject({
      eligible: false,
      rejectionReasons: ["target_list_like"],
    });
  });

  it("enforces byte, lead, allowed-link, duplicate, and direct-edge boundaries", () => {
    expect(scoreDailyCandidate(candidate)).toMatchObject({ eligible: true, classifierVersion: "editorial-v1" });
    expect(scoreDailyCandidate({ ...candidate, target: { ...candidate.target, articleBytes: 1_499 } }).rejectionReasons)
      .toContain("target_too_short");
    expect(scoreDailyCandidate({ ...candidate, target: { ...candidate.target, leadText: "A".repeat(79) } }).rejectionReasons)
      .toContain("target_lead_too_short");
    expect(scoreDailyCandidate({ ...candidate, start: { ...candidate.start, allowedLinks: Array(7).fill("x") } }).rejectionReasons)
      .toContain("start_too_few_links");
    expect(scoreDailyCandidate({ ...candidate, start: { ...candidate.start, allowedLinks: Array(200).fill("x") } }).eligible)
      .toBe(true);
    expect(scoreDailyCandidate({ ...candidate, start: { ...candidate.start, allowedLinks: Array(201).fill("x") } }).rejectionReasons)
      .toContain("start_too_many_links");
    expect(scoreDailyCandidate({ ...candidate, start: { ...candidate.start, pageId: 2 } }).rejectionReasons)
      .toContain("same_article");
    expect(scoreDailyCandidate({ ...candidate, target: { ...candidate.target, title: "Start" } }).rejectionReasons)
      .toContain("same_article");
    expect(scoreDailyCandidate({ ...candidate, directEdge: true }).rejectionReasons)
      .toContain("direct_edge");
  });

  it("returns deterministic integer flavor scores and stable ties", () => {
    const first = scoreDailyCandidate(candidate);
    const second = scoreDailyCandidate(candidate);
    expect(first).toEqual(second);
    expect(first.recognizableScore).toEqual(expect.any(Number));
    expect(Number.isInteger(first.recognizableScore)).toBe(true);
    expect(first.weirdScore).toEqual(expect.any(Number));
    expect(first.hardScore).toEqual(expect.any(Number));
    expect(first.tieBreak).toEqual(expect.any(Number));
    expect(first.components).toEqual(expect.objectContaining({
      editorialMembership: expect.any(Number), pageviews: expect.any(Number), thumbnail: expect.any(Number),
    }));
    expect(first.classifierVersion).toBe(CLASSIFIER_VERSION);
    expect(compareScoredDailyCandidates(first, { ...first, tieBreak: first.tieBreak + 1 }, "recognizable")).toBeGreaterThan(0);
  });

  it("degrades confidence for missing pageviews without invalidating editorial membership", () => {
    const withViews = scoreDailyCandidate(candidate);
    const missingViews = scoreDailyCandidate({
      ...candidate,
      target: { ...candidate.target, recentPageviews: null },
    });
    expect(withViews.confidence).toBe("high");
    expect(missingViews).toMatchObject({ eligible: true, confidence: "medium" });
    expect(missingViews.components.editorialMembership).toBeGreaterThan(0);
  });

  it("uses editorial membership, pageviews, and thumbnails as score signals", () => {
    const noSignals = scoreDailyCandidate({
      ...candidate,
      target: {
        ...candidate.target,
        hasThumbnail: false,
        recentPageviews: 0,
        editorial: { recognizable: false, weird: false },
      },
    });
    const recognizable = scoreDailyCandidate(candidate);
    const weird = scoreDailyCandidate({
      ...candidate,
      target: { ...candidate.target, editorial: { recognizable: false, weird: true } },
    });
    expect(recognizable.recognizableScore).toBeGreaterThan(noSignals.recognizableScore);
    expect(weird.weirdScore).toBeGreaterThan(noSignals.weirdScore);
    expect(recognizable.components.pageviews).toBeGreaterThan(noSignals.components.pageviews);
    expect(recognizable.components.thumbnail).toBeGreaterThan(noSignals.components.thumbnail);
  });

  it("trims the lead before applying its 80-character floor", () => {
    expect(scoreDailyCandidate({
      ...candidate,
      target: { ...candidate.target, leadText: ` ${"A".repeat(80)} ` },
    }).eligible).toBe(true);
  });
});
