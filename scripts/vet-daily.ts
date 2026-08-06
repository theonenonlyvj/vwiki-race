/**
 * Local vetting harness for tomorrow's daily: runs the PRODUCTION
 * dailyCandidateEvaluator against live Wikipedia with the real no-repeat
 * exclusion sets, N times, and prints every distinct candidate it accepts
 * so a human can pick the most playable one to queue.
 */
import { readFileSync } from "node:fs";
import { DOMParser } from "linkedom";
import { createDailyCandidateEvaluator } from "../src/server/dailyCandidateEvaluator";
import {
  createWikipediaGateway,
  WIKIMEDIA_API_USER_AGENT,
} from "../src/services/wikipediaGateway";
import { sanitizeWikipediaArticleHtml } from "../src/services/wikipediaSanitizer";
import { normalizeTitle } from "../src/domain/rules";

const uaFetch: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set("User-Agent", WIKIMEDIA_API_USER_AGENT);
  return fetch(input, { ...init, headers });
};
const parseDocument = (rawHtml: string): Document => {
  const document = new DOMParser().parseFromString(
    "<!doctype html><html><head></head><body></body></html>",
    "text/html",
  );
  document.body.innerHTML = rawHtml;
  return document as unknown as Document;
};
const gateway = createWikipediaGateway({
  fetchImpl: uaFetch,
  sanitizeHtml: (rawHtml, currentTitle) =>
    sanitizeWikipediaArticleHtml(rawHtml, currentTitle, { parseDocument }),
});

const dir = "/private/tmp/claude-501/-Users-vijayram-Cursor/b35d1ef1-ec6f-425c-813b-0cf79c62b390/scratchpad";
const excludedTargetTitles = new Set<string>(
  (JSON.parse(readFileSync(`${dir}/excluded_targets.json`, "utf8")) as string[]).map(normalizeTitle),
);
const excludedStartTitles = new Set<string>(
  (JSON.parse(readFileSync(`${dir}/excluded_starts.json`, "utf8")) as string[]).map(normalizeTitle),
);

const attempts = Number(process.argv[2] ?? 5);
const seen = new Set<string>();
const results: unknown[] = [];

const run = async () => {
  for (let i = 0; i < attempts; i++) {
    const evaluator = createDailyCandidateEvaluator({
      fetchImpl: uaFetch,
      gateway,
      onDiagnostic: (event, fields) => {
        if (event === "selection" || event.includes("discarded")) {
          console.error(`[diag] ${event} ${JSON.stringify(fields)}`);
        }
      },
    });
    try {
      const c = await evaluator.findCandidate({
        dailyDate: "2026-08-06",
        flavor: "weird",
        excludedTargetTitles,
        excludedStartTitles,
        computeReferencePath: true,
      });
      const key = `${c.startTitle}→${c.targetTitle}`;
      if (!seen.has(key)) {
        seen.add(key);
        results.push(c);
        console.log(`\n=== CANDIDATE ${results.length} ===`);
        console.log(JSON.stringify(c, null, 2));
      } else {
        console.error(`[dup] ${key}`);
      }
    } catch (err) {
      console.error(`[attempt ${i + 1} failed]`, err instanceof Error ? `${err.name}: ${err.message}` : err);
    }
  }
  console.log(`\nTOTAL DISTINCT: ${results.length}/${attempts}`);
};

run();
