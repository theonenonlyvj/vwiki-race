import { describe, expect, it } from "vitest";
import type { Article, SanitizedWikipediaHtml } from "./types";
import { extractArticlePreview } from "./articlePreview";

describe("extractArticlePreview", () => {
  it("returns the first meaningful lead as plain text without embedded media", () => {
    const preview = extractArticlePreview(article(`
      <div class="mw-parser-output">
        <p> </p>
        <table class="infobox"><tbody><tr><td>
          <img src="https://upload.wikimedia.org/example.jpg" alt="Target landmark" />
        </td></tr></tbody></table>
        <p>The <a href="#article:Target">target</a> is a notable place with a long and useful history worth exploring in detail.</p>
        <p>A second paragraph should not be included.</p>
      </div>
    `));

    expect(preview).toEqual({
      blurb: "The target is a notable place with a long and useful history worth exploring in detail.",
    });
    expect(preview.blurb).not.toContain("<a");
  });

  // PV-1: the root-cause case - a sidebar/caption fragment ("Life on
  // Earth:") is the first <p>, ahead of the real lead. It ends with ":" and
  // reads nothing like a sentence, so the picker must skip past it.
  it("skips a sidebar caption fragment and picks the real lead prose", () => {
    const preview = extractArticlePreview(article(`
      <p>Life on Earth:</p>
      <p>Life is a quality that distinguishes matter that has biological processes, such as signaling and self-sustaining processes, from that which does not.</p>
    `));

    expect(preview.blurb).toBe(
      "Life is a quality that distinguishes matter that has biological processes, such as signaling and self-sustaining processes, from that which does not.",
    );
  });

  // PV-1: hatnotes ("For other uses...", "This article is about...") often
  // read long enough and sentence-shaped to pass a naive length/punctuation
  // check, so they need their own explicit skip rule.
  it("skips 'For other uses' and 'This article is about' hatnotes", () => {
    const preview = extractArticlePreview(article(`
      <p>For other uses, see Epoch (disambiguation) and other related topics.</p>
      <p>This article is about the astronomical reference epoch used in celestial coordinate systems.</p>
      <p>In astronomy, an epoch is a moment in time used as a reference point for some time-varying astronomical quantity.</p>
    `));

    expect(preview.blurb).toBe(
      "In astronomy, an epoch is a moment in time used as a reference point for some time-varying astronomical quantity.",
    );
  });

  // PV-1: an article whose only leading paragraphs are fragments (no real
  // lead within the scanned window) must fall back to null - PreRacePreview
  // already renders "Wikipedia does not provide a short lead" for this case.
  it("returns null when every scanned paragraph reads like a fragment, not prose", () => {
    const preview = extractArticlePreview(article(`
      <p>Life on Earth:</p>
      <p>Coordinates:</p>
      <p>For other uses, see Life (disambiguation) and its many related uses.</p>
    `));

    expect(preview).toEqual({ blurb: null });
  });

  it("bounds a long lead at a word boundary", () => {
    const longLead = Array.from(
      { length: 40 },
      (_, index) => `Word${index} is part of a very long article lead paragraph.`,
    ).join(" ");
    const preview = extractArticlePreview(article(`<p>${longLead}</p>`));

    expect(preview.blurb?.length).toBeLessThanOrEqual(363);
    expect(preview.blurb).toMatch(/\.\.\.$/);
    const finalWord = preview.blurb?.slice(0, -3).split(" ").at(-1);
    expect(longLead.split(" ")).toContain(finalWord);
  });

  it("returns null fields when the sanitized article has no preview content", () => {
    expect(extractArticlePreview(article("<div><br /></div>"))).toEqual({ blurb: null });
  });
});

function article(sanitizedHtml: string): Article {
  return {
    pageId: 1,
    canonicalTitle: "Target",
    revisionId: 2,
    sourceUrl: "https://en.wikipedia.org/wiki/Target",
    attributionUrl: "https://en.wikipedia.org/w/index.php?title=Target&oldid=2",
    sanitizedHtml: sanitizedHtml as SanitizedWikipediaHtml,
    links: [],
    attribution: "Wikipedia revision 2",
  };
}
