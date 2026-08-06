import { DOMParser } from "linkedom";
import { createWikipediaGateway, WIKIMEDIA_API_USER_AGENT } from "../src/services/wikipediaGateway";
import { sanitizeWikipediaArticleHtml } from "../src/services/wikipediaSanitizer";
const uaFetch: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set("User-Agent", WIKIMEDIA_API_USER_AGENT);
  return fetch(input, { ...init, headers });
};
const parseDocument = (rawHtml: string): Document => {
  const d = new DOMParser().parseFromString("<!doctype html><html><head></head><body></body></html>", "text/html");
  d.body.innerHTML = rawHtml;
  return d as unknown as Document;
};
const gateway = createWikipediaGateway({
  fetchImpl: uaFetch,
  sanitizeHtml: (raw, t) => sanitizeWikipediaArticleHtml(raw, t, { parseDocument }),
});
const [title, filter] = process.argv.slice(2);
gateway.getArticle(title).then((a) => {
  const rx = new RegExp(filter, "i");
  console.log(a.links.map((l) => l.title).filter((t) => rx.test(t)).join("\n") || "(no matches)");
});
