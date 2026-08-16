import { afterEach, describe, expect, it, vi } from "vitest";
import { drawGraphImage, graphImageBlob, shareGraphImage } from "./graphImageExport";

/**
 * A recording 2D context. jsdom has no canvas, and the two defects these guard
 * against are both *drawing state* - which is exactly what a recorder can see.
 */
function recordingContext() {
  const calls: Array<{ op: string; args: unknown[]; lineCap: string; dash: unknown }> = [];
  let lineCap = "butt";
  let dash: unknown = [];
  const ctx = {
    get lineCap() { return lineCap; },
    set lineCap(v: string) { lineCap = v; },
    setLineDash(v: unknown) { dash = v; },
    getLineDash() { return dash; },
    save() {}, restore() {}, beginPath() {}, closePath() {},
    moveTo() {}, lineTo() {}, arc() {}, fill() {}, fillRect() {},
    fillText() {}, strokeText() {}, measureText: () => ({ width: 40 }),
    createRadialGradient: () => ({ addColorStop() {} }),
    stroke(...args: unknown[]) { calls.push({ op: "stroke", args, lineCap, dash }); },
    globalAlpha: 1, fillStyle: "", strokeStyle: "", lineWidth: 1, lineJoin: "",
    textAlign: "", textBaseline: "", font: "", filter: "",
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

const baseRequest = {
  width: 330, height: 400, background: "#061014",
  fontFamily: "serif", caption: "c", captionCentred: true, finisherCount: 1, targetGlowOpacity: 0.3,
  startTitle: "A", targetTitle: "B", edges: [], nodes: [],
};

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

function setNavigator(value: Partial<Navigator>) {
  Object.defineProperty(globalThis, "navigator", {
    value: { ...navigator, ...value },
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
  vi.restoreAllMocks();
});

const blob = () => new Blob(["png"], { type: "image/png" });

describe("shareGraphImage", () => {
  it("hands the file to the OS share sheet when one accepts files", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    setNavigator({ share, canShare: () => true } as Partial<Navigator>);

    await expect(shareGraphImage(blob(), "Opus Film", "Technology")).resolves.toBe("shared");
    expect(share).toHaveBeenCalledTimes(1);
    const [payload] = share.mock.calls[0];
    expect(payload.files[0].name).toBe("opus-film-to-technology.png");
  });

  // Safari exposes navigator.share but rejects file payloads in some contexts.
  // Calling it unguarded rejects only AFTER the user has tapped, so canShare
  // has to be consulted with the actual file.
  it("falls back to a download when the share sheet will not take files", async () => {
    const share = vi.fn();
    setNavigator({ share, canShare: () => false } as Partial<Navigator>);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    await expect(shareGraphImage(blob(), "Opus Film", "Technology")).resolves.toBe("downloaded");
    expect(share).not.toHaveBeenCalled();
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("falls back to a download when there is no share sheet at all", async () => {
    setNavigator({ share: undefined, canShare: undefined } as Partial<Navigator>);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    await expect(shareGraphImage(blob(), null, null)).resolves.toBe("downloaded");
    expect(click).toHaveBeenCalledTimes(1);
  });

  // Dismissing the share sheet raises AbortError. That is a deliberate "no" -
  // downloading the file anyway would be the opposite of what was asked.
  it("does not download behind the user's back when they dismiss the share sheet", async () => {
    const abort = new Error("dismissed");
    abort.name = "AbortError";
    setNavigator({ share: vi.fn().mockRejectedValue(abort), canShare: () => true } as Partial<Navigator>);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    await expect(shareGraphImage(blob(), "A", "B")).resolves.toBe("shared");
    expect(click).not.toHaveBeenCalled();
  });

  // A share sheet that accepts files and then rejects for a real reason must
  // still leave the user with a file where that is possible - on a desktop
  // browser the download works, and refusing to try left those users with
  // nothing at all.
  it("still delivers a file when the share sheet rejects for a real reason", async () => {
    setNavigator({
      share: vi.fn().mockRejectedValue(new Error("NotAllowedError")),
      canShare: () => true,
    } as Partial<Navigator>);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    await expect(shareGraphImage(blob(), "A", "B")).resolves.toBe("downloaded");
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("leaves no anchor behind in the document after downloading", async () => {
    setNavigator({ share: undefined, canShare: undefined } as Partial<Navigator>);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    await shareGraphImage(blob(), "A", "B");
    expect(document.querySelectorAll("a[download]")).toHaveLength(0);
  });
});

describe("graphImageBlob", () => {
  // iOS Safari only honours navigator.share() while the page holds transient
  // activation from the tap. Any await before the share() call gives that up,
  // and the sheet never appears - on the one device this feature is for. So
  // the encode must not be a promise. jsdom has no 2d context, so this throws;
  // the point is that it THROWS rather than REJECTING.
  it("produces the image synchronously, never as a promise", () => {
    let threw = false;
    let returned: unknown;
    try {
      returned = graphImageBlob({ ...baseRequest, legend: [] });
    } catch {
      threw = true;
    }
    expect(threw || !(returned instanceof Promise)).toBe(true);
    expect(returned).not.toBeInstanceOf(Promise);
  });
});

describe("drawGraphImage legend swatches", () => {
  // A round cap extends half the line width past each dash end, which on a
  // 16px swatch bridges the gaps entirely - so a dashed strand printed as a
  // solid one and the 8th player became indistinguishable from the 1st in the
  // shared PNG, which is the exact confusion the dash exists to prevent.
  it("strokes a dashed swatch with butt caps and a real dash pattern", () => {
    const { ctx, calls } = recordingContext();
    drawGraphImage(ctx, {
      ...baseRequest,
      legend: [
        { player: "P1", color: "#fcbe00", dash: "9 5", stat: "1:00 . 2 clk", status: "completed" as const, isWinner: false },
      ],
    });
    const swatch = calls.at(-1);
    expect(swatch?.lineCap).toBe("butt");
    expect(swatch?.dash).toEqual([5, 3]);
  });

  it("strokes an undashed swatch solid", () => {
    const { ctx, calls } = recordingContext();
    drawGraphImage(ctx, {
      ...baseRequest,
      legend: [
        { player: "P1", color: "#fcbe00", dash: null, stat: "1:00 . 2 clk", status: "completed" as const, isWinner: false },
      ],
    });
    expect(calls.at(-1)?.dash).toEqual([]);
  });
});
