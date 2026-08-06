/**
 * Verifies a candidate daily's reference path hop-by-hop using the SAME
 * gateway + sanitizer the game serves articles with, so every hop is a
 * link a player can actually click. Usage:
 *   npx tsx scripts/verify-chain.ts "Title A" "Title B" "Title C"
 */
import { DOMParser } from "linkedom";
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

const chain = process.argv.slice(2);
if (chain.length < 2) throw new Error("Need at least two titles.");

const run = async () => {
  let ok = true;
  for (let i = 0; i < chain.length; i++) {
    const article = await gateway.getArticle(chain[i]);
    const info = `[${i}] "${chain[i]}" -> canonical "${article.title}" (pageId ${article.pageId ?? "?"}), ${article.links.length} links`;
    console.log(info);
    if (i < chain.length - 1) {
      const next = normalizeTitle(chain[i + 1]);
      const hit = article.links.find((l) => normalizeTitle(l.title) === next);
      if (hit) {
        console.log(`     ✓ links to "${chain[i + 1]}"`);
      } else {
        ok = false;
        console.log(`     ✗ NO LINK to "${chain[i + 1]}"`);
        const sample = article.links.slice(0, 40).map((l) => l.title).join(" | ");
        console.log(`     sample links: ${sample}`);
      }
    }
  }
  console.log(ok ? "\nCHAIN OK" : "\nCHAIN BROKEN");
  if (!ok) process.exit(1);
};

run();
