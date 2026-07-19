import { describe, expect, it } from "vitest";
import { sanitizeWikipediaArticleHtml } from "./wikipediaSanitizer";

// QF-02 (Judge B amendment 4): wikipediaSanitizer had zero test coverage
// despite being the HTML sanitizer for untrusted Wikipedia content. These
// guard the one behavior change QF-02 makes to it: every article <img>
// unconditionally carries loading + decoding hints, with the lead (first,
// document-order) image kept eager so it doesn't regress the game's own
// LCP element (Judge A amendment 1, folded into the binding ruling).
describe("wikipediaSanitizer: img loading/decoding hints (QF-02)", () => {
  it("sets loading=lazy decoding=async on every img regardless of source markup", () => {
    const { sanitizedHtml } = sanitizeWikipediaArticleHtml(
      `<div class="mw-parser-output">
        <p><img src="//upload.wikimedia.org/a.jpg" alt="a"></p>
        <p><img src="//upload.wikimedia.org/b.jpg" alt="b" loading="eager" decoding="sync"></p>
      </div>`,
      "Article",
    );
    const document = new DOMParser().parseFromString(sanitizedHtml, "text/html");
    const images = [...document.querySelectorAll("img")];
    expect(images).toHaveLength(2);

    // First image = lead image: stays eager.
    expect(images[0].getAttribute("loading")).toBe("eager");
    expect(images[0].getAttribute("decoding")).toBe("async");

    // Second image: not the lead - goes lazy, even though the source
    // markup asked for eager/sync (unconditional override, not a whitelist).
    expect(images[1].getAttribute("loading")).toBe("lazy");
    expect(images[1].getAttribute("decoding")).toBe("async");
  });

  it("keeps only the first document-order img eager when more than two images are present", () => {
    const { sanitizedHtml } = sanitizeWikipediaArticleHtml(
      `<div class="mw-parser-output">
        <p><img src="//upload.wikimedia.org/lead.jpg" alt="lead"></p>
        <table class="infobox"><tbody><tr><td>
          <img src="//upload.wikimedia.org/infobox.jpg" alt="infobox">
        </td></tr></tbody></table>
        <p><img src="//upload.wikimedia.org/third.jpg" alt="third"></p>
      </div>`,
      "Article",
    );
    const document = new DOMParser().parseFromString(sanitizedHtml, "text/html");
    const images = [...document.querySelectorAll("img")];
    expect(images.map((image) => image.getAttribute("alt"))).toEqual([
      "lead",
      "infobox",
      "third",
    ]);
    expect(images.map((image) => image.getAttribute("loading"))).toEqual([
      "eager",
      "lazy",
      "lazy",
    ]);
  });
});
