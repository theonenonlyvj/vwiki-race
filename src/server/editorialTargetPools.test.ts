import { describe, expect, it, vi } from "vitest";
import {
  EditorialTargetPoolError,
  createEditorialTargetPools,
  parseUnusualEntries,
  parseVitalEntries,
} from "./editorialTargetPools";

const vitalHtml = `
  <main id="mw-content-text"><ul>
    <li><a href="/wiki/Earth?action=edit">query edit Earth</a></li>
    <li><a href="/wiki/Earth" data-pageid="101">Earth</a> <a href="/wiki/Incidental">details</a></li>
    <li><a href="/wiki/File:Earth.jpg">image</a></li>
    <li><a href="/w/index.php?title=Moon&action=edit">edit Moon</a></li>
    <li><a href="/wiki/Mars#History">Mars</a></li>
    <li><a href="wiki/Not_canonical">malformed relative link</a></li>
    <li><a href="/wiki/Earth">Earth duplicate</a></li>
    <li><a href="https://example.test/wiki/Elsewhere">wrong wiki</a></li>
  </ul></main>`;

const unusualHtml = `
  <main id="mw-content-text"><dl>
    <dt><a href="/wiki/Null_Island" data-page-id="123">Null Island</a> <a href="/wiki/Incidental">details</a></dt>
    <dd>Explanatory copy <a href="/wiki/Ignore_me">Ignore me</a></dd>
    <dt><a href="/wiki/Template:Odd">template</a> <a href="/wiki/Gravity_hill" data-mw='{"pageId":456}'>Gravity hill</a></dt>
    <dt><a href="/wiki/Null_Island">Duplicate</a></dt>
    <dt><a href="/wiki/History_of_foo#Edit">fragment</a></dt>
    <dt><a href="/w/index.php?title=Edit_me&action=edit">edit</a></dt>
    <dt><a href="/wiki/Bad_ID" data-pageid="-5">Bad ID</a></dt>
  </dl></main>`;

describe("editorial target-pool parsers", () => {
  it("extracts only unique mainspace Vital entry links and preserves valid supplied page IDs", () => {
    expect(parseVitalEntries(vitalHtml, 1)).toEqual([
      { title: "Earth", pageId: 101, source: "vital", vitalLevel: 1 },
    ]);
  });

  it("extracts the first valid mainspace link from each Unusual term", () => {
    expect(parseUnusualEntries(unusualHtml)).toEqual([
      { title: "Null Island", pageId: 123, source: "unusual" },
      { title: "Gravity hill", pageId: 456, source: "unusual" },
      { title: "Bad ID", source: "unusual" },
    ]);
  });
});

describe("editorial target pools", () => {
  it("serves valid cache data for 24 hours without refetching", async () => {
    let now = 10_000;
    const fetchImpl = vi.fn(async (url: string) => new Response(
      url.includes("Unusual") ? unusualHtml : vitalFor(levelFromUrl(url)),
    ));
    const pools = createEditorialTargetPools({ fetchImpl: fetchImpl as unknown as typeof fetch, now: () => now });

    await expect(pools.list("recognizable")).resolves.toHaveLength(3);
    now += 24 * 60 * 60 * 1_000 - 1;
    await expect(pools.list("recognizable")).resolves.toHaveLength(3);

    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(requestHeaders(fetchImpl)).toEqual(expect.objectContaining({
      "Api-User-Agent": expect.stringContaining("VWiki Race"),
      Accept: "text/html",
    }));
  });

  it("uses only a validated cache through seven stale days when refresh fails", async () => {
    let now = 1_000;
    const fetchImpl = vi.fn(async (url: string) => new Response(url.includes("Unusual") ? unusualHtml : vitalHtml));
    const pools = createEditorialTargetPools({ fetchImpl: fetchImpl as unknown as typeof fetch, now: () => now });
    await pools.list("recognizable");
    fetchImpl.mockRejectedValue(new TypeError("offline"));
    now += 24 * 60 * 60 * 1_000 + 1;

    await expect(pools.list("recognizable")).resolves.toHaveLength(1);
  });

  it("rejects empty/malformed upstream data and stale cache older than seven days", async () => {
    let now = 1_000;
    const fetchImpl = vi.fn(async (url: string) => new Response(url.includes("Unusual") ? unusualHtml : vitalHtml));
    const pools = createEditorialTargetPools({ fetchImpl: fetchImpl as unknown as typeof fetch, now: () => now });
    await pools.list("recognizable");
    fetchImpl.mockResolvedValue(new Response("<main>no entries</main>"));
    now += 7 * 24 * 60 * 60 * 1_000 + 1;

    await expect(pools.list("recognizable")).rejects.toBeInstanceOf(EditorialTargetPoolError);
    const fresh = createEditorialTargetPools({
      fetchImpl: vi.fn(async () => new Response("<main>no entries</main>")),
    });
    await expect(fresh.list("weird")).rejects.toBeInstanceOf(EditorialTargetPoolError);
  });

  it("propagates caller aborts and does not return stale data for an aborted request", async () => {
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const pools = createEditorialTargetPools({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const controller = new AbortController();
    const request = pools.list("weird", controller.signal);
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });

  it("returns hard as a stable union deduplicated by canonical title", async () => {
    const fetchImpl = vi.fn(async (url: string) => new Response(
      url.includes("Unusual")
        ? `<main><dl><dt><a href="/wiki/Earth">Earth</a></dt><dt><a href="/wiki/Oddity">Oddity</a></dt></dl></main>`
        : vitalHtml,
    ));
    const pools = createEditorialTargetPools({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(pools.list("hard")).resolves.toEqual([
      { title: "Earth", pageId: 101, source: "vital", vitalLevel: 1 },
      { title: "Oddity", source: "unusual" },
    ]);
  });
});

function levelFromUrl(url: string): number {
  return Number(url.match(/Level\/(\d)/)?.[1] ?? 1);
}

function vitalFor(level: number): string {
  return `<main id="mw-content-text"><ul><li><a href="/wiki/Level_${level}">Level ${level}</a></li></ul></main>`;
}

function requestHeaders(fetchImpl: ReturnType<typeof vi.fn>): HeadersInit | undefined {
  return fetchImpl.mock.calls[0]?.[1]?.headers;
}
